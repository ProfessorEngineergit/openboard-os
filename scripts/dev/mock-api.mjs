#!/usr/bin/env node
// OpenBoard mock controller for UI development (no dependencies).
//
//   node scripts/dev/mock-api.mjs [--port 4180] [--quiet]     (or OPENBOARD_PORT=4181)
//   OPENBOARD_CONTROLLER=http://127.0.0.1:4181 node remote/server.mjs   # console against the mock
//
// Serves kiosk/ui and kiosk/apps statically and implements the local HTTP API
// contract from docs/ARCHITECTURE.md with fake but plausible data: changing
// metrics with a 10-minute history, SSE (`state`, `metrics`, `prompt`, `toast`,
// `update`), config GET/PATCH with secret masking, app lifecycle actions,
// performance prompts, logs and an ASTRA glance. Nothing touches the system.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(flag('--port') || process.env.OPENBOARD_PORT || 4180);
const QUIET = args.includes('--quiet');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const kiosk = resolve(repo, 'kiosk');
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, 'localhost:14180', '127.0.0.1:14180']);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'";
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const log = (...parts) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...parts); };
const clone = value => structuredClone(value);
const rand = (min, max) => min + Math.random() * (max - min);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- config
let config = {
  version: 2,
  apps: [
    { id: 'gev', name: 'God’s Eye View', url: 'http://localhost:4173/', icon: 'globe', builtin: false, enabled: true, zoom: 1, residency: 'auto', weight: 'heavy' },
    { id: 'home', name: 'Home Assistant', url: 'http://homeassistant.local:8123/', icon: 'home', builtin: false, enabled: true, zoom: 0.75, residency: 'always', weight: 'standard' },
    { id: 'astra', name: 'Astra', url: 'http://localhost:4180/apps/astra/', icon: 'astra', builtin: true, enabled: true, zoom: 1, residency: 'always', weight: 'light' },
    { id: 'board', name: 'Whiteboard', url: 'http://localhost:4180/apps/board/', icon: 'board', builtin: true, enabled: true, zoom: 1, residency: 'auto', weight: 'standard' },
    { id: 'settings', name: 'Einstellungen', url: 'http://localhost:4180/apps/settings/', icon: 'settings', builtin: true, enabled: true, zoom: 1, residency: 'eco', weight: 'light' },
  ],
  startApp: 'gev',
  appearance: { theme: 'dark', lightFrom: '07:00', darkFrom: '19:30', glass: 'webgl', frost: 0.55, keyboardScale: 1, accent: '#f4f5f8' },
  dock: {
    order: ['gev', 'home', 'astra', 'board', 'settings'],
    autoHideSeconds: 6, indicator: 'touch',
    tiles: [
      { id: 't1', items: [{ id: 'w1', type: 'metric.cpu', options: { style: 'ring' } }, { id: 'w2', type: 'metric.gpu' }, { id: 'w3', type: 'action.sleep' }, { id: 'w4', type: 'action.theme' }] },
      { id: 't2', items: [{ id: 'w5', type: 'info.clock' }] },
    ],
  },
  display: { orientation: 'landscape', sleepMode: 'black', useDdc: true, idleSleepMinutes: 0, schedule: { enabled: false, sleepAt: '23:30', wakeAt: '06:45' } },
  performance: { mode: 'balanced', elevatedCpu: 75, criticalCpu: 92, sustainSeconds: 20, memoryFloorMB: 600, terminate: 'ask', askTimeoutSeconds: 30, askDefault: 'keep', terminateMinIdleMinutes: 20, freezeMinIdleMinutes: 3, prewarm: true, thermalLimitC: 88, gev: { fps: 30, resolutionScale: 0.8 } },
  astra: { url: 'http://astra.local:8088', token: 'astra-display-token', voice: true, briefingOnDisplay: true },
  mqtt: { url: 'mqtt://homeassistant.local:1883', username: 'openboard', password: 'hunter2', discoveryPrefix: 'homeassistant', nodeId: 'openboard' },
  gemini: { key: '', model: 'gemini-3.8-live' },
  board: { paper: 'auto', lowLatency: true, prediction: true },
  updates: { enabled: true, branch: 'main', intervalSeconds: 60, restartBrowser: 'idle' },
};
const SECRET = /^(key|token|password)$/;
function mask(value) {
  if (Array.isArray(value)) return value.map(mask);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET.test(k) && typeof v === 'string' ? { set: v.length > 0 } : mask(v)]));
}
function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (SECRET.test(key)) { if (typeof value === 'string') target[key] = value; continue; } // {set:…} keeps the stored secret
    if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) merge(target[key], value);
    else target[key] = clone(value);
  }
  return target;
}
function validate(next) {
  const tiles = next.dock?.tiles || [];
  if (!Array.isArray(tiles) || tiles.length > 4) throw Object.assign(new Error('Höchstens 4 Kacheln'), { status: 400 });
  for (const tile of tiles) if ((tile.items || []).length > 4) throw Object.assign(new Error('Eine Kachel fasst höchstens 4 Elemente'), { status: 400 });
  if (!Array.isArray(next.apps)) throw Object.assign(new Error('apps muss eine Liste sein'), { status: 400 });
}

