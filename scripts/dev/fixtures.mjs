// Stand-ins for God's Eye View (4173) and Home Assistant (8123) for local
// end-to-end tests. Usage: node scripts/dev/fixtures.mjs
import http from 'node:http';

const GEV = `<!doctype html><html><head><meta charset="utf-8"><title>GEV fixture</title>
<style>html,body{margin:0;height:100%;background:#02060c;overflow:hidden}canvas{position:fixed;inset:0;width:100%;height:100%}</style></head>
<body><canvas id="globe"></canvas><script>
const canvas = document.getElementById('globe'), ctx = canvas.getContext('2d');
const listeners = new Set();
function resize(){ canvas.width = innerWidth; canvas.height = innerHeight; }
resize(); addEventListener('resize', resize);
function frame(t){
  const w = canvas.width, h = canvas.height;
  const g = ctx.createRadialGradient(w*.5, h*.55, 40, w*.5, h*.55, h*.62);
  g.addColorStop(0, '#2d6cdf'); g.addColorStop(.55, '#0b3a6b'); g.addColorStop(1, '#02060c');
  ctx.fillStyle = '#02060c'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(w*.5, h*.55, h*.42, 0, Math.PI*2); ctx.fill();
  ctx.strokeStyle = 'rgba(160,220,255,.35)'; ctx.lineWidth = 1.5;
  for (let i = -6; i <= 6; i++) { ctx.beginPath(); ctx.ellipse(w*.5, h*.55, Math.abs(Math.cos(t/4000 + i/4))*h*.42, h*.42, 0, 0, Math.PI*2); ctx.stroke(); }
  for (let i = 0; i < 40; i++) { ctx.fillStyle = 'rgba(255,190,90,.9)'; ctx.fillRect((i*137 + t/30) % w, (i*89) % h, 4, 4); }
  for (const fn of listeners) fn();
  if (window.__godsEyeView.viewer.useDefaultRenderLoop) requestAnimationFrame(frame);
}
window.__godsEyeView = {
  viewer: { targetFrameRate: 60, resolutionScale: 1, useDefaultRenderLoop: true,
    scene: { canvas, msaaSamples: 4, postRender: { addEventListener(fn){ listeners.add(fn); return () => listeners.delete(fn); } } } },
  voiceCommands: { runner: async (name, args) => ({ ok: true, name, args }) },
};
document.addEventListener('visibilitychange', () => { window.__godsEyeView.viewer.useDefaultRenderLoop = !document.hidden; if (!document.hidden) requestAnimationFrame(frame); });
requestAnimationFrame(frame);
</script></body></html>`;

const HA = `<!doctype html><html><head><meta charset="utf-8"><title>Home Assistant fixture</title>
<style>body{margin:0;font:18px system-ui;background:#f2f4f7;color:#1c2430}aside{position:fixed;left:0;top:0;bottom:0;width:240px;background:#fff;border-right:1px solid #dde2ea;padding:20px}aside a,aside button{display:block;margin:10px 0;padding:14px;border-radius:12px;background:#eef2f8;color:inherit;text-decoration:none;border:0;font:inherit;width:100%;text-align:left}main{margin-left:280px;padding:30px}.card{background:#fff;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 1px 3px #0001}input{font:inherit;padding:12px;border-radius:10px;border:1px solid #c9d1dc;width:320px}</style></head>
<body><aside><b>Home Assistant</b>
<a href="/lovelace/0" id="nav-0">Übersicht</a>
<a href="/lovelace/1" id="nav-blank" target="_blank">Energie (neuer Tab)</a>
<button id="nav-open">Kameras (window.open)</button></aside>
<main><h1 id="title">Übersicht</h1><div class="card">Wohnzimmer · 21,5 °C · Licht an</div><div class="card">Küche · 20,1 °C</div>
<div class="card"><label>Suche <input id="search" placeholder="Entität suchen"></label></div><p id="loads"></p></main>
<script>
// Like HA: internal anchors are routed client-side, "location-changed" re-renders.
const render = () => { document.getElementById('title').textContent = 'Dashboard ' + location.pathname; };
addEventListener('location-changed', render); addEventListener('popstate', render);
document.addEventListener('click', e => { const a = e.target.closest('a'); if (a && !a.target) { e.preventDefault(); history.pushState(null, '', a.getAttribute('href')); render(); } });
document.getElementById('nav-open').onclick = () => window.open('/lovelace/2', '_blank');
render();
</script></body></html>`;

export function startFixtures() {
  const gev = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(GEV); }).listen(4173, '127.0.0.1');
  const ha = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HA); }).listen(8123, '127.0.0.1');
  return () => { gev.close(); ha.close(); };
}

if (import.meta.url === `file://${process.argv[1]}`) { startFixtures(); console.log('Fixtures: GEV :4173, Home Assistant :8123'); }
