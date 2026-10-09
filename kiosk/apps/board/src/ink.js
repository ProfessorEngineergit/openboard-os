// Low-latency ink layer.
//
// While the pen or highlighter is active, single-pointer strokes never reach Excalidraw.
// They are drawn straight from the input event on a separate, desynchronized 2D canvas
// (pointerrawupdate + coalesced points, predicted points drawn provisionally) using the
// same perfect-freehand parameters Excalidraw uses for `freedraw`, so the committed
// element looks identical to the live stroke. On pointerup the stroke becomes a real
// Excalidraw element and the ink canvas is cleared once Excalidraw has painted it.
//
// Two-finger gestures: when a second touch lands while a finger stroke is running, the
// stroke is dropped (or kept, if it was clearly a deliberate stroke) and both pointers
// are handed to Excalidraw (synthetic pointerdown for the first finger), which then
// pinch-zooms/pans natively.
import { getStroke } from 'perfect-freehand';

export const FREEDRAW = {
  thinning: 0.6, smoothing: 0.5, streamline: 0.5,
  easing: t => Math.sin((t * Math.PI) / 2),
};

const hasRawUpdate = typeof window !== 'undefined' && 'onpointerrawupdate' in window;
const hasPredicted = typeof PointerEvent !== 'undefined' && typeof PointerEvent.prototype.getPredictedEvents === 'function';
const hasCoalesced = typeof PointerEvent !== 'undefined' && typeof PointerEvent.prototype.getCoalescedEvents === 'function';

function outlinePath(ctx, outline) {
  // Same quadratic smoothing as Excalidraw's getSvgPathFromStroke.
  if (outline.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 0; i < outline.length; i++) {
    const p = outline[i], q = outline[(i + 1) % outline.length];
    ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
  }
  ctx.closePath();
}

export class InkLayer {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas full-screen canvas above Excalidraw (pointer-events: none)
   * @param {() => {scrollX:number, scrollY:number, zoom:number}} o.getView
   * @param {() => (null | {kind:'pen'|'highlighter'|'lasso', color:string, display:string, strokeWidth:number, opacity:number})} o.getStyle
   * @param {(stroke) => void} o.onCommit
   * @param {(points) => void} o.onLasso
   * @param {() => boolean} o.prediction
   */
  constructor({ canvas, getView, getStyle, onCommit, onLasso, prediction = () => true, palmSize = 46 }) {
    this.canvas = canvas;
    this.getView = getView;
    this.getStyle = getStyle;
    this.onCommit = onCommit;
    this.onLasso = onLasso;
    this.prediction = prediction;
    this.palmSize = palmSize;
    this.active = null;
    this.pending = [];             // committed strokes still visible until Excalidraw paints them
    this.passthrough = new Set();  // pointers handed to Excalidraw (gesture)
    this.palms = new Set();
    this.prevBox = null;
    this.presenter = null;
    this.ctx = canvas.getContext('2d', { desynchronized: true, alpha: true }) || canvas.getContext('2d');
    const attributes = this.ctx.getContextAttributes?.() || {};
    this.features = {
      rawupdate: hasRawUpdate,
      predicted: hasPredicted,
      coalesced: hasCoalesced,
      desynchronized: !!attributes.desynchronized,
      delegatedInk: false,
    };
    this.resize();
    this.bind();
    if (navigator.ink?.requestPresenter) {
      navigator.ink.requestPresenter({ presentationArea: canvas })
        .then(presenter => { this.presenter = presenter; this.features.delegatedInk = true; })
        .catch(() => {});
    }
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = Math.round(innerWidth * dpr);
    this.canvas.height = Math.round(innerHeight * dpr);
    this.pending = [];
    this.prevBox = null;
    if (this.active) this.render();
  }

  bind() {
    const opts = { capture: true, passive: false };
    addEventListener('pointerdown', e => this.down(e), opts);
    addEventListener('pointermove', e => this.move(e), opts);
    if (hasRawUpdate) addEventListener('pointerrawupdate', e => this.raw(e), opts);
    addEventListener('pointerup', e => this.up(e, true), opts);
    addEventListener('pointercancel', e => this.up(e, false), opts);
    addEventListener('touchstart', e => this.touchstart(e), opts);
    addEventListener('resize', () => this.resize());
  }

  isSurface(target) {
    return target instanceof HTMLCanvasElement && target.classList.contains('interactive') && target.classList.contains('excalidraw__canvas');
  }

  isPalm(e) {
    // Chrome reports width/height = 1 when the digitizer has no contact geometry.
    return e.pointerType === 'touch' && (e.width > this.palmSize || e.height > this.palmSize);
  }

