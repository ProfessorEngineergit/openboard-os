// Board controller: glues Excalidraw, the ink layer, sync, board management and the
// page API together. React only renders UI from `store`.
import {
  CaptureUpdateAction, restoreElements, reconcileElements, newElementWith, convertToExcalidrawElements,
  exportToBlob, exportToSvg, serializeAsJSON, viewportCoordsToSceneCoords, FONT_FAMILY, ROUNDNESS,
} from '@excalidraw/excalidraw';
import { createStore } from './store.js';
import { InkLayer, strokeToElement } from './ink.js';
import { BoardSync, request, HttpError } from './sync.js';
import { createOps } from './ops.js';
import { SWATCHES, PEN_WIDTHS, HIGHLIGHTER, STICKY_COLORS, PAPER_BACKGROUND, displayColor, paperTheme } from './colors.js';

const LAST_BOARD_KEY = 'openboard.board.current';
const PREFS_KEY = 'openboard.board.prefs';

const SHAPES = { rect: 'rectangle', ellipse: 'ellipse', arrow: 'arrow', line: 'line' };
const INK_TOOLS = new Set(['pen', 'highlighter', 'lasso']);

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
export function randomId(size = 21) {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let id = '';
  for (const b of bytes) id += ALPHABET[b & 63];
  return id;
}
const randomInteger = () => Math.floor(Math.random() * 2 ** 31);

function safeStorage(fn, fallback) { try { return fn(); } catch { return fallback; } }

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function fileStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
}

