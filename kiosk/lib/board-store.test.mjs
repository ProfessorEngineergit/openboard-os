// node --test kiosk/lib/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, appendFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBoardRoutes, convertLegacy, LIMITS } from './board-store.mjs';

// Fake router with the same surface as lib/router.mjs (get/post/put/patch/delete + ctx).
function fakeRouter() {
  const routes = [];
  const add = method => (pattern, handler, options = {}) => {
    const keys = [];
    const source = pattern.replace(/\/:([a-zA-Z_]+)/g, (_, key) => { keys.push(key); return '/([^/]+)'; });
    routes.push({ method, regex: new RegExp(`^${source}$`), keys, handler, options });
  };
  async function call(method, path, { body, raw, headers = {} } = {}) {
    const url = new URL(path, 'http://localhost:4180');
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      const limit = route.options.limit ?? 64 * 1024;
      const buffer = raw ?? Buffer.from(body === undefined ? '' : JSON.stringify(body));
      const response = { status: 200, headers: {}, body: undefined, headersSent: false };
      const res = {
        writeHead(status, h) { response.status = status; response.headers = h; response.headersSent = true; },
        end(data) { response.body = data; },
        get headersSent() { return response.headersSent; },
      };
      const ctx = {
        req: { method, headers }, res, url,
        params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])])),
        raw: async () => { if (buffer.length > limit) throw Object.assign(new Error('Request too large'), { status: 413 }); return buffer; },
        body: async () => { if (buffer.length > limit) throw Object.assign(new Error('Request too large'), { status: 413 }); return buffer.length ? JSON.parse(buffer.toString()) : {}; },
        json: (status, data) => { response.status = status; response.body = data; response.headersSent = true; },
      };
      try {
        const result = await route.handler(ctx);
        if (result !== undefined && !response.headersSent) response.body = result;
      } catch (error) {
        response.status = error.status || 400;
        response.body = { error: error.message };
      }
      return response;
    }
    return { status: 404, body: { error: 'Not found' } };
  }
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), call, routes };
}

