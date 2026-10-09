import RFB from './novnc/core/rfb.js';
const $=id=>document.getElementById(id);
let rfb,reconnectTimer,closing=false;
function connect(){
 clearTimeout(reconnectTimer);$('screen').replaceChildren();
 const current=new RFB($('screen'),`${location.protocol==='https:'?'wss':'ws'}://${location.host}/websockify`);rfb=current;
 current.scaleViewport=true;current.resizeSession=false;current.showDotCursor=true;current.qualityLevel=6;current.compressionLevel=3;
 current.addEventListener('connect',()=>{if(rfb===current)$('status').textContent='Verbunden · verschlüsselter SSH-Tunnel';});
 current.addEventListener('disconnect',()=>{
  if(closing||rfb!==current)return;
  $('status').textContent='Verbindung unterbrochen · verbinde automatisch erneut …';
  reconnectTimer=setTimeout(connect,3000);
 });
}
window.addEventListener('beforeunload',()=>{closing=true;clearTimeout(reconnectTimer);rfb?.disconnect();});
connect();
async function action(path){const response=await fetch(path,{method:'POST'});const data=await response.json();if(!response.ok){$('status').textContent=data.error;return;}setTimeout(()=>rfb.focus(),100);}
for(const button of document.querySelectorAll('[data-tab]'))button.onclick=()=>action(`/api/tab/${button.dataset.tab}`);
$('desktop').onclick=()=>action('/api/desktop');$('terminal').onclick=()=>action('/api/terminal');$('kiosk').onclick=()=>action('/api/kiosk');
$('fullscreen').onclick=()=>document.fullscreenElement?document.exitFullscreen():$('screen').requestFullscreen();
$('clipboard').onclick=()=>{const text=prompt('Text in die Zwischenablage des Display-Rechners kopieren:');if(text!==null){rfb.clipboardPasteFrom(text);rfb.focus();}};

$('chrome').onclick=()=>action('/api/chrome-setup');
$('settings').onclick=()=>window.open('/settings','_blank','noopener');