function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export class BoardController {
  constructor() {
    const prefs = safeStorage(() => JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'), {});
    this.clientId = randomId(12);
    this.api = null;
    this.config = { paper: 'auto', lowLatency: true, prediction: true };
    const systemTheme = document.documentElement.dataset.obTheme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    this.store = createStore({
      ready: false,
      tool: 'pen', shape: prefs.shape || 'rect', selectMode: 'select',
      penColor: prefs.penColor || SWATCHES[0].color, hlColor: prefs.hlColor || SWATCHES[7].color,
      width: prefs.width || 'm',
      collapsed: false, popover: null, sheet: null,
      boards: [], boardId: null, boardName: '',
      status: 'idle', notice: null,
      systemTheme, paper: paperTheme(systemTheme, 'auto'),
      canUndo: false, canRedo: false,
      snapshots: null, busy: false, error: null,
    });
    this.sync = new BoardSync({ clientId: this.clientId, onStatus: status => this.store.set({ status }) });
    this.sync.onBehind = () => this.pullRemote();
    this.sync.onCache = () => this.cacheScene();
    this.ops = createOps({ getApi: () => this.api, getInk: () => ({ color: this.store.get().penColor }) });
    this.lastTool = null;
    this.selectedCount = 0;
    new MutationObserver(() => {
      const theme = document.documentElement.dataset.obTheme;
      if (theme && theme !== this.store.get().systemTheme) this.store.set({ systemTheme: theme, paper: paperTheme(theme, this.config.paper) });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ob-theme'] });
  }

  get state() { return this.store.get(); }

  savePrefs() {
    const { shape, penColor, hlColor, width } = this.state;
    safeStorage(() => localStorage.setItem(PREFS_KEY, JSON.stringify({ shape, penColor, hlColor, width })));
  }

  setPaper(paper) {
    this.config.paper = ['light', 'dark', 'auto'].includes(paper) ? paper : 'auto';
    this.store.set({ paper: paperTheme(this.state.systemTheme, this.config.paper) });
  }

  // ---------- Excalidraw wiring ----------

  attach(api) {
    if (this.api === api || !api) return;
    this.api = api;
    this.applyTool();
    this.watchUndo();
    this.start();
  }

  attachInk(canvas) {
    if (this.ink || !canvas) return;
    // Registered before the ink layer (which stops events it owns): sticky-note taps and
    // dismissing open popovers/sheets.
    addEventListener('pointerdown', e => this.surfacePointerDown(e), { capture: true, passive: false });
    this.ink = new InkLayer({
      canvas,
      getView: () => {
        const st = this.api.getAppState();
        return { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value };
      },
      getStyle: () => this.inkStyle(),
      prediction: () => this.config.prediction !== false,
      onCommit: stroke => this.commitStroke(stroke),
      onLasso: points => this.lassoSelect(points),
    });
  }

  inkStyle() {
    const s = this.state;
    if (!this.api || !s.ready || s.sheet || !INK_TOOLS.has(s.tool) || this.config.lowLatency === false && s.tool !== 'lasso') return null;
    if (s.tool === 'lasso') return { kind: 'lasso', color: '#1971c2', display: displayColor('#1971c2', s.paper), strokeWidth: 1, opacity: 100 };
    if (s.tool === 'highlighter') return { kind: 'highlighter', color: s.hlColor, display: displayColor(s.hlColor, s.paper), strokeWidth: HIGHLIGHTER.stroke, opacity: HIGHLIGHTER.opacity };
    const width = PEN_WIDTHS.find(w => w.id === s.width) || PEN_WIDTHS[1];
    return { kind: 'pen', color: s.penColor, display: displayColor(s.penColor, s.paper), strokeWidth: width.stroke, opacity: 100 };
  }

  onChange(elements, appState, files) {
    this.sync.track(elements, appState, files);
    // Excalidraw switches back to selection after text/shapes; mirror that in the toolbar.
    const type = appState.activeTool.type;
    if (type !== this.lastTool) {
      this.lastTool = type;
      const s = this.state;
      const mapped = type === 'selection' ? 'select' : type === 'eraser' ? 'eraser' : type === 'text' ? 'text'
        : Object.entries(SHAPES).find(([, t]) => t === type)?.[0];
      if (type === 'freedraw' && !INK_TOOLS.has(s.tool)) this.store.set({ tool: 'pen' });
      else if (mapped && SHAPES[mapped] && !(s.tool === 'shape' && s.shape === mapped)) this.store.set({ tool: 'shape', shape: mapped });
      else if (mapped && !SHAPES[mapped] && s.tool !== mapped && !(mapped === 'select' && s.tool === 'sticky')) this.store.set({ tool: mapped });
    }
    const selected = Object.keys(appState.selectedElementIds).length;
    if (selected !== this.selectedCount) { this.selectedCount = selected; this.store.set({ hasSelection: selected > 0 }); }
  }

  excalidrawTool(tool = this.state.tool) {
    if (INK_TOOLS.has(tool)) return 'freedraw';
    if (tool === 'shape') return SHAPES[this.state.shape];
    return { eraser: 'eraser', select: 'selection', text: 'text', sticky: 'selection' }[tool] || 'selection';
  }

  applyTool() {
    if (!this.api) return;
    const s = this.state;
    const width = PEN_WIDTHS.find(w => w.id === s.width) || PEN_WIDTHS[1];
    this.api.updateScene({
      appState: {
        currentItemStrokeColor: s.penColor,
        currentItemStrokeWidth: width.shape,
        currentItemRoughness: 0,
        currentItemFontFamily: FONT_FAMILY.Nunito,
        currentItemFontSize: 28,
        currentItemRoundness: 'round',
        currentItemArrowType: 'round',
        currentItemOpacity: 100,
        currentItemBackgroundColor: 'transparent',
        penMode: false,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const type = this.excalidrawTool();
    this.lastTool = type;
    this.api.setActiveTool({ type });
  }

  setTool(tool, extra = {}) {
    this.ink?.cancel();
    this.store.set({ tool, popover: null, ...extra });
    this.savePrefs();
    this.applyTool();
  }

  setColor(color) {
    const s = this.state;
    if (s.tool === 'highlighter') this.store.set({ hlColor: color });
    else this.store.set({ penColor: color });
    this.savePrefs();
    this.applyTool();
    this.styleSelection({ strokeColor: color });
  }

  setWidth(width) {
    this.store.set({ width, tool: this.state.tool === 'highlighter' ? 'pen' : this.state.tool });
    this.savePrefs();
    this.applyTool();
    const w = PEN_WIDTHS.find(x => x.id === width);
    if (w) this.styleSelection({ strokeWidth: w.shape }, el => el.type === 'freedraw' ? { strokeWidth: w.stroke } : null);
  }

  styleSelection(patch, override) {
    const api = this.api;
    const selected = api.getAppState().selectedElementIds;
    if (!Object.keys(selected).length) return;
    const elements = api.getSceneElementsIncludingDeleted().map(el => {
      if (!selected[el.id] || el.type === 'image') return el;
      return newElementWith(el, override?.(el) || patch);
    });
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }

  commitStroke(stroke) {
    const api = this.api;
    const [element] = restoreElements([strokeToElement(stroke, { randomId, randomInteger })], null);
    if (!element) return;
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }

  lassoSelect(polygon) {
    const api = this.api;
    const ids = {};
    for (const el of api.getSceneElements()) {
      if (el.locked) continue;
      let samples;
      if (Array.isArray(el.points) && el.points.length) {
        const step = Math.max(1, Math.floor(el.points.length / 16));
        samples = el.points.filter((_, i) => i % step === 0).map(([px, py]) => [el.x + px, el.y + py]);
      } else {
        samples = [[el.x, el.y], [el.x + el.width, el.y], [el.x, el.y + el.height], [el.x + el.width, el.y + el.height], [el.x + el.width / 2, el.y + el.height / 2]];
      }
      const inside = samples.filter(p => pointInPolygon(p, polygon)).length;
      if (inside / samples.length >= 0.6) ids[el.id] = true;
    }
    this.store.set({ tool: 'select', selectMode: 'lasso' });
    this.lastTool = 'selection';
    api.setActiveTool({ type: 'selection' });
    api.updateScene({ appState: { selectedElementIds: ids }, captureUpdate: CaptureUpdateAction.NEVER });
  }

  surfacePointerDown(e) {
    const s = this.state;
    const onSurface = e.target instanceof HTMLCanvasElement && e.target.classList.contains('excalidraw__canvas');
    if (s.sheet && !e.target.closest?.('.tb-wrap')) {
      // A tap outside a sheet only closes it.
      if (onSurface) { e.stopImmediatePropagation(); e.preventDefault(); }
      this.store.set({ popover: null, sheet: null });
      return;
    }
    // Popovers close on the first touch of the canvas, which still draws.
    if (s.popover && !e.target.closest?.('.tb-wrap')) this.store.set({ popover: null });
    if (s.tool === 'sticky' && onSurface && e.isPrimary) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.addSticky(e);
    }
  }

  addSticky(e) {
    const api = this.api;
    const { x, y } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, api.getAppState());
    const [note] = convertToExcalidrawElements([{
      type: 'rectangle', x: x - 130, y: y - 110, width: 260, height: 220,
      backgroundColor: STICKY_COLORS.fill, strokeColor: STICKY_COLORS.stroke, fillStyle: 'solid',
      strokeWidth: 1, roughness: 0, roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
    }], { regenerateIds: true });
    api.updateScene({
      elements: [...api.getSceneElementsIncludingDeleted(), note],
      appState: { selectedElementIds: { [note.id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    this.store.set({ tool: 'select' });
    this.lastTool = 'selection';
    api.setActiveTool({ type: 'selection' });
    // Enter on a selected container starts editing its bound text.
    requestAnimationFrame(() => {
      const container = document.querySelector('.board-canvas .excalidraw');
      container?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    });
  }

  // ---------- Undo / redo (Excalidraw's own, hidden buttons keep history semantics) ----------

  historyButton(kind) {
    return document.querySelector(`.board-canvas .${kind}-button-container button`);
  }

  watchUndo() {
    const update = () => {
      const undo = this.historyButton('undo'), redo = this.historyButton('redo');
      this.store.set({ canUndo: !!undo && !undo.disabled, canRedo: !!redo && !redo.disabled });
    };
    const root = document.querySelector('.board-canvas');
    new MutationObserver(update).observe(root, { subtree: true, attributes: true, attributeFilter: ['disabled'], childList: true });
    update();
  }

  history(kind) {
    const button = this.historyButton(kind);
    if (button) { button.click(); return; }
    const container = document.querySelector('.board-canvas .excalidraw');
    container?.dispatchEvent(new KeyboardEvent('keydown', {
      key: kind === 'undo' ? 'z' : 'y', code: kind === 'undo' ? 'KeyZ' : 'KeyY', ctrlKey: true, bubbles: true, cancelable: true,
    }));
  }

  // ---------- Boards ----------

  async start() {
    try {
      const { openboard } = await import('/ui/app.js');
      this.openboard = openboard;
      await openboard.connect();
      openboard.on('board.changed', event => this.onBoardEvent(event));
      openboard.on('connection', ({ connected }) => { if (connected && this.state.boardId) this.pullRemote(); });
      openboard.api('/api/local/config').then(config => {
        const board = config?.board || {};
        this.config = { ...this.config, ...board };
        this.setPaper(board.paper || 'auto');
      }).catch(() => {});
    } catch (error) {
      console.warn('[board] runtime helper unavailable', error);
    }
    await this.bootBoards();
  }

  // Opens the remembered (or first) board. Without a reachable server the remembered
  // board is loaded from the IndexedDB cache and the connection is retried in the background.
  async bootBoards() {
    const boards = await this.refreshBoards();
    const remembered = safeStorage(() => localStorage.getItem(LAST_BOARD_KEY), null);
    const target = boards?.find(b => b.id === remembered) || boards?.[0] || (boards === null && remembered ? { id: remembered } : null);
    if (target) await this.openBoard(target.id);
    else { this.store.set({ ready: true, status: 'offline' }); this.watchServer(); }
  }

  // Retries until the server answers, then performs the normal start-up.
  watchServer() {
    if (this.serverTimer) return;
    this.serverTimer = setInterval(async () => {
      try { await request('/boards'); } catch { return; }
      clearInterval(this.serverTimer);
      this.serverTimer = null;
      if (this.state.boardId) await this.pullRemote(); else await this.bootBoards();
    }, 4000);
  }

  async refreshBoards() {
    try {
      const boards = await request('/boards');
      this.store.set({ boards });
      const current = boards.find(b => b.id === this.state.boardId);
      if (current) this.store.set({ boardName: current.name });
      return boards;
    } catch {
      return null;
    }
  }

  async openBoard(id) {
    const api = this.api;
    this.ink?.cancel();
    this.store.set({ busy: true });
    let data;
    try {
      data = await this.sync.load(id);
    } catch (error) {
      this.store.set({ busy: false, error: error.message });
      if (error instanceof HttpError && error.status === 404) {
        const boards = await this.refreshBoards();
        if (boards?.[0] && boards[0].id !== id) return this.openBoard(boards[0].id);
      }
      // Neither server nor local cache: keep an empty, offline board and retry in the background.
      if (!this.state.boardId) { this.store.set({ ready: true, status: 'offline' }); this.watchServer(); }
      this.flash(error instanceof HttpError ? 'Board nicht ladbar' : 'Server nicht erreichbar');
      return;
    }
    safeStorage(() => localStorage.setItem(LAST_BOARD_KEY, id));
    const elements = restoreElements(data.elements, null, { refreshDimensions: false, repairBindings: true });
    const app = data.appState || {};
    this.sync.paused = true;
    api.updateScene({
      elements,
      appState: {
        viewBackgroundColor: PAPER_BACKGROUND,
        ...(Number.isFinite(app.scrollX) ? { scrollX: app.scrollX, scrollY: app.scrollY } : { scrollX: 0, scrollY: 0 }),
        ...(Number.isFinite(app.zoom?.value) ? { zoom: { value: app.zoom.value } } : { zoom: { value: 1 } }),
        selectedElementIds: {},
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    this.sync.acknowledge(api.getSceneElementsIncludingDeleted().filter(el => !this.sync.out.upserts.has(el.id)));
    this.sync.paused = false;
    api.history.clear();
    const name = data.name || this.state.boards.find(b => b.id === id)?.name || 'Whiteboard';
    this.store.set({ boardId: id, boardName: name, ready: true, busy: false, error: null, snapshots: null });
    this.applyTool();
    this.loadFiles(id, Object.keys(data.files || {}));
  }

  async loadFiles(boardId, ids) {
    const have = this.api.getFiles();
    const missing = ids.filter(id => !have[id]);
    const files = (await Promise.all(missing.map(id => this.sync.fetchFile(boardId, id)))).filter(Boolean);
    if (files.length && boardId === this.state.boardId) this.api.addFiles(files);
  }

  // Board management needs the server; failures show a notice instead of an unhandled rejection.
  async serverAction(fn) {
    try { return await fn(); } catch (error) {
      console.warn('[board] action failed', error);
      this.flash(error instanceof HttpError ? error.message : 'Server nicht erreichbar');
      return undefined;
    }
  }

  createBoard(name) {
    return this.serverAction(async () => {
      const board = await request('/boards', { method: 'POST', body: { name: name || 'Neues Board' } });
      await this.refreshBoards();
      await this.openBoard(board.id);
      this.store.set({ sheet: null });
      return board;
    });
  }

  renameBoard(id, name) {
    return this.serverAction(async () => {
      await request(`/boards/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } });
      await this.refreshBoards();
    });
  }

  deleteBoard(id) {
    return this.serverAction(async () => {
      await request(`/boards/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const boards = await this.refreshBoards();
      if (id === this.state.boardId && boards?.[0]) await this.openBoard(boards[0].id);
    });
  }

  async onBoardEvent(event) {
    if (!event) return;
    if (event.kind && event.kind !== 'ops') this.refreshBoards();
    if (event.id !== this.state.boardId) return;
    if (event.kind === 'deleted') { const boards = await this.refreshBoards(); if (boards?.[0]) this.openBoard(boards[0].id); return; }
    if (event.kind === 'restore') { await this.openBoard(event.id); return; }
    if (event.client === this.clientId || this.sync.ownSeqs.has(event.seq)) return;
    if (Number.isFinite(event.seq) && event.seq <= this.sync.seq) return;
    this.pullRemote();
  }

  async pullRemote() {
    const id = this.state.boardId;
    if (!id || this.pulling) { this.pullAgain = true; return; }
    this.pulling = true;
    try {
      const data = await request(`/boards/${encodeURIComponent(id)}`);
      if (id !== this.state.boardId) return;
      const api = this.api;
      const remote = restoreElements(data.scene.elements, null, { refreshDimensions: false, repairBindings: true });
      const local = api.getSceneElementsIncludingDeleted();
      const merged = reconcileElements(local, remote, api.getAppState());
      const remoteSet = new Set(remote);
      this.sync.paused = true;
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER });
      this.sync.acknowledge(merged.filter(el => remoteSet.has(el)));
      this.sync.paused = false;
      this.sync.seq = Math.max(this.sync.seq, data.seq);
      this.loadFiles(id, Object.keys(data.scene.files || {}));
      if (this.state.status === 'offline' || this.state.status === 'error') {
        // The server answered again: push what is still unsent, otherwise we are in sync.
        if (this.sync.pendingCount) this.sync.schedule(50); else this.sync.setStatus('saved');
      }
    } catch (error) {
      console.warn('[board] pull failed', error);
    } finally {
      this.pulling = false;
      if (this.pullAgain) { this.pullAgain = false; this.pullRemote(); }
    }
  }

  cacheScene() {
    const id = this.state.boardId;
    if (!id || !this.api) return;
    const st = this.api.getAppState();
    const files = {};
    for (const [fid, f] of Object.entries(this.api.getFiles())) files[fid] = { id: fid, mimeType: f.mimeType };
    this.sync.writeCache(id, this.state.boardName, {
      elements: this.api.getSceneElementsIncludingDeleted(),
      appState: { viewBackgroundColor: st.viewBackgroundColor, scrollX: st.scrollX, scrollY: st.scrollY, zoom: { value: st.zoom.value } },
      files,
    });
  }

  // ---------- Snapshots ----------

  async loadSnapshots() {
    this.store.set({ snapshots: null });
    try {
      const snapshots = await request(`/boards/${encodeURIComponent(this.state.boardId)}/snapshots`);
      this.store.set({ snapshots });
    } catch (error) {
      this.store.set({ snapshots: [], error: error.message });
    }
  }

  async restoreSnapshot(snap) {
    await this.sync.flush();
    await request(`/boards/${encodeURIComponent(this.state.boardId)}/snapshots/${encodeURIComponent(snap)}/restore`, { method: 'POST', body: {} });
    await this.openBoard(this.state.boardId);
    this.store.set({ sheet: null });
    this.flash('Stand wiederhergestellt');
  }

  // ---------- Export / clear ----------

  exportOptions() {
    const api = this.api;
    return {
      elements: api.getSceneElements(),
      appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: PAPER_BACKGROUND, exportWithDarkMode: this.state.paper === 'dark' },
      files: api.getFiles(),
      exportPadding: 40,
    };
  }

  async exportPNGBlob() {
    return exportToBlob({ ...this.exportOptions(), mimeType: 'image/png' });
  }

  async export(kind) {
    const base = `${(this.state.boardName || 'Whiteboard').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'Whiteboard'}_${fileStamp()}`;
    this.store.set({ popover: null });
    if (kind === 'png') download(await this.exportPNGBlob(), `${base}.png`);
    else if (kind === 'svg') {
      const svg = await exportToSvg({ ...this.exportOptions() });
      download(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }), `${base}.svg`);
    } else {
      const api = this.api;
      const json = serializeAsJSON(api.getSceneElements(), api.getAppState(), api.getFiles(), 'local');
      download(new Blob([json], { type: 'application/vnd.excalidraw+json' }), `${base}.excalidraw`);
    }
    this.flash('Export gespeichert');
  }

  clear() {
    const api = this.api;
    const elements = api.getSceneElementsIncludingDeleted().map(el => (el.isDeleted ? el : newElementWith(el, { isDeleted: true })));
    api.updateScene({ elements, appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    this.store.set({ popover: null });
    this.flash('Tafel geleert – Rückgängig möglich');
  }

  zoomToFit() {
    const elements = this.api.getSceneElements();
    this.store.set({ popover: null });
    if (elements.length) this.api.scrollToContent(elements, { fitToViewport: true, viewportZoomFactor: 0.85, animate: true, duration: 450 });
  }

  flash(text) {
    clearTimeout(this.flashTimer);
    this.store.set({ notice: text });
    this.flashTimer = setTimeout(() => this.store.set({ notice: null }), 3200);
  }

  // ---------- Page API (controller / Puppeteer) ----------

  pageApi() {
    return {
      apply: op => this.ops.apply(op),
      exportPNG: async () => {
        const blob = await this.exportPNGBlob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      },
      diagnostics: () => ({
        elements: this.api ? this.api.getSceneElements().length : 0,
        boardId: this.state.boardId,
        boardName: this.state.boardName,
        status: this.state.status,
        saved: this.state.status === 'saved' && this.sync.pendingElements === 0,
        pending: this.sync.pendingElements,
        pendingApp: !!this.sync.out.app,
        seq: this.sync.seq,
        tool: this.state.tool,
        paper: this.state.paper,
        lowLatency: { ...(this.ink?.features || {}), enabled: this.config.lowLatency !== false, prediction: this.config.prediction !== false },
      }),
      flush: () => this.sync.flush(),
      setPaper: paper => this.setPaper(paper),
      openBoard: id => this.openBoard(id),
    };
  }
}
