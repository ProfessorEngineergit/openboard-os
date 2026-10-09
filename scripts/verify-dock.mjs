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
    assert.equal(await gev.evaluate(() => window.__megaKioskVersion), 5.1);
    const optics=await verifyRefraction(gev);
    assert.equal((await diagnostics()).glassEngine,'snell-v1');
    assert.equal((await diagnostics()).ior,1.5);
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
    await gev.screenshot({ path: new URL('../logs/glass-panel-v5.png', import.meta.url).pathname });
    await hide(); await sleep(250);
    next = await diagnostics();
    assert.equal(next.handle.width, 48); assert.equal(next.glassError, '');
    await gev.screenshot({ path: new URL('../logs/glass-handle-v5.png', import.meta.url).pathname });
    assert.equal((await browser.pages()).length, pages.length);
    for (const [i, page] of pages.entries()) assert.equal(await page.evaluate(() => performance.timeOrigin), origins[i]);
    report = { handleSize: 48, draggingPersists: true, draggingDoesNotOpen: true,
      panelFixedTopLeft: true, glassFrames: next.glassFrames, glassError: next.glassError, optics,
      retainedTabs: pages.length, unchangedDocuments: pages.length };
  } finally {
    await hide();
    if (initial) await moveHandle(initial.x, initial.y);
    await activate(start.current);
  }
  await writeFile(new URL('../logs/dock-verification.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

// Render the actual bundled GPU shader against a fixture without touching app data.
async function verifyRefraction(page) {
  const report=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=240;canvas.height=180;
    const source=document.createElement('canvas');source.width=240;source.height=180;
    const ctx=source.getContext('2d');
    for(let y=0;y<180;y+=6)for(let x=0;x<240;x+=6){ctx.fillStyle=(x/6+y/6)%2?'#e9d780':'#142944';ctx.fillRect(x,y,6,6);}
    const glass=new MegaGlass.WebGLGlass(canvas,{compositeMode:'overlay',preserveDrawingBuffer:true,material:{ior:1,dispersion:0,bevel:18,height:22,refractScale:2.4,sizeAdaptation:0,blurPlateau:0,blurRim:0,saturation:1,tintAmount:0,tintAdapt:0,specular:0,fresnel:0,edgeLine:0,edgeDark:0,shadow:0,brightness:0,debug:3}});
    try{
      glass.setElements([{id:'fixture',shape:'rect',x:48,y:48,width:144,height:84,radius:18}],false);
      glass.setBackdrop(source,{update:'static',autoStart:false,shouldRender:false});
      const gl=glass.renderer.gl;
      const sample=ior=>{
        glass.setMaterial({ior},false);glass.render({dpr:1,force:true});
        const pixels=new Uint8Array(240*180*4);gl.readPixels(0,0,240,180,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let sum=0,count=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]>250){sum+=pixels[i];count++;}}
        return {meanDisplacement:sum/count,count,error:gl.getError()};
      };
      const air=sample(1),glass15=sample(1.5);
      glass.setMaterial({ior:1.5,debug:0},false);glass.render({dpr:1,force:true});
      const transmitted=canvas.toDataURL();
      glass.setMaterial({ior:1,debug:0},false);glass.render({dpr:1,force:true});
      const unbent=canvas.toDataURL();
      return {air,glass15,transmitted,unbent};
    }finally{glass.destroy();}
  });
  assert.equal(report.air.error,0);assert.equal(report.glass15.error,0);
  assert(report.air.count>1000);
  assert(report.air.meanDisplacement<.5,'IOR 1 must produce no displacement');
  assert(report.glass15.meanDisplacement>5,'IOR 1.5 must produce measurable GPU refraction');
  assert.notEqual(report.transmitted,report.unbent,'Changing only IOR must change transmitted pixels');
  return {ior1Mean:report.air.meanDisplacement,ior15Mean:report.glass15.meanDisplacement,gpuError:0,transmittedPixelsChanged:true};
}
