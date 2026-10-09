// Incremental board sync.
//
// - Every Excalidraw onChange is diffed against the last known `version:versionNonce`
//   per element. Changed or new elements are queued and POSTed (debounced ~300 ms) as one
//   `upsert` op. Deletions in Excalidraw are soft (isDeleted: true + version bump), so
//   they travel as `upsert` too; the server keeps them as slim tombstones so other
//   clients reconcile correctly and undo of a delete works. A `delete` op is sent only
//   for elements that vanished from the scene entirely.
// - appState subset (viewBackgroundColor, scroll, zoom) is sent as an `app` op (slower debounce).
// - Image files are PUT separately (raw bytes) once per file id.
// - Unsent work is mirrored to IndexedDB (outbox) and retried with backoff; the last
//   good scene is cached in IndexedDB as an offline fallback for loading.
import { idb } from './idb.js';

const API = '/api/local/board';
const MAX_BATCH_BYTES = 3 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function request(path, { method = 'GET', body, raw, contentType, keepalive } = {}) {
  const response = await fetch(API + path, {
    method, keepalive,
    headers: raw ? { 'content-type': contentType || 'application/octet-stream' } : body === undefined ? undefined : { 'content-type': 'application/json' },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  if (!response.ok) {
    let message = response.statusText;
    try { message = (await response.json()).error || message; } catch { /* not JSON */ }
    throw new HttpError(response.status, message);
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response;
}

export function dataURLToBytes(dataURL) {
  const match = /^data:([^;,]+)?((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(dataURL || '');
  if (!match) throw new Error('Ungültige Data-URL');
  const mimeType = match[1] || 'application/octet-stream';
  const payload = match[4];
  let bytes;
  if (match[3]) {
    const binary = atob(payload);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return { mimeType, bytes };
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const key = el => `${el.version}:${el.versionNonce}`;
const emptyOutbox = () => ({ upserts: new Map(), deletes: new Set(), app: null });
const outboxEmpty = o => !o.upserts.size && !o.deletes.size && !o.app;

export class BoardSync {
  constructor({ clientId, onStatus }) {
    this.clientId = clientId;
    this.onStatus = onStatus || (() => {});
    this.boardId = null;
    this.seq = 0;
    this.known = new Map();
    this.out = emptyOutbox();
    this.inflight = null;
    this.timer = null;
    this.retryDelay = 0;
    this.lastApp = '';
    this.fileMeta = new Set();     // file ids the server has
    this.fileUploads = new Map();  // id -> promise
    this.ownSeqs = new Set();
    this.status = 'idle';
    this.cacheTimer = null;
    this.paused = false;
    addEventListener('online', () => this.schedule(50));
    addEventListener('pagehide', () => this.flushOnExit());
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
  }

  setStatus(status) {
    if (status === this.status) return;
    this.status = status;
    this.onStatus(status);
  }

  // Element and file changes not yet on the server (scroll/zoom-only changes excluded).
  get pendingElements() {
    return this.out.upserts.size + this.out.deletes.size + (this.sendingElements || 0) + this.fileUploads.size;
  }

  get pendingCount() {
    return this.out.upserts.size + this.out.deletes.size + (this.out.app ? 1 : 0) + (this.sendingCount || 0) + this.fileUploads.size;
  }

  // Loads a board: server first, IndexedDB scene cache as fallback. Unsent outbox
  // entries from an earlier session are merged on top and queued again.
  async load(boardId) {
    await this.flush();
    this.boardId = boardId;
    this.known = new Map();
    this.out = emptyOutbox();
    this.lastApp = '';
    this.fileMeta = new Set();
    this.ownSeqs = new Set();
    let data, source = 'server';
    try {
      data = await request(`/boards/${encodeURIComponent(boardId)}`);
      idb.put('scenes', boardId, data);
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) throw error;
      data = await idb.get('scenes', boardId);
      if (!data) throw error;
      source = 'local';
    }
    const elements = new Map((data.scene?.elements || []).map(el => [el.id, el]));
    for (const el of elements.values()) this.known.set(el.id, key(el));
    const saved = await idb.get('outbox', boardId);
    if (saved) {
      for (const el of saved.upserts || []) {
        const current = elements.get(el.id);
        if (!current || current.version < el.version) { elements.set(el.id, el); this.out.upserts.set(el.id, el); this.known.set(el.id, key(el)); }
      }
      for (const id of saved.deletes || []) { if (elements.delete(id)) { this.out.deletes.add(id); this.known.delete(id); } }
    }
    this.seq = data.seq || 0;
    for (const id of Object.keys(data.scene?.files || {})) this.fileMeta.add(id);
    if (!outboxEmpty(this.out)) this.schedule(500);
    this.setStatus(source === 'server' ? (outboxEmpty(this.out) ? 'saved' : 'saving') : 'offline');
    return { elements: [...elements.values()], appState: data.scene?.appState || {}, files: data.scene?.files || {}, seq: this.seq, source, name: data.name };
  }

  // Marks elements as known (e.g. after applying a remote change) so they are not echoed.
  acknowledge(elements) {
    for (const el of elements) this.known.set(el.id, key(el));
  }

  // Diff from Excalidraw's onChange (elements include deleted ones).
  track(elements, appState, files) {
    if (!this.boardId || this.paused) return;
    let changed = false;
    const inProgress = appState.newElement?.id;
    for (const el of elements) {
      if (el.id === inProgress) continue;
      const k = key(el);
      if (this.known.get(el.id) !== k) {
        this.known.set(el.id, k);
        this.out.upserts.set(el.id, el);
        this.out.deletes.delete(el.id);
        changed = true;
      }
    }
    if (this.known.size > elements.length) {
      const present = new Set(elements.map(el => el.id));
      for (const id of [...this.known.keys()]) {
        if (!present.has(id)) { this.known.delete(id); this.out.upserts.delete(id); this.out.deletes.add(id); changed = true; }
      }
    }
    const app = {
      viewBackgroundColor: appState.viewBackgroundColor,
      scrollX: Math.round(appState.scrollX), scrollY: Math.round(appState.scrollY),
      zoom: { value: Math.round(appState.zoom.value * 1000) / 1000 },
    };
    const appKey = JSON.stringify(app);
    let appChanged = false;
    if (appKey !== this.lastApp) {
      if (this.lastApp) { this.out.app = app; appChanged = true; }
      this.lastApp = appKey;
    }
    for (const id in files) if (!this.fileMeta.has(id) && !this.fileUploads.has(id)) this.uploadFile(files[id]);
    if (changed) { this.setStatus('saving'); this.schedule(300); }
    else if (appChanged) this.schedule(2000, true);
  }

  schedule(delay, lazy = false) {
    if (this.timer && lazy) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, delay);
  }

  uploadFile(file) {
    const boardId = this.boardId;
    const task = (async () => {
      try {
        const { mimeType, bytes } = dataURLToBytes(file.dataURL);
        idb.put('files', file.id, { id: file.id, mimeType: file.mimeType || mimeType, dataURL: file.dataURL, created: file.created });
        await request(`/boards/${encodeURIComponent(boardId)}/files/${encodeURIComponent(file.id)}`, { method: 'PUT', raw: bytes, contentType: file.mimeType || mimeType });
        if (boardId === this.boardId) this.fileMeta.add(file.id);
      } catch (error) {
        console.warn('[board] file upload failed', file.id, error);
        if (boardId === this.boardId) { this.setStatus('offline'); setTimeout(() => { this.fileUploads.delete(file.id); }, 15000); }
        return;
      }
      this.fileUploads.delete(file.id);
    })();
    this.fileUploads.set(file.id, task);
  }

  persistOutbox(boardId, extra) {
    const merged = emptyOutbox();
    for (const source of [extra, this.out]) {
      if (!source) continue;
      for (const [id, el] of source.upserts) merged.upserts.set(id, el);
      for (const id of source.deletes) merged.deletes.add(id);
      if (source.app) merged.app = source.app;
    }
    if (outboxEmpty(merged)) return idb.delete('outbox', boardId);
    return idb.put('outbox', boardId, { upserts: [...merged.upserts.values()], deletes: [...merged.deletes], app: merged.app, saved: Date.now() });
  }

  batches(outbox) {
    // Splits large upserts so a single request stays well below the server limit.
    const batches = [];
    let current = [], bytes = 0;
    for (const el of outbox.upserts.values()) {
      const size = JSON.stringify(el).length;
      if (current.length && bytes + size > MAX_BATCH_BYTES) { batches.push([{ type: 'upsert', elements: current }]); current = []; bytes = 0; }
      current.push(el); bytes += size;
    }
    const last = [];
    if (current.length) last.push({ type: 'upsert', elements: current });
    if (outbox.deletes.size) last.push({ type: 'delete', ids: [...outbox.deletes] });
    if (outbox.app) last.push({ type: 'app', appState: outbox.app });
    if (last.length) batches.push(last);
    return batches;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.inflight) { this.again = true; return this.inflight; }
    if (!this.boardId || outboxEmpty(this.out)) return Promise.resolve();
    const boardId = this.boardId;
    const sending = this.out;
    this.out = emptyOutbox();
    this.sendingCount = sending.upserts.size + sending.deletes.size + (sending.app ? 1 : 0);
    this.sendingElements = sending.upserts.size + sending.deletes.size;
    this.inflight = (async () => {
      let ok = false;
      try {
        if (sending.upserts.size || sending.deletes.size) this.setStatus('saving');
        await this.persistOutbox(boardId, sending);
        for (const ops of this.batches(sending)) {
          const base = this.seq;
          const result = await request(`/boards/${encodeURIComponent(boardId)}/ops`, {
            method: 'POST', body: { base_seq: base, client: this.clientId, ops },
          });
          if (boardId === this.boardId && Number.isFinite(result?.seq)) {
            this.ownSeqs.add(result.seq);
            // Someone else wrote between our last known seq and this batch: pull and reconcile.
            const behind = Number.isFinite(result.previous_seq) && result.previous_seq > base;
            this.seq = Math.max(this.seq, result.seq);
            if (behind) this.onBehind?.();
          }
        }
        ok = true;
      } catch (error) {
        console.warn('[board] save failed', error);
        // Put the batch back without overwriting anything newer.
        for (const [id, el] of sending.upserts) if (!this.out.upserts.has(id)) this.out.upserts.set(id, el);
        for (const id of sending.deletes) if (!this.out.upserts.has(id)) this.out.deletes.add(id);
        if (sending.app && !this.out.app) this.out.app = sending.app;
        if (error instanceof HttpError && error.status === 404) { this.setStatus('error'); return; }
        this.setStatus('offline');
        this.retryDelay = Math.min(30000, this.retryDelay ? this.retryDelay * 2 : 2000);
      } finally {
        this.sendingCount = 0;
        this.sendingElements = 0;
        this.inflight = null;
      }
      await this.persistOutbox(boardId);
      if (ok) {
        this.retryDelay = 0;
        if (outboxEmpty(this.out)) this.setStatus(this.fileUploads.size ? 'saving' : 'saved');
        this.cacheSoon();
      }
      if (boardId === this.boardId && (this.again || !outboxEmpty(this.out))) {
        this.again = false;
        this.schedule(ok ? 300 : this.retryDelay);
      }
    })();
    return this.inflight;
  }

  flushOnExit() {
    if (!this.boardId || outboxEmpty(this.out)) return;
    const body = JSON.stringify({ base_seq: this.seq, client: this.clientId, ops: this.batches(this.out).flat() });
    if (body.length < 60000) {
      try { fetch(`${API}/boards/${encodeURIComponent(this.boardId)}/ops`, { method: 'POST', keepalive: true, headers: { 'content-type': 'application/json' }, body }); } catch { /* outbox in IndexedDB covers it */ }
    }
    this.persistOutbox(this.boardId);
  }

  cacheSoon() {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = setTimeout(() => this.onCache?.(), 2000);
  }

  writeCache(boardId, scene) {
    return idb.put('scenes', boardId, { scene, seq: this.seq, cached: Date.now() });
  }

  async fetchFile(boardId, id) {
    try {
      const response = await request(`/boards/${encodeURIComponent(boardId)}/files/${encodeURIComponent(id)}`);
      const blob = await response.blob();
      const dataURL = await blobToDataURL(blob);
      return { id, mimeType: blob.type, dataURL, created: Date.now() };
    } catch {
      return idb.get('files', id);
    }
  }
}
