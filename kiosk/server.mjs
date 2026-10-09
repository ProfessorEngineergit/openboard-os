// OpenBoard controller: wires apps, shell, performance manager, ASTRA, MQTT,
// voice and the local API together. Listens on 127.0.0.1:4180 only.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRouter, openStream, HttpError, PORT } from './lib/router.mjs';
import { serveDirectory } from './lib/static.mjs';
import { ConfigStore, effectiveTheme, redact, validateUrl, ORIENTATIONS } from './lib/config.mjs';
import { Metrics } from './lib/metrics.mjs';
import { SystemControl } from './lib/system.mjs';
import { Updates } from './lib/updates.mjs';
import { buildShell } from './lib/shell-bundle.mjs';
import { AppManager } from './lib/apps.mjs';
import { PerformanceManager } from './lib/lifecycle.mjs';
import { AstraBridge } from './lib/astra.mjs';
import { GeminiVoice, loadGevTools } from './lib/gemini.mjs';
import { MqttBridge } from './lib/mqtt.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const base = resolve(root, '..');
const dataDir = process.env.OPENBOARD_DATA_DIR || resolve(root, 'data');
await mkdir(dataDir, { recursive: true, mode: 0o700 });

// ---------- Logging (ring buffer for the console) ----------
const logLines = [];
const log = message => {
  const line = `${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${message}`;
  logLines.push(line); if (logLines.length > 500) logLines.shift();
  console.log(message);
};

// ---------- Core services ----------
const store = new ConfigStore(process.env.OPENBOARD_CONFIG || resolve(root, 'config.json'));
await store.load();
const config = () => store.get();
const tokenPath = process.env.OPENBOARD_TOKEN_FILE || resolve(root, 'api-token');
let token;
try { token = (await readFile(tokenPath, 'utf8')).trim(); } catch {
  token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token, { mode: 0o600 });
}
const updates = await new Updates({ base, dataDir }).init();
const metrics = new Metrics();
await metrics.start();
const system = new SystemControl({ base });
let shell = await buildShell(root);
const gevTools = await loadGevTools();
const catalog = (() => {
  const read = name => readFile(resolve(root, 'ui', name), 'utf8');
  return Promise.all([read('icons.js'), read('widgets.js')]).then(([icons, widgets]) => {
    const context = vm.createContext({});
    vm.runInContext(`${icons}\n${widgets}\nthis.result = OBWidgets.catalog.map(({ type, kind, category, name, icon, description, options }) => ({ type, kind, category, name, icon, description, options }));`, context);
    return context.result;
  });
})();

// ---------- Local event stream (built-in apps and the remote console) ----------
const streams = new Set();
const broadcast = (type, data, { metricsOnly = false } = {}) => {
  for (const stream of streams) if (!metricsOnly || stream.metrics) stream.send(type, data);
};

// ---------- Display state ----------
const display = { asleep: false, since: Date.now(), lastActivity: Date.now(), savedBrightness: null };
let updateStatus = await updates.status();

const apps = new AppManager({
  config, log,
  shell: () => shell,
  onBridge: (id, message, page) => onBridge(id, message, page),
});

const perf = new PerformanceManager({
  apps, metrics, config, log,
  patchConfig: patch => store.patch(patch),
  usageFile: resolve(dataDir, 'usage.json'),
  isAsleep: () => display.asleep,
  protectedApps: () => new Set(gemini.active ? ['gev'] : []),
});

const astra = new AstraBridge({ config, log });
const gemini = new GeminiVoice({
  config, tools: gevTools, log,
  hooks: {
    apps: () => config().apps.filter(app => app.enabled),
    astraAvailable: () => astra.configured,
    activate: id => activate(id),
    sleep: () => sleep(),
    askAstra: async text => {
      const result = await astra.message({ session_id: 'display-main', text, speak: false, context: context() });
      broadcast('astra.reply', result);
      return result.reply;
    },
    runTool: (name, args) => runGevTool(name, args),
    send: (page, event) => page.evaluate(value => window.__openboard?.event(value), event).catch(() => {}),
  },
});