  stop(e) {
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
  }

  touchstart(e) {
    // Excalidraw uses touchstart for double-tap → text. Single-finger touches belong to the ink.
    if (!this.getStyle() || this.passthrough.size || !this.isSurface(e.target)) return;
    if (e.touches.length === 1) e.stopImmediatePropagation();
  }

  down(e) {
    if (this.passthrough.has(e.pointerId)) return;              // our own synthetic handover event
    const style = this.getStyle();
    if (!style || !this.isSurface(e.target)) return;
    if (this.passthrough.size && e.pointerType === 'touch') { this.passthrough.add(e.pointerId); return; }
    if (this.isPalm(e)) { this.palms.add(e.pointerId); this.stop(e); return; }
    if (e.pointerType === 'mouse' && e.button !== 0) return;     // wheel/right button → Excalidraw
    if (this.active) {
      if (this.active.pointerType === 'pen' && e.pointerType === 'touch') { this.palms.add(e.pointerId); this.stop(e); return; }
      if (e.pointerType === 'touch' && this.active.pointerType === 'touch') { this.handover(e); return; }
      this.stop(e);
      return;
    }
    this.stop(e);
    const view = this.getView();
    const realPressure = e.pointerType === 'pen' && e.pressure > 0 && e.pressure !== 0.5;
    this.active = {
      pointerId: e.pointerId, pointerType: e.pointerType, style, view,
      simulate: style.kind === 'pen' && !realPressure,
      points: [], predicted: [], started: performance.now(), length: 0,
      last: { x: e.clientX, y: e.clientY, width: e.width, height: e.height },
    };
    this.add(e);
    this.render();
    try { e.target.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }

  toScene(e, view = this.active.view) {
    return [e.clientX / view.zoom - view.scrollX, e.clientY / view.zoom - view.scrollY];
  }

  add(e) {
    const a = this.active;
    const [x, y] = this.toScene(e);
    const prev = a.points[a.points.length - 1];
    if (prev) {
      const d = Math.hypot(x - prev[0], y - prev[1]);
      if (d < 0.05) return;
      a.length += d;
    }
    const pressure = a.style.kind === 'highlighter' ? 0.5 : (a.simulate ? 0.5 : Math.max(0.05, e.pressure || 0.5));
    a.points.push([x, y, pressure]);
    a.last = { x: e.clientX, y: e.clientY, width: e.width, height: e.height };
  }

  addCoalesced(e) {
    const list = hasCoalesced ? e.getCoalescedEvents() : [];
    if (list.length) for (const c of list) this.add(c);
    else this.add(e);
  }

  raw(e) {
    if (!this.active || e.pointerId !== this.active.pointerId) return;
    this.addCoalesced(e);
    this.active.predicted = [];
    this.render();
  }

  move(e) {
    if (this.passthrough.has(e.pointerId)) return;
    if (this.palms.has(e.pointerId)) { this.stop(e); return; }
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    this.stop(e);
    if (!hasRawUpdate) this.addCoalesced(e);
    a.predicted = [];
    if (hasPredicted && this.prediction() && a.style.kind !== 'lasso') {
      for (const p of e.getPredictedEvents()) {
        const [x, y] = this.toScene(p);
        a.predicted.push([x, y, a.points[a.points.length - 1]?.[2] ?? 0.5]);
      }
    }
    this.render();
    if (this.presenter && a.style.kind === 'pen' && e.isTrusted) {
      try {
        this.presenter.updateInkTrailStartPoint(e, {
          color: a.style.display,
          diameter: Math.max(1, a.style.strokeWidth * 4.25 * 1.2 * a.view.zoom),
        });
      } catch { /* not supported for this event */ }
    }
  }

  up(e, ended) {
    if (this.passthrough.delete(e.pointerId)) return;
    if (this.palms.delete(e.pointerId)) { this.stop(e); return; }
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    this.stop(e);
    if (ended) this.add(e);
    this.active = null;
    a.predicted = [];
    if (!ended && a.length < 24) { this.redrawAll(); return; }
    this.finish(a);
  }

  handover(second) {
    const a = this.active;
    this.active = null;
    // A finger that has already drawn a real line before the second one landed keeps its stroke.
    const deliberate = performance.now() - a.started > 400 && a.length * a.view.zoom > 60;
    if (deliberate) this.finish(a); else this.redrawAll();
    this.passthrough.add(a.pointerId);
    this.passthrough.add(second.pointerId);
    const surface = second.target;
    const init = {
      bubbles: true, cancelable: true, composed: true, pointerId: a.pointerId, pointerType: 'touch',
      isPrimary: true, clientX: a.last.x, clientY: a.last.y, screenX: a.last.x, screenY: a.last.y,
      button: 0, buttons: 1, pressure: 0.5, width: a.last.width || 1, height: a.last.height || 1,
    };
    surface.dispatchEvent(new PointerEvent('pointerdown', init));
    // The real pointerdown of the second finger now continues to Excalidraw.
  }

  finish(a) {
    if (a.style.kind === 'lasso') {
      this.redrawAll();
      if (a.points.length > 2) this.onLasso?.(a.points.map(([x, y]) => [x, y]));
      return;
    }
    if (!a.points.length) { this.redrawAll(); return; }
    // Keep the final (tapered) stroke on screen until Excalidraw has painted the element.
    const entry = { stroke: a, outline: this.outline(a, true) };
    this.pending.push(entry);
    this.redrawAll();
    this.onCommit?.(a);
    // Two frames: React commit + Excalidraw's rAF-throttled static canvas render.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.pending = this.pending.filter(p => p !== entry);
      this.redrawAll();
    }));
  }

  outline(a, last = false) {
    const points = a.predicted.length ? a.points.concat(a.predicted) : a.points;
    if (a.style.kind === 'lasso') return points;
    return getStroke(points, {
      ...FREEDRAW,
      size: a.style.strokeWidth * 4.25,
      simulatePressure: a.simulate,
      last,
    });
  }

  transform(view) {
    const s = this.dpr * view.zoom;
    this.ctx.setTransform(s, 0, 0, s, s * view.scrollX, s * view.scrollY);
  }

  paint(a, outline) {
    const ctx = this.ctx;
    this.transform(a.view);
    if (a.style.kind === 'lasso') {
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2 / a.view.zoom;
      ctx.setLineDash([8 / a.view.zoom, 6 / a.view.zoom]);
      ctx.strokeStyle = a.style.display;
      ctx.beginPath();
      outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      return this.box(outline, a.view, 4);
    }
    ctx.globalAlpha = a.style.opacity / 100;
    ctx.fillStyle = a.style.display;
    outlinePath(ctx, outline);
    ctx.fill();
    ctx.globalAlpha = 1;
    return this.box(outline, a.view, 2);
  }

  box(points, view, pad) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    const s = this.dpr * view.zoom;
    return {
      x: Math.floor((minX + view.scrollX) * s) - pad, y: Math.floor((minY + view.scrollY) * s) - pad,
      w: Math.ceil((maxX - minX) * s) + pad * 2 + 1, h: Math.ceil((maxY - minY) * s) + pad * 2 + 1,
    };
  }

  // Called synchronously from the input event: no rAF in between.
  render() {
    const a = this.active;
    if (!a) return;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.prevBox) ctx.clearRect(this.prevBox.x, this.prevBox.y, this.prevBox.w, this.prevBox.h);
    for (const p of this.pending) this.paint(p.stroke, p.outline);
    this.prevBox = this.paint(a, this.outline(a));
  }

  redrawAll() {
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.prevBox = null;
    for (const p of this.pending) this.paint(p.stroke, p.outline);
    if (this.active) this.prevBox = this.paint(this.active, this.outline(this.active));
  }

  cancel() {
    this.active = null;
    this.redrawAll();
  }
}

// Builds the Excalidraw freedraw element for a finished stroke (scene coordinates).
export function strokeToElement(stroke, { randomId, randomInteger }) {
  const pts = stroke.points;
  const [x0, y0] = pts[0];
  const rel = pts.map(([x, y]) => [x - x0, y - y0]);
  if (rel.length === 1) rel.push([0.0001, 0.0001]);
  const pressures = stroke.simulate ? [] : pts.map(p => p[2]);
  if (!stroke.simulate && pressures.length < rel.length) pressures.push(pressures[0] ?? 0.5);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of rel) {
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
  }
  return {
    type: 'freedraw', id: randomId(), x: x0, y: y0, width: maxX - minX, height: maxY - minY, angle: 0,
    strokeColor: stroke.style.color, backgroundColor: 'transparent', fillStyle: 'solid',
    strokeWidth: stroke.style.strokeWidth, strokeStyle: 'solid', roughness: 0, opacity: stroke.style.opacity,
    groupIds: [], frameId: null, roundness: null, seed: randomInteger(), version: 1, versionNonce: randomInteger(),
    isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
    points: rel, pressures, simulatePressure: stroke.simulate, lastCommittedPoint: rel[rel.length - 1],
  };
}
