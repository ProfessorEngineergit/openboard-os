// Whiteboard storage (docs/ARCHITECTURE.md, "Whiteboard-Speicher").
//
// Layout per board: <dataDir>/<id>/
//   meta.json      {id, name, created, updated, elements}
//   scene.json     last compacted state {seq, elements, appState, files}
//   ops.ndjson     append log, one accepted batch per line {seq, t, client, ops}
//   files/         image bytes (+ <id>.json with mime type)
//   snapshots/     <stamp>__<count>[__<reason>].json, hourly when changed, kept 14 days
// Deleted boards move to <dataDir>/.trash/.
//
// Every write is atomic (tmp + fsync + rename + directory fsync) and every board has a
// serialized queue, so concurrent requests never interleave. Ops are applied in memory,
// appended to the log with fsync, and compacted into scene.json after 500 ops or 2 MB.
//
// Element semantics: `upsert` replaces an element when its version is newer (ties: the
// lower versionNonce wins, like Excalidraw). Elements with isDeleted are kept as slim
// tombstones (points/text dropped) so clients reconcile deletions; tombstones older than
// 7 days are purged on compaction. `delete` removes ids outright.
import { mkdir, readFile, rename, open, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const LIMITS = {
  elements: 50000,               // per board
  elementBytes: 2 * 1024 * 1024, // per element (long freedraw strokes)
  opsBody: 8 * 1024 * 1024,      // per POST …/ops
  fileBytes: 15 * 1024 * 1024,   // per image
  nameLength: 80,
  boards: 500,
};
const COMPACT_OPS = 500;
const COMPACT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_INTERVAL = 60 * 60 * 1000;
const SNAPSHOT_KEEP = 14 * 24 * 60 * 60 * 1000;
const TOMBSTONE_KEEP = 7 * 24 * 60 * 60 * 1000;
const TRASH_KEEP = 30 * 24 * 60 * 60 * 1000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SNAP_ID = /^[0-9]{8}T[0-9]{6}(?:-[0-9]{3})?Z__[0-9]+(?:__[a-z-]+)?$/;
const ELEMENT_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'image', 'frame', 'magicframe', 'embeddable', 'iframe']);
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']);
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent|[a-z]{3,20})$/;
const SLIM_DROP = ['points', 'pressures', 'text', 'originalText', 'customData', 'lastCommittedPoint'];

class BoardError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new BoardError(status, message); };

// ---------- atomic file helpers ----------

async function fsyncDir(dir) {
  let handle;
  try { handle = await open(dir, 'r'); await handle.sync(); }
  catch (error) { if (error.code !== 'EISDIR' && error.code !== 'EINVAL' && error.code !== 'EPERM') throw error; }
  finally { await handle?.close(); }
}

export async function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, file);
  await fsyncDir(resolve(file, '..'));
}

async function appendSync(file, line) {
  const handle = await open(file, 'a', 0o600);
  try { await handle.writeFile(line); await handle.datasync(); } finally { await handle.close(); }
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

const exists = path => stat(path).then(() => true, () => false);

// ---------- validation ----------

function cleanName(name) {
  if (typeof name !== 'string') fail(400, 'name required');
  const value = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, LIMITS.nameLength);
  if (!value) fail(400, 'name required');
  return value;
}

export function validateElement(el) {
  if (!el || typeof el !== 'object' || Array.isArray(el)) fail(400, 'Invalid element');
  if (typeof el.id !== 'string' || !ID.test(el.id)) fail(400, 'Invalid element id');
  if (!ELEMENT_TYPES.has(el.type)) fail(400, `Invalid element type: ${String(el.type).slice(0, 30)}`);
  if (!Number.isFinite(el.version) || el.version < 0) fail(400, 'Invalid element version');
  for (const key of ['x', 'y', 'width', 'height']) if (el[key] !== undefined && !Number.isFinite(el[key])) fail(400, `Invalid element ${key}`);
  if (el.points !== undefined && !Array.isArray(el.points)) fail(400, 'Invalid element points');
  if (el.type === 'image' && el.fileId != null && (typeof el.fileId !== 'string' || !FILE_ID.test(el.fileId))) fail(400, 'Invalid fileId');
  const size = JSON.stringify(el).length;
  if (size > LIMITS.elementBytes) fail(413, 'Element too large');
  return size;
}

