// Shared helpers for the OpenBoard settings app, the dock editor and the remote
// console. Vanilla DOM, no framework. Expects the classic globals OBIcons
// (/ui/icons.js) and, for the dock editor, OBWidgets (/ui/widgets.js).

// ---------------------------------------------------------------- DOM
// h('div', { class: 'x', onclick: fn, dataset: { id: 1 } }, child, [children], 'text')
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') { for (const [prop, v] of Object.entries(value)) { if (prop.startsWith('--')) el.style.setProperty(prop, v); else el.style[prop] = v; } }
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value;
    else if (key in el && typeof value !== 'string') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}
// Glyphs the shared set does not have (yet), same 24px stroke style.
const EXTRA_ICONS = { search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>' };
const iconCache = new Map();
export function icon(name, cls = '') {
  const key = name + '|' + cls;
  if (!iconCache.has(key)) {
    const template = document.createElement('template');
    const extra = !globalThis.OBIcons?.paths?.[name] && EXTRA_ICONS[name];
    template.innerHTML = extra ? `<svg class="ob-icon" viewBox="0 0 24 24" aria-hidden="true">${extra}</svg>` : globalThis.OBIcons ? OBIcons.svg(name) : '<span></span>';
    const node = template.content.firstElementChild;
    if (cls) node.classList.add(...cls.split(' '));
    iconCache.set(key, node);
  }
  return iconCache.get(key).cloneNode(true);
}
export const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
export function debounce(fn, ms) {
  let timer = null, lastArgs;
  const wrapped = (...args) => { lastArgs = args; clearTimeout(timer); timer = setTimeout(() => { timer = null; fn(...lastArgs); }, ms); };
  wrapped.flush = () => { if (timer) { clearTimeout(timer); timer = null; fn(...lastArgs); } };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  wrapped.pending = () => timer != null;
  return wrapped;
}
export function injectStyle(id, css) {
  if (document.getElementById(id)) return;
  document.head.append(h('style', { id }, css));
}
export function injectStylesheet(href) {
  const url = new URL(href, import.meta.url).href;
  if ([...document.querySelectorAll('link[rel=stylesheet]')].some(link => link.href === url)) return Promise.resolve();
  return new Promise(resolve => {
    const link = h('link', { rel: 'stylesheet', href: url });
    link.addEventListener('load', resolve); link.addEventListener('error', resolve);
    document.head.append(link);
  });
}

// ---------------------------------------------------------------- objects
export const clone = value => value == null ? value : structuredClone(value);
export const getPath = (obj, path) => path.split('.').reduce((value, key) => value?.[key], obj);
export function patchFor(path, value) {
  return path.split('.').reduceRight((inner, key) => ({ [key]: inner }), value);
}
export const isSecretSet = value => value && typeof value === 'object' ? !!value.set : !!value;
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const uid = prefix => prefix + Math.random().toString(36).slice(2, 9);

// ---------------------------------------------------------------- format
export const fmt = {
  pct: v => Number.isFinite(v) ? Math.round(v) + ' %' : '–',
  mb: v => !Number.isFinite(v) ? '–' : v >= 1024 ? (v / 1024).toFixed(1).replace('.', ',') + ' GB' : Math.round(v) + ' MB',
  kbs: v => !Number.isFinite(v) ? '–' : v >= 1024 ? (v / 1024).toFixed(1).replace('.', ',') + ' MB/s' : Math.round(v) + ' kB/s',
  temp: v => Number.isFinite(v) ? Math.round(v) + ' °C' : '–',
  duration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '–';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), mm = Math.floor(s % 3600 / 60);
    if (d) return `${d} T ${hh} Std`;
    if (hh) return `${hh} Std ${mm} min`;
    if (mm) return `${mm} min`;
    return `${s} s`;
  },
  ago(ts) {
    if (!ts) return 'nie';
    const diff = Date.now() - ts;
    if (diff < 45e3) return 'gerade eben';
    if (diff < 3600e3) return `vor ${Math.round(diff / 60e3)} min`;
    if (diff < 86400e3) return `vor ${Math.round(diff / 3600e3)} Std`;
    return new Date(ts).toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
  },
  time: ts => ts ? new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–',
};
export const LIFECYCLE = {
  active: { label: 'Aktiv', kind: 'ok' },
  background: { label: 'Hintergrund', kind: '' },
  frozen: { label: 'Pausiert', kind: 'info' },
  terminated: { label: 'Beendet', kind: 'faint' },
  loading: { label: 'Lädt …', kind: 'warn' },
};
export const PRESSURE = {
  normal: { label: 'Normal', kind: 'ok', text: 'Reserven vorhanden – keine Eingriffe.' },
  elevated: { label: 'Erhöht', kind: 'warn', text: 'Ungenutzte Hintergrund-Apps werden eingefroren.' },
  critical: { label: 'Kritisch', kind: 'err', text: 'Ungenutzte Apps werden beendet oder es wird nachgefragt.' },
};
export function badge(text, kind = '') { return h('span', { class: `ob-badge ${kind}` }, text); }
export function lifecycleBadge(lifecycle) {
  const info = LIFECYCLE[lifecycle] || { label: lifecycle || '–', kind: '' };
  return h('span', { class: `ob-badge lc lc-${lifecycle || 'none'} ${info.kind}` }, h('i', { class: 'dot' }), info.label);
}

