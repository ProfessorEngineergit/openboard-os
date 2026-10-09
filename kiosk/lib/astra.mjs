// Server-side bridge to ASTRA's display API v1. The browser never sees the token.
import { EventEmitter } from 'node:events';
import { HttpError } from './router.mjs';

const GLANCE_TTL = 10 * 60000;

export function parseSse(buffer, onEvent) {
  // Returns the unparsed remainder. Events are separated by a blank line.
  let index;
  while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
    const block = buffer.slice(0, index);
    buffer = buffer.slice(index + (buffer[index] === '\r' ? 4 : 2));
    let type = 'message'; const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') type = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) {
      try { onEvent(type, JSON.parse(data.join('\n'))); } catch { /* ignore malformed */ }
    }
  }
  return buffer;
}

export class AstraBridge extends EventEmitter {
  constructor({ config, log }) {
    super();
    this.config = config; this.log = log;
    this.connected = false; this.glanceCache = null; this.stream = null; this.retry = 0; this.info = null;
  }

  get settings() { return this.config().astra; }
  get configured() { return !!(this.settings.url && this.settings.token); }

  status() { return { configured: this.configured, connected: this.connected, name: this.info?.name || null, version: this.info?.version || null }; }

  async request(path, { method = 'GET', body, timeout = 30000 } = {}) {
    if (!this.configured) throw new HttpError(503, 'ASTRA ist nicht eingerichtet');
    const url = new URL(path, this.settings.url.endsWith('/') ? this.settings.url : this.settings.url + '/');
    let response;
    try {
      response = await fetch(url, {
        method, signal: AbortSignal.timeout(timeout),
        headers: { authorization: `Bearer ${this.settings.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) { throw new HttpError(503, `ASTRA nicht erreichbar: ${error.cause?.code || error.message}`); }
    const text = await response.text();
    let data; try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 502 : response.status >= 500 ? 502 : response.status, data?.error || data?.detail || `ASTRA: HTTP ${response.status}`);
    return data;
  }

  async hello() { this.info = await this.request('display/v1/hello', { timeout: 8000 }); return this.info; }

  async message(body) {
    const result = await this.request('display/v1/message', { method: 'POST', body, timeout: 120000 });
    this.glanceCache = null;
    return result;
  }

  async glance({ refresh = false } = {}) {
    if (!refresh && this.glanceCache && Date.now() - this.glanceCache.at < GLANCE_TTL) return this.glanceCache.data;
    const data = await this.request('display/v1/glance', { timeout: 30000 });
    this.glanceCache = { at: Date.now(), data };
    this.emit('glance', data);
    return data;
  }

  cachedGlance() { return this.glanceCache?.data || null; }

  tts(text) { return this.request('display/v1/tts', { method: 'POST', body: { text: String(text).slice(0, 4000) }, timeout: 60000 }); }

  async test() {
    const info = await this.hello();
    return { ok: true, detail: `${info.name || 'ASTRA'} ${info.version || ''}`.trim() };
  }

  // Keeps one SSE connection open; reconnects with backoff while configured.
  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
    this.refresh = setInterval(() => { if (this.configured) void this.glance({ refresh: true }).catch(() => {}); }, GLANCE_TTL);
  }

  restart() { this.stream?.abort(); this.retry = 0; this.glanceCache = null; }

  stop() { this.running = false; this.stream?.abort(); clearInterval(this.refresh); }

  setConnected(value) {
    if (this.connected === value) return;
    this.connected = value;
    this.emit('status', this.status());
  }

  async loop() {
    while (this.running) {
      if (!this.configured) { this.setConnected(false); await new Promise(resolve => setTimeout(resolve, 5000)); continue; }
      const controller = new AbortController();
      this.stream = controller;
      try {
        await this.hello().catch(() => {});
        const url = new URL('display/v1/events', this.settings.url.endsWith('/') ? this.settings.url : this.settings.url + '/');
        const response = await fetch(url, { headers: { authorization: `Bearer ${this.settings.token}`, accept: 'text/event-stream' }, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.setConnected(true); this.retry = 0;
        void this.glance({ refresh: true }).catch(() => {});
        const decoder = new TextDecoder(); let buffer = '';
        let watchdog = setTimeout(() => controller.abort(), 60000);
        for await (const chunk of response.body) {
          clearTimeout(watchdog); watchdog = setTimeout(() => controller.abort(), 60000);
          buffer = parseSse(buffer + decoder.decode(chunk, { stream: true }), (type, data) => { if (type !== 'ping') this.emit('event', type, data); });
        }
        clearTimeout(watchdog);
      } catch (error) {
        if (this.connected) this.log(`ASTRA-Verbindung: ${error.message}`);
      }
      this.setConnected(false);
      if (!this.running) break;
      const wait = Math.min(60000, 2000 * 2 ** Math.min(this.retry++, 5));
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}
