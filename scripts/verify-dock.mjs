import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

export async function verifyDock(browser) {
  const token = (await readFile(new URL('../kiosk/api-token', import.meta.url), 'utf8')).trim();
  const base = 'http://127.0.0.1:4180', headers = { Authorization: `Bearer ${token}` };
  const getState = () => fetch(base + '/api/state', { headers }).then(response => response.json());
  const activate = id => fetch(`${base}/api/tabs/${id}/activate`, { method: 'POST', headers });
  const start = await getState(), pages = await browser.pages();
  const gev = pages.find(page => page.url().startsWith('http://localhost:4173/'));
  assert(gev);
  const diagnostics = () => gev.evaluate(() => window.__megaKioskDiagnostics());
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const origins = await Promise.all(pages.map(page => page.evaluate(() => performance.timeOrigin)));
  let initial, report;
  const hide = async () => {
    const state = await diagnostics();
    if (state.open) await gev.touchscreen.tap(state.panel.right - 34, state.panel.top + 34);
  };
  const moveHandle = async (x, y) => {
    const handle = (await diagnostics()).handle;
    await gev.mouse.move(handle.x + 24, handle.y + 24);
    await gev.mouse.down();
    await gev.mouse.move(x + 24, y + 24, { steps: 12 });
    await gev.mouse.up();
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = await getState(), size = await gev.evaluate(() => ({ w: innerWidth - 72, h: innerHeight - 72 }));
      if (Math.abs(12 + state.layout.x * size.w - x) < 1 && Math.abs(12 + state.layout.y * size.h - y) < 1) break;
      await sleep(100);
    }
  };
  try {
    await activate('gev'); await hide();
    assert.equal(await gev.evaluate(() => window.__megaKioskVersion), 4.1);
    initial = (await diagnostics()).handle;
    assert.equal(initial.width, 48); assert.equal(initial.height, 48);
    const size = await gev.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const x = Math.min(size.w - 60, Math.round(size.w * .52)), y = Math.min(size.h - 60, Math.round(size.h * .60));
    await moveHandle(x, y);
    let next = await diagnostics();
    assert.equal(next.open, false, 'Dragging must not open the panel');
    assert(Math.abs(next.handle.x - x) < 1 && Math.abs(next.handle.y - y) < 1, `Handle must move to ${x},${y}; actual ${next.handle.x},${next.handle.y}`);
    assert.equal((await getState()).layout.positioned, true, 'Handle position must persist');
    await gev.touchscreen.tap(x + 24, y + 24);
    await sleep(450);
    next = await diagnostics();
    assert.equal(next.open, true, 'Tapping must open the panel');
    assert.equal(next.panel.x, 12); assert.equal(next.panel.y, 12);
    await gev.mouse.move(80, 40); await gev.mouse.down();
    await gev.mouse.move(240, 180, { steps: 10 }); await gev.mouse.up();
    next = await diagnostics();
    assert.equal(next.panel.x, 12); assert.equal(next.panel.y, 12);
    assert(next.glassFrames > 0); assert.equal(next.glassError, '');
    await mkdir(new URL('../logs/', import.meta.url), { recursive: true });
    await gev.screenshot({ path: new URL('../logs/glass-panel-v4.png', import.meta.url).pathname });
    await hide(); await sleep(250);
    next = await diagnostics();
    assert.equal(next.handle.width, 48); assert.equal(next.glassError, '');
    await gev.screenshot({ path: new URL('../logs/glass-handle-v4.png', import.meta.url).pathname });
    assert.equal((await browser.pages()).length, pages.length);
    for (const [i, page] of pages.entries()) assert.equal(await page.evaluate(() => performance.timeOrigin), origins[i]);
    report = { handleSize: 48, draggingPersists: true, draggingDoesNotOpen: true,
      panelFixedTopLeft: true, glassFrames: next.glassFrames, glassError: next.glassError,
      retainedTabs: pages.length, unchangedDocuments: pages.length };
  } finally {
    await hide();
    if (initial) await moveHandle(initial.x, initial.y);
    await activate(start.current);
  }
  await writeFile(new URL('../logs/dock-verification.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
