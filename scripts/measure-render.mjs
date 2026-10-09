import {createRequire}from'node:module';import{writeFile}from'node:fs/promises';
const require=createRequire(new URL('../kiosk/package.json',import.meta.url)),p=require('puppeteer');
let browser;
try{
 browser=await p.connect({browserWSEndpoint:'ws://127.0.0.1:9222/session',protocol:'webDriverBiDi',defaultViewport:null});
 const page=(await browser.pages()).find(p=>p.url().startsWith('http://localhost:4173'));
 await page.waitForFunction(()=>!!window.__godsEyeView?.viewer);
 const result=await page.evaluate(async()=>{
  const v=window.__godsEyeView.viewer;
  async function bench(rate,scale){
   v.targetFrameRate=rate;v.resolutionScale=scale;
   await new Promise(r=>setTimeout(r,700));
   const intervals=[];let previous=performance.now();
   const remove=v.scene.postRender.addEventListener(()=>{const now=performance.now();intervals.push(now-previous);previous=now;});
   const trigger=setInterval(()=>v.scene.requestRender(),10);
   const began=performance.now();await new Promise(r=>setTimeout(r,4000));
   clearInterval(trigger);remove();
   const sorted=intervals.sort((a,b)=>a-b);
   return{rate,scale,fps:Math.round(intervals.length*1000/(performance.now()-began)*100)/100,p90Ms:Math.round(sorted[Math.floor(sorted.length*.9)]||0)};
  }
  const normal=await bench(30,.8),responsive=await bench(60,.75),light=await bench(60,.6);
  const selected=[normal,responsive,light].sort((a,b)=>b.fps-a.fps)[0];
  v.targetFrameRate=selected.rate;v.resolutionScale=selected.scale;
  return{normal,responsive,light,selected:{...selected}};
 });
 await writeFile(new URL('../logs/render-benchmark.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.disconnect();}