// ---------------------------------------------------------------- runtime
const startedAt = Date.now() - 3 * 3600e3 - 17 * 60e3;
const runtime = {
  active: 'gev',
  apps: {
    gev: { lifecycle: 'active', lastActive: Date.now(), cpu: 24, heapMB: 212 },
    home: { lifecycle: 'background', lastActive: Date.now() - 8 * 60e3, cpu: 3, heapMB: 96 },
    astra: { lifecycle: 'background', lastActive: Date.now() - 31 * 60e3, cpu: 1.2, heapMB: 41 },
    board: { lifecycle: 'frozen', lastActive: Date.now() - 64 * 60e3, cpu: 0, heapMB: 58 },
    settings: { lifecycle: 'terminated', lastActive: Date.now() - 5 * 3600e3, cpu: 0, heapMB: 0 },
  },
  display: { asleep: false, since: Date.now() - 2 * 3600e3 },
  system: { volume: 40, muted: false, brightness: 70 },
  pressure: 'normal',
  prompts: [],
  update: { current: 'a1b2c3d', available: false, lastCheck: Date.now() - 42e3, lastResult: 'ok', pendingBrowserRestart: false },
  voice: { listening: false },
  actions: [
    { at: Date.now() - 4 * 60e3, text: 'Whiteboard eingefroren (seit 61 min ungenutzt, Last erhöht)', app: 'board' },
    { at: Date.now() - 52 * 60e3, text: 'Astra vorgewärmt (Wecker um 7:00)', app: 'astra' },
    { at: Date.now() - 3 * 3600e3, text: 'Einstellungen beendet (Residenz „Sparsam“, 2 h ungenutzt)', app: 'settings' },
  ],
  prediction: { id: 'board', share: 0.42 },
};
const logs = { controller: [], update: [] };
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const logLine = (kind, text) => { logs[kind].push(`${stamp()} ${text}`); if (logs[kind].length > 500) logs[kind].shift(); };
for (const line of ['openboard-control 2.0.0 gestartet (Port 4180)', 'Konfiguration v2 geladen', 'Browser verbunden (Chrome 141, CDP 127.0.0.1:9222)', 'Shell-Bundle 7f3c2e1 injiziert in 5 Seiten', 'MQTT verbunden mit mqtt://homeassistant.local:1883', 'ASTRA verbunden (2.4.1)', 'Leistung: Druckstufe normal', 'Whiteboard „Planung“ kompaktiert (412 Ops)']) logLine('controller', line);
for (const line of ['git fetch origin main', 'HEAD a1b2c3d = origin/main – kein Update', 'Letzte Prüfung erfolgreich']) logLine('update', line);

function thresholds() {
  const p = config.performance, shift = { eco: -15, balanced: 0, max: 8 }[p.mode] || 0;
  return { elevated: Math.min(99, p.elevatedCpu + shift), critical: Math.min(100, p.criticalCpu + shift), terminate: p.mode === 'max' ? 'never' : p.terminate };
}
function managerAction(text, app) {
  if (booting) return; runtime.actions.unshift({ at: Date.now(), text, app }); runtime.actions.length = Math.min(runtime.actions.length, 30); logLine('controller', `Leistung: ${text}`); }