const mqtt = new MqttBridge({
  config, log,
  handlers: {
    screen: on => on ? wake() : sleep(),
    app: name => { const app = config().apps.find(entry => entry.name === name || entry.id === name); if (app) return activate(app.id); },
    performance: mode => ['eco', 'balanced', 'max'].includes(mode) && store.patch({ performance: { mode } }),
    theme: theme => ['dark', 'light', 'auto'].includes(theme) && store.patch({ appearance: { theme } }),
    orientation: value => ORIENTATIONS.includes(value) && store.patch({ display: { orientation: value } }),
    say: text => speak(text),
    reload: () => apps.active && apps.reload(apps.active),
    restartBrowser: () => system.service('restart', 'openboard-browser.service'),
  },
});
mqtt.on('values', () => { void pushShellMetrics(); });

// ---------- State ----------
const context = () => ({ active_app: apps.active, locale: 'de-DE', theme: effectiveTheme(config().appearance) });
function state() {
  const c = config();
  return {
    version: updates.version, connected: apps.connected, active: apps.active,
    theme: effectiveTheme(c.appearance), appearance: c.appearance, dock: c.dock, startApp: c.startApp,
    display: { asleep: display.asleep, since: display.since, mode: c.display.sleepMode, orientation: c.display.orientation },
    apps: apps.snapshot(),
    pressure: perf.pressure.level,
    performance: perf.state(),
    astra: astra.status(), mqtt: mqtt.status(), update: updateStatus,
    voice: { gemini: !!c.gemini.key, listening: gemini.active },
    system: { volume: system.audio?.volume ?? null, muted: system.audio?.muted ?? null, brightness: system.brightness },
  };
}
let publishTimer = null;
function publish() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    const next = state();
    void apps.publish(next);
    broadcast('state', next);
    mqtt.publishState(mqttContext());
  }, 60);
}
const mqttContext = () => ({
  asleep: display.asleep, appName: config().apps.find(app => app.id === apps.active)?.name, performance: config().performance.mode,
  theme: config().appearance.theme, orientation: config().display.orientation, metrics: metrics.latest, pressure: perf.pressure.level, lastTouch: display.lastActivity,
  version: updates.version, astra: astra.connected, updateAvailable: updateStatus.available, apps: config().apps.filter(app => app.enabled),
});

// Shell pages that show the dock receive metrics; nobody watching means no work.
const shellMetricPages = new Map(); // page → release()
async function pushShellMetrics() {
  if (!shellMetricPages.size) return;
  const payload = { type: 'metrics', metrics: metrics.snapshot(), glance: astra.cachedGlance(), mqtt: mqtt.values };
  await Promise.allSettled([...shellMetricPages.keys()].map(page => page.isClosed() ? null : page.evaluate(value => window.__openboard?.event(value), payload)));
}
metrics.on('sample', sample => {
  void pushShellMetrics();
  void sample;
  broadcast('metrics', { ...metrics.snapshot(), apps: apps.snapshot().map(({ id, cpu, heapMB, lifecycle }) => ({ id, cpu, heapMB, lifecycle })), pressure: perf.pressure.level }, { metricsOnly: true });
  mqtt.publishState(mqttContext());
});

// ---------- Actions ----------
async function activate(id) {
  if (display.asleep) await wake();
  if (id !== apps.active) await gemini.stop();
  const result = await apps.activate(id);
  publish();
  return result;
}

async function sleep() {
  if (display.asleep) return { ok: true, asleep: true };
  const c = config().display;
  display.asleep = true; display.since = Date.now();
  await gemini.stop();
  publish();
  if (c.useDdc && c.sleepMode === 'black') {
    display.savedBrightness = await system.readBrightness().catch(() => null);
    if (display.savedBrightness != null) await system.setBrightness({ value: 0 }).catch(() => {});
  }
  await system.screen(false, c.sleepMode);
  log('Ruhezustand');
  return { ok: true, asleep: true };
}

async function wake() {
  if (!display.asleep) return { ok: true, asleep: false };
  const c = config().display;
  display.asleep = false; display.since = Date.now(); display.lastActivity = Date.now();
  await system.screen(true, c.sleepMode);
  if (display.savedBrightness != null) { await system.setBrightness({ value: display.savedBrightness }).catch(() => {}); display.savedBrightness = null; }
  if (apps.active && apps.rt(apps.active).lifecycle === 'frozen') await apps.resume(apps.active);
  publish();
  log('Aufgeweckt');
  return { ok: true, asleep: false };
}

