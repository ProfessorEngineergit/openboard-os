import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
const run = promisify(execFile);

export async function verifyStartup(browser, recoverFailedPage) {
  const ready = await run('python3', [new URL('./wait-kiosk-ready.py', import.meta.url).pathname]);
  assert(ready.stdout.includes('are ready'));
  await assert.rejects(run('python3', [new URL('./wait-kiosk-ready.py', import.meta.url).pathname],
    { env: { ...process.env, DISPLAY: ':99' }, timeout: 1800 }),
    error => error.killed === true);
  const context = browser.defaultBrowserContext();
  const initial = await context.pages();
  console.log('Startup readiness checked');
  const gev = initial.find(page => page.url().startsWith('http://localhost:4173/'));
  assert(gev, 'GEV must already exist');
  let probe;
  const fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Reconnect probe</title><p>Ready again</p>');
  });
  try {
    if (context.userContext) {
      const anchor = gev.mainFrame().browsingContext;
      const created = await context.userContext.createBrowsingContext('tab', { referenceContext: anchor, background: true });
      probe = (await context.pages()).find(page => page.mainFrame().browsingContext.id === created.id);
      assert(probe, 'A background tab must be available');
      assert.equal(created.windowId, anchor.windowId, 'Preload must use the existing kiosk window');
    } else probe = await context.newPage({ type: 'tab', background: true });
    assert.equal(await probe.evaluate(() => document.hidden), true, 'A preload must not take focus');
    console.log('Background kiosk-window placement checked');
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const port = fixture.address().port;
    await new Promise(resolve => fixture.close(resolve));
    const url = `http://127.0.0.1:${port}/`;
    await probe.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
    console.log('Offline fixture created');
    await new Promise(resolve => fixture.listen(port, '127.0.0.1', resolve));
    assert.equal(await recoverFailedPage(probe, url), true, 'An offline page must recover when its server returns');
    for (let attempt = 0; attempt < 30 && (await probe.title()) !== 'Reconnect probe'; attempt++)
      await new Promise(resolve => setTimeout(resolve, 100));
    console.log('Network recovery checked');
    assert.equal(await probe.title(), 'Reconnect probe');
    const loaded = await probe.evaluate(() => performance.timeOrigin);
    assert.equal(await recoverFailedPage(probe, url), false, 'Healthy documents must not reload');
    assert.equal(await probe.evaluate(() => performance.timeOrigin), loaded);
  } finally {
    await probe?.close();
    fixture.closeAllConnections();
    if (fixture.listening) await new Promise(resolve => fixture.close(resolve));
  }
  // Firefox reports contextDestroyed asynchronously after the close response.
  for (let attempt = 0; attempt < 20 && (await context.pages()).length !== initial.length; attempt++)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal((await context.pages()).length, initial.length, 'Probe must not leave extra tabs');
  const report = { localAppsReady: true, absentXSessionWaits: true,
    backgroundTabRetainsKioskWindow: true, backgroundTabDoesNotTakeFocus: true,
    networkErrorRecovers: true, healthyDocumentNotReloaded: true,
    retainedTabs: initial.length };
  await writeFile(new URL('../logs/startup-verification.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
