import http from 'node:http';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
import {resolve, dirname, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../kiosk/package.json',import.meta.url));
const {WebSocketServer,WebSocket}=require('ws');
const root=dirname(fileURLToPath(import.meta.url));
const run=promisify(execFile), base=resolve(root,'..');
const origins=new Set(['http://localhost:16080','http://127.0.0.1:16080','http://localhost:6080','http://127.0.0.1:6080']);
const hosts=new Set([...origins].map(x=>new URL(x).host));
const common={'cache-control':'no-store','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:16080 ws://127.0.0.1:16080; img-src 'self' data: blob:; frame-ancestors 'none'"};
const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json',...common});res.end(JSON.stringify(data));};
const trusted=req=>hosts.has(req.headers.host)&&(!req.headers.origin||req.headers.origin===`http://${req.headers.host}`)&&(!req.headers['sec-fetch-site']||['same-origin','none'].includes(req.headers['sec-fetch-site']));
const server=http.createServer(async(req,res)=>{
 try{
  if(!hosts.has(req.headers.host))return json(res,403,{error:'Invalid host'});
  const url=new URL(req.url,'http://localhost:6080');
  if (['/settings','/settings/status'].includes(url.pathname) && ['GET','POST'].includes(req.method)) {
   if(!trusted(req))return json(res,403,{error:'Same-origin required'});
   const options={method:req.method};
   if(req.method==='POST'){
    const chunks=[];let length=0;
    for await(const chunk of req){length+=chunk.length;if(length>32000)return json(res,413,{error:'Request too large'});chunks.push(chunk);}
    options.body=Buffer.concat(chunks);options.headers={'Content-Type':'application/json'};
   }
   const response=await fetch(`http://127.0.0.1:4180${url.pathname}`,options);
   res.writeHead(response.status,{'content-type':response.headers.get('content-type'),'cache-control':'no-store','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});
   res.end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(req.method==='POST'){
   if(!trusted(req))return json(res,403,{error:'Same-origin required'});
   if(url.pathname==='/api/desktop'){await run('bash',[resolve(base,'scripts/stop-kiosk.sh')]);return json(res,200,{ok:true});}
   if(url.pathname==='/api/kiosk'){await run('bash',[resolve(base,'scripts/start-kiosk.sh')]);return json(res,200,{ok:true});}
   if(url.pathname==='/api/terminal'){
    await run('bash',[resolve(base,'scripts/stop-kiosk.sh')]);
    execFile('/usr/bin/xfce4-terminal',[],{env:{...process.env,DISPLAY:':0',XAUTHORITY:`${process.env.HOME}/.Xauthority`}});
    return json(res,200,{ok:true});
   }
   if(url.pathname==='/api/chrome-setup'){
    await run('bash',[resolve(base,'scripts/stop-kiosk.sh')]);
    execFile('/usr/bin/xfce4-terminal',['--execute','/usr/bin/bash',resolve(base,'scripts/setup-chrome-interactive.sh')],{env:{...process.env,DISPLAY:':0',XAUTHORITY:`${process.env.HOME}/.Xauthority`}});
    return json(res,200,{ok:true});
   }
   if(/^\/api\/tab\/(gev|home|astra|board)$/.test(url.pathname)){
    const token=(await readFile(resolve(base,'kiosk/api-token'),'utf8')).trim();
    const response=await fetch(`http://127.0.0.1:4180/api/tabs/${url.pathname.split('/').pop()}/activate`,{method:'POST',headers:{Authorization:`Bearer ${token}`}});
    return json(res,response.status,await response.json());
   }
   return json(res,404,{error:'Unknown action'});
  }
  if(req.method!=='GET')return json(res,405,{error:'Method not allowed'});
  if(url.pathname==='/health')return json(res,200,{ok:true,transport:'SSH tunnel only'});
  const relative=url.pathname==='/'?'index.html':decodeURIComponent(url.pathname).slice(1);
  const file=resolve(root,relative);
  if(!file.startsWith(root+'/')||relative.includes('..')||['server.mjs'].includes(relative))return json(res,403,{error:'Invalid path'});
  const data=await readFile(file);
  const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.json':'application/json'}[extname(file)]||'application/octet-stream';
  res.writeHead(200,{'content-type':mime,...common});res.end(data);
 }catch(error){json(res,error.code==='ENOENT'?404:500,{error:error.code==='ENOENT'?'Not found':error.message});}
});
const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024});
server.on('upgrade',(req,socket,head)=>{
 if(req.url!=='/websockify'||!hosts.has(req.headers.host)||req.headers.origin!==`http://${req.headers.host}`){socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
 wss.handleUpgrade(req,socket,head,ws=>{
  const tcp=net.createConnection({host:'127.0.0.1',port:5900});
  ws.on('message',data=>tcp.write(data));
  tcp.on('data',data=>{if(ws.readyState===WebSocket.OPEN)ws.send(data,{binary:true});});
  tcp.on('error',()=>ws.close(1011,'VNC unavailable'));tcp.on('end',()=>ws.close());
  ws.on('close',()=>tcp.destroy());ws.on('error',()=>tcp.destroy());
 });
});
server.listen(6080,'127.0.0.1',()=>console.log('Remote display on loopback:6080; access through SSH'));