function appRuntime(id) { return runtime.apps[id] ||= { lifecycle: 'terminated', lastActive: 0, cpu: 0, heapMB: 0 }; }
function effectiveTheme() {
  const a = config.appearance;
  if (a.theme !== 'auto') return a.theme;
  const now = new Date(), minutes = now.getHours() * 60 + now.getMinutes();
  const toMin = t => { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + m; };
  const light = toMin(a.lightFrom), dark = toMin(a.darkFrom);
  return minutes >= light && minutes < dark ? 'light' : 'dark';
}
function state() {
  return {
    version: runtime.update.current, connected: true, active: runtime.active, theme: effectiveTheme(), startedAt,
    display: { ...clone(runtime.display), orientation: config.display.orientation },
    apps: config.apps.map(app => ({ id: app.id, name: app.name, icon: app.icon, url: app.url, enabled: app.enabled !== false, builtin: !!app.builtin, custom: !!app.custom, residency: app.residency, ...appRuntime(app.id) })),
    dock: clone(config.dock), appearance: clone(config.appearance),
    pressure: runtime.pressure,
    astra: { configured: !!config.astra.url, connected: !!config.astra.url && !!config.astra.token },
    mqtt: { configured: !!config.mqtt.url, connected: !!config.mqtt.url },
    update: clone(runtime.update),
    voice: { gemini: !!config.gemini.key, listening: runtime.voice.listening },
    system: clone(runtime.system),
    performance: { mode: config.performance.mode, pressure: runtime.pressure, prompts: clone(runtime.prompts), actions: clone(runtime.actions), prediction: runtime.prediction, thresholds: thresholds(), thermalThrottled: last.temp > config.performance.thermalLimitC },
  };
}

// ---------------------------------------------------------------- metrics
const HISTORY = 300;
const history = { cpu: [], gpu: [], ram: [], temp: [], net: [] };
let last = { cpu: 28, gpu: 35, ram: 54, temp: 58, rx: 120, tx: 18 };
function step() {
  const spike = Math.random() < 0.04 ? rand(20, 45) : 0;
  last.cpu = clamp(last.cpu + rand(-6, 6) + spike - (last.cpu - 30) * 0.12, 4, 99);
  last.gpu = clamp(last.gpu + rand(-5, 5) - (last.gpu - 38) * 0.1 + spike * 0.5, 2, 99);
  last.ram = clamp(last.ram + rand(-0.6, 0.7) - (last.ram - 55) * 0.02, 30, 95);
  last.temp = clamp(last.temp + rand(-1, 1) + (last.cpu - 30) * 0.03 - (last.temp - 58) * 0.08, 38, 92);
  last.rx = clamp(last.rx + rand(-60, 60) - (last.rx - 140) * 0.15 + (Math.random() < 0.05 ? rand(400, 2200) : 0), 2, 6000);
  last.tx = clamp(last.tx + rand(-8, 8) - (last.tx - 20) * 0.2, 1, 900);
  for (const [key, value] of [['cpu', last.cpu], ['gpu', last.gpu], ['ram', last.ram], ['temp', last.temp], ['net', last.rx]]) {
    history[key].push(Math.round(value * 10) / 10);
    if (history[key].length > HISTORY) history[key].shift();
  }
  for (const [id, app] of Object.entries(runtime.apps)) {
    if (app.lifecycle === 'active') { app.cpu = clamp((id === 'gev' ? 22 : 6) + rand(-5, 8), 0, 90); app.heapMB = clamp(app.heapMB + rand(-3, 3), 20, 900); }
    else if (app.lifecycle === 'background') { app.cpu = clamp(app.cpu * 0.6 + rand(0, 3), 0, 40); app.heapMB = clamp(app.heapMB + rand(-1, 1), 20, 900); }
    else if (app.lifecycle === 'frozen') app.cpu = 0;
    else if (app.lifecycle === 'terminated') { app.cpu = 0; app.heapMB = 0; }
  }
  const pressure = last.cpu > config.performance.criticalCpu ? 'critical' : last.cpu > config.performance.elevatedCpu ? 'elevated' : 'normal';
  if (pressure !== runtime.pressure) {
    if (pressure !== 'normal' && runtime.pressure === 'normal') managerAction(`Druckstufe ${pressure === 'critical' ? 'kritisch' : 'erhöht'} (CPU ${Math.round(last.cpu)} %)`, null);
    runtime.pressure = pressure; if (!booting) broadcastState();
  }
}
let booting = true;
for (let i = 0; i < HISTORY; i++) step();
booting = false; runtime.pressure = 'normal';
function metrics(withHistory) {
  const totalMB = 15872, usedMB = Math.round(totalMB * last.ram / 100);
  const data = {
    t: Date.now(),
    cpu: { pct: Math.round(last.cpu * 10) / 10 },
    gpu: { pct: Math.round(last.gpu * 10) / 10, freqMHz: Math.round(350 + last.gpu * 8.5), maxMHz: 1150, source: 'busy' },
    ram: { usedMB, totalMB, pct: Math.round(last.ram * 10) / 10 },
    temp: { c: Math.round(last.temp * 10) / 10 },
    net: { rxKBs: Math.round(last.rx), txKBs: Math.round(last.tx) },
    disk: { pct: 47, freeGB: 118.4 },
    apps: Object.entries(runtime.apps).filter(([id]) => config.apps.some(a => a.id === id)).map(([id, a]) => ({ id, cpu: Math.round(a.cpu * 10) / 10, heapMB: Math.round(a.heapMB), lifecycle: a.lifecycle })),
    pressure: runtime.pressure,
  };
  if (withHistory) data.history = clone(history);
  return data;
}