async function setup({ legacy } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'board-store-'));
  const dataDir = join(root, 'boards');
  if (legacy) {
    await mkdir(join(root, 'whiteboard'), { recursive: true });
    await writeFile(join(root, 'whiteboard', 'current.json'), JSON.stringify(legacy));
  }
  const events = [];
  const router = fakeRouter();
  const store = registerBoardRoutes(router, { dataDir, emit: (type, data) => events.push({ type, data }) });
  await store.ready;
  return { root, dataDir, events, router, store, call: router.call, cleanup: async () => { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

let counter = 0;
function element(overrides = {}) {
  counter++;
  return {
    id: `el${counter}`, type: 'rectangle', x: 10, y: 20, width: 100, height: 50, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2,
    strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 1, version: 1, versionNonce: 100, isDeleted: false, boundElements: null, updated: Date.now(),
    link: null, locked: false, ...overrides,
  };
}

const B = '/api/local/board/boards';

test('registers exactly the documented routes', async () => {
  const t = await setup();
  try {
    const list = t.router.routes.map(r => `${r.method} ${r.regex.source.replace(/\(\[\^\/\]\+\)/g, ':p').replace(/^\^|\$$/g, '').replaceAll('\\/', '/')}`);
    assert.deepEqual(list.sort(), [
      'DELETE /api/local/board/boards/:p',
      'GET /api/local/board/boards',
      'GET /api/local/board/boards/:p',
      'GET /api/local/board/boards/:p/files/:p',
      'GET /api/local/board/boards/:p/snapshots',
      'PATCH /api/local/board/boards/:p',
      'POST /api/local/board/boards',
      'POST /api/local/board/boards/:p/ops',
      'POST /api/local/board/boards/:p/snapshots/:p/restore',
      'PUT /api/local/board/boards/:p/files/:p',
    ]);
    assert.ok(t.router.routes.every(r => (r.options.access ?? 'local') === 'local'));
  } finally { await t.cleanup(); }
});

test('creates a default board when none exist', async () => {
  const t = await setup();
  try {
    const { status, body } = await t.call('GET', B);
    assert.equal(status, 200);
    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'Whiteboard');
    const board = await t.call('GET', `${B}/${body[0].id}`);
    assert.deepEqual(board.body.scene.elements, []);
    assert.equal(board.body.seq, 0);
  } finally { await t.cleanup(); }
});

test('migrates the legacy whiteboard (after last clear, file untouched)', async () => {
  const legacy = {
    dark: true,
    strokes: [
      { color: '#258ef1', width: 4, erase: false, points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
      { clear: true },
      { color: '#182633', width: 8, erase: false, points: [{ x: 100, y: 200 }, { x: 110, y: 230 }, { x: 140, y: 260 }] },
      { color: '#ef5263', width: 36, erase: true, points: [{ x: 5, y: 5 }] },
      { color: '#21ab83', width: 16, erase: false, points: [{ x: 50, y: 60 }] },
    ],
  };
  const t = await setup({ legacy });
  try {
    const { body: boards } = await t.call('GET', B);
    assert.equal(boards.length, 1);
    assert.equal(boards[0].name, 'Whiteboard');
    const { body } = await t.call('GET', `${B}/${boards[0].id}`);
    const els = body.scene.elements;
    assert.equal(els.length, 2);
    assert.ok(els.every(e => e.type === 'freedraw' && !e.isDeleted));
    assert.equal(els[0].strokeColor, '#1e1e1e'); // legacy ink → Excalidraw ink
    assert.equal(els[0].x, 100);
    assert.deepEqual(els[0].points[0], [0, 0]);
    assert.deepEqual(els[0].points.at(-1), [40, 60]);
    assert.ok(els[0].points.length > 3, 'densified');
    assert.equal(els[0].width, 40);
    assert.equal(els[0].pressures.length, els[0].points.length);
    assert.equal(els[1].points.length, 2); // single point becomes a dot
    const meta = JSON.parse(await readFile(join(t.dataDir, boards[0].id, 'meta.json'), 'utf8'));
    assert.equal(meta.migratedFrom.erasers, 1);
    assert.equal(meta.migratedFrom.skippedErase, 0);
    const original = JSON.parse(await readFile(join(t.root, 'whiteboard', 'current.json'), 'utf8'));
    assert.deepEqual(original, legacy);
  } finally { await t.cleanup(); }
});

test('convertLegacy applies eraser strokes by cutting earlier strokes (clears reset, later strokes untouched)', () => {
  const line = (color, y) => ({ color, width: 4, erase: false, points: [{ x: 0, y }, { x: 300, y }] });
  const eraser = (points, width = 36) => ({ color: '#ef5263', width, erase: true, points });
  const { elements, erasers, skippedErase } = convertLegacy({
    dark: false,
    strokes: [
      line('#ff0000', 0),                                  // before a clear: dropped entirely
      { clear: true },
      line('#258ef1', 0),                                  // cut in the middle
      line('#21ab83', 100),                                // untouched (far from the eraser)
      line('#ef5263', 8),                                  // fully erased (all points within the radius)
      eraser([{ x: 100, y: -30 }, { x: 150, y: 30 }]),     // passes x 100..150 at |y| <= 18 + slack
      { color: '#182633', width: 8, erase: false, points: [{ x: 120, y: 0 }] }, // drawn after the eraser: stays
      eraser([{ x: 1000, y: 1000 }]),                      // erases nothing
    ],
  });
  assert.equal(erasers, 2);
  assert.equal(skippedErase, 0);
  const blue = elements.filter(e => e.strokeColor === '#258ef1');
  assert.equal(blue.length, 2, 'the blue line is split in two');
  assert.ok(blue[0].x === 0 && blue[0].x + blue[0].width < 100 + 1, 'left part ends where the eraser starts');
  assert.ok(blue[1].x > 150 - 20 && blue[1].x + blue[1].width === 300, 'right part starts behind the eraser');
  assert.equal(elements.filter(e => e.strokeColor === '#21ab83').length, 1);
  assert.equal(elements.filter(e => e.strokeColor === '#ff0000').length, 0);
  assert.equal(elements.filter(e => e.strokeColor === '#1e1e1e').length, 1, 'stroke after the eraser is kept');
  assert.ok(elements.every(e => e.points.length >= 2 && e.pressures.length === e.points.length));
});

test('convertLegacy keeps a single-point eraser dot from removing distant strokes and handles a long history', () => {
  const strokes = [];
  for (let i = 0; i < 2000; i++) strokes.push({ color: '#258ef1', width: 4, erase: false, points: [{ x: i, y: 0 }, { x: i + 20, y: 30 }] });
  strokes.push({ color: '#ef5263', width: 36, erase: true, points: [{ x: 1000, y: 10 }] });
  const t0 = Date.now();
  const { elements } = convertLegacy({ strokes, dark: true });
  assert.ok(Date.now() - t0 < 3000, 'eraser pass over 2000 strokes stays fast');
  assert.ok(elements.length > 1950 && elements.length < 2060, String(elements.length));
});

test('convertLegacy handles empty and malformed data', () => {
  assert.deepEqual(convertLegacy(null).elements, []);
  const r = convertLegacy({ strokes: [{ color: '#000000', width: 4, erase: false, points: [] }, { points: [{ x: 'a' }] }] });
  assert.equal(r.elements.length, 0);
  assert.equal(r.skippedInvalid, 2);
});

test('ops: upsert, version rules, tombstones, delete, app; seq and events', async () => {
  const t = await setup();
  try {
    const { body: [board] } = await t.call('GET', B);
    const a = element(), b = element({ type: 'freedraw', points: [[0, 0], [5, 5]], pressures: [], simulatePressure: true });
    let r = await t.call('POST', `${B}/${board.id}/ops`, { body: { base_seq: 0, client: 'c1', ops: [{ type: 'upsert', elements: [a, b] }] } });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { seq: 1, previous_seq: 0, base_seq: 0 });
    assert.deepEqual(t.events.at(-1), { type: 'board.changed', data: { id: board.id, seq: 1, client: 'c1', kind: 'ops' } });

    // Older version is ignored, newer wins.
    await t.call('POST', `${B}/${board.id}/ops`, { body: { base_seq: 1, ops: [{ type: 'upsert', elements: [{ ...a, version: 0, x: 999 }] }] } });
    r = await t.call('GET', `${B}/${board.id}`);
    assert.equal(r.body.scene.elements.find(e => e.id === a.id).x, 10);
    await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [{ ...a, version: 2, x: 42 }] }] } });

    // Soft delete keeps a slim tombstone.
    await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [{ ...b, version: 2, isDeleted: true }] }] } });
    r = await t.call('GET', `${B}/${board.id}`);
    const tomb = r.body.scene.elements.find(e => e.id === b.id);
    assert.equal(tomb.isDeleted, true);
    assert.deepEqual(tomb.points, []);
    assert.equal(r.body.scene.elements.find(e => e.id === a.id).x, 42);

    // Hard delete and app state.
    r = await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'delete', ids: [b.id] }, { type: 'app', appState: { viewBackgroundColor: '#ffffff', scrollX: 10.5, scrollY: -3, zoom: { value: 1.25 }, evil: 'x' } }] } });
    assert.equal(r.body.seq, 5);
    r = await t.call('GET', `${B}/${board.id}`);
    assert.equal(r.body.scene.elements.length, 1);
    assert.deepEqual(r.body.scene.appState, { viewBackgroundColor: '#ffffff', scrollX: 10.5, scrollY: -3, zoom: { value: 1.25 } });
    const list = (await t.call('GET', B)).body;
    assert.equal(list[0].elements, 1);
  } finally { await t.cleanup(); }
});

