import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

export async function verifyOverlays(browser, _recover, attachKnownPages) {
  const config = JSON.parse(await readFile(new URL('../kiosk/config.json', import.meta.url), 'utf8'));
  const home = new URL(config.tabs.find(tab => tab.id === 'home').url).origin;
  const pages = await browser.pages(), before = new Map();
  const known = [];
  for (const page of pages) {
    const top = await page.evaluate(() => window.top === window).catch(() => false);
    if (!top) continue;
    let origin; try { origin = new URL(page.url()).origin; } catch { continue; }
    if (!config.tabs.some(tab => new URL(tab.url).origin === origin)) continue;
    before.set(page, await page.evaluate(() => performance.timeOrigin));
    known.push({ page, home: origin === home });
  }
  await attachKnownPages();
  for (const { page } of known) {
    assert.equal(await page.evaluate(() => window.__megaKioskVersion), 5.1);
    const diagnostics = await page.evaluate(() => window.__megaKioskDiagnostics());
    assert.equal(diagnostics.glassEngine,'snell-v1');
    assert.equal(diagnostics.ior,1.5);
    assert.equal(diagnostics.glassError,'');
    if(!await page.evaluate(()=>document.hidden))assert(diagnostics.glassFrames>0,'Visible apps must render optical glass');
    assert.equal(diagnostics.tabs, 4, 'Every known top-level app window must receive the switcher buttons');
    assert.equal(await page.evaluate(() => performance.timeOrigin), before.get(page), 'Attaching must not reload an existing page');
  }
  assert(known.filter(item => item.home).length >= 2, 'Regression check requires the additional Home Assistant window');
  const secondary = known.filter(item => item.home).at(-1).page;
  await mkdir(new URL('../logs/', import.meta.url), { recursive: true });
  await secondary.screenshot({ path: new URL('../logs/home-overlay-restored.png', import.meta.url).pathname });
  const report = { knownWindowsChecked: known.length, homeWindowsChecked: known.filter(item => item.home).length,
    overlaysPresent: true, appButtonsPresent: true, existingDocumentsRetained: true, glassEngine:'snell-v1',ior:1.5,noGlassErrors:true };
  await writeFile(new URL('../logs/overlay-verification.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
