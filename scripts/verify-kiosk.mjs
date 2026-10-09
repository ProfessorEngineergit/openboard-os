import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const requireKiosk = createRequire(new URL('../kiosk/package.json', import.meta.url));
const { default: puppeteer } = await import(pathToFileURL(requireKiosk.resolve('puppeteer')).href);
export async function verify(browser) {
const token = (await readFile(new URL('../kiosk/api-token', import.meta.url), 'utf8')).trim();
const base = 'http://127.0.0.1:4180';
const authorized = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
assert.equal((await fetch(`${base}/api/state`)).status, 401, 'Unauthenticated control must be refused');
assert.equal((await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401, 'Wrong token must be refused');
assert.equal((await fetch(`${base}/settings`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'Foreign settings writes must be refused');
const state = await (await fetch(`${base}/api/state`, { headers: authorized })).json();
assert.equal(state.tabs.length, 4);
assert.equal(state.geminiConfigured, !!state.geminiConfigured);
const tools = await (await fetch(`${base}/api/gev/tools`, { headers: authorized })).json();
assert(tools.some(tool => tool.name === 'fly_to_location'));
console.log(`API authentication and cross-origin gate passed; ${tools.length} GEV actions available.`);
if (process.argv.includes('--api-only')) return;
assert.equal(state.connected, true, 'Browser must be connected');
if (!browser) browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
const gev = (await browser.pages()).find(page => page.url().startsWith('http://localhost:4173/'));
assert(gev, 'Globe tab must exist');
const failures = [];
gev.on('pageerror', error => failures.push(error.message));
await gev.waitForFunction(() => !!window.__godsEyeView?.viewer && !!window.__godsEyeView?.voiceCommands?.runner, { timeout: 90000 });
assert(await gev.evaluate(() => window.__megaKiosk && !!document.getElementById('mega-display-controls')), 'Tab overlay must be mounted');
await gev.evaluate(() => {
  const welcome = document.getElementById('first-run-launcher');
  if (welcome && !welcome.hidden) {
    const suppress = welcome.querySelector('[data-first-run-suppress]');
    if (!suppress.checked) suppress.click();
    welcome.querySelector('[data-first-run-choice="explore"]').click();
  }
});
await mkdir(new URL('../logs/', import.meta.url), { recursive: true });
await gev.screenshot({ path: new URL('../logs/gev-default.png', import.meta.url).pathname });
const handle=await gev.evaluate(()=>window.__megaKioskDiagnostics().handle);
await gev.touchscreen.tap(handle.x+handle.width/2,handle.y+handle.height/2);
await new Promise(resolve => setTimeout(resolve, 400));
assert.equal(await gev.evaluate(() => window.__megaKioskDiagnostics().open), true, 'Touch must open the switcher');
assert.equal(await gev.evaluate(() => window.__megaKioskDiagnostics().voiceVisible), state.geminiConfigured, 'Gemini button only appears with a key');
await new Promise(resolve=>setTimeout(resolve,1000));
const glass=await gev.evaluate(()=>window.__megaKioskDiagnostics());
assert(glass.glassFrames>0,'Real glass renderer must draw the globe texture');
assert.equal(glass.glassError,'');
assert.equal(await gev.evaluate(()=>getComputedStyle(document.body).cursor),'none');
await gev.screenshot({ path: new URL('../logs/gev-switcher.png', import.meta.url).pathname });
for (const id of ['home', 'astra', 'board', 'gev']) {
  const response = await fetch(`${base}/api/tabs/${id}/activate`, { method: 'POST', headers: authorized, body: '{}' });
  assert.equal(response.status, 200, `Activate ${id}`);
  const next = await (await fetch(`${base}/api/state`, { headers: authorized })).json();
  assert.equal(next.current, id);
  if (id === 'board') {
    const board=(await browser.pages()).find(page=>page.url().includes('/whiteboard'));
    await board.waitForFunction(()=>window.__whiteboardDiagnostics?.().saved);
    const before=await board.evaluate(()=>window.__whiteboardDiagnostics().strokes);
    await board.mouse.move(700,380);await board.mouse.down();
    for(let i=1;i<=12;i++)await board.mouse.move(700+i*15,380+Math.sin(i/3)*30);
    await board.mouse.up();
    assert.equal(await board.evaluate(()=>window.__whiteboardDiagnostics().strokes),before+1);
    await board.screenshot({path:new URL('../logs/whiteboard.png',import.meta.url).pathname});
    await new Promise(resolve=>setTimeout(resolve,400));await board.reload();
    await board.waitForFunction(n=>window.__whiteboardDiagnostics?.().strokes===n,{},before+1);
    await board.click('#undo');
    assert.equal(await board.evaluate(()=>window.__whiteboardDiagnostics().strokes),before);
  }
  if (id !== 'gev') {
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await gev.evaluate(() => document.hidden), true, 'Globe must become hidden');
    assert.equal(await gev.evaluate(() => window.__godsEyeView.viewer.useDefaultRenderLoop), false, 'Hidden globe must stop rendering');
  }
}
const command = await fetch(`${base}/api/gev/command`, { method: 'POST', headers: authorized, body: JSON.stringify({ name: 'get_current_view_state', args: {} }) });
if (tools.some(tool => tool.name === 'get_current_view_state')) assert.equal(command.status, 200);
const forbidden = await fetch(`${base}/api/gev/command`, { method: 'POST', headers: authorized, body: JSON.stringify({ name: 'eval', args: {} }) });
assert.equal(forbidden.status, 400, 'Arbitrary execution must be refused');
const diagnostics = await gev.evaluate(() => ({
  title: document.title, width: innerWidth, height: innerHeight,
  targetFrameRate: window.__godsEyeView.viewer.targetFrameRate,
  renderer: (() => { const gl = window.__godsEyeView.viewer.scene.context._gl; const ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'not exposed'; })(),
  governor: window.__godsEyeView.getRenderGovernorDiagnostics(),
}));
await writeFile(new URL('../logs/verification.json', import.meta.url), JSON.stringify({ diagnostics, glass, failures, verifiedAt: new Date().toISOString() }, null, 2));
console.log(JSON.stringify({ diagnostics, failures }));
console.log('Browser, tab transitions, hidden globe suspension and API command allowlist passed.');
assert.equal(diagnostics.targetFrameRate, 30);
}
if (process.argv[1] === new URL(import.meta.url).pathname) await verify();