function slim(el) {
  const copy = { ...el };
  for (const key of SLIM_DROP) delete copy[key];
  if (Array.isArray(el.points)) copy.points = [];
  if (el.type === 'freedraw') copy.pressures = [];
  return copy;
}

function newer(incoming, current) {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return (incoming.versionNonce ?? 0) < (current.versionNonce ?? 0);
}

function validateApp(app) {
  if (!app || typeof app !== 'object') fail(400, 'Invalid appState');
  const out = {};
  if (app.viewBackgroundColor !== undefined) {
    if (typeof app.viewBackgroundColor !== 'string' || !COLOR.test(app.viewBackgroundColor)) fail(400, 'Invalid viewBackgroundColor');
    out.viewBackgroundColor = app.viewBackgroundColor;
  }
  for (const key of ['scrollX', 'scrollY']) {
    if (app[key] === undefined) continue;
    if (!Number.isFinite(app[key]) || Math.abs(app[key]) > 1e7) fail(400, `Invalid ${key}`);
    out[key] = app[key];
  }
  if (app.zoom !== undefined) {
    const value = typeof app.zoom === 'number' ? app.zoom : app.zoom?.value;
    if (!Number.isFinite(value) || value < 0.05 || value > 40) fail(400, 'Invalid zoom');
    out.zoom = { value };
  }
  return out;
}

function validateOps(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.ops)) fail(400, 'ops required');
  if (body.ops.length > 100) fail(400, 'Too many ops');
  const ops = [];
  for (const op of body.ops) {
    if (op?.type === 'upsert') {
      if (!Array.isArray(op.elements)) fail(400, 'upsert.elements required');
      if (op.elements.length > LIMITS.elements) fail(413, 'Too many elements');
      for (const el of op.elements) validateElement(el);
      ops.push({ type: 'upsert', elements: op.elements });
    } else if (op?.type === 'delete') {
      if (!Array.isArray(op.ids) || op.ids.some(id => typeof id !== 'string' || !ID.test(id))) fail(400, 'delete.ids invalid');
      ops.push({ type: 'delete', ids: op.ids });
    } else if (op?.type === 'app') {
      ops.push({ type: 'app', appState: validateApp(op.appState) });
    } else fail(400, `Unknown op: ${String(op?.type).slice(0, 30)}`);
  }
  const client = typeof body.client === 'string' && ID.test(body.client) ? body.client : null;
  const baseSeq = Number.isInteger(body.base_seq) ? body.base_seq : null;
  return { ops, client, baseSeq };
}

// ---------- legacy migration (kiosk/whiteboard.html format) ----------

const LEGACY_INK = '#182633';
const randomInt = () => randomBytes(4).readUInt32BE(0) >>> 1;
const randomId = () => randomBytes(16).toString('base64url').slice(0, 21);

