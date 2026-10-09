// Performance manager. Principle: with headroom nothing is touched; under load
// the cheapest reversible step comes first (freeze), terminating is the last
// step and may ask the user. See docs/ARCHITECTURE.md "Leistungsmanager".
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const MODE_SHIFT = { eco: -15, balanced: 0, max: 8 };
const WEIGHT = { heavy: 3, standard: 1.5, light: 1 };
const HALF_LIFE_DAYS = 7;
const ECO_GRACE_MS = 15000;

export function thresholds(p) {
  const shift = MODE_SHIFT[p.mode] ?? 0;
  const elevated = Math.max(20, Math.min(99, p.elevatedCpu + shift));
  return { elevated, critical: Math.max(elevated + 1, Math.min(100, p.criticalCpu + shift)), terminate: p.mode === 'max' ? 'never' : p.terminate };
}

// Pure pressure state machine with sustain and hysteresis; returns the next state.
export function nextPressure(prev, sample, p, now) {
  const t = thresholds(p);
  const memoryLow = Number.isFinite(sample.availableMB) && p.memoryFloorMB > 0 && sample.availableMB < p.memoryFloorMB;
  const raw = memoryLow || sample.cpu >= t.critical ? 'critical' : sample.cpu >= t.elevated ? 'elevated' : 'normal';
  const rank = { normal: 0, elevated: 1, critical: 2 };
  const state = { ...prev };
  if (rank[raw] > rank[state.level]) {
    if (state.candidate !== raw) { state.candidate = raw; state.candidateSince = now; }
    // Memory exhaustion acts at once; CPU must be sustained.
    if (memoryLow || now - state.candidateSince >= p.sustainSeconds * 1000) { state.level = raw; state.since = now; state.candidate = null; }
  } else {
    state.candidate = null;
    const limit = state.level === 'critical' ? t.critical - 10 : t.elevated - 10;
    if (state.level !== 'normal' && !memoryLow && sample.cpu < limit) {
      if (!state.calmSince) state.calmSince = now;
      if (now - state.calmSince >= 30000) { state.level = state.level === 'critical' && sample.cpu >= t.elevated - 10 ? 'elevated' : 'normal'; state.since = now; state.calmSince = null; }
    } else state.calmSince = null;
  }
  state.memoryLow = memoryLow;
  return state;
}

// Cost of keeping a background app: CPU share, memory and its weight class.
export function cost(app) {
  return (app.cpu || 0) + (app.heapMB || 0) / 50 + (WEIGHT[app.weight] || 1) * 5;
}

export function pickTerminationCandidate(apps, { active, protectedIds, minIdleMs, cooldowns, now }) {
  return apps
    .filter(app => app.id !== active && app.residency !== 'always' && !protectedIds.has(app.id))
    .filter(app => app.lifecycle === 'background' || app.lifecycle === 'frozen')
    .filter(app => now - (app.lastActive || app.openedAt || 0) >= minIdleMs && !(cooldowns.get(app.id) > now))
    .map(app => ({ app, score: cost(app) * ((now - (app.lastActive || 0)) / 60000) }))
    .sort((a, b) => b.score - a.score)[0]?.app || null;
}

export class UsageModel {
  constructor(file) { this.file = file; this.data = { updated: Date.now(), apps: {} }; this.dirty = false; }
  async load() {
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); } catch { /* fresh */ }
    this.decay();
  }
  decay(now = Date.now()) {
    const days = (now - this.data.updated) / 86400000;
    if (days < 0.25) return;
    const factor = Math.pow(0.5, days / HALF_LIFE_DAYS);
    for (const buckets of Object.values(this.data.apps)) for (let i = 0; i < 24; i++) buckets[i] *= factor;
    this.data.updated = now; this.dirty = true;
  }
  add(id, seconds, date = new Date()) {
    const buckets = this.data.apps[id] ||= new Array(24).fill(0);
    buckets[date.getHours()] += seconds; this.dirty = true;
  }
  // Most likely app for the hour starting `ahead` ms from now, with its share.
  predict(ahead = 5 * 60000, now = Date.now()) {
    const hour = new Date(now + ahead).getHours();
    const entries = Object.entries(this.data.apps).map(([id, buckets]) => [id, buckets[hour] || 0]);
    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    if (total < 300) return null;
    const [id, value] = entries.sort((a, b) => b[1] - a[1])[0];
    return { id, share: value / total, seconds: value };
  }
  async save() {
    if (!this.dirty) return;
    this.dirty = false;
    await writeFile(this.file + '.tmp', JSON.stringify(this.data), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
  }
}

