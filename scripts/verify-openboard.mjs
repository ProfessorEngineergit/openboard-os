// Live check of a running OpenBoard (npm run verify / node kiosk/server.mjs --verify).
// Non-destructive: it reads state, opens and closes the dock and switches apps back.
// For a complete synthetic run (sleep, keyboard, Home Assistant navigation, portrait) use scripts/dev/e2e.mjs.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

export async function verify({ apps, base, token }) {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = { at: new Date().toISOString(), checks: [] };
  const check = async (name, fn) => {
    try { await fn(); report.checks.push({ name, ok: true }); console.log(`✓ ${name}`); }
    catch (error) { report.checks.push({ name, ok: false, error: error.message }); console.log(`✗ ${name}: ${error.message}`); process.exitCode = 1; }
  };

  await check('token API refuses missing or wrong tokens', async () => {
    assert.equal((await fetch(`${base}/api/v1/state`)).status, 401);
    assert.equal((await fetch(`${base}/api/v1/state`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  });
  await check('foreign origins are refused on the local API', async () => {
    const response = await fetch(`${base}/api/local/config`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: '{}' });
    assert.equal(response.status, 403);
  });
  let state;
  await check('state reports a connected browser and open apps', async () => {
    state = await (await fetch(`${base}/api/v1/state`, { headers })).json();
    assert.equal(state.connected, true, 'browser connected');
    assert(state.apps.filter(app => app.lifecycle !== 'terminated').length >= 1, 'at least one app open');
  });
  await check('secrets never leave the controller', async () => {
    const text = JSON.stringify(await (await fetch(`${base}/api/local/config`, { headers: { Host: 'localhost:4180' } })).json());
    assert(!/"(token|password|key)":"[^"{][^"]*"/.test(text), 'a secret value appeared in the config');
  });
  await check('arbitrary GEV commands are refused', async () => {
    const response = await fetch(`${base}/api/v1/gev/command`, { method: 'POST', headers, body: JSON.stringify({ name: 'eval', args: {} }) });
    assert.equal(response.status, 400);
  });
  await check('every open app carries the shell', async () => {
    for (const [id, page] of apps.pages) {
      if (apps.rt(id).lifecycle === 'frozen' || page.isClosed()) continue;
      const d = await page.evaluate(() => window.__openboard?.diagnostics()).catch(() => null);
      assert(d, `${id}: shell missing`);
      assert(d.apps >= 1, `${id}: no app buttons`);
    }
  });
  await check('dock opens and closes in the active app', async () => {
    const page = apps.activePage();
    assert(page, 'active page');
    await page.evaluate(() => window.__openboard.open());
    await sleep(900);
    const open = await page.evaluate(() => window.__openboard.diagnostics());
    assert.equal(open.open, true);
    assert.equal(open.glassError, '', 'glass renderer error');
    await page.evaluate(() => window.__openboard.close());
    await sleep(300);
    assert.equal((await page.evaluate(() => window.__openboard.diagnostics())).open, false);
  });
  await check('switching apps keeps pages loaded (no reload)', async () => {
    const start = state.active, before = new Map();
    for (const [id, page] of apps.pages) if (!page.isClosed()) before.set(id, await page.evaluate(() => performance.timeOrigin).catch(() => null));
    for (const app of state.apps.filter(entry => entry.enabled && entry.lifecycle !== 'terminated')) {
      await fetch(`${base}/api/v1/apps/${app.id}/activate`, { method: 'POST', headers, body: '{}' });
      await sleep(250);
    }
    await fetch(`${base}/api/v1/apps/${start}/activate`, { method: 'POST', headers, body: '{}' });
    for (const [id, origin] of before) {
      const page = apps.pages.get(id);
      if (!page || page.isClosed() || origin == null) continue;
      assert.equal(await page.evaluate(() => performance.timeOrigin).catch(() => null), origin, `${id} was reloaded`);
    }
  });
  await check('hidden GEV stops rendering', async () => {
    const gev = apps.pages.get('gev');
    if (!gev || state.active === 'gev') return;
    assert.equal(await gev.evaluate(() => window.__godsEyeView?.viewer?.useDefaultRenderLoop).catch(() => false), false);
  });

  await mkdir(new URL('../logs/', import.meta.url), { recursive: true });
  await writeFile(new URL('../logs/openboard-verification.json', import.meta.url), JSON.stringify(report, null, 2));
  const failed = report.checks.filter(entry => !entry.ok).length;
  console.log(failed ? `${failed} Prüfung(en) fehlgeschlagen` : `Alle ${report.checks.length} Prüfungen bestanden`);
}