// ---------------------------------------------------------------- SSE
const clients = new Set();   // { res, metrics }
function broadcast(type, data) { for (const client of clients) if (type !== 'metrics' || client.metrics) client.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); }
let stateTimer = null;
function broadcastState() { clearTimeout(stateTimer); stateTimer = setTimeout(() => broadcast('state', state()), 30); }
function toast(text, kind = 'info') { broadcast('toast', { text, kind }); }
setInterval(() => { step(); broadcast('metrics', metrics(false)); }, 2000);
setInterval(() => broadcastState(), 10000); // periodic state like a real controller (CPU/heap per app)

let promptSeq = 0;
function addPrompt() {
  const candidate = config.apps.find(a => a.id === 'gev' && runtime.active !== 'gev') || config.apps.find(a => a.id !== runtime.active && appRuntime(a.id).lifecycle === 'background') || config.apps[0];
  const prompt = { id: 'p' + (++promptSeq), app: candidate.id, text: `${candidate.name} verbraucht 38 % CPU und ist seit 22 min ungenutzt. Beenden?`, choices: [{ id: 'terminate', label: 'Beenden' }, { id: 'keep', label: 'Behalten' }, { id: 'always', label: 'Immer erlauben' }], expiresAt: Date.now() + config.performance.askTimeoutSeconds * 1000 };
  runtime.prompts.push(prompt);
  broadcast('prompt', prompt);
  broadcastState();
}
setTimeout(addPrompt, 1500);
setInterval(() => { if (!runtime.prompts.length) addPrompt(); }, 120000);

// ---------------------------------------------------------------- HTTP
const send = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const sameOrigin = req => {
  const host = req.headers.host, origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  return HOSTS.has(host) && (!origin || origin === `http://${host}`) && (!site || site === 'same-origin' || site === 'none');
};
async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) { length += chunk.length; if (length > 256 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 }); chunks.push(chunk); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}
async function serveStatic(req, res, base, relative) {
  const root = resolve(base);
  let file = resolve(root, decodeURIComponent(relative));
  if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'Invalid path' });
  try {
    if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': CSP });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { send(res, 404, { error: 'Not found' }); }
}
let catalogCache;
function catalog() {
  if (catalogCache) return catalogCache;
  const context = vm.createContext({});
  vm.runInContext(readFileSync(resolve(kiosk, 'ui/icons.js'), 'utf8') + '\n' + readFileSync(resolve(kiosk, 'ui/widgets.js'), 'utf8') + '\nthis.__catalog = OBWidgets.catalog;', context);
  return (catalogCache = JSON.parse(JSON.stringify(context.__catalog)));
}
const slug = text => String(text || 'app').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'app';