export class PerformanceManager extends EventEmitter {
  constructor({ apps, metrics, config, patchConfig, usageFile, isAsleep, protectedApps, log }) {
    super();
    Object.assign(this, { apps, metrics, config, patchConfig, isAsleep, protectedApps, log });
    this.usage = new UsageModel(usageFile);
    this.pressure = { level: 'normal', since: Date.now(), candidate: null };
    this.cpuSmooth = null;
    this.prompts = new Map();   // id → { id, app, text, choices, resolve, timer }
    this.cooldowns = new Map(); // app id → timestamp until which it is not proposed again
    this.thermalThrottled = false;
    this.lastTick = Date.now();
    this.actions = [];          // recent decisions for the console
  }

  async start() {
    await this.usage.load();
    this.timer = setInterval(() => { void this.tick().catch(error => this.log(`Leistung: ${error.message}`)); }, 2000);
    this.saveTimer = setInterval(() => { void this.usage.save().catch(() => {}); this.usage.decay(); }, 300000);
  }

  stop() { clearInterval(this.timer); clearInterval(this.saveTimer); void this.usage.save().catch(() => {}); }

  record(text, app) {
    this.actions.unshift({ at: Date.now(), text, app });
    this.actions.length = Math.min(this.actions.length, 50);
    this.log(`Leistung: ${text}`);
  }

  state() {
    const t = thresholds(this.config().performance);
    return { mode: this.config().performance.mode, pressure: this.pressure.level, memoryLow: !!this.pressure.memoryLow, cpu: this.cpuSmooth,
      thresholds: t, thermalThrottled: this.thermalThrottled, prediction: this.usage.predict(),
      prompts: [...this.prompts.values()].map(({ id, app, text, choices, expires }) => ({ id, app, text, choices, expires })), actions: this.actions.slice(0, 15) };
  }

  async tick() {
    const now = Date.now(), p = this.config().performance;
    const dt = (now - this.lastTick) / 1000; this.lastTick = now;
    if (!this.apps.connected) return;
    await this.apps.sample();
    const m = this.metrics.latest;
    if (Number.isFinite(m.cpu.pct)) this.cpuSmooth = this.cpuSmooth == null ? m.cpu.pct : this.cpuSmooth * 0.7 + m.cpu.pct * 0.3;
    const previous = this.pressure.level;
    this.pressure = nextPressure(this.pressure, { cpu: this.cpuSmooth ?? 0, availableMB: m.ram.availableMB }, p, now);
    if (this.pressure.level !== previous) { this.record(`Lastlage ${previous} → ${this.pressure.level}`); this.emit('change'); }

    const asleep = this.isAsleep();
    if (!asleep && this.apps.active && dt < 10) this.usage.add(this.apps.active, dt);
    const apps = this.apps.snapshot().map(app => ({ ...app, openedAt: this.apps.rt(app.id).openedAt }));
    const protectedIds = this.protectedApps();

    // 1. Eco apps and sleep: freezing hidden apps costs nothing and resumes instantly.
    for (const app of apps) {
      if (app.lifecycle !== 'background' || app.id === this.apps.active || protectedIds.has(app.id) || app.residency === 'always') continue;
      const idle = now - (app.lastActive || 0);
      const eco = app.residency === 'eco' && idle > ECO_GRACE_MS;
      const pressured = this.pressure.level !== 'normal' && idle >= p.freezeMinIdleMinutes * 60000;
      if (asleep || eco || pressured) {
        if (await this.apps.freeze(app.id).catch(() => false)) this.record(`${app.name} pausiert (${asleep ? 'Ruhezustand' : eco ? 'Sparsam' : 'Last'})`, app.id);
      }
    }

    // 2. Critical: terminate the most expensive long-idle app (memory, or CPU that freezing could not stop).
    if (this.pressure.level === 'critical' && !this.prompts.size && thresholds(p).terminate !== 'never') {
      const fresh = this.apps.snapshot().map(app => ({ ...app, openedAt: this.apps.rt(app.id).openedAt }));
      const pool = this.pressure.memoryLow ? fresh : fresh.filter(app => app.lifecycle === 'background' && (app.cpu || 0) > 5);
      const candidate = pickTerminationCandidate(pool, { active: this.apps.active, protectedIds, minIdleMs: p.terminateMinIdleMinutes * 60000, cooldowns: this.cooldowns, now });
      if (candidate) await this.proposeTermination(candidate);
    }

    // 3. Prewarm the app that is usually used in the coming hour.
    if (p.prewarm && this.pressure.level === 'normal' && !asleep) {
      const guess = this.usage.predict();
      const app = guess && guess.share >= 0.4 && apps.find(entry => entry.id === guess.id && entry.enabled);
      if (app && app.id !== this.apps.active && (app.lifecycle === 'frozen' || app.lifecycle === 'terminated') && !(this.cooldowns.get('prewarm:' + app.id) > now)) {
        this.cooldowns.set('prewarm:' + app.id, now + 30 * 60000);
        if (app.lifecycle === 'frozen') await this.apps.resume(app.id);
        // Firefox may focus a tab that loads in the background; Chrome does not.
        else await this.apps.ensurePage(app.id).then(() => this.apps.protocol === 'bidi' && this.apps.active ? this.apps.activate(this.apps.active) : null).catch(() => {});
        this.record(`${app.name} vorgewärmt (wird um diese Zeit meist genutzt)`, app.id);
      }
    }

    // 4. Thermal governor for the globe.
    const temp = m.temp.c;
    if (Number.isFinite(temp)) {
      if (!this.thermalThrottled && temp >= p.thermalLimitC) { this.thermalThrottled = true; await this.apps.setGevQuality(20, Math.min(0.6, p.gev.resolutionScale)); this.record(`Temperatur ${Math.round(temp)} °C: Globus gedrosselt`, 'gev'); this.emit('change'); }
      else if (this.thermalThrottled && temp < p.thermalLimitC - 5) { this.thermalThrottled = false; await this.apps.setGevQuality(p.gev.fps, p.gev.resolutionScale); this.record('Temperatur normal: Globus wieder in voller Qualität', 'gev'); this.emit('change'); }
    }
  }

