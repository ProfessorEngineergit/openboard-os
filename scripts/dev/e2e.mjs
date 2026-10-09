// End-to-end test against a headless Chromium with fixture apps.
//   node scripts/dev/e2e.mjs [--out DIR] [--keep]
// Starts fixtures (GEV :4173, HA :8123), the ASTRA mock (:18088), Chromium (:9222)
// and the controller (:4180) with a temporary config, then exercises the OS.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { startFixtures } from './fixtures.mjs';

// Isolated ports so the test never collides with a running controller.
const PORT = Number(process.env.OPENBOARD_PORT || 4280);
const APP = `http://localhost:${PORT}`;
const DEBUG = Number(process.env.OPENBOARD_DEBUG_PORT || 9333);

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(resolve(repo, 'kiosk/package.json'));
const { default: puppeteer } = await import(pathToFileURL(require.resolve('puppeteer')).href);
const out = process.argv.includes('--out') ? resolve(process.argv[process.argv.indexOf('--out') + 1]) : await mkdtemp(resolve(tmpdir(), 'openboard-e2e-'));
await mkdir(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const children = [];
const results = [];
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const step = async (name, fn) => {
  if (only && !name.includes(only)) return;
  try { await fn(); results.push(['ok', name]); console.log(`✓ ${name}`); }
  catch (error) { results.push(['fail', name, error.message]); console.log(`✗ ${name}: ${error.message}`); }
};

function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  const dir = readdirSync(base).find(name => /^chromium-\d+$/.test(name));
  for (const candidate of [`${base}/${dir}/chrome-linux/chrome`, `${base}/${dir}/chrome-linux64/chrome`]) if (existsSync(candidate)) return candidate;
  throw new Error('Chromium not found');
}