test('validation and limits', async () => {
  const t = await setup();
  try {
    const { body: [board] } = await t.call('GET', B);
    const bad = async (ops, status = 400) => {
      const r = await t.call('POST', `${B}/${board.id}/ops`, { body: { ops } });
      assert.equal(r.status, status, JSON.stringify(r.body));
    };
    await bad([{ type: 'upsert', elements: [element({ id: '../x' })] }]);
    await bad([{ type: 'upsert', elements: [element({ type: 'script' })] }]);
    await bad([{ type: 'upsert', elements: [element({ version: 'x' })] }]);
    await bad([{ type: 'upsert', elements: [element({ x: Infinity })] }]);
    await bad([{ type: 'delete', ids: ['a/b'] }]);
    await bad([{ type: 'app', appState: { zoom: { value: 1000 } } }]);
    await bad([{ type: 'app', appState: { viewBackgroundColor: 'url(javascript:1)' } }]);
    await bad([{ type: 'nope' }]);
    await bad([{ type: 'upsert', elements: [element({ type: 'freedraw', points: new Array(200000).fill([123.456789, 987.654321]) })] }], 413);
    assert.equal((await t.call('GET', `${B}/..%2F..%2Fetc`)).status, 400);
    assert.equal((await t.call('GET', `${B}/doesnotexist`)).status, 404);
    assert.equal((await t.call('POST', `${B}/doesnotexist/ops`, { body: { ops: [] } })).status, 404);
    assert.equal((await t.call('POST', B, { body: { name: '   ' } })).status, 400);
    const huge = Buffer.alloc(LIMITS.opsBody + 10, 32);
    assert.equal((await t.call('POST', `${B}/${board.id}/ops`, { raw: huge })).status, 413);
    // Nothing was written by the rejected requests.
    assert.equal((await t.call('GET', `${B}/${board.id}`)).body.seq, 0);
  } finally { await t.cleanup(); }
});

