// Runtime helper for built-in OpenBoard apps (ES module).
//   import { openboard } from '/ui/app.js';
//   const ob = await openboard.connect();
//   ob.on('state', s => …); ob.on('astra.card', d => …);
//   await ob.api('/api/local/astra/message', { method: 'POST', body: {...} });
// It keeps <html data-ob-theme> in sync with the system theme.
const listeners = new Map();
let state = null, source = null;

function emit(type, data) {
  for (const callback of listeners.get(type) || []) { try { callback(data); } catch (error) { console.error(error); } }
  for (const callback of listeners.get('*') || []) { try { callback(type, data); } catch (error) { console.error(error); } }
}

function applyTheme(theme) {
  if (theme && document.documentElement.dataset.obTheme !== theme) document.documentElement.dataset.obTheme = theme;
}

async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(path, {
    method, signal,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw Object.assign(new Error(data?.error || response.statusText), { status: response.status, data });
  return data;
}

// Event types forwarded by the controller. EventSource needs explicit names.
const EVENT_TYPES = ['state', 'metrics', 'prompt', 'toast', 'update', 'board.changed',
  'astra.hello', 'astra.card', 'astra.cards', 'astra.say', 'astra.reply', 'astra.alarm', 'astra.command', 'astra.board', 'astra.status'];

function openEvents(metrics) {
  source?.close();
  source = new EventSource(metrics ? '/api/local/events?metrics=1' : '/api/local/events');
  for (const type of EVENT_TYPES) source.addEventListener(type, event => {
    const data = JSON.parse(event.data);
    if (type === 'state') { state = data; applyTheme(data.theme); }
    emit(type, data);
  });
  source.onerror = () => emit('connection', { connected: false });
  source.onopen = () => emit('connection', { connected: true });
}

export const openboard = {
  api,
  get state() { return state; },
  on(type, callback) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(callback);
    return () => listeners.get(type).delete(callback);
  },
  // { metrics: true } additionally streams live metrics (only where shown).
  async connect({ metrics = false } = {}) {
    try { state = await api('/api/local/state'); applyTheme(state.theme); } catch { state = null; }
    openEvents(metrics);
    return this;
  },
};
