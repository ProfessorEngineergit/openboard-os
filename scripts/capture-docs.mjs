// Reproducible documentation images. Uses only public source and synthetic data.
// Run after npm ci in kiosk; requires an installed Chrome/Chromium executable.
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require=createRequire(new URL('../kiosk/package.json',import.meta.url));
const {default:puppeteer}=await import(require.resolve('puppeteer'));
const root=new URL('../',import.meta.url);
const overlay=await readFile(new URL('kiosk/vendor/liquid-glass/glass-runtime.js',root),'utf8')+'\n'+await readFile(new URL('kiosk/overlay.js',root),'utf8');
const demo=await readFile(new URL('docs/demo/switcher.html',root),'utf8');
const whiteboard=await readFile(new URL('kiosk/whiteboard.html',root),'utf8');
const output=new URL('docs/screenshots/',root);
await mkdir(output,{recursive:true});
const strokes=[];
const line=(points,color='#258ef1',width=5)=>strokes.push({points:points.map(([x,y])=>({x,y})),color,width,erase:false});
const box=(x,y,w,h,color)=>line([[x,y],[x+w,y+2],[x+w-2,y+h],[x+1,y+h-1],[x,y]],color);
const arrow=(x,y,w,color)=>{line([[x,y],[x+w,y]],color);line([[x+w-20,y-16],[x+w,y],[x+w-20,y+16]],color);};
box(440,310,240,240,'#258ef1');box(840,310,240,240,'#21ab83');box(1240,310,240,240,'#ef5263');
arrow(710,430,100,'#182633');arrow(1110,430,100,'#182633');
// A sketch, a board, and a completed task: generated geometry, no user work.
line([[490,465],[530,365],[568,465],[615,375],[640,465]],'#258ef1',7);
for(let y=360;y<480;y+=45){line([[890,y],[907,y+12],[930,y-14]],'#21ab83',6);line([[958,y],[1030,y]],'#21ab83');}
line([[1300,430],[1344,470],[1430,370]],'#ef5263',9);
line(Array.from({length:100},(_,i)=>[470+i*10,650+18*Math.sin(i/8)]),'#182633',3);
const drawing={strokes,dark:false};
const server=http.createServer((req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/whiteboard/drawing'){
    // Writes stay in this disposable process; no live drawing store is read.
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.method==='GET'?drawing:{ok:true}));return;
  }
  if(path==='/demo'||path==='/whiteboard'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(path==='/demo'?demo:whiteboard);return;}
  res.writeHead(404);res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
let browser;
try{
  browser=await puppeteer.launch({headless:true,executablePath:process.env.DOCS_BROWSER,defaultViewport:{width:1920,height:1080,deviceScaleFactor:1}});
  // A fresh browser profile has no account cookies, storage or personal tabs.
  const page=await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request',request=>{request.url().startsWith(base+'/')?request.continue():request.abort();});
  const state={current:'gev',layout:{x:0,y:0,positioned:false},geminiConfigured:false,tabs:[
    {id:'gev',name:'Projekt Alpha'},{id:'home',name:'Projekt Beta'},{id:'astra',name:'Assistent'},{id:'board',name:'Whiteboard'},
  ]};
  await page.exposeFunction('megaKiosk',async raw=>{
    const action=JSON.parse(raw);
    if(action.action==='layout')state.layout={x:action.x,y:action.y,positioned:true};
    if(action.action==='ready')await page.evaluate(value=>window.__megaKioskUpdate(value),state);
  });
  const install=async path=>{
    await page.goto(base+path,{waitUntil:'load'});
    await page.evaluate(overlay);
    await page.waitForFunction(()=>window.__megaKioskDiagnostics?.().tabs===4);
    await page.waitForFunction(()=>window.__megaKioskDiagnostics().glassFrames>0&&window.__megaKioskDiagnostics().glassError==='');
  };
  await install('/demo');
  await page.mouse.click(36,36);
  await page.waitForFunction(()=>window.__megaKioskDiagnostics().open);
  await new Promise(resolve=>setTimeout(resolve,350));
  let diagnostics=await page.evaluate(()=>window.__megaKioskDiagnostics());
  assert.equal(diagnostics.ior,1.5);assert.equal(diagnostics.glassError,'');
  await page.screenshot({path:fileURLToPath(new URL('glass-panel.png',output))});
  await page.mouse.click(diagnostics.panel.right-34,diagnostics.panel.top+34);
  await page.mouse.move(36,36);await page.mouse.down();await page.mouse.move(244,500,{steps:12});await page.mouse.up();
  await page.waitForFunction(()=>!window.__megaKioskDiagnostics().open);
  await new Promise(resolve=>setTimeout(resolve,350));
  await page.screenshot({path:fileURLToPath(new URL('launcher.png',output))});
  state.current='board';state.layout={x:0,y:.14,positioned:true};
  await install('/whiteboard');
  await page.waitForFunction(()=>window.__whiteboardDiagnostics().strokes>0&&window.__whiteboardDiagnostics().serverSaved);
  await page.screenshot({path:fileURLToPath(new URL('whiteboard.png',output))});
  console.log('Created three 1920×1080 screenshots from isolated, synthetic fixtures.');
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
}