export function convertLegacy(data) {
  const strokes = Array.isArray(data?.strokes) ? data.strokes : [];
  let start = 0;
  strokes.forEach((stroke, index) => { if (stroke?.clear === true) start = index + 1; });
  const elements = [];
  let skippedErase = 0, skippedInvalid = 0;
  const now = Date.now();
  for (const stroke of strokes.slice(start)) {
    if (stroke?.erase) { skippedErase++; continue; }
    const raw = Array.isArray(stroke?.points) ? stroke.points.filter(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)) : [];
    if (!raw.length) { skippedInvalid++; continue; }
    // Old strokes were straight polylines; densify so perfect-freehand's streamline keeps corners.
    const points = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      const a = raw[i - 1], b = raw[i];
      const steps = Math.min(200, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 3));
      for (let s = 1; s < steps; s++) points.push({ x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps });
      points.push(b);
    }
    const x0 = points[0].x, y0 = points[0].y;
    const rel = points.map(p => [p.x - x0, p.y - y0]);
    if (rel.length === 1) rel.push([0.0001, 0.0001]);
    const xs = rel.map(p => p[0]), ys = rel.map(p => p[1]);
    const width = Number.isFinite(stroke.width) ? stroke.width : 4;
    elements.push({
      type: 'freedraw', id: randomId(), x: x0, y: y0,
      width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), angle: 0,
      strokeColor: !stroke.color || stroke.color.toLowerCase() === LEGACY_INK ? '#1e1e1e' : stroke.color,
      backgroundColor: 'transparent', fillStyle: 'solid',
      // Old strokes were constant-width lines; perfect-freehand at pressure 0.5 renders ≈ 6 × strokeWidth.
      strokeWidth: Math.round((width / 6) * 100) / 100, strokeStyle: 'solid', roughness: 0, opacity: 100,
      groupIds: [], frameId: null, roundness: null, seed: randomInt(), version: 1, versionNonce: randomInt(),
      isDeleted: false, boundElements: null, updated: now, link: null, locked: false,
      points: rel, pressures: rel.map(() => 0.5), simulatePressure: false, lastCommittedPoint: rel[rel.length - 1],
    });
  }
  return { elements, skippedErase, skippedInvalid, dark: !!data?.dark };
}

// ---------- store ----------

export class BoardStore {
  constructor({ dataDir, emit = () => {}, legacyFile, log = () => {} }) {
    this.dir = resolve(dataDir);
    this.trash = join(this.dir, '.trash');
    this.emit = emit;
    this.log = log;
    this.legacyFile = legacyFile ?? resolve(this.dir, '..', 'whiteboard', 'current.json');
    this.boards = new Map();     // id -> loaded state
    this.queues = new Map();     // id -> promise chain
    this.ready = this.init();
    this.ready.catch(error => log(`board-store init failed: ${error.message}`));
  }