  async proposeTermination(app) {
    const p = this.config().performance, now = Date.now();
    const idleMinutes = Math.round((now - (app.lastActive || app.openedAt || now)) / 60000);
    const reason = this.pressure.memoryLow ? `${app.heapMB ?? '?'} MB Speicher` : `${Math.round(app.cpu || 0)} % CPU`;
    if (thresholds(p).terminate === 'auto' || p.alwaysAllow.includes(app.id)) {
      await this.apps.terminate(app.id);
      this.record(`${app.name} beendet (${reason}, ${idleMinutes} min ungenutzt)`, app.id);
      this.emit('toast', { text: `${app.name} wurde beendet, um Leistung freizugeben`, icon: app.icon });
      return;
    }
    const choice = await this.ask({
      app: app.id,
      text: `${app.name} belastet das System (${reason}) und ist seit ${idleMinutes} min ungenutzt. Beenden? Beim nächsten Öffnen lädt die App neu.`,
      choices: [{ id: 'terminate', label: 'Beenden' }, { id: 'keep', label: 'Behalten' }, { id: 'always', label: 'Immer erlauben' }],
      timeoutSeconds: p.askTimeoutSeconds, fallback: p.askDefault,
    });
    if (choice === 'keep') { this.cooldowns.set(app.id, Date.now() + 30 * 60000); this.record(`${app.name} behalten`, app.id); return; }
    if (choice === 'always') await this.patchConfig({ performance: { alwaysAllow: [...new Set([...p.alwaysAllow, app.id])] } });
    if (this.apps.active === app.id) return;
    await this.apps.terminate(app.id).catch(() => {});
    this.record(`${app.name} beendet (${reason})`, app.id);
  }

  // Shows a prompt in the shell and the console; resolves with a choice id.
  ask({ app, text, choices, timeoutSeconds, fallback }) {
    return new Promise(resolve => {
      const id = randomUUID(), expires = Date.now() + timeoutSeconds * 1000;
      const finish = choice => {
        const prompt = this.prompts.get(id);
        if (!prompt) return;
        clearTimeout(prompt.timer); this.prompts.delete(id);
        this.emit('prompt-closed', { id, choice }); this.emit('change');
        resolve(choice);
      };
      this.prompts.set(id, { id, app, text, choices, expires, resolve: finish, timer: setTimeout(() => finish(fallback), timeoutSeconds * 1000) });
      this.emit('prompt', { id, app, text, choices, expires }); this.emit('change');
    });
  }

  answer(id, choice) {
    const prompt = this.prompts.get(id);
    if (!prompt) throw new Error('Rückfrage ist nicht mehr offen');
    if (!prompt.choices.some(entry => entry.id === choice)) throw new Error('Ungültige Antwort');
    prompt.resolve(choice);
  }
}