async function api(req, res, url) {
  const path = url.pathname, method = req.method;
  let m;
  if (method === 'GET' && path === '/api/local/state') return send(res, 200, state());
  if (method === 'GET' && path === '/api/local/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    // Metrics only for clients that ask for them (?metrics=1), like the real controller.
    const client = { res, metrics: url.searchParams.get('metrics') === '1' };
    clients.add(client);
    req.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
    return;
  }
  if (method === 'GET' && path === '/api/local/config') return send(res, 200, mask(config));
  if (method === 'PATCH' && path === '/api/local/config') {
    const patch = await body(req);
    const next = merge(clone(config), patch);
    validate(next);
    config = next;
    logLine('controller', `Konfiguration geändert: ${Object.keys(patch).join(', ')}`);
    broadcastState();
    return send(res, 200, mask(config));
  }
  if (method === 'POST' && (m = path.match(/^\/api\/local\/config\/test\/(astra|mqtt|gemini)$/))) {
    await sleep(700);
    const target = m[1];
    if (target === 'astra') return send(res, 200, config.astra.url ? (config.astra.token ? { ok: true, detail: 'ASTRA 2.4.1 · message, glance, tts, events' } : { ok: false, detail: 'Token fehlt (401 von ASTRA)' }) : { ok: false, detail: 'Keine URL eingetragen' });
    if (target === 'mqtt') return send(res, 200, config.mqtt.url ? { ok: true, detail: `Verbunden mit ${config.mqtt.url} · 14 Entitäten veröffentlicht` } : { ok: false, detail: 'Keine Broker-URL eingetragen' });
    return send(res, 200, config.gemini.key ? { ok: true, detail: `Modell ${config.gemini.model} erreichbar` } : { ok: false, detail: 'Kein API-Key gespeichert' });
  }
  if (method === 'GET' && path === '/api/local/widgets/catalog') return send(res, 200, { catalog: catalog() });
  if (method === 'GET' && path === '/api/local/metrics') return send(res, 200, metrics(url.searchParams.get('history') === '1'));
  if (method === 'GET' && path === '/api/local/logs') return send(res, 200, clone(logs));
  if (method === 'GET' && path === '/api/local/astra/glance') {
    const at = h => { const d = new Date(); d.setHours(d.getHours() + h, 0, 0, 0); return d.toISOString(); };
    return send(res, 200, { generated_at: new Date().toISOString(), greeting: 'Guten Tag', weather: { location: 'Frankfurt', updated: new Date().toISOString(), now: { temp: 14.6, feels_like: 13, condition: 'partly', is_day: true, description: 'Leicht bewölkt', humidity: 62, wind_kmh: 11, high: 17, low: 9 }, hourly: [], daily: [] }, calendar: { events: [{ title: 'Team-Standup', start: at(1), end: at(2), all_day: false }] }, briefing: null, alarms: [] });
  }
  if (method === 'POST' && path === '/api/local/apps') {
    const input = await body(req);
    if (!input.name || !/^https?:\/\//.test(input.url || '')) return send(res, 400, { error: 'Name und http(s)-URL erforderlich' });
    let id = slug(input.name); while (config.apps.some(a => a.id === id)) id += '-2';
    const app = { id, name: String(input.name).slice(0, 60), url: input.url, icon: input.icon || 'web', builtin: false, custom: true, enabled: true, zoom: 1, residency: 'auto', weight: 'standard' };
    config.apps.push(app); config.dock.order.push(id);
    runtime.apps[id] = { lifecycle: 'terminated', lastActive: 0, cpu: 0, heapMB: 0 };
    logLine('controller', `App angelegt: ${id} (${app.url})`);
    broadcastState();
    return send(res, 200, app);
  }
  if (method === 'DELETE' && (m = path.match(/^\/api\/local\/apps\/([^/]+)$/))) {
    const app = config.apps.find(a => a.id === m[1]);
    if (!app) return send(res, 404, { error: 'Unbekannte App' });
    if (!app.custom) return send(res, 409, { error: 'Nur eigene Web-Apps können entfernt werden' });
    config.apps = config.apps.filter(a => a.id !== app.id);
    config.dock.order = config.dock.order.filter(id => id !== app.id);
    delete runtime.apps[app.id];
    if (runtime.active === app.id) runtime.active = config.apps[0]?.id;
    logLine('controller', `App entfernt: ${app.id}`);
    broadcastState();
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && (m = path.match(/^\/api\/local\/apps\/([^/]+)\/(activate|reload|suspend|resume|terminate)$/))) {
    const [, id, action] = m;
    if (!config.apps.some(a => a.id === id)) return send(res, 404, { error: 'Unbekannte App' });
    const app = appRuntime(id);
    if (action === 'activate') {
      appRuntime(runtime.active).lifecycle = 'background';
      runtime.active = id; app.lifecycle = app.lifecycle === 'terminated' ? 'loading' : 'active'; app.lastActive = Date.now();
      if (app.lifecycle === 'loading') { app.heapMB = 60; setTimeout(() => { app.lifecycle = runtime.active === id ? 'active' : 'background'; broadcastState(); }, 1500); }
    } else if (action === 'reload') {
      app.lifecycle = 'loading'; setTimeout(() => { app.lifecycle = runtime.active === id ? 'active' : 'background'; broadcastState(); }, 1500);
    } else if (action === 'suspend') {
      if (runtime.active === id) return send(res, 409, { error: 'Die aktive App kann nicht pausiert werden' });
      app.lifecycle = 'frozen';
    } else if (action === 'resume') {
      app.lifecycle = runtime.active === id ? 'active' : 'background';
    } else if (action === 'terminate') {
      if (runtime.active === id) return send(res, 409, { error: 'Die aktive App kann nicht beendet werden' });
      app.lifecycle = 'terminated'; app.cpu = 0; app.heapMB = 0;
    }
    logLine('controller', `App ${id}: ${action}`);
    broadcastState();
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && (m = path.match(/^\/api\/local\/display\/(sleep|wake)$/))) {
    runtime.display = { asleep: m[1] === 'sleep', since: Date.now() };
    logLine('controller', m[1] === 'sleep' ? `Ruhezustand (${config.display.sleepMode})` : 'Aufgewacht');
    broadcastState();
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && (m = path.match(/^\/api\/local\/prompt\/([^/]+)$/))) {
    const { choice } = await body(req);
    const prompt = runtime.prompts.find(p => p.id === m[1]);
    if (!prompt) return send(res, 404, { error: 'Rückfrage nicht mehr offen' });
    runtime.prompts = runtime.prompts.filter(p => p !== prompt);
    if (choice === 'terminate' || choice === 'always') { const app = appRuntime(prompt.app); app.lifecycle = 'terminated'; app.cpu = 0; app.heapMB = 0; }
    if (choice === 'always') config.performance.terminate = 'auto';
    managerAction(choice === 'keep' ? `${prompt.app} behalten (Antwort aus Rückfrage)` : `${prompt.app} beendet (Antwort aus Rückfrage)`, prompt.app);
    logLine('controller', `Rückfrage ${prompt.id}: ${choice}`);
    toast(choice === 'keep' ? 'App bleibt geöffnet' : 'App beendet');
    broadcastState();
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && (m = path.match(/^\/api\/local\/system\/([a-z-]+)$/))) {
    const action = m[1], input = await body(req);
    if (action === 'volume') { if ('muted' in input) runtime.system.muted = !!input.muted; if (Number.isFinite(input.value)) runtime.system.volume = clamp(Math.round(input.value), 0, 100); }
    else if (action === 'brightness') { if (Number.isFinite(input.value)) runtime.system.brightness = clamp(Math.round(input.value), 0, 100); }
    else if (action === 'update-check') {
      logLine('update', 'git fetch origin ' + config.updates.branch);
      await sleep(900);
      runtime.update.lastCheck = Date.now(); runtime.update.lastResult = 'ok';
      logLine('update', `HEAD ${runtime.update.current} = origin/${config.updates.branch} – kein Update`);
      broadcast('update', clone(runtime.update));
    } else if (['restart-browser', 'restart-controller', 'exit-kiosk'].includes(action)) {
      logLine('controller', `Systemaktion: ${action} (Mock – keine Wirkung)`);
      toast(`${action} ausgelöst (Mock)`);
    } else return send(res, 404, { error: 'Unbekannte Aktion' });
    broadcastState();
    return send(res, 200, { ok: true, system: runtime.system });
  }
  return send(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (!HOSTS.has(req.headers.host)) return send(res, 403, { error: 'Invalid host' });
    if (url.pathname === '/health') return send(res, 200, { ok: true, browser: true, version: runtime.update.current, mock: true });
    if (url.pathname.startsWith('/api/local/')) {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Same-origin required' });
      log(req.method, url.pathname + url.search);
      return await api(req, res, url);
    }
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, { error: 'Method not allowed' });
    if (url.pathname === '/settings') { res.writeHead(302, { location: '/apps/settings/' }); return res.end(); }
    if (url.pathname.startsWith('/ui/')) return await serveStatic(req, res, resolve(kiosk, 'ui'), url.pathname.slice(4));
    let m = url.pathname.match(/^\/apps\/([a-z0-9-]+)$/);
    if (m) { res.writeHead(302, { location: `/apps/${m[1]}/` }); return res.end(); }
    m = url.pathname.match(/^\/apps\/([a-z0-9-]+)\/(.*)$/);
    if (m) return await serveStatic(req, res, resolve(kiosk, 'apps', m[1]), m[2]);
    if (url.pathname === '/') { res.writeHead(302, { location: '/apps/settings/' }); return res.end(); }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    if (!res.headersSent) send(res, error.status || 400, { error: error.message });
    else res.end();
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`OpenBoard mock controller on http://127.0.0.1:${PORT}/ (settings: /apps/settings/)`));