  async init() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.purgeTrash().catch(() => {});
    const ids = await this.boardIds();
    if (!ids.length) {
      const migrated = await this.migrateLegacy();
      if (!migrated) await this.createBoard({ name: 'Whiteboard' });
    }
  }

  async migrateLegacy() {
    const legacy = await readJson(this.legacyFile).catch(() => null);
    if (!legacy) return null;
    const { elements, skippedErase, skippedInvalid, dark } = convertLegacy(legacy);
    const board = await this.createBoard({
      name: 'Whiteboard',
      elements,
      migratedFrom: { file: 'whiteboard/current.json', at: new Date().toISOString(), strokes: elements.length, skippedErase, skippedInvalid, dark },
    });
    this.log(`board-store: migrated ${elements.length} strokes from ${this.legacyFile}` + (skippedErase ? ` (${skippedErase} eraser strokes skipped)` : ''));
    return board;
  }

  boardDir(id) {
    if (typeof id !== 'string' || !ID.test(id)) fail(400, 'Invalid board id');
    return join(this.dir, id);
  }

  async boardIds() {
    const entries = await readdir(this.dir, { withFileTypes: true }).catch(() => []);
    const ids = [];
    for (const entry of entries) {
      if (entry.isDirectory() && ID.test(entry.name) && !entry.name.startsWith('.') && await exists(join(this.dir, entry.name, 'meta.json'))) ids.push(entry.name);
    }
    return ids;
  }

  queue(id, task) {
    const previous = this.queues.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    this.queues.set(id, tail);
    tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return next;
  }

  // Loads a board into memory: scene.json + replay of ops.ndjson (seq > scene.seq).
  async load(id) {
    const cached = this.boards.get(id);
    if (cached) return cached;
    const dir = this.boardDir(id);
    const meta = await readJson(join(dir, 'meta.json'));
    if (!meta) fail(404, 'Board not found');
    const scene = await readJson(join(dir, 'scene.json'), { seq: 0, elements: [], appState: {}, files: {} });
    const state = {
      id, dir, meta,
      seq: scene.seq || 0,
      elements: new Map((scene.elements || []).map(el => [el.id, el])),
      appState: scene.appState || {},
      files: scene.files || {},
      opsCount: 0, opsBytes: 0,
      snapshotSeq: 0, lastSnapshot: 0,
    };
    let log = '';
    try { log = await readFile(join(dir, 'ops.ndjson'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const line of log.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // torn last line after a crash
      state.opsCount++;
      state.opsBytes += line.length + 1;
      if (entry.seq <= state.seq) continue;
      this.applyToState(state, entry.ops);
      state.seq = entry.seq;
    }
    state.snapshotSeq = Number.isInteger(meta.snapshotSeq) ? Math.min(meta.snapshotSeq, state.seq) : 0;
    state.lastSnapshot = await this.latestSnapshotTime(dir);
    this.boards.set(id, state);
    return state;
  }

  applyToState(state, ops) {
    let elementsChanged = false;
    for (const op of ops) {
      if (op.type === 'upsert') {
        for (const el of op.elements) {
          const current = state.elements.get(el.id);
          if (!newer(el, current)) continue;
          state.elements.set(el.id, el.isDeleted ? slim(el) : el);
          elementsChanged = true;
        }
      } else if (op.type === 'delete') {
        for (const id of op.ids) if (state.elements.delete(id)) elementsChanged = true;
      } else if (op.type === 'app') {
        state.appState = { ...state.appState, ...op.appState };
      } else if (op.type === 'file' && op.file?.id) {
        state.files = { ...state.files, [op.file.id]: op.file };
      }
    }
    return elementsChanged;
  }

  sceneOf(state, { tombstones = true } = {}) {
    const elements = [...state.elements.values()].filter(el => tombstones || !el.isDeleted);
    return { elements, appState: state.appState, files: state.files };
  }

  liveCount(state) {
    let n = 0;
    for (const el of state.elements.values()) if (!el.isDeleted) n++;
    return n;
  }

  async writeMeta(state) {
    state.meta = { ...state.meta, elements: this.liveCount(state) };
    await atomicWrite(join(state.dir, 'meta.json'), JSON.stringify(state.meta));
  }

  async compact(state) {
    const cutoff = Date.now() - TOMBSTONE_KEEP;
    for (const [id, el] of state.elements) if (el.isDeleted && (el.updated || 0) < cutoff) state.elements.delete(id);
    await atomicWrite(join(state.dir, 'scene.json'), JSON.stringify({ seq: state.seq, ...this.sceneOf(state) }));
    await atomicWrite(join(state.dir, 'ops.ndjson'), '');
    state.opsCount = 0;
    state.opsBytes = 0;
    await this.writeMeta(state);
  }

  // ---------- public operations ----------

  async list() {
    await this.ready;
    const boards = [];
    for (const id of await this.boardIds()) {
      const dir = join(this.dir, id);
      const meta = await readJson(join(dir, 'meta.json')).catch(() => null);
      if (!meta) continue;
      const loaded = this.boards.get(id);
      let updated = loaded?.meta.updated ?? meta.updated ?? meta.created;
      if (!loaded) {
        const log = await stat(join(dir, 'ops.ndjson')).catch(() => null);
        if (log && log.size) updated = Math.max(updated || 0, log.mtimeMs);
      }
      boards.push({
        id, name: meta.name, created: meta.created, updated: Math.round(updated || 0),
        elements: loaded ? this.liveCount(loaded) : meta.elements,
      });
    }
    boards.sort((a, b) => b.updated - a.updated);
    return boards;
  }

  async createBoard({ name, elements = [], migratedFrom } = {}) {
    const ids = await this.boardIds();
    if (ids.length >= LIMITS.boards) fail(409, 'Too many boards');
    const id = `b${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const dir = join(this.dir, id);
    await mkdir(join(dir, 'files'), { recursive: true, mode: 0o700 });
    await mkdir(join(dir, 'snapshots'), { recursive: true, mode: 0o700 });
    const now = Date.now();
    const meta = { id, name: cleanName(name ?? 'Whiteboard'), created: now, updated: now, elements: elements.length, ...(migratedFrom ? { migratedFrom } : {}) };
    await atomicWrite(join(dir, 'scene.json'), JSON.stringify({ seq: 0, elements, appState: {}, files: {} }));
    await atomicWrite(join(dir, 'meta.json'), JSON.stringify(meta));
    await fsyncDir(this.dir);
    this.emit('board.changed', { id, seq: 0, kind: 'created' });
    return { id, name: meta.name, created: now, updated: now, elements: elements.length };
  }

  async get(id) {
    await this.ready;
    return this.queue(id, async () => {
      const state = await this.load(id);
      return { id, name: state.meta.name, seq: state.seq, scene: this.sceneOf(state) };
    });
  }

  async rename(id, name) {
    await this.ready;
    const value = cleanName(name);
    return this.queue(id, async () => {
      const state = await this.load(id);
      state.meta = { ...state.meta, name: value, updated: Date.now() };
      await this.writeMeta(state);
      this.emit('board.changed', { id, seq: state.seq, kind: 'renamed' });
      return { id, name: value };
    });
  }

  async remove(id) {
    await this.ready;
    const dir = this.boardDir(id);
    const result = await this.queue(id, async () => {
      if (!await exists(join(dir, 'meta.json'))) fail(404, 'Board not found');
      await mkdir(this.trash, { recursive: true, mode: 0o700 });
      const target = join(this.trash, `${id}--${Date.now()}`);
      await rename(dir, target);
      await fsyncDir(this.dir);
      this.boards.delete(id);
      return { ok: true, trashed: true };
    });
    this.emit('board.changed', { id, seq: 0, kind: 'deleted' });
    if (!(await this.boardIds()).length) await this.createBoard({ name: 'Whiteboard' });
    return result;
  }

  async applyOps(id, body) {
    await this.ready;
    const { ops, client, baseSeq } = validateOps(body);
    return this.queue(id, async () => {
      const state = await this.load(id);
      const previous = state.seq;
      // Hourly snapshot of the state before this session's changes.
      if (state.seq > state.snapshotSeq && Date.now() - state.lastSnapshot >= SNAPSHOT_INTERVAL) await this.snapshot(state);
      // Size guard before touching anything.
      let added = 0;
      for (const op of ops) if (op.type === 'upsert') for (const el of op.elements) if (!state.elements.has(el.id)) added++;
      if (state.elements.size + added > LIMITS.elements) fail(413, 'Board has too many elements');
      const changed = this.applyToState(state, ops);
      state.seq += 1;
      const line = JSON.stringify({ seq: state.seq, t: Date.now(), client, ops }) + '\n';
      await appendSync(join(state.dir, 'ops.ndjson'), line);
      state.opsCount++;
      state.opsBytes += line.length;
      if (changed) state.meta = { ...state.meta, updated: Date.now() };
      if (state.opsCount >= COMPACT_OPS || state.opsBytes >= COMPACT_BYTES) await this.compact(state);
      if (changed) this.emit('board.changed', { id, seq: state.seq, client, kind: 'ops' });
      return { seq: state.seq, previous_seq: previous, base_seq: baseSeq };
    });
  }

  async putFile(id, fileId, bytes, mimeType) {
    await this.ready;
    if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) fail(400, 'Invalid file id');
    const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) fail(415, 'Unsupported image type');
    if (!bytes.length) fail(400, 'Empty file');
    if (bytes.length > LIMITS.fileBytes) fail(413, 'File too large');
    return this.queue(id, async () => {
      const state = await this.load(id);
      const dir = join(state.dir, 'files');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await atomicWrite(join(dir, fileId), bytes);
      const meta = { id: fileId, mimeType: type, size: bytes.length, created: Date.now() };
      await atomicWrite(join(dir, `${fileId}.json`), JSON.stringify(meta));
      state.files = { ...state.files, [fileId]: meta };
      // Recorded in the log so a crash before compaction keeps the file reference.
      state.seq += 1;
      await appendSync(join(state.dir, 'ops.ndjson'), JSON.stringify({ seq: state.seq, t: Date.now(), ops: [{ type: 'file', file: meta }] }) + '\n');
      state.opsCount++;
      return { ok: true, id: fileId, size: bytes.length };
    });
  }

  async getFile(id, fileId) {
    await this.ready;
    if (typeof fileId !== 'string' || !FILE_ID.test(fileId)) fail(400, 'Invalid file id');
    const dir = join(this.boardDir(id), 'files');
    const meta = await readJson(join(dir, `${fileId}.json`));
    if (!meta) fail(404, 'File not found');
    return { meta, bytes: await readFile(join(dir, fileId)) };
  }

  async latestSnapshotTime(dir) {
    const list = await this.snapshotFiles(dir);
    return list.length ? list[0].created : 0;
  }

  async snapshotFiles(dir) {
    const names = await readdir(join(dir, 'snapshots')).catch(() => []);
    const list = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const snapId = name.slice(0, -5);
      if (!SNAP_ID.test(snapId)) continue;
      const [stamp, count, reason] = snapId.split('__');
      const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}${stamp.length > 16 ? '.' + stamp.slice(16, 19) : ''}Z`;
      list.push({ id: snapId, created: Date.parse(iso), elements: Number(count), ...(reason ? { reason } : {}) });
    }
    return list.sort((a, b) => b.created - a.created);
  }

  async snapshot(state, reason) {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace('.', '-');
    const name = `${stamp}__${this.liveCount(state)}${reason ? `__${reason}` : ''}`;
    const dir = join(state.dir, 'snapshots');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await atomicWrite(join(dir, `${name}.json`), JSON.stringify({ seq: state.seq, created: now.getTime(), ...this.sceneOf(state, { tombstones: false }) }));
    state.lastSnapshot = now.getTime();
    state.snapshotSeq = state.seq;
    state.meta = { ...state.meta, snapshotSeq: state.seq };
    await this.writeMeta(state);
    // Retention: 14 days.
    for (const snap of await this.snapshotFiles(state.dir)) {
      if (now.getTime() - snap.created > SNAPSHOT_KEEP) await rm(join(dir, `${snap.id}.json`), { force: true });
    }
    return name;
  }

  async snapshots(id) {
    await this.ready;
    return this.queue(id, async () => {
      const state = await this.load(id);
      return this.snapshotFiles(state.dir);
    });
  }

  async restore(id, snapId) {
    await this.ready;
    if (typeof snapId !== 'string' || !SNAP_ID.test(snapId)) fail(400, 'Invalid snapshot id');
    return this.queue(id, async () => {
      const state = await this.load(id);
      const data = await readJson(join(state.dir, 'snapshots', `${snapId}.json`));
      if (!data) fail(404, 'Snapshot not found');
      await this.snapshot(state, 'pre-restore');
      // Elements that did not exist in the snapshot become tombstones with a higher
      // version, so clients holding them locally drop them on reconcile.
      const next = new Map();
      const now = Date.now();
      for (const el of data.elements || []) {
        const current = state.elements.get(el.id);
        const version = Math.max(el.version || 1, (current?.version || 0) + 1);
        next.set(el.id, { ...el, version, versionNonce: randomInt(), updated: now });
      }
      for (const [elId, el] of state.elements) {
        if (!next.has(elId)) next.set(elId, slim({ ...el, isDeleted: true, version: (el.version || 0) + 1, versionNonce: randomInt(), updated: now }));
      }
      state.elements = next;
      state.appState = { ...state.appState, ...(data.appState || {}) };
      state.seq += 1;
      state.meta = { ...state.meta, updated: now };
      await this.compact(state);
      state.snapshotSeq = state.seq;
      this.emit('board.changed', { id, seq: state.seq, kind: 'restore' });
      return { ok: true, seq: state.seq };
    });
  }

  // Hourly snapshots for boards that changed but were not touched again.
  async tick() {
    for (const state of this.boards.values()) {
      if (state.seq > state.snapshotSeq && Date.now() - state.lastSnapshot >= SNAPSHOT_INTERVAL) {
        await this.queue(state.id, () => this.snapshot(state)).catch(error => this.log(`board-store snapshot failed: ${error.message}`));
      }
    }
  }

  async purgeTrash() {
    const entries = await readdir(this.trash).catch(() => []);
    for (const name of entries) {
      const at = Number(name.split('--')[1]);
      if (Number.isFinite(at) && Date.now() - at > TRASH_KEEP) await rm(join(this.trash, name), { recursive: true, force: true });
    }
  }

  // Waits for all queued writes, then compacts loaded boards (used on shutdown and in tests).
  async close() {
    clearInterval(this.timer);
    await this.ready.catch(() => {});
    for (const state of this.boards.values()) await this.queue(state.id, () => (state.opsCount ? this.compact(state) : null)).catch(() => {});
  }
}

