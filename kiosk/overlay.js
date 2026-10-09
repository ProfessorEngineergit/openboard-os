(() => {
  if (window.top !== window || window.__megaKioskVersion === 5.1) return;
  window.__megaKioskDispose?.();
  document.getElementById('mega-display-controls')?.remove();
  window.__megaKiosk = true;
  window.__megaKioskVersion = 5.1;
  const send = value => window.megaKiosk(JSON.stringify(value));
  const icon = (name) => {
    const paths = {
      gev:'<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
      home:'<path d="m3 11 9-8 9 8M5 9v12h14V9M10 21v-7h4v7"/>',
      astra:'<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/>',
      board:'<path d="M4 17 16 5l4 4L8 21H3l1-4ZM14 7l4 4"/>',
      apps:'<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
      close:'<path d="m6 6 12 12M18 6 6 18"/>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.apps}</svg>`;
  };
  const mount = () => {
    const events = new AbortController();
    const on = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...(typeof options === 'boolean' ? { capture: options } : options), signal: events.signal });
    const cursorStyle = document.createElement('style');
    cursorStyle.textContent='html,body,body *{cursor:none!important}';
    document.documentElement.appendChild(cursorStyle);
    const host = document.createElement('div');
    host.id = 'mega-display-controls';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box;cursor:none!important;font-family:system-ui,sans-serif;user-select:none}
      svg{width:28px;height:28px;fill:none;stroke:currentColor;stroke-width:1.65;stroke-linecap:round;stroke-linejoin:round}
      button{appearance:none;border:0;color:inherit;font:inherit;padding:0;touch-action:manipulation}
      #dock{position:absolute;left:12px;top:12px;color:#edf4fb;pointer-events:auto;touch-action:none}
      .glass{border:1px solid #ffffff34;background:linear-gradient(145deg,#bac9dd12,#05090d14),#1018222e;box-shadow:inset 0 1px 1px #ffffff65,inset 0 -1px 1px #ffffff18;backdrop-filter:blur(12px) saturate(125%);filter:drop-shadow(0 12px 24px #0005)}
      #handle{position:fixed;left:12px;top:12px;isolation:isolate;overflow:hidden;display:grid;place-items:center;width:48px;height:48px;border-radius:18px;color:#e4edf6;touch-action:none}
      #handle svg{width:18px;height:18px;position:relative;z-index:1}#handle:active{background-color:#ffffff18}
      #panel{display:none;position:relative;isolation:isolate;border-radius:30px;overflow:hidden;width:min(680px,calc(100vw - 24px));padding:10px 12px 14px}
      #dock.side #panel{width:min(280px,calc(100vw - 24px))}
      #dock.open #panel{display:block;animation:reveal .22s cubic-bezier(.22,.8,.25,1)}#dock.open #handle{display:none}
      @keyframes reveal{from{opacity:0;transform:scale(.94)}to{opacity:1;transform:scale(1)}}
      @media(prefers-reduced-motion:reduce){#dock.open #panel{animation:none}}
      .lens{position:absolute;z-index:-2;pointer-events:none;opacity:1}
      #panel:after,#handle:after{content:'';position:absolute;inset:0;z-index:-1;background:linear-gradient(135deg,#17212e22,#0e17231c 45%,#0a111d33);pointer-events:none}
      #bar{height:48px;display:flex;align-items:center;gap:12px;margin-bottom:8px}
      #grip{display:flex;align-items:center;gap:10px;flex:1;height:48px;padding-left:10px;font-size:12px;font-weight:600;letter-spacing:1.6px;opacity:.78;touch-action:none}

      #hide{width:44px;height:44px;border-radius:50%;background:#ffffff09;display:grid;place-items:center}#hide svg{width:20px;height:20px}
      #tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
      #dock.side #tabs{grid-template-columns:1fr}
      #tabs button{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;min-height:94px;border:1px solid transparent;border-radius:22px;background:#ffffff04;transition:background .12s,transform .12s}
      #dock.side #tabs button{flex-direction:row;justify-content:flex-start;padding:0 18px;min-height:72px;gap:18px}
      #tabs button span{font-size:17px;font-weight:550;letter-spacing:.1px}
      #tabs button.active{background:linear-gradient(135deg,#d8ebff35,#accbff15);border-color:#ffffff48;box-shadow:inset 0 1px #ffffff40,0 3px 12px #0002;color:white}
      #tabs button:active{transform:scale(.96);background:#ffffff30}#tabs button:disabled{opacity:.5}
      #voice{position:absolute;bottom:24px;right:24px;pointer-events:auto;display:none;max-width:320px;background:#13202af5;border:1px solid #536b7d;border-radius:18px;padding:10px}
      #mic{width:100%;padding:18px;font-size:18px;border-radius:14px;background:#ffffff12}#mic.on{background:#2b6975}#status{font-size:13px;color:#c5d9e6;max-width:290px;margin:8px 4px 2px;white-space:pre-wrap}
    </style><div id="dock" class="side"><section id="panel" class="glass" aria-label="Apps"><canvas id="lens" class="lens"></canvas><div id="bar"><div id="grip">APPS</div><button id="hide" aria-label="Dock schließen">${icon('close')}</button></div><div id="tabs"></div></section><button id="handle" class="glass" aria-label="Apps öffnen"><canvas id="handle-lens" class="lens"></canvas>${icon('apps')}</button></div><div id="voice"><button id="mic">GEV · Gemini starten</button><div id="status"></div></div>`;
    document.documentElement.appendChild(host);
    const $ = id => shadow.getElementById(id);
    const dock = $('dock');
    const handle = $('handle');
    let handleLayout={x:0,y:0}, drag, suppressClickUntil=0;
    let timer, state, mic, audio, processor, source, playbackTime = 0, tabSignature='', layoutSignature='';
    let lastDOM=0;
    let frameCount=0, glassError='', lastGlass=0, detachRender, domTimer, backdropKind='';
    const glassMaterial={ior:1.5,dispersion:.035,bevel:18,height:22,refractScale:2.4,meniscus:1,blurPlateau:2.5,blurRim:1,specular:.36,fresnel:1,saturation:1.18,tintAmount:.025,tintColor:[.10,.15,.21],tintAdapt:0,shadow:0,edgeLine:.22};
    const renderers=new Map();
    const crop=document.createElement('canvas'), cropContext=crop.getContext('2d');
    const paintGlass = (force=false) => {
      if(document.hidden || (!force && performance.now()-lastGlass<140)) return;
      lastGlass=performance.now();
      const original=window.__godsEyeView?.viewer?.scene?.canvas || document.getElementById('board');
      try {
        const expanded=dock.classList.contains('open');
        const element=expanded?$('panel'):$('handle');
        const lens=expanded?$('lens'):$('handle-lens');
        const box=element.getBoundingClientRect(),w=Math.round(box.width),h=Math.round(box.height);
        if(!w||!h)return;
        // Bleed is real surrounding imagery, not stretched pixels from the lens center.
        const margin=48,cw=w+margin*2,ch=h+margin*2;
        lens.style.cssText=`left:-${margin}px;top:-${margin}px;width:${cw}px;height:${ch}px`;
        let renderer=renderers.get(lens);
        if(!renderer){renderer=new MegaGlass.WebGLGlass(lens,{compositeMode:'overlay',material:glassMaterial});renderers.set(lens,renderer);}
        if(crop.width!==cw||crop.height!==ch){crop.width=cw;crop.height=ch;}
        if(lens.width!==cw||lens.height!==ch){
          renderer.resize(cw,ch,1);
          renderer.setElements([{id:'surface',shape:'rect',x:margin,y:margin,width:w,height:h,radius:expanded?30:18}],false);
        }
        const region={x:box.left-margin,y:box.top-margin,width:cw,height:ch};
        const bg=getComputedStyle(document.body).backgroundColor;
        cropContext.setTransform(1,0,0,1,0,0);cropContext.clearRect(0,0,cw,ch);
        cropContext.fillStyle=bg==='rgba(0, 0, 0, 0)'?'#05080d':bg;cropContext.fillRect(0,0,cw,ch);
        if(original){
          backdropKind='live-canvas+dom';
          // Include GEV's opaque scope mask: the lens must not reveal hidden terrain.
          const layers=[original,...['scope-mask','world-overlay-canvas'].map(id=>document.getElementById(id)).filter(Boolean)];
          for(const layer of layers){
            const parent=layer.getBoundingClientRect(),style=getComputedStyle(layer);
            if(!parent.width||!parent.height||style.display==='none'||style.visibility==='hidden')continue;
            cropContext.globalAlpha=Number(style.opacity)||0;
            cropContext.drawImage(layer,(region.x-parent.left)*layer.width/parent.width,(region.y-parent.top)*layer.height/parent.height,cw*layer.width/parent.width,ch*layer.height/parent.height,0,0,cw,ch);
          }
        }else backdropKind='dom-repaint';
        // Add correctly aligned DOM text/chrome, including open Home Assistant shadows.
        // Re-measure periodically; the library also invalidates on DOM/layout changes.
        if(performance.now()-lastDOM>1500){MegaGlass.invalidatePageContent();lastDOM=performance.now();}
        cropContext.globalAlpha=1;
        cropContext.setTransform(1,0,0,1,-region.x,-region.y);
        MegaGlass.paintPageContent(cropContext,region,null);
        cropContext.setTransform(1,0,0,1,0,0);
        cropContext.globalAlpha=1;
        renderer.setBackdrop(crop,{update:'live',autoStart:false,shouldRender:false});
        renderer.render({dpr:1});frameCount++;glassError='';
      } catch(error){glassError=error.message;}
    };
    const bindGlass = () => {
      const scene=window.__godsEyeView?.viewer?.scene;
      if(scene&&!detachRender)detachRender=scene.postRender.addEventListener(()=>paintGlass());
      paintGlass(true);
    };
    window.__megaKioskRefreshGlass=()=>paintGlass(true);
    // GEV captures immediately after its WebGL draw; other apps refresh at 4 FPS.
    domTimer=setInterval(()=>{if(!window.__godsEyeView?.viewer?.scene)paintGlass();},250);
    const bounds=()=>({x:Math.max(0,innerWidth-48-24),y:Math.max(0,innerHeight-48-24)});
    const place = () => {
      dock.classList.add('side');dock.style.left='12px';dock.style.top='12px';
      if(!drag){const range=bounds();handle.style.left=`${12+handleLayout.x*range.x}px`;handle.style.top=`${12+handleLayout.y*range.y}px`;}
      bindGlass();
    };
    const hide=()=>{dock.classList.remove('open');place();};
    const show=()=>{dock.classList.add('open');place();clearTimeout(timer);timer=setTimeout(hide,12000);};
    on(window,'resize',place);
    on(handle,'click',event=>{if(performance.now()<suppressClickUntil){event.preventDefault();return;}show();});
    on($('hide'),'click',hide);
    // Only the compact launcher can move; the expanded panel stays top-left.
    on(handle,'pointerdown',event=>{
      if(!event.isPrimary || (event.pointerType==='mouse'&&event.button!==0))return;
      const box=handle.getBoundingClientRect();
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,left:box.left,top:box.top,moved:false};
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    on(handle,'pointermove',event=>{
      if(!drag||drag.id!==event.pointerId)return;
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if(!drag.moved&&Math.hypot(dx,dy)<6)return;
      drag.moved=true;
      const range=bounds(),left=Math.max(12,Math.min(12+range.x,drag.left+dx)),top=Math.max(12,Math.min(12+range.y,drag.top+dy));
      handle.style.left=`${left}px`;handle.style.top=`${top}px`;
      handleLayout={x:range.x?(left-12)/range.x:0,y:range.y?(top-12)/range.y:0};
      paintGlass();
    });
    const endDrag=event=>{
      if(!drag||drag.id!==event.pointerId)return;
      const moved=drag.moved;drag=undefined;suppressClickUntil=performance.now()+400;
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
      if(moved){void send({action:'layout',...handleLayout}).catch(()=>{});place();}
      else if(event.type==='pointerup')show();
    };
    on(handle,'pointerup',endDrag);on(handle,'pointercancel',endDrag);
    on(dock,'pointerdown',()=>clearTimeout(timer));
    on(dock,'pointerup',()=>{clearTimeout(timer);timer=setTimeout(hide,12000);});
    on(document,'contextmenu',event=>event.preventDefault(),true);
    const touches=new Map();
    on(document,'pointerdown',event=>{if(event.pointerType==='touch')touches.set(event.pointerId,{x:event.clientX,y:event.clientY});},true);
    on(document,'pointermove',event=>{
      const start=touches.get(event.pointerId);
      if(touches.size>=3&&start&&Math.min(start.x,innerWidth-start.x,start.y,innerHeight-start.y)<70&&Math.hypot(event.clientX-start.x,event.clientY-start.y)>70)show();
    },true);
    for(const name of ['pointerup','pointercancel'])on(document,name,event=>touches.delete(event.pointerId),true);
    const players = new Set();
    const stopAudio = () => {
      mic?.getTracks().forEach(track => track.stop()); mic = null;
      processor?.disconnect(); source?.disconnect(); processor = source = null;
      for (const player of players) { try { player.stop(); } catch {} }
      players.clear(); playbackTime = 0;
      audio?.close(); audio = null;
      $('mic').classList.remove('on'); $('mic').textContent = 'GEV · Gemini starten';
    };
    window.__megaKioskDispose = () => {
      events.abort(); clearTimeout(timer); clearInterval(domTimer); detachRender?.(); stopAudio();
      for (const renderer of renderers.values()) renderer.destroy();
      cursorStyle.remove(); host.remove();
      window.__megaKioskVersion = undefined;
    };
    on($('mic'),'click', async () => {
      if (mic) { send({ action: 'voice-stop' }); stopAudio(); return; }
      try {
        if (!state?.geminiConfigured) throw new Error('Gemini-Key fehlt. Einrichtung unter localhost:4180/settings.');
        // Clicking the microphone is the user's explicit recording action.
        mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
        audio = new AudioContext({ sampleRate: 24000 }); await audio.resume();
        source = audio.createMediaStreamSource(mic);
        processor = audio.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = event => {
          const input = event.inputBuffer.getChannelData(0), ratio = audio.sampleRate / 16000;
          const pcm = new Int16Array(Math.floor(input.length / ratio));
          for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)])) * 32767;
          const bytes = new Uint8Array(pcm.buffer);
          send({ action: 'voice-audio', data: btoa(String.fromCharCode(...bytes)) });
        };
        send({ action: 'voice-start' });
        // Begin capture after the upstream setup acknowledgement, below.
        source.connect(processor);
        $('mic').classList.add('on'); $('mic').textContent = 'Gemini stoppen';
        $('status').textContent = 'Verbinde …';
      } catch (error) { stopAudio(); $('status').textContent = error.message; }
    });
    window.__megaKioskUpdate = next => {
      state=next;
      const signature=next.tabs.map(t=>t.id+':'+t.name).join('|');
      if(signature!==tabSignature){
        tabSignature=signature;
        $('tabs').replaceChildren(...next.tabs.map(tab=>{
          const button=document.createElement('button');button.dataset.tab=tab.id;
          button.setAttribute('aria-label',tab.name);button.innerHTML=icon(tab.id);
          const label=document.createElement('span');label.textContent=tab.name;button.appendChild(label);
          on(button,'click',async()=>{button.disabled=true;try{await send({action:'activate',id:tab.id});hide();}finally{button.disabled=false;}});
          return button;
        }));
      }
      for(const button of $('tabs').children){const selected=button.dataset.tab===next.current;button.classList.toggle('active',selected);button.setAttribute('aria-pressed',String(selected));}
      const layout=JSON.stringify(next.layout);
      if(layout!==layoutSignature){layoutSignature=layout;if(!drag){handleLayout=next.layout?.positioned?{x:next.layout.x,y:next.layout.y}:{x:0,y:0};place();}}
      $('voice').style.display=next.current==='gev'&&next.geminiConfigured?'block':'none';
      bindGlass();
    };
    window.__megaKioskVoice = message => {
      if (message.type === 'ready') { processor?.connect(audio.destination); $('status').textContent = 'Hört zu'; }
      if (message.type === 'status') $('status').textContent = message.text;
      if (message.type === 'stop' || message.type === 'error') { stopAudio(); $('status').textContent = message.text || ''; }
      if (message.type === 'interrupted') { for (const player of players) { try { player.stop(); } catch {} } players.clear(); playbackTime = audio?.currentTime || 0; }
      if (message.type === 'audio' && audio) {
        const binary = atob(message.data), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
        const pcm = new Int16Array(bytes.buffer), buffer = audio.createBuffer(1, pcm.length, message.rate || 24000);
        const samples = buffer.getChannelData(0); for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
        const player = audio.createBufferSource(); player.buffer = buffer; player.connect(audio.destination);
        playbackTime = Math.max(audio.currentTime + .02, playbackTime); player.start(playbackTime); playbackTime += buffer.duration;
        players.add(player); player.onended = () => players.delete(player);
      }
    };
    window.__megaKioskDiagnostics = () => ({open:dock.classList.contains('open'),voiceVisible:$('voice').style.display!=='none',tabs:$('tabs').children.length,handle:JSON.parse(JSON.stringify($('handle').getBoundingClientRect())),panel:JSON.parse(JSON.stringify($('panel').getBoundingClientRect())),glassFrames:frameCount,glassError,glassEngine:MegaGlass.IOR_RENDERER,ior:glassMaterial.ior,dispersion:glassMaterial.dispersion,backdropKind,backdropMargin:48});
    on(document,'visibilitychange', () => { if (document.hidden && mic) { send({ action: 'voice-stop' }); stopAudio(); } });
    send({ action: 'ready' });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
})();