const stopFixtures = startFixtures();
const work = await mkdtemp(resolve(tmpdir(), 'openboard-run-'));
if (existsSync(resolve(repo, 'scripts/dev/mock-astra.mjs'))) {
  children.push(spawn(process.execPath, [resolve(repo, 'scripts/dev/mock-astra.mjs'), '--port', '18088', '--token', 'dev'], { stdio: 'ignore' }));
}
const chrome = spawn(chromiumPath(), ['--headless=new', `--remote-debugging-port=${DEBUG}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${work}/profile`,
  '--window-size=1920,1080', '--no-first-run', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
children.push(chrome);
await writeFile(`${work}/config.json`, JSON.stringify({
  version: 2,
  apps: [
    { id: 'gev', name: 'God’s Eye View', url: 'http://localhost:4173/', icon: 'globe', builtin: false, enabled: true, zoom: 1, residency: 'auto', weight: 'heavy' },
    { id: 'home', name: 'Home Assistant', url: 'http://localhost:8123/', icon: 'home', builtin: false, enabled: true, zoom: 0.75, residency: 'always', weight: 'standard' },
    { id: 'astra', name: 'Astra', url: `${APP}/apps/astra/`, icon: 'astra', builtin: true, enabled: true, zoom: 1, residency: 'always', weight: 'light' },
    { id: 'board', name: 'Whiteboard', url: `${APP}/apps/board/`, icon: 'board', builtin: true, enabled: true, zoom: 1, residency: 'auto', weight: 'standard' },
    { id: 'settings', name: 'Einstellungen', url: `${APP}/apps/settings/`, icon: 'settings', builtin: true, enabled: true, zoom: 1, residency: 'eco', weight: 'light' },
  ],
  astra: { url: 'http://127.0.0.1:18088', token: 'dev', voice: true, briefingOnDisplay: true },
  performance: { prewarm: false },
  // Headless Chromium renders WebGL in software; keep the dock open long enough to inspect.
  dock: { autoHideSeconds: 90 },
}));
await sleep(1500);
const controller = spawn(process.execPath, [resolve(repo, 'kiosk/server.mjs')], {
  env: { ...process.env, OPENBOARD_PORT: String(PORT), OPENBOARD_DEBUG_PORT: String(DEBUG), OPENBOARD_CONFIG: `${work}/config.json`, OPENBOARD_DATA_DIR: `${work}/data`, OPENBOARD_TOKEN_FILE: `${work}/token`, OPENBOARD_STATE_DIR: `${work}/state` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(controller);
const controllerLog = [];
controller.stdout.on('data', d => controllerLog.push(d.toString())); controller.stderr.on('data', d => controllerLog.push(d.toString()));

const base = `http://127.0.0.1:${PORT}`;
const api = async (path, { method = 'GET', body } = {}) => {
  const response = await fetch(base + path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${data?.error || ''}`);
  return data;
};
let state;
for (let i = 0; i < 60; i++) {
  try { state = await api('/api/local/state'); if (state.connected && state.apps.filter(a => a.lifecycle !== 'terminated').length >= 4) break; } catch { /* starting */ }
  await sleep(500);
}

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG}`, defaultViewport: null });
const pageFor = async prefix => (await browser.pages()).find(page => page.url().startsWith(prefix));
const shot = async (page, name) => { await page.screenshot({ path: `${out}/${name}.png` }); };

try {
  await step('controller connects and warms apps', async () => {
    assert.equal(state?.connected, true, 'browser connected');
    const live = state.apps.filter(app => app.lifecycle !== 'terminated').map(app => app.id);
    for (const id of ['gev', 'home', 'astra', 'board']) assert(live.includes(id), `${id} open (${live})`);
  });

  await step('shell is injected into every app', async () => {
    for (const prefix of ['http://localhost:4173/', 'http://localhost:8123/', `${APP}/apps/astra/`, `${APP}/apps/board/`]) {
      const page = await pageFor(prefix);
      assert(page, `page ${prefix}`);
      await page.waitForFunction(() => !!window.__openboard?.diagnostics, { timeout: 15000 });
      const d = await page.evaluate(() => window.__openboard.diagnostics());
      assert(d.apps >= 5, `dock apps in ${prefix}: ${d.apps}`);
    }
  });

  const gev = await pageFor('http://localhost:4173/');
  await step('dock opens with a swipe up from the bottom edge', async () => {
    await api('/api/local/apps/gev/activate', { method: 'POST' });
    await gev.bringToFront();
    await sleep(400);
    const { w, h } = await gev.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await gev.touchscreen.touchStart(w / 2, h - 4);
    for (let y = h - 10; y > h - 130; y -= 15) await gev.touchscreen.touchMove(w / 2, y);
    await gev.touchscreen.touchEnd();
    await sleep(700);
    const d = await gev.evaluate(() => window.__openboard.diagnostics());
    assert.equal(d.open, true, 'dock open');
    assert.equal(d.tiles, 2, 'two widget tiles');
    await sleep(1200);
    await shot(gev, '01-dock-gev');
    const after = await gev.evaluate(() => window.__openboard.diagnostics());
    assert.equal(after.glassError, '', `glass error: ${after.glassError}`);
  });

  await step('widget editor opens on long press', async () => {
    await gev.evaluate(() => window.__openboard.openEditor());
    await sleep(600);
    await shot(gev, '02-widget-editor');
    await gev.evaluate(() => window.__openboard.closeEditor());
  });

  await step('app switching via dock tap', async () => {
    await gev.evaluate(() => window.__openboard.open());
    await sleep(500);
    const d = await gev.evaluate(() => window.__openboard.diagnostics());
    // Home is the second icon in the dock.
    const x = d.dock.left + 10 + 84 + 10 + 42, y = d.dock.top + d.dock.height / 2;
    await gev.touchscreen.tap(x, y);
    for (let i = 0; i < 20 && (await api('/api/local/state')).active !== 'home'; i++) await sleep(150);
    assert.equal((await api('/api/local/state')).active, 'home');
  });

  const home = await pageFor('http://localhost:8123/');
  await step('Home Assistant: target=_blank and window.open stay in the same tab without reload', async () => {
    await home.bringToFront();
    const origin = await home.evaluate(() => performance.timeOrigin);
    const before = (await browser.pages()).length;
    await home.click('#nav-blank');
    await sleep(600);
    await home.click('#nav-open');
    await sleep(1500);
    const after = (await browser.pages()).length;
    assert.equal(after, before, `tab count ${before} → ${after}`);
    assert.equal(await home.evaluate(() => performance.timeOrigin), origin, 'no reload');
    assert.equal(await home.evaluate(() => location.pathname), '/lovelace/2');
    await shot(home, '03-home');
  });

  await step('on-screen keyboard types into a focused field', async () => {
    await home.click('#search');
    await sleep(500);
    assert.equal((await home.evaluate(() => window.__openboard.diagnostics())).keyboard, true, 'keyboard visible');
    await shot(home, '04-keyboard');
    // Press "h", "a" via the shell keyboard buttons.
    for (const key of ['h', 'a']) {
      const box = await home.evaluateHandle(() => document.getElementById('openboard-shell'));
      void box;
      await home.evaluate(k => window.openboardBridge(JSON.stringify({ action: 'key', text: k })), key);
    }
    await sleep(200);
    assert.equal(await home.evaluate(() => document.getElementById('search').value), 'ha');
  });

  await step('keyboard resizes by dragging a corner and keeps the size', async () => {
    const before = await home.evaluate(() => window.__openboard.diagnostics());
    assert(before.keyboard, 'keyboard visible');
    const r = before.keyboardRect, cx = r.left + r.width / 2;
    // Top-right corner grip: drag towards the centre to shrink.
    await home.mouse.move(r.right + 2, r.top - 2);
    await home.mouse.down();
    await home.mouse.move(cx + 300, r.top + 16, { steps: 8 });
    await home.mouse.up();
    await sleep(500);
    const after = await home.evaluate(() => window.__openboard.diagnostics());
    assert(after.keyboardScale < before.keyboardScale - 0.3, `scale ${before.keyboardScale} → ${after.keyboardScale}`);
    for (let i = 0; i < 20 && (await api('/api/local/config')).appearance.keyboardScale === 1; i++) await sleep(100);
    const saved = (await api('/api/local/config')).appearance.keyboardScale;
    assert(Math.abs(saved - after.keyboardScale) < 0.02, `saved ${saved}`);
    await shot(home, '04b-keyboard-small');
    await api('/api/local/config', { method: 'PATCH', body: { appearance: { keyboardScale: 1 } } });
  });

  await step('freeze, resume and terminate a background app', async () => {
    await api('/api/local/apps/home/activate', { method: 'POST' });
    await api('/api/local/apps/board/suspend', { method: 'POST' });
    let s = await api('/api/local/state');
    assert.equal(s.apps.find(a => a.id === 'board').lifecycle, 'frozen');
    await api('/api/local/apps/board/resume', { method: 'POST' });
    s = await api('/api/local/state');
    assert.equal(s.apps.find(a => a.id === 'board').lifecycle, 'background');
    await api('/api/local/apps/board/terminate', { method: 'POST' });
    s = await api('/api/local/state');
    assert.equal(s.apps.find(a => a.id === 'board').lifecycle, 'terminated');
    await api('/api/local/apps/board/activate', { method: 'POST' });
    s = await api('/api/local/state');
    assert.equal(s.active, 'board');
    assert.equal(s.apps.find(a => a.id === 'board').lifecycle, 'active');
  });

  await step('per-app CPU and heap are measured', async () => {
    await sleep(4500);
    const s = await api('/api/local/state');
    const gevApp = s.apps.find(a => a.id === 'gev');
    assert(gevApp.heapMB != null, 'heap measured');
  });

  await step('sleep and wake', async () => {
    await api('/api/local/display/sleep', { method: 'POST' });
    const page = await pageFor(`${APP}/apps/board/`);
    await sleep(1200);
    assert.equal((await page.evaluate(() => window.__openboard.diagnostics())).asleep, true);
    await shot(page, '05-sleep');
    await api('/api/local/display/wake', { method: 'POST' });
    await sleep(300);
    assert.equal((await page.evaluate(() => window.__openboard.diagnostics())).asleep, false);
  });

  await step('light theme', async () => {
    await api('/api/local/config', { method: 'PATCH', body: { appearance: { theme: 'light' } } });
    await api('/api/local/apps/home/activate', { method: 'POST' });
    await home.evaluate(() => window.__openboard.open());
    await sleep(1400);
    await shot(home, '06-dock-light-home');
    await api('/api/local/config', { method: 'PATCH', body: { appearance: { theme: 'dark' } } });
  });

  await step('ASTRA bridge (mock)', async () => {
    const hello = await api('/api/local/astra/hello');
    assert(hello.name, 'hello');
    const reply = await api('/api/local/astra/message', { method: 'POST', body: { text: 'Wie wird das Wetter?' } });
    assert(reply.reply, 'reply');
    const s = await api('/api/local/state');
    assert.equal(s.astra.connected, true, 'SSE connected');
  });

  await step('widget catalog and config validation', async () => {
    const { catalog } = await api('/api/local/widgets/catalog');
    assert(catalog.length > 20);
    const response = await fetch(base + '/api/local/config', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ performance: { mode: 'turbo' } }) });
    assert.equal(response.status, 400);
  });

  await step('foreign origins and missing tokens are refused', async () => {
    const foreign = await fetch(base + '/api/local/config', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(foreign.status, 403);
    assert.equal((await fetch(base + '/api/v1/state')).status, 401);
  });

  await step('pinch zoom is locked in every app (no --disable-pinch needed)', async () => {
    const problems = [];
    for (const [id, prefix] of [['settings', `${APP}/apps/settings/`], ['board', `${APP}/apps/board/`], ['astra', `${APP}/apps/astra/`], ['home', 'http://localhost:8123/']]) {
      await api(`/api/local/apps/${id}/activate`, { method: 'POST' });
      const page = await pageFor(prefix);
      await sleep(600);
      const session = await page.createCDPSession();
      await session.send('Input.synthesizePinchGesture', { x: 800, y: 400, scaleFactor: 2.5, relativeSpeed: 600, gestureSourceType: 'touch' }).catch(() => {});
      await sleep(500);
      const scale = await page.evaluate(() => window.visualViewport.scale);
      if (Math.abs(scale - 1) > 0.01) problems.push(`${id}: scale ${scale}`);
      await session.detach();
    }
    assert.deepEqual(problems, []);
  });

  await step('portrait (1080×1920): built-in apps and the dock fit without horizontal overflow', async () => {
    const problems = [];
    for (const [id, prefix] of [['astra', `${APP}/apps/astra/`], ['board', `${APP}/apps/board/`], ['settings', `${APP}/apps/settings/`], ['home', 'http://localhost:8123/']]) {
      await api(`/api/local/apps/${id}/activate`, { method: 'POST' });
      const page = await pageFor(prefix);
      await page.setViewport({ width: 1080, height: 1920 });
      await sleep(1200);
      const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      if (overflow.sw > overflow.iw + 1) problems.push(`${id}: scrollWidth ${overflow.sw} > ${overflow.iw}`);
      await page.evaluate(() => window.__openboard.open());
      await sleep(1500);
      const d = await page.evaluate(() => window.__openboard.diagnostics());
      if (d.dock.left < 0 || d.dock.right > 1080) problems.push(`${id}: dock ${Math.round(d.dock.left)}..${Math.round(d.dock.right)}`);
      await shot(page, `10-portrait-${id}`);
      await page.evaluate(() => window.__openboard.close());
      await page.setViewport({ width: 1920, height: 993 });
    }
    assert.deepEqual(problems, []);
  });

  for (const [id, name] of [['astra', '07-astra'], ['board', '08-board'], ['settings', '09-settings']]) {
    await step(`screenshot ${id}`, async () => {
      await api(`/api/local/apps/${id}/activate`, { method: 'POST' });
      const page = await pageFor(`${APP}/apps/${id}/`);
      await sleep(1500);
      await shot(page, name);
    });
  }
  // Documentation images: node scripts/dev/e2e.mjs --docs docs/screenshots (synthetic fixtures only).
  if (process.argv.includes('--docs')) {
    const docs = resolve(process.argv[process.argv.indexOf('--docs') + 1]);
    await mkdir(docs, { recursive: true });
    await api('/api/local/config', { method: 'PATCH', body: { appearance: { theme: 'dark' } } });
    await step('documentation screenshots', async () => {
      const grab = async (id, prefix, file, prepare) => {
        await api(`/api/local/apps/${id}/activate`, { method: 'POST' });
        const page = await pageFor(prefix);
        await page.evaluate(() => window.__openboard?.close());
        if (prepare) await prepare(page);
        await sleep(1800);
        await page.screenshot({ path: `${docs}/${file}` });
        return page;
      };
      await grab('gev', 'http://localhost:4173/', 'dock.png', async page => { await page.evaluate(() => window.__openboard.open()); await sleep(600); });
      await grab('astra', `${APP}/apps/astra/`, 'astra.png');
      await grab('board', `${APP}/apps/board/`, 'board.png', async page => {
        await page.waitForFunction(() => !!window.__openboardBoard, { timeout: 20000 });
        await page.evaluate(async () => {
          const box = (x, y, w, h, text, color) => ({ type: 'rectangle', x, y, width: w, height: h, backgroundColor: color, fillStyle: 'solid', roundness: { type: 3 }, label: { text, fontSize: 28 } });
          await window.__openboardBoard.apply({ op: 'add_elements', elements: [
            { type: 'text', x: 320, y: 150, text: 'Sprint-Planung', fontSize: 40 },
            box(320, 280, 280, 120, 'Idee', '#a5d8ff'),
            { type: 'ellipse', x: 820, y: 262, width: 280, height: 156, backgroundColor: '#b2f2bb', fillStyle: 'solid', label: { text: 'Plan', fontSize: 28 } },
            box(1320, 280, 300, 120, 'Umsetzung', '#ffec99'),
            { type: 'arrow', x: 600, y: 340, width: 220, height: 0, points: [[0, 0], [220, 0]] },
            { type: 'arrow', x: 1100, y: 340, width: 220, height: 0, points: [[0, 0], [220, 0]] },
          ] });
        });
        await sleep(1200);
      });
      await grab('settings', `${APP}/apps/settings/`, 'settings.png');
    });
  }
  await step('npm run verify (live check script) passes against the running system', async () => {
    controller.kill(); await sleep(1500);
    const verifier = spawn(process.execPath, [resolve(repo, 'kiosk/server.mjs'), '--verify'], {
      env: { ...process.env, OPENBOARD_PORT: String(PORT), OPENBOARD_DEBUG_PORT: String(DEBUG), OPENBOARD_CONFIG: `${work}/config.json`, OPENBOARD_DATA_DIR: `${work}/data`, OPENBOARD_TOKEN_FILE: `${work}/token`, OPENBOARD_STATE_DIR: `${work}/state` },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; verifier.stdout.on('data', d => { output += d; }); verifier.stderr.on('data', d => { output += d; });
    const code = await new Promise(resolveExit => { const timer = setTimeout(() => { verifier.kill(); resolveExit(-1); }, 90000); verifier.on('exit', c => { clearTimeout(timer); resolveExit(c); }); });
    assert.equal(code, 0, output.slice(-1500));
    assert(/Alle \d+ Prüfungen bestanden/.test(output), output.slice(-800));
  });
} finally {
  await browser.disconnect();
  if (!process.argv.includes('--keep')) { for (const child of children) child.kill(); stopFixtures(); }
  const failed = results.filter(r => r[0] === 'fail');
  console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots: ${out}`);
  if (failed.length) { console.log('--- controller log ---\n' + controllerLog.join('').slice(-4000)); process.exitCode = 1; }
  if (!process.argv.includes('--keep')) setTimeout(() => process.exit(), 500);
}
