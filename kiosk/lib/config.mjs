// Configuration v2: defaults, migration from v1, redaction and validated patches.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { EventEmitter } from 'node:events';

export const BUILTIN_APPS = [
  { id: 'gev', name: 'God’s Eye View', url: 'http://localhost:4173/', icon: 'globe', builtin: false, enabled: true, zoom: 1, residency: 'auto', weight: 'heavy' },
  { id: 'home', name: 'Home Assistant', url: 'http://homeassistant.local:8123/', icon: 'home', builtin: false, enabled: true, zoom: 0.75, residency: 'always', weight: 'standard' },
  { id: 'astra', name: 'Astra', url: 'http://localhost:4180/apps/astra/', icon: 'astra', builtin: true, enabled: true, zoom: 1, residency: 'always', weight: 'light' },
  { id: 'board', name: 'Whiteboard', url: 'http://localhost:4180/apps/board/', icon: 'board', builtin: true, enabled: true, zoom: 1, residency: 'auto', weight: 'standard' },
  { id: 'settings', name: 'Einstellungen', url: 'http://localhost:4180/apps/settings/', icon: 'settings', builtin: true, enabled: true, zoom: 1, residency: 'eco', weight: 'light' },
];

export function defaults() {
  return {
    version: 2,
    apps: structuredClone(BUILTIN_APPS),
    startApp: 'gev',
    appearance: { theme: 'dark', lightFrom: '07:00', darkFrom: '19:30', glass: 'webgl', frost: 0.55, keyboardScale: 1, accent: '#f4f5f8' },
    dock: {
      order: BUILTIN_APPS.map(app => app.id), autoHideSeconds: 6, indicator: 'touch',
      tiles: [
        { id: 't1', items: [
          { id: 'w1', type: 'metric.cpu', options: { style: 'ring' } },
          { id: 'w2', type: 'metric.gpu', options: { style: 'ring' } },
          { id: 'w3', type: 'action.sleep', options: {} },
          { id: 'w4', type: 'action.theme', options: {} },
        ] },
        { id: 't2', items: [{ id: 'w5', type: 'info.clock', options: {} }] },
      ],
    },
    display: { orientation: 'landscape', sleepMode: 'black', useDdc: false, idleSleepMinutes: 0, schedule: { enabled: false, sleepAt: '23:30', wakeAt: '06:45' } },
    performance: {
      mode: 'balanced', elevatedCpu: 75, criticalCpu: 92, sustainSeconds: 20, memoryFloorMB: 600,
      terminate: 'ask', askTimeoutSeconds: 30, askDefault: 'keep', terminateMinIdleMinutes: 20, freezeMinIdleMinutes: 3,
      prewarm: true, thermalLimitC: 88, gev: { fps: 30, resolutionScale: 0.8 }, alwaysAllow: [],
    },
    astra: { url: '', token: '', voice: true, briefingOnDisplay: true },
    mqtt: { url: '', username: '', password: '', discoveryPrefix: 'homeassistant', nodeId: 'openboard' },
    gemini: { key: '', model: 'gemini-3.8-live' },
    board: { paper: 'auto', lowLatency: true, prediction: true },
    updates: { enabled: true, branch: 'main', intervalSeconds: 60, restartBrowser: 'idle' },
  };
}

export const ORIENTATIONS = ['landscape', 'portrait', 'landscape-flipped', 'portrait-flipped'];
const SECRET_PATHS = [['astra', 'token'], ['mqtt', 'password'], ['gemini', 'key']];
const LEGACY_URLS = { 'http://localhost:4180/astra': 'http://localhost:4180/apps/astra/', 'http://localhost:4180/whiteboard': 'http://localhost:4180/apps/board/' };

const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

// Deep merge: objects merge, arrays and scalars replace.
export function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isObject(value) && isObject(target[key])) merge(target[key], value);
    else target[key] = structuredClone(value);
  }
  return target;
}