async function runGevTool(name, args = {}) {
  if (!gevTools.some(tool => tool.name === name)) throw new Error('Unbekannter GEV-Befehl');
  const page = apps.pages.get('gev');
  if (!page || page.isClosed()) throw new Error('God’s Eye View ist nicht geöffnet');
  if (apps.rt('gev').lifecycle === 'frozen') await apps.resume('gev');
  return page.evaluate(async ({ name, args }) => {
    const runner = window.__godsEyeView?.voiceCommands?.runner;
    if (!runner) throw new Error('God’s Eye View lädt noch');
    return runner(name, args);
  }, { name, args });
}

async function speak(text) {
  const clean = String(text || '').trim().slice(0, 1000);
  if (!clean) return { ok: false };
  if (display.asleep) await wake();
  let speech = null;
  if (astra.configured) speech = await astra.tts(clean).catch(() => null);
  broadcast('astra.say', { text: clean, speech });
  void apps.event({ type: 'toast', text: clean, icon: 'astra' }, { only: apps.active ? [apps.active] : undefined });
  return { ok: true, spoken: !!speech };
}

async function boardOperation(op) {
  if (!op || typeof op.op !== 'string') throw new HttpError(400, 'Ungültige Board-Operation');
  const page = await apps.ensurePage('board');
  if (apps.rt('board').lifecycle === 'frozen') await apps.resume('board');
  await page.waitForFunction(() => !!window.__openboardBoard, { timeout: 20000 });
  const result = await page.evaluate(value => window.__openboardBoard.apply(value), op);
  await activate('board');
  return result ?? { ok: true };
}

const nextIn = (list, value) => list[(list.indexOf(value) + 1) % list.length];
async function runWidget(item, step) {
  const options = item.options || {};
  switch (item.type) {
    case 'action.sleep': await sleep(); return {};
    case 'action.theme': await store.patch({ appearance: { theme: nextIn(['dark', 'light', 'auto'], config().appearance.theme) } }); return {};
    case 'action.performance': {
      const mode = nextIn(['eco', 'balanced', 'max'], config().performance.mode);
      await store.patch({ performance: { mode } });
      return { toast: { eco: 'Leistung: Eco – Apps im Hintergrund werden früher pausiert', balanced: 'Leistung: Ausgewogen', max: 'Leistung: Maximal – nichts wird beendet' }[mode], icon: 'bolt' };
    }
    case 'action.orientation': {
      const orientation = config().display.orientation.startsWith('landscape') ? 'portrait' : 'landscape';
      await store.patch({ display: { orientation } });
      return { toast: orientation === 'portrait' ? 'Hochformat' : 'Querformat', icon: 'rotate' };
    }
    case 'action.reload': if (apps.active) await apps.reload(apps.active); return {};
    case 'action.app': await activate(options.app); return {};
    case 'action.volume': {
      const audio = step ? await system.setVolume({ step: step * (Number(options.step) || 10) }) : await system.setVolume({ toggleMute: true });
      publish(); return { toast: audio.muted ? 'Ton aus' : `Lautstärke ${audio.volume} %`, icon: audio.muted ? 'volume-off' : 'volume' };
    }
    case 'action.brightness': {
      const current = system.brightness ?? await system.readBrightness();
      const value = step ? await system.setBrightness({ step: step * (Number(options.step) || 10) }) : await system.setBrightness({ value: current >= 90 ? 60 : current >= 50 ? 30 : 100 });
      publish(); return { toast: `Helligkeit ${value} %`, icon: 'brightness' };
    }
    case 'action.mqtt': mqtt.trigger(options.name || item.id, options.payload); return { toast: `Ausgelöst: ${options.label || options.name}`, icon: 'mqtt' };
    case 'action.webhook': {
      validateUrl(options.url, 'Webhook');
      if (!/^https?:/.test(options.url)) throw new Error('Webhook: nur http(s)');
      const method = ['GET', 'POST', 'PUT'].includes(options.method) ? options.method : 'POST';
      const response = await fetch(options.url, { method, signal: AbortSignal.timeout(10000), headers: options.body ? { 'content-type': 'application/json' } : undefined, body: method === 'GET' ? undefined : options.body || undefined });
      return { toast: `${options.label || 'Webhook'}: ${response.ok ? 'OK' : `HTTP ${response.status}`}`, icon: response.ok ? 'check' : 'warning' };
    }
    case 'action.astra': {
      await activate('astra');
      const result = await astra.message({ session_id: 'display-main', text: String(options.prompt || ''), speak: !!config().astra.voice, context: context() });
      broadcast('astra.reply', result);
      return {};
    }
    default: throw new Error('Dieses Widget hat keine Aktion');
  }
}

