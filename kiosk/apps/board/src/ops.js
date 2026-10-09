// Board operations (ASTRA `board` event, POST /api/v1/board/insert via the controller,
// window.__openboardBoard.apply). Inserted content lands right of the existing content
// (at the height of the visible area) unless coordinates are given, is scrolled into view
// and is persisted like any user edit (undoable).
import { CaptureUpdateAction, convertToExcalidrawElements, getCommonBounds, FONT_FAMILY } from '@excalidraw/excalidraw';
import { blobToDataURL, dataURLToBytes } from './sync.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const GAP = 120;

// Calm defaults for inserted content (clean strokes, Nunito) unless the caller sets them.
function withDefaults(skeleton) {
  const el = { roughness: 0, ...skeleton };
  if (el.type === 'text' && el.fontFamily === undefined) el.fontFamily = FONT_FAMILY.Nunito;
  if (el.label && typeof el.label === 'object' && el.label.fontFamily === undefined) el.label = { fontFamily: FONT_FAMILY.Nunito, ...el.label };
  // Shapes created implicitly for arrow ends get the same calm style.
  for (const end of ['start', 'end']) if (el[end] && typeof el[end] === 'object') el[end] = withDefaults(el[end]);
  return el;
}

// Excalidraw measures text with whatever font is loaded at that moment; inserting before the
// face has loaded gives too-narrow boxes and clipped text. Load every shipped face once.
let fontsReady = null;
function ensureFonts() {
  if (!fontsReady) {
    fontsReady = Promise.all([...document.fonts].map(face => face.load().catch(() => null)))
      .then(() => document.fonts.ready)
      .catch(() => null);
  }
  return fontsReady;
}