export function migrate(raw) {
  if (raw?.version === 2) {
    const config = merge(defaults(), raw);
    // New built-in apps appear for existing installations.
    for (const app of BUILTIN_APPS) if (!config.apps.some(existing => existing.id === app.id)) {
      config.apps.push(structuredClone(app));
      if (!config.dock.order.includes(app.id)) config.dock.order.push(app.id);
    }
    return config;
  }
  const config = defaults();
  if (!raw) return config;
  // v1: { layout, geminiModel, geminiKey, tabs:[{id,name,url}] }
  if (raw.geminiKey) config.gemini.key = raw.geminiKey;
  if (raw.geminiModel) config.gemini.model = raw.geminiModel;
  for (const tab of raw.tabs || []) {
    const url = LEGACY_URLS[tab.url] || tab.url;
    const app = config.apps.find(app => app.id === tab.id);
    if (app) { app.url = url; if (tab.name) app.name = tab.name; }
    else config.apps.push({ id: tab.id, name: tab.name || tab.id, url, icon: 'web', builtin: false, enabled: true, zoom: 1, residency: 'auto', weight: 'standard' });
  }
  config.dock.order = config.apps.map(app => app.id);
  return config;
}

export function redact(config) {
  const copy = structuredClone(config);
  for (const [section, key] of SECRET_PATHS) copy[section][key] = { set: !!config[section]?.[key] };
  return copy;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const oneOf = (value, list, name) => { if (!list.includes(value)) throw new Error(`Ungültiger Wert für ${name}`); };
const number = (value, min, max, name) => { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} muss zwischen ${min} und ${max} liegen`); };

export function validateUrl(value, name) {
  if (value === '') return;
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name}: ungültige URL`); }
  if (!['http:', 'https:', 'mqtt:', 'mqtts:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) throw new Error(`${name}: nur http(s)/mqtt(s) ohne Zugangsdaten in der URL`);
}

// Throws with a German message if the config is not usable.
export function validate(config) {
  const ids = new Set();
  for (const app of config.apps) {
    if (!ID.test(app.id) || ids.has(app.id)) throw new Error(`Ungültige App-ID: ${app.id}`);
    ids.add(app.id);
    if (typeof app.name !== 'string' || !app.name.trim() || app.name.length > 40) throw new Error('App-Name fehlt oder ist zu lang');
    const url = new URL(app.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${app.name}: nur http(s)-URLs ohne Zugangsdaten`);
    oneOf(app.residency, ['always', 'auto', 'eco'], 'Verbleib');
    oneOf(app.weight, ['heavy', 'standard', 'light'], 'Gewicht');
    number(app.zoom, 0.5, 2, 'Zoom');
  }
  if (!ids.has(config.startApp)) config.startApp = config.apps[0]?.id;
  config.dock.order = [...new Set([...config.dock.order.filter(id => ids.has(id)), ...ids])];
  oneOf(config.appearance.theme, ['dark', 'light', 'auto'], 'Design');
  oneOf(config.appearance.glass, ['webgl', 'css', 'off'], 'Glas');
  number(config.appearance.frost, 0, 1, 'Milchglas-Stärke');
  number(config.appearance.keyboardScale, 0.5, 1.6, 'Tastaturgröße');
  if (!TIME.test(config.appearance.lightFrom) || !TIME.test(config.appearance.darkFrom)) throw new Error('Uhrzeit im Format HH:MM');
  oneOf(config.dock.indicator, ['always', 'touch', 'never'], 'Indikator');
  number(config.dock.autoHideSeconds, 2, 120, 'Ausblenden nach');
  if (!Array.isArray(config.dock.tiles) || config.dock.tiles.length > 4) throw new Error('Höchstens vier Kacheln');
  for (const tile of config.dock.tiles) {
    if (!Array.isArray(tile.items) || tile.items.length > 4) throw new Error('Höchstens vier Elemente pro Kachel');
    for (const item of tile.items) if (typeof item.type !== 'string' || typeof item.id !== 'string') throw new Error('Ungültiges Widget');
  }
  oneOf(config.display.sleepMode, ['black', 'dpms'], 'Ruhemodus');
  oneOf(config.display.orientation, ORIENTATIONS, 'Ausrichtung');
  number(config.display.idleSleepMinutes, 0, 1440, 'Automatischer Ruhezustand');
  if (!TIME.test(config.display.schedule.sleepAt) || !TIME.test(config.display.schedule.wakeAt)) throw new Error('Uhrzeit im Format HH:MM');
  const p = config.performance;
  oneOf(p.mode, ['eco', 'balanced', 'max'], 'Leistungsmodus');
  number(p.elevatedCpu, 20, 99, 'Erhöhte Last'); number(p.criticalCpu, p.elevatedCpu, 100, 'Kritische Last');
  number(p.sustainSeconds, 2, 600, 'Dauer'); number(p.memoryFloorMB, 0, 65536, 'RAM-Untergrenze');
  oneOf(p.terminate, ['ask', 'auto', 'never'], 'Beenden');
  oneOf(p.askDefault, ['keep', 'terminate'], 'Standardantwort');
  number(p.askTimeoutSeconds, 5, 600, 'Wartezeit'); number(p.terminateMinIdleMinutes, 1, 1440, 'Leerlauf vor Beenden');
  number(p.freezeMinIdleMinutes, 0, 1440, 'Leerlauf vor Pausieren'); number(p.thermalLimitC, 50, 105, 'Temperaturgrenze');
  number(p.gev.fps, 5, 60, 'GEV-Bildrate'); number(p.gev.resolutionScale, 0.3, 1, 'GEV-Auflösung');
  validateUrl(config.astra.url, 'ASTRA'); validateUrl(config.mqtt.url, 'MQTT');
  if (!/^[a-z0-9_-]{1,32}$/i.test(config.mqtt.nodeId)) throw new Error('MQTT-Node-ID: nur Buchstaben, Ziffern, _ und -');
  if (!/^[a-z0-9_/-]{1,64}$/i.test(config.mqtt.discoveryPrefix)) throw new Error('Ungültiges Discovery-Präfix');
  if (!/^gemini-[a-z0-9.-]+$/.test(config.gemini.model)) throw new Error('Ungültiges Gemini-Modell');
  oneOf(config.board.paper, ['auto', 'light', 'dark'], 'Papier');
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(config.updates.branch)) throw new Error('Ungültiger Branch');
  number(config.updates.intervalSeconds, 30, 86400, 'Update-Intervall');
  oneOf(config.updates.restartBrowser, ['idle', 'now', 'never'], 'Browser-Neustart');
  return config;
}

export class ConfigStore extends EventEmitter {
  constructor(file) { super(); this.file = file; this.data = null; this.queue = Promise.resolve(); }

  async load() {
    let raw = null;
    try { raw = JSON.parse(await readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') console.error(`Config: ${error.message}; defaults used`); }
    this.data = validate(migrate(raw));
    await this.save();
    return this.data;
  }

  get() { return this.data; }

  // Applies a partial update; secrets that arrive as {set:true} stay untouched.
  async patch(patch) {
    const next = structuredClone(this.data);
    const clean = structuredClone(patch);
    for (const [section, key] of SECRET_PATHS) if (isObject(clean[section]?.[key])) delete clean[section][key];
    delete clean.version;
    merge(next, clean);
    validate(next);
    const previous = this.data;
    this.data = next;
    await this.save();
    this.emit('change', next, previous);
    return next;
  }

  save() {
    const text = JSON.stringify(this.data, null, 2);
    const task = this.queue.catch(() => {}).then(async () => {
      await writeFile(this.file + '.tmp', text, { mode: 0o600, flush: true });
      await rename(this.file + '.tmp', this.file);
    });
    this.queue = task;
    return task;
  }
}

// Effective theme for "auto": light between lightFrom and darkFrom.
export function effectiveTheme(appearance, now = new Date()) {
  if (appearance.theme !== 'auto') return appearance.theme;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = value => { const [h, m] = value.split(':').map(Number); return h * 60 + m; };
  const light = toMinutes(appearance.lightFrom), dark = toMinutes(appearance.darkFrom);
  return (light <= dark ? minutes >= light && minutes < dark : minutes >= light || minutes < dark) ? 'light' : 'dark';
}