// Restricted config changes from inside app pages (dock editor, quick toggles).
function checkShellPatch(patch) {
  const allowed = { dock: ['tiles', 'order'], appearance: ['theme', 'keyboardScale'], performance: ['mode'] };
  for (const [section, value] of Object.entries(patch || {})) {
    if (!allowed[section] || typeof value !== 'object') throw new Error('Nicht erlaubt');
    for (const key of Object.keys(value)) if (!allowed[section].includes(key)) throw new Error('Nicht erlaubt');
  }
}

async function onBridge(id, message, page) {
  const isPopup = !id || id.startsWith('popup:');
  switch (message.action) {
    case 'ready': await apps.pushState(page, state()); return { ok: true };
    case 'activity': display.lastActivity = Date.now(); return null;
    case 'activate': await activate(message.id); return { ok: true };
    case 'metrics-subscribe':
      if (message.on && !shellMetricPages.has(page)) { shellMetricPages.set(page, metrics.watch()); void system.readAudio().then(publish); void pushShellMetrics(); if (astra.configured && !astra.cachedGlance()) void astra.glance().catch(() => {}); }
      if (!message.on && shellMetricPages.has(page)) { shellMetricPages.get(page)(); shellMetricPages.delete(page); }
      return null;
    case 'display': return message.value === 'sleep' ? sleep() : wake();
    case 'config-patch': checkShellPatch(message.patch); await store.patch(message.patch); return { ok: true };
    case 'app-action': return appAction(message.id, message.op);
    case 'app-residency': {
      if (!['always', 'auto', 'eco'].includes(message.residency)) throw new Error('Ungültig');
      await store.patch({ apps: config().apps.map(app => app.id === message.id ? { ...app, residency: message.residency } : app) });
      return { ok: true };
    }
    case 'widget': return runWidget(message.item, Number(message.step) || 0).catch(error => ({ error: error.message }));
    case 'prompt': perf.answer(message.id, message.choice); return { ok: true };
    case 'key':
      if (typeof message.text === 'string' && message.text.length <= 8) await page.keyboard.type(message.text);
      else if (['Backspace', 'Enter', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape'].includes(message.key)) await page.keyboard.press(message.key);
      return null;
    case 'voice-start': if (id === 'gev' && apps.active === 'gev' && !isPopup) await gemini.start(page); return null;
    case 'voice-stop': await gemini.stop(); return null;
    case 'voice-audio': gemini.audio(page, message.data); return null;
    default: return null;
  }
}

async function appAction(id, action) {
  if (!config().apps.some(app => app.id === id)) throw new HttpError(404, 'Unbekannte App');
  if (action === 'reload') await apps.reload(id);
  else if (action === 'suspend') { if (!await apps.freeze(id)) throw new HttpError(409, 'Nur Hintergrund-Apps lassen sich pausieren (Chrome)'); }
  else if (action === 'resume') await apps.resume(id);
  else if (action === 'terminate') await apps.terminate(id);
  else throw new HttpError(400, 'Unbekannte Aktion');
  publish();
  return { ok: true };
}

// ---------- Event wiring ----------
store.on('change', (next, previous) => {
  if (JSON.stringify(next.astra) !== JSON.stringify(previous.astra)) astra.restart();
  if (JSON.stringify(next.mqtt) !== JSON.stringify(previous.mqtt)) mqtt.connect(mqttContext);
  else if (JSON.stringify(next.dock) !== JSON.stringify(previous.dock) || JSON.stringify(next.apps) !== JSON.stringify(previous.apps)) { mqtt.publishDiscovery(mqttContext()); mqtt.syncValueTopics(); }
  if (next.display.orientation !== previous.display.orientation) system.setOrientation(next.display.orientation).then(() => log(`Ausrichtung: ${next.display.orientation}`), error => { log(error.message); void apps.event({ type: 'toast', text: error.message, icon: 'warning' }); });
  if (JSON.stringify(next.performance.gev) !== JSON.stringify(previous.performance.gev) && !perf.thermalThrottled) void apps.setGevQuality(next.performance.gev.fps, next.performance.gev.resolutionScale);
  // App URL changes reopen that app; removed or disabled apps close.
  for (const app of previous.apps) {
    const now = next.apps.find(entry => entry.id === app.id);
    if ((!now || !now.enabled || now.url !== app.url || now.zoom !== app.zoom) && apps.pages.has(app.id) && apps.active !== app.id) void apps.terminate(app.id).catch(() => {});
  }
  publish();
});
apps.on('change', publish);
apps.on('toast', toast => void apps.event({ type: 'toast', ...toast }));
apps.on('connected', () => { log(`Browser verbunden (${apps.protocol})`); publish(); });
apps.on('disconnected', () => { log('Browser getrennt'); shellMetricPages.clear(); publish(); });
perf.on('change', publish);
perf.on('prompt', prompt => { broadcast('prompt', prompt); if (display.asleep) void wake(); });
perf.on('toast', toast => void apps.event({ type: 'toast', ...toast }));
astra.on('status', status => { broadcast('astra.status', status); publish(); });
astra.on('event', (type, data) => {
  broadcast(`astra.${type}`, data);
  if (type === 'command') {
    if (data.action === 'sleep') void sleep();
    else if (data.action === 'wake') void wake();
    else if (data.action === 'open_app' && data.app) void activate(data.app).catch(error => log(`ASTRA: ${error.message}`));
  } else if (type === 'alarm') {
    void wake().then(() => activate('astra')).catch(error => log(`Wecker: ${error.message}`));
  } else if (type === 'board') {
    void boardOperation(data).catch(error => log(`ASTRA-Board: ${error.message}`));
  } else if (type === 'say' || type === 'card' || type === 'cards' || type === 'reply') {
    if (apps.active !== 'astra') {
      const text = type === 'say' ? data.text : type === 'reply' ? data.reply : data.card?.title || data.cards?.[0]?.title || 'Neue Inhalte';
      void apps.event({ type: 'toast', text: `ASTRA: ${String(text || '').slice(0, 140)}`, icon: 'astra' }, { only: apps.active ? [apps.active] : undefined });
    }
  }
});

// ---------- HTTP API ----------
const router = createRouter({ token: () => token });
const send404 = ctx => ctx.json(404, { error: 'Not found' });
const redirect = location => ctx => { ctx.res.writeHead(302, { location }); ctx.res.end(); };

router.get('/health', () => ({ ok: true, browser: apps.connected, version: updates.version }), { access: 'public' });
router.get('/ui/:path*', serveDirectory(resolve(root, 'ui'), { cache: 'max-age=300' }), { access: 'public' });
for (const app of ['astra', 'board', 'settings']) router.get(`/apps/${app}`, redirect(`/apps/${app}/`), { access: 'public' });
router.get('/apps/:path*', serveDirectory(resolve(root, 'apps')), { access: 'public' });
router.get('/astra', redirect('/apps/astra/'), { access: 'public' });
router.get('/whiteboard', redirect('/apps/board/'), { access: 'public' });
router.get('/settings', redirect('/apps/settings/'), { access: 'public' });

router.get('/api/local/state', () => state());
router.get('/api/local/events', ctx => {
  const stream = openStream(ctx);
  stream.metrics = ctx.url.searchParams.get('metrics') === '1';
  const release = stream.metrics ? metrics.watch() : null;
  streams.add(stream);
  stream.onClose = () => { streams.delete(stream); release?.(); };
  stream.send('state', state());
  if (stream.metrics) stream.send('metrics', { ...metrics.snapshot(), pressure: perf.pressure.level });
});
router.get('/api/local/config', () => redact(config()));
router.patch('/api/local/config', async ctx => redact(await store.patch(await ctx.body())));
router.post('/api/local/config/test/:target', async ctx => {
  const target = ctx.params.target;
  try {
    if (target === 'astra') return await astra.test();
    if (target === 'mqtt') return await mqtt.test();
    if (target === 'gemini') return await gemini.test();
  } catch (error) { return { ok: false, detail: error.message }; }
  throw new HttpError(404, 'Unbekanntes Ziel');
});
router.get('/api/local/widgets/catalog', async () => ({ catalog: await catalog }));
router.get('/api/local/metrics', ctx => ({ ...metrics.snapshot({ history: ctx.url.searchParams.get('history') === '1' }), apps: apps.snapshot().map(({ id, cpu, heapMB, lifecycle }) => ({ id, cpu, heapMB, lifecycle })), pressure: perf.pressure.level }));
router.post('/api/local/apps/:id/activate', ctx => activate(ctx.params.id));
router.post('/api/local/apps/:id/:action', ctx => appAction(ctx.params.id, ctx.params.action));
router.post('/api/local/apps', async ctx => {
  const { name, url, icon = 'web' } = await ctx.body();
  const base = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'app';
  let id = base, n = 2;
  while (config().apps.some(app => app.id === id)) id = `${base}-${n++}`;
  const app = { id, name: String(name || '').trim().slice(0, 40), url: String(url || ''), icon: String(icon), builtin: false, enabled: true, zoom: 1, residency: 'auto', weight: 'standard' };
  await store.patch({ apps: [...config().apps, app], dock: { order: [...config().dock.order, id] } });
  return app;
});
router.delete('/api/local/apps/:id', async ctx => {
  const id = ctx.params.id;
  if (['gev', 'home', 'astra', 'board', 'settings'].includes(id)) throw new HttpError(400, 'Eingebaute Apps lassen sich nur deaktivieren');
  if (apps.active === id) await activate(config().startApp);
  await store.patch({ apps: config().apps.filter(app => app.id !== id) });
  return { ok: true };
});
router.post('/api/local/display/:action', ctx => ctx.params.action === 'sleep' ? sleep() : ctx.params.action === 'wake' ? wake() : send404(ctx));
router.post('/api/local/prompt/:id', async ctx => { perf.answer(ctx.params.id, (await ctx.body()).choice); return { ok: true }; });
router.post('/api/local/system/:action', async ctx => {
  const action = ctx.params.action, body = await ctx.body().catch(() => ({}));
  if (action === 'restart-browser') { await system.service('restart', 'openboard-browser.service'); return { ok: true }; }
  if (action === 'restart-controller') { setTimeout(() => process.exit(0), 300); return { ok: true }; }
  if (action === 'exit-kiosk') { await system.exitKiosk(); return { ok: true }; }
  if (action === 'update-check') { await updates.check(); return { ok: true }; }
  if (action === 'volume') { const audio = await system.setVolume(body.toggleMute ? { toggleMute: true } : { value: Number(body.value), step: Number(body.step) || 0 }); publish(); return audio; }
  if (action === 'brightness') { const value = await system.setBrightness({ value: Number(body.value), step: Number(body.step) || 0 }); publish(); return { brightness: value }; }
  return send404(ctx);
});
router.get('/api/local/logs', async () => ({ controller: logLines.slice(-300), update: await updates.log(), performance: perf.actions }));

// ASTRA bridge for the Astra app.
router.get('/api/local/astra/hello', () => astra.hello());
router.post('/api/local/astra/message', async ctx => {
  const body = await ctx.body();
  return astra.message({ session_id: String(body.session_id || 'display-main').slice(0, 64), text: body.text, audio: body.audio, speak: !!body.speak, context: { ...context(), ...(body.context || {}) } });
}, { limit: 12 * 1024 * 1024 });
router.get('/api/local/astra/glance', ctx => astra.glance({ refresh: ctx.url.searchParams.get('refresh') === '1' }));
router.post('/api/local/astra/tts', async ctx => astra.tts((await ctx.body()).text));

// Whiteboard storage (module from apps/board).
try {
  const { registerBoardRoutes } = await import('./lib/board-store.mjs');
  await registerBoardRoutes(router, { dataDir: resolve(dataDir, 'boards'), legacyFile: resolve(dataDir, 'whiteboard/current.json'), emit: broadcast });
} catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') log(`Board-Speicher: ${error.message}`); }

// Token API for assistants and scripts (and legacy paths).
const tokenRoutes = (prefix, legacy = false) => {
  router.get(`${prefix}/state`, () => state(), { access: 'token' });
  router.post(legacy ? `${prefix}/tabs/:id/activate` : `${prefix}/apps/:id/activate`, ctx => activate(ctx.params.id), { access: 'token' });
  router.get(`${prefix}/gev/tools`, () => gevTools, { access: 'token' });
  router.post(`${prefix}/gev/command`, async ctx => { const { name, args } = await ctx.body(); return runGevTool(name, args); }, { access: 'token' });
};
tokenRoutes('/api/v1'); tokenRoutes('/api', true);
router.post('/api/v1/display/:action', ctx => ctx.params.action === 'sleep' ? sleep() : ctx.params.action === 'wake' ? wake() : send404(ctx), { access: 'token' });
router.post('/api/v1/board/insert', async ctx => boardOperation(await ctx.body()), { access: 'token', limit: 16 * 1024 * 1024 });
router.post('/api/v1/say', async ctx => speak((await ctx.body()).text), { access: 'token' });

const server = http.createServer((req, res) => { void router.handle(req, res); });
server.listen(PORT, '127.0.0.1', () => log(`OpenBoard ${updates.version} auf 127.0.0.1:${PORT}`));

// ---------- Background loops ----------
await system.setOrientation(config().display.orientation, { apply: false }).catch(() => {});
astra.start();
mqtt.connect(mqttContext);
await perf.start();

let lastScheduleKey = '';
setInterval(async () => {
  const c = config(), now = new Date();
  // Night schedule (sleepAt / wakeAt).
  const hhmm = now.toTimeString().slice(0, 5), key = `${now.toDateString()} ${hhmm}`;
  if (c.display.schedule.enabled && key !== lastScheduleKey) {
    if (hhmm === c.display.schedule.sleepAt) { lastScheduleKey = key; void sleep(); }
    else if (hhmm === c.display.schedule.wakeAt) { lastScheduleKey = key; void wake(); }
  }
  // Idle sleep.
  if (c.display.idleSleepMinutes > 0 && !display.asleep && !gemini.active && Date.now() - display.lastActivity > c.display.idleSleepMinutes * 60000) void sleep();
  // Theme "auto" flips at its times.
  const theme = effectiveTheme(c.appearance);
  if (theme !== lastTheme) { lastTheme = theme; publish(); }
  // Update status and deferred browser restarts.
  const next = await updates.status();
  if (JSON.stringify(next) !== JSON.stringify(updateStatus)) { updateStatus = next; broadcast('update', next); publish(); }
  const idle = display.asleep || Date.now() - display.lastActivity > 120000;
  if (next.pendingBrowserRestart && (c.updates.restartBrowser === 'now' || (c.updates.restartBrowser === 'idle' && idle))) {
    await updates.clearBrowserRestart();
    log('Browser-Neustart nach Update');
    await system.service('restart', 'openboard-browser.service').catch(error => log(`Browser-Neustart: ${error.message}`));
  }
}, 15000).unref();
let lastTheme = effectiveTheme(config().appearance);

// Shell changes on disk (development) are picked up without restarting.
setInterval(async () => {
  const next = await buildShell(root).catch(() => null);
  if (next && next.version !== shell.version) { shell = next; log(`Shell ${shell.version}`); await apps.reinstallShell(); }
}, 30000).unref();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 3000).unref();
  perf.stop(); astra.stop(); mqtt.close(); metrics.stop();
  await gemini.stop();
  await apps.disconnect();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });

if (process.argv.includes('--verify')) {
  for (let attempt = 0; attempt < 30 && !apps.connected; attempt++) { await apps.connect().catch(error => log(error.message)); if (!apps.connected) await new Promise(r => setTimeout(r, 1000)); }
  const { verify } = await import('../scripts/verify-openboard.mjs');
  try { await verify({ apps, base: `http://127.0.0.1:${PORT}`, token }); } finally { await shutdown(); }
} else {
  // Reconnect loop: the browser may start after (or restart independently of) the controller.
  let reloadedAfterUpdate = false;
  for (let cycle = 0; ; cycle++) {
    try { await apps.connect(); } catch { /* browser not up yet */ }
    if (apps.connected) {
      if (!reloadedAfterUpdate) {
        reloadedAfterUpdate = true;
        for (const id of updates.changedApps(config().apps)) if (apps.pages.has(id)) void apps.reload(id).catch(() => {});
      }
      if (cycle % 5 === 0) { await apps.adoptExistingPages().catch(() => {}); await apps.recoverFailedPages(); }
    }
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