// ---------------------------------------------------------------- controls
export function switchEl(checked, onChange, label) {
  const input = h('input', { type: 'checkbox', class: 'ob-switch', role: 'switch', 'aria-label': label || 'Schalter' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  input.set = value => { input.checked = !!value; };
  return input;
}
export function seg(options, value, onChange, { label } = {}) {
  const el = h('div', { class: 'ob-seg', role: 'group', 'aria-label': label || '' });
  for (const [optionValue, optionLabel] of options) {
    el.append(h('button', { type: 'button', dataset: { value: String(optionValue) }, onclick: () => { el.set(optionValue); onChange(optionValue); } }, optionLabel));
  }
  el.set = next => { for (const button of el.children) button.setAttribute('aria-pressed', String(button.dataset.value === String(next))); };
  el.set(value);
  return el;
}
export function select(options, value, onChange, { label } = {}) {
  const el = h('select', { class: 'ob-select', 'aria-label': label || '' }, options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = value ?? '';
  el.addEventListener('change', () => onChange(el.value));
  el.set = next => { el.value = next ?? ''; };
  return el;
}
// Number stepper: [−] value [+]. Typing commits after a pause or on blur.
export function stepper({ value, min = -Infinity, max = Infinity, step = 1, unit = '', decimals = 0, scale = 1, onChange, label }) {
  const toText = v => Number.isFinite(v) ? (v * scale).toFixed(decimals).replace('.', ',') : '';
  const input = h('input', { class: 'num', inputmode: 'decimal', 'aria-label': label || '', autocomplete: 'off', spellcheck: 'false' });
  let current = value;
  const commit = next => {
    if (!Number.isFinite(next)) { input.value = toText(current); return; }
    next = Math.min(max, Math.max(min, Math.round(next / step) * step));
    next = Number(next.toFixed(6));
    input.value = toText(next);
    if (next !== current) { current = next; onChange(next); }
  };
  const typed = debounce(() => commit(parseFloat(input.value.replace(',', '.')) / scale), 900);
  input.addEventListener('input', typed);
  input.addEventListener('blur', () => typed.flush());
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { typed.flush(); input.blur(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); commit((current ?? 0) + step); }
    if (event.key === 'ArrowDown') { event.preventDefault(); commit((current ?? 0) - step); }
  });
  const el = h('div', { class: 'obs-stepper' },
    h('button', { type: 'button', class: 'step', 'aria-label': 'Weniger', onclick: () => commit((current ?? 0) - step) }, icon('minus')),
    h('label', { class: 'field' }, input, unit ? h('span', { class: 'unit' }, unit) : null),
    h('button', { type: 'button', class: 'step', 'aria-label': 'Mehr', onclick: () => commit((current ?? 0) + step) }, icon('plus')));
  el.set = next => { current = next; if (document.activeElement !== input && !typed.pending()) input.value = toText(next); };
  el.editing = () => document.activeElement === input || typed.pending();
  el.set(value);
  return el;
}
// Range slider with live label; onInput is throttled, onChange fires on release.
export function slider({ value, min = 0, max = 100, step = 1, format = v => v, onChange, onInput, label }) {
  const input = h('input', { type: 'range', class: 'obs-range', min, max, step, 'aria-label': label || '' });
  const out = h('output', { class: 'obs-range-value' });
  let dragging = false, lastSent = 0;
  const paint = () => { const p = (input.value - min) / (max - min) * 100; input.style.setProperty('--p', p + '%'); out.textContent = format(Number(input.value)); };
  input.value = value ?? min; paint();
  input.addEventListener('pointerdown', () => { dragging = true; });
  input.addEventListener('input', () => { paint(); const now = Date.now(); if (onInput && now - lastSent > 250) { lastSent = now; onInput(Number(input.value)); } });
  input.addEventListener('change', () => { dragging = false; paint(); onChange?.(Number(input.value)); });
  const el = h('div', { class: 'obs-slider' }, input, out);
  el.set = next => { if (!dragging && next != null) { input.value = next; paint(); } };
  return el;
}
// Icon grid picker
export function iconGrid(value, onChange, { names } = {}) {
  const UI_GLYPHS = ['plus', 'minus', 'close', 'check', 'chevron', 'back', 'drag'];
  const list = names || (globalThis.OBIcons?.names || []).filter(name => !UI_GLYPHS.includes(name));
  const el = h('div', { class: 'obs-icongrid', role: 'listbox' });
  for (const name of list) {
    el.append(h('button', { type: 'button', class: 'ic', title: name, 'aria-label': name, dataset: { icon: name }, onclick: () => { el.set(name); onChange(name); } }, icon(name)));
  }
  el.set = next => { for (const button of el.children) button.setAttribute('aria-pressed', String(button.dataset.icon === next)); };
  el.set(value);
  return el;
}

// ---------------------------------------------------------------- feedback
export function createToaster(host) {
  const box = h('div', { class: 'obs-toasts', role: 'status', 'aria-live': 'polite' });
  host.append(box);
  function show(text, { kind = 'info', action, timeout = kind === 'err' ? 6000 : 3200 } = {}) {
    const node = h('div', { class: `obs-toast ${kind}` },
      icon(kind === 'err' ? 'warning' : kind === 'ok' ? 'check' : 'info'),
      h('span', { class: 'txt' }, text),
      action ? h('button', { type: 'button', class: 'act', onclick: () => { action.run(); close(); } }, action.label) : null);
    const close = () => { node.classList.add('out'); setTimeout(() => node.remove(), 260); };
    box.append(node);
    while (box.children.length > 3) box.firstElementChild.remove();
    setTimeout(close, timeout);
    return close;
  }
  return { show, destroy: () => box.remove() };
}
// Modal sheet. Returns { close, el }. actions: [{label, kind, run}] (run may return false to stay open)
export function openSheet(host, { title, text, content, actions = [], wide = false, onClose }) {
  const scrim = h('div', { class: 'obs-scrim' });
  const panel = h('div', { class: `obs-sheet ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' },
    title ? h('h2', null, title) : null,
    text ? h('p', { class: 'txt' }, text) : null,
    content || null,
    actions.length ? h('div', { class: 'actions' }, actions.map(action => h('button', {
      type: 'button', class: `ob-btn ${action.kind || ''}`, disabled: action.disabled,
      onclick: async () => { if ((await action.run?.()) !== false) close(); },
    }, action.label))) : null);
  scrim.append(panel);
  const close = () => { scrim.classList.add('out'); document.removeEventListener('keydown', onKey); setTimeout(() => scrim.remove(), 200); onClose?.(); };
  const onKey = event => { if (event.key === 'Escape') close(); };
  scrim.addEventListener('pointerdown', event => { if (event.target === scrim) close(); });
  document.addEventListener('keydown', onKey);
  host.append(scrim);
  requestAnimationFrame(() => panel.querySelector('input,button.primary,button.danger')?.focus?.({ preventScroll: true }));
  return { close, el: panel };
}
export function confirmSheet(host, { title, text, confirm = 'OK', danger = false }) {
  return new Promise(resolve => {
    let answered = false;
    openSheet(host, {
      title, text, onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: 'Abbrechen', kind: 'ghost', run: () => { answered = true; resolve(false); } },
        { label: confirm, kind: danger ? 'danger' : 'primary', run: () => { answered = true; resolve(true); } },
      ],
    });
  });
}

// ---------------------------------------------------------------- client
// Same interface as the `openboard` helper from /ui/app.js ({api, on, state}),
// plus `metrics`, `connected` and automatic reconnects when the controller
// (or the proxy in front of it) is down. Does not touch the document theme.
export function createClient({ applyTheme = false, metrics = true } = {}) {
  const listeners = new Map();
  let source = null, retry = null, connected = false, lastEvent = 0;
  const client = {
    state: null, metrics: null, connected: false,
    async api(path, { method = 'GET', body, signal } = {}) {
      const response = await fetch(path, { method, signal, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
      if (!response.ok) throw Object.assign(new Error(data?.error || response.statusText), { status: response.status, data });
      return data;
    },
    on(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
      return () => listeners.get(type)?.delete(callback);
    },
    async connect() { await refresh(); open(); return client; },
    close() { clearTimeout(retry); source?.close(); source = null; },
  };
  const emit = (type, data) => { for (const cb of listeners.get(type) || []) { try { cb(data); } catch (error) { console.error(error); } } };
  const setConnected = value => { if (value !== connected) { connected = client.connected = value; emit('connection', { connected: value }); } };
  async function refresh() {
    try { client.state = await client.api('/api/local/state'); setConnected(true); emit('state', client.state); }
    catch { setConnected(false); }
  }
  const TYPES = ['state', 'metrics', 'prompt', 'toast', 'update', 'astra.status'];
  function open() {
    source?.close();
    source = new EventSource(metrics ? '/api/local/events?metrics=1' : '/api/local/events');
    for (const type of TYPES) source.addEventListener(type, event => {
      let data; try { data = JSON.parse(event.data); } catch { return; }
      lastEvent = Date.now();
      if (type === 'state') { client.state = data; if (applyTheme && data.theme) document.documentElement.dataset.obTheme = data.theme; }
      if (type === 'metrics') client.metrics = data;
      setConnected(true);
      emit(type, data);
    });
    source.onopen = () => { setConnected(true); };
    source.onerror = () => {
      setConnected(false);
      if (source.readyState === EventSource.CLOSED) { clearTimeout(retry); retry = setTimeout(() => refresh().then(open), 3000); }
    };
  }
  // Watchdog: a proxy may keep a dead stream open; verify with a plain request after silence.
  setInterval(() => { if (source && Date.now() - lastEvent > 30000) { lastEvent = Date.now(); refresh(); } }, 10000);
  return client;
}
