import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
export async function verifyUpdates(browser) {
  const token = (await readFile(new URL('../kiosk/api-token', import.meta.url), 'utf8')).trim();
  const base = 'http://127.0.0.1:4180';
  const headers = { Authorization: `Bearer ${token}` };
  const state = () => fetch(base + '/api/state', { headers }).then(r => r.json());
  const start = await state();
  for (let i = 0; i < 40 && !(await state()).tabs.every(t => t.open); i++) await new Promise(r => setTimeout(r, 250));
  const getPages = async () => {
    const all = await browser.pages();
    return start.tabs.map(tab => [tab.id, all.find(page => page.url().startsWith(tab.url))]);
  };
  const entries = await getPages();
  assert(entries.every(([, page]) => !!page), 'Every app must be preloaded');
  const initial = new Map(await Promise.all(entries.map(async ([id, page]) => [id, await page.evaluate(() => performance.timeOrigin)])));
  const count = (await browser.pages()).length;
  const timings = [], fullscreen = [];
  try {
    for (const id of ['gev', 'home', 'board', 'astra', 'gev', 'board', 'home', 'gev']) {
      const began = performance.now();
      const result = await fetch(`${base}/api/tabs/${id}/activate`, { method: 'POST', headers });
      assert.equal(result.status, 200);
      timings.push({ id, milliseconds: Math.round(performance.now() - began) });
      const root = await run('xprop', ['-root', '_NET_ACTIVE_WINDOW'], { env: { ...process.env, DISPLAY: ':0' } });
      const windowId = root.stdout.match(/0x[0-9a-f]+/i)?.[0];
      assert(windowId, 'An active X11 window must exist');
      const window = await run('xprop', ['-id', windowId, '_NET_WM_STATE'], { env: { ...process.env, DISPLAY: ':0' } });
      assert(window.stdout.includes('_NET_WM_STATE_FULLSCREEN'), 'Kiosk must remain fullscreen during every switch');
      fullscreen.push(id);
    }
    assert.equal((await browser.pages()).length, count, 'Switching must not create additional tabs');
    for (const [id, page] of entries) {
      assert.equal(await page.evaluate(() => performance.timeOrigin), initial.get(id), `${id} must not reload`);
      assert.equal(await page.evaluate(() => window.__megaKioskVersion), 5.1);
      const diagnostics = await page.evaluate(() => window.__megaKioskDiagnostics());
      assert.equal(diagnostics.handle.width, 48);
      assert.equal(diagnostics.handle.height, 48);
    }
    const home = entries.find(([id]) => id === 'home')[1];
    assert.equal(await home.evaluate(() => getComputedStyle(document.body).zoom), '0.75');
    const gev = entries.find(([id]) => id === 'gev')[1];
    const handle = await gev.evaluate(() => window.__megaKioskDiagnostics().handle);
    await gev.touchscreen.tap(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await new Promise(r => setTimeout(r, 500));
    const glass = await gev.evaluate(() => window.__megaKioskDiagnostics());
    assert(glass.open && glass.glassFrames > 0);
    assert.equal(glass.glassError, '');
    assert.equal(glass.panel.x, 12); assert.equal(glass.panel.y, 12);
    await gev.screenshot({ path: new URL('../logs/gev-switcher-v3.png', import.meta.url).pathname });
    const drawing = await fetch(base + '/whiteboard/drawing').then(r => r.json());
    assert(drawing && Array.isArray(drawing.strokes), 'Existing drawing must be saved outside the browser');
    assert.equal((await fetch(base + '/whiteboard/drawing', { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' })).status, 403);
    const report = { timings, fullscreen, retainedTabs: count, unchangedDocuments: entries.length, whiteboardStrokes: drawing.strokes.length, glass };
    await writeFile(new URL('../logs/update-verification.json', import.meta.url), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    await fetch(`${base}/api/tabs/${start.current}/activate`, { method: 'POST', headers });
  }
}
