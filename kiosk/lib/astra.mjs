// Server-side bridge to ASTRA's display API v1. The browser never sees the token.
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './router.mjs';

const GLANCE_TTL = 10 * 60000;
const IMAGE_LIMIT = 8 * 1024 * 1024;

export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80') || lower.startsWith('::ffff:');
  }
  return true;
}

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
    await this.inlineImages(result?.cards);
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

  // Cards may carry https image URLs; the app's CSP only allows data: images, so they are fetched here.
  // Only public hosts are fetched (a model-written URL must not probe the home network); the ASTRA host
  // itself is allowed. Failures leave the card as is (the app shows a placeholder).
  async inlineImages(cards) {
    if (!Array.isArray(cards)) return cards;
    const astraHost = this.configured ? new URL(this.settings.url).hostname : null;
    await Promise.all(cards.map(async card => {
      const src = card?.type === 'image' ? card.data?.src : null;
      if (typeof src !== 'string' || !/^https?:\/\//i.test(src)) return;
      try {
        const url = new URL(src);
        if (url.hostname !== astraHost) {
          const addresses = await dns.lookup(url.hostname, { all: true });
          if (!addresses.length || addresses.some(entry => isPrivateAddress(entry.address))) return;
        }
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: url.hostname === astraHost ? { authorization: `Bearer ${this.settings.token}` } : {} });
        const type = response.headers.get('content-type')?.split(';')[0].trim() || '';
        if (!response.ok || !/^image\/(png|jpe?g|webp|gif|avif)$/.test(type)) return;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > IMAGE_LIMIT) return;
        card.data = { ...card.data, src: `data:${type};base64,${bytes.toString('base64')}` };
      } catch { /* keep the original card */ }
    }));
    return cards;
  }

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
          buffer = parseSse(buffer + decoder.decode(chunk, { stream: true }), (type, data) => {
            if (type === 'ping') return;
            const cards = type === 'card' ? [data.card] : type === 'cards' ? data.cards : type === 'alarm' ? data.cards : null;
            if (cards?.some(card => card?.type === 'image')) void this.inlineImages(cards).finally(() => this.emit('event', type, data));
            else this.emit('event', type, data);
          });
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