test('files: put/get, type and size limits', async () => {
  const t = await setup();
  try {
    const { body: [board] } = await t.call('GET', B);
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    let r = await t.call('PUT', `${B}/${board.id}/files/abc123`, { raw: png, headers: { 'content-type': 'image/png' } });
    assert.equal(r.status, 200);
    r = await t.call('GET', `${B}/${board.id}/files/abc123`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.match(r.headers['content-security-policy'], /sandbox/);
    assert.deepEqual(Buffer.from(r.body), png);
    r = await t.call('GET', `${B}/${board.id}`);
    assert.equal(r.body.scene.files.abc123.mimeType, 'image/png');
    assert.equal((await t.call('PUT', `${B}/${board.id}/files/x1`, { raw: png, headers: { 'content-type': 'text/html' } })).status, 415);
    assert.equal((await t.call('PUT', `${B}/${board.id}/files/..%2Fx`, { raw: png, headers: { 'content-type': 'image/png' } })).status, 400);
    const big = Buffer.alloc(LIMITS.fileBytes + 1);
    assert.equal((await t.call('PUT', `${B}/${board.id}/files/big`, { raw: big, headers: { 'content-type': 'image/png' } })).status, 413);
    assert.equal((await t.call('GET', `${B}/${board.id}/files/missing`)).status, 404);
  } finally { await t.cleanup(); }
});

test('persists across restarts: ops log replay, torn last line, file references', async () => {
  const t = await setup();
  try {
    const { body: [board] } = await t.call('GET', B);
    const a = element();
    await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [a] }] } });
    await t.call('PUT', `${B}/${board.id}/files/f1`, { raw: Buffer.from('<svg/>'), headers: { 'content-type': 'image/svg+xml' } });
    await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [{ ...a, version: 3, x: 7 }] }] } });
    await appendFile(join(t.dataDir, board.id, 'ops.ndjson'), '{"seq":99,"ops":[{"type":"ups'); // crash mid-write
    const router = fakeRouter();
    const again = registerBoardRoutes(router, { dataDir: t.dataDir });
    const r = await router.call('GET', `${B}/${board.id}`);
    assert.equal(r.body.seq, 3);
    assert.equal(r.body.scene.elements[0].x, 7);
    assert.ok(r.body.scene.files.f1);
    clearInterval(again.timer);
  } finally { await t.cleanup(); }
});

test('compaction after 500 ops keeps state and truncates the log', async () => {
  const t = await setup();
  try {
    const { body: [board] } = await t.call('GET', B);
    const a = element();
    for (let i = 1; i <= 501; i++) {
      await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [{ ...a, version: i, x: i }] }] } });
    }
    const dir = join(t.dataDir, board.id);
    const scene = JSON.parse(await readFile(join(dir, 'scene.json'), 'utf8'));
    assert.equal(scene.seq, 500);
    assert.equal(scene.elements[0].x, 500);
    const log = await readFile(join(dir, 'ops.ndjson'), 'utf8');
    assert.equal(log.trim().split('\n').length, 1);
    const router = fakeRouter();
    const again = registerBoardRoutes(router, { dataDir: t.dataDir });
    const r = await router.call('GET', `${B}/${board.id}`);
    assert.equal(r.body.seq, 501);
    assert.equal(r.body.scene.elements[0].x, 501);
    clearInterval(again.timer);
    // No temp files left behind by atomic writes.
    assert.ok(!(await readdir(dir)).some(name => name.endsWith('.tmp')));
  } finally { await t.cleanup(); }
});