// ---------- HTTP routes ----------

export function registerBoardRoutes(router, { dataDir, emit = () => {}, legacyFile, log } = {}) {
  const store = new BoardStore({ dataDir, emit, legacyFile, log });
  store.timer = setInterval(() => store.tick(), 10 * 60 * 1000);
  store.timer.unref?.();
  const base = '/api/local/board/boards';
  const wrap = handler => async ctx => {
    try { return await handler(ctx); }
    catch (error) {
      if (error instanceof SyntaxError) throw Object.assign(new Error('Invalid JSON'), { status: 400 });
      if (error.code === 'ENOENT') throw Object.assign(new Error('Not found'), { status: 404 });
      throw error;
    }
  };

  router.get(base, wrap(() => store.list()));
  router.post(base, wrap(async ctx => {
    const body = await ctx.body();
    return store.createBoard({ name: body.name ?? 'Neues Board' });
  }), { access: 'local', limit: 16 * 1024 });
  router.get(`${base}/:id`, wrap(ctx => store.get(ctx.params.id)));
  router.patch(`${base}/:id`, wrap(async ctx => store.rename(ctx.params.id, (await ctx.body()).name)), { access: 'local', limit: 16 * 1024 });
  router.delete(`${base}/:id`, wrap(ctx => store.remove(ctx.params.id)));
  router.post(`${base}/:id/ops`, wrap(async ctx => store.applyOps(ctx.params.id, await ctx.body())), { access: 'local', limit: LIMITS.opsBody });
  router.put(`${base}/:id/files/:fileId`, wrap(async ctx => {
    const bytes = await ctx.raw();
    return store.putFile(ctx.params.id, ctx.params.fileId, bytes, ctx.req.headers['content-type']);
  }), { access: 'local', limit: LIMITS.fileBytes + 1024 });
  router.get(`${base}/:id/files/:fileId`, wrap(async ctx => {
    const { meta, bytes } = await store.getFile(ctx.params.id, ctx.params.fileId);
    ctx.res.writeHead(200, {
      'content-type': meta.mimeType, 'content-length': bytes.length,
      'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff',
      // SVGs are only ever rendered as <img>; opened directly they must stay inert.
      'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
    });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : bytes);
  }));
  router.get(`${base}/:id/snapshots`, wrap(ctx => store.snapshots(ctx.params.id)));
  router.post(`${base}/:id/snapshots/:snap/restore`, wrap(ctx => store.restore(ctx.params.id, ctx.params.snap)));
  return store;
}