function bounds(elements) {
  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function createOps({ getApi, getInk }) {
  function view() {
    const st = getApi().getAppState();
    const zoom = st.zoom.value;
    return { x: -st.scrollX, y: -st.scrollY, width: st.width / zoom, height: st.height / zoom, zoom };
  }

  // Top-left position for a block of the given size.
  function place(width, height) {
    const v = view();
    const existing = getApi().getSceneElements();
    const top = v.y + 140 / v.zoom; // below the toolbar
    if (!existing.length) return { x: v.x + Math.max(40, (v.width - width) / 2), y: Math.max(top, v.y + (v.height - height) / 2) };
    const b = bounds(existing);
    return { x: b.maxX + GAP, y: top };
  }

  function insert(elements, { anchor, files = [] } = {}) {
    const api = getApi();
    if (!elements.length) throw new Error('Keine Elemente');
    const b = bounds(elements);
    const target = anchor || place(b.width, b.height);
    const dx = target.x - b.minX, dy = target.y - b.minY;
    const moved = elements.map(el => ({ ...el, x: el.x + dx, y: el.y + dy }));
    if (files.length) api.addFiles(files);
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...moved], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    const v = view();
    const fit = b.width > v.width * 0.8 || b.height > v.height * 0.8;
    api.scrollToContent(moved, { fitToViewport: fit, viewportZoomFactor: 0.8, animate: true, duration: 450 });
    return { ok: true, ids: moved.map(el => el.id) };
  }

  const textColor = () => getInk().color;

  async function imageFromDataURL(dataURL, mimeType) {
    if (!IMAGE_TYPES.has(mimeType)) throw new Error(`Bildtyp nicht erlaubt: ${mimeType}`);
    const { bytes } = dataURLToBytes(dataURL);
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Bild ist größer als 15 MB');
    let id;
    try {
      const digest = await crypto.subtle.digest('SHA-1', bytes);
      id = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch { id = `img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`; }
    const size = await new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth || 640, height: img.naturalHeight || 480 });
      img.onerror = () => resolve({ width: 640, height: 480 });
      img.src = dataURL;
    });
    const v = view();
    const maxW = Math.min(900, v.width * 0.6), maxH = Math.min(700, v.height * 0.6);
    const scale = Math.min(1, maxW / size.width, maxH / size.height);
    return { file: { id, mimeType, dataURL, created: Date.now() }, width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  }

  async function loadSource(src) {
    if (typeof src !== 'string' || !src) throw new Error('src fehlt');
    if (src.startsWith('data:')) {
      const { mimeType } = dataURLToBytes(src);
      return { dataURL: src, mimeType };
    }
    const url = new URL(src, location.href);
    if (url.origin !== location.origin) throw new Error('Nur data:-URLs oder Bilder vom Kiosk selbst');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Bild nicht ladbar (${response.status})`);
    const blob = await response.blob();
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('Bild ist größer als 15 MB');
    return { dataURL: await blobToDataURL(blob), mimeType: blob.type.split(';')[0] };
  }

  async function addImage({ src, caption, x, y }) {
    const { dataURL, mimeType } = await loadSource(src);
    const { file, width, height } = await imageFromDataURL(dataURL, mimeType);
    const skeleton = [{ type: 'image', x: 0, y: 0, width, height, fileId: file.id }];
    if (caption) {
      skeleton.push({
        type: 'text', x: 0, y: height + 18, text: String(caption).slice(0, 500), fontSize: 22,
        fontFamily: FONT_FAMILY.Nunito, strokeColor: textColor(),
      });
    }
    const elements = convertToExcalidrawElements(skeleton, { regenerateIds: true });
    return insert(elements, { files: [file], anchor: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
  }

  function svgToDataURL(svg) {
    const text = String(svg || '').trim();
    if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text)) throw new Error('Kein SVG');
    if (text.length > 5 * 1024 * 1024) throw new Error('SVG ist zu groß');
    let source = text;
    if (!/xmlns=/.test(source.slice(0, source.indexOf('>')))) source = source.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    const bytes = new TextEncoder().encode(source);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/svg+xml;base64,${btoa(binary)}`;
  }

  const handlers = {
    async add_text({ text, x, y, fontSize }) {
      if (typeof text !== 'string' || !text.trim()) throw new Error('text fehlt');
      const [el] = convertToExcalidrawElements([{
        type: 'text', x: 0, y: 0, text: text.slice(0, 20000), fontSize: Number.isFinite(fontSize) ? fontSize : 32,
        fontFamily: FONT_FAMILY.Nunito, strokeColor: textColor(),
      }], { regenerateIds: true });
      return insert([el], { anchor: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
    },
    async add_mermaid({ definition, x, y }) {
      if (typeof definition !== 'string' || !definition.trim()) throw new Error('definition fehlt');
      const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
      const { elements: skeleton, files } = await parseMermaidToExcalidraw(definition, { themeVariables: { fontSize: '20px' } });
      const elements = convertToExcalidrawElements(skeleton.map(withDefaults), { regenerateIds: true });
      return insert(elements, { files: Object.values(files || {}), anchor: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
    },
    add_image: addImage,
    async add_svg({ svg, caption, x, y }) {
      return addImage({ src: svgToDataURL(svg), caption, x, y });
    },
    async add_elements({ elements, x, y, absolute }) {
      if (!Array.isArray(elements) || !elements.length) throw new Error('elements fehlt');
      if (elements.length > 2000) throw new Error('Zu viele Elemente');
      const converted = convertToExcalidrawElements(elements.map(withDefaults), { regenerateIds: true });
      if (absolute) {
        const api = getApi();
        api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...converted], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        api.scrollToContent(converted, { animate: true, duration: 450 });
        return { ok: true, ids: converted.map(el => el.id) };
      }
      return insert(converted, { anchor: Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null });
    },
  };

  return {
    async apply(op) {
      if (!op || typeof op !== 'object') throw new Error('Ungültige Operation');
      const type = op.op || op.type;
      const handler = handlers[type];
      if (!handler) throw new Error(`Unbekannte Operation: ${type}`);
      if (type !== 'add_image' && type !== 'add_svg') await ensureFonts();
      else if (op.caption) await ensureFonts();
      return handler(op);
    },
  };
}