test('concurrent ops are serialized with unique sequence numbers', async () => {
  const t = await setup();
  try {
    const { body: [board] } = await t.call('GET', B);
    const results = await Promise.all(Array.from({ length: 30 }, () =>
      t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [element()] }] } })));
    const seqs = results.map(r => r.body.seq).sort((x, y) => x - y);
    assert.deepEqual(seqs, Array.from({ length: 30 }, (_, i) => i + 1));
    assert.equal((await t.call('GET', `${B}/${board.id}`)).body.scene.elements.length, 30);
  } finally { await t.cleanup(); }
});

test('snapshots: hourly when changed, list, restore with pre-restore snapshot', async () => {
  const t = await setup();
  try {
    const { body: [board] } = await t.call('GET', B);
    const a = element(), b = element();
    await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [a] }] } });
    // Pretend the last snapshot is older than an hour: the next change snapshots the state before it.
    const state = t.store.boards.get(board.id);
    state.lastSnapshot = Date.now() - 2 * 60 * 60 * 1000;
    await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [b] }] } });
    let r = await t.call('GET', `${B}/${board.id}/snapshots`);
    assert.equal(r.body.length, 1);
    assert.equal(r.body[0].elements, 1);
    const snap = r.body[0].id;
    // No second snapshot within the hour.
    await t.call('POST', `${B}/${board.id}/ops`, { body: { ops: [{ type: 'upsert', elements: [{ ...a, version: 2, x: 77 }] }] } });
    assert.equal((await t.call('GET', `${B}/${board.id}/snapshots`)).body.length, 1);

    r = await t.call('POST', `${B}/${board.id}/snapshots/${snap}/restore`);
    assert.equal(r.status, 200);
    assert.equal(t.events.at(-1).data.kind, 'restore');
    r = await t.call('GET', `${B}/${board.id}`);
    const live = r.body.scene.elements.filter(e => !e.isDeleted);
    assert.deepEqual(live.map(e => e.id), [a.id]);
    assert.equal(live[0].x, 10);
    assert.ok(live[0].version > 2, 'restored element outranks local copies');
    assert.ok(r.body.scene.elements.find(e => e.id === b.id).isDeleted);
    const snaps = (await t.call('GET', `${B}/${board.id}/snapshots`)).body;
    assert.equal(snaps.length, 2);
    assert.ok(snaps.some(s => s.reason === 'pre-restore' && s.elements === 2));
    assert.equal((await t.call('POST', `${B}/${board.id}/snapshots/nope/restore`)).status, 400);
    assert.equal((await t.call('POST', `${B}/${board.id}/snapshots/20200101T000000-000Z__1/restore`)).status, 404);
  } finally { await t.cleanup(); }
});

test('board lifecycle: create, rename, delete to trash, default recreated', async () => {
  const t = await setup();
  try {
    let r = await t.call('POST', B, { body: { name: '  Planung\u0007 Q4 ' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'Planung Q4');
    const id = r.body.id;
    assert.equal((await t.call('GET', B)).body.length, 2);
    r = await t.call('PATCH', `${B}/${id}`, { body: { name: 'Retro' } });
    assert.equal(r.body.name, 'Retro');
    assert.ok((await t.call('GET', B)).body.some(b => b.name === 'Retro'));
    r = await t.call('DELETE', `${B}/${id}`);
    assert.deepEqual(r.body, { ok: true, trashed: true });
    const trash = await readdir(join(t.dataDir, '.trash'));
    assert.equal(trash.length, 1);
    assert.ok(trash[0].startsWith(`${id}--`));
    assert.ok(t.events.some(e => e.data.kind === 'deleted' && e.data.id === id));
    assert.equal((await t.call('GET', `${B}/${id}`)).status, 404);
    // Deleting the last board leaves a fresh default board.
    const [last] = (await t.call('GET', B)).body;
    await t.call('DELETE', `${B}/${last.id}`);
    const after = (await t.call('GET', B)).body;
    assert.equal(after.length, 1);
    assert.notEqual(after[0].id, last.id);
    assert.ok((await stat(join(t.dataDir, after[0].id, 'scene.json'))).isFile());
  } finally { await t.cleanup(); }
});
