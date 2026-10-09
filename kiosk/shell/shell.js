// OpenBoard shell. Injected into every top-level app page by the controller
// (bundled by lib/shell-bundle.mjs with TOKENS_CSS, FONT_CSS, SHELL_VERSION,
// OBIcons, OBWidgets and MegaGlass in scope). Invisible until summoned:
// swipe up from the bottom edge (or tap the indicator) to open the dock.
if (window.top !== window) return;
if (window.__openboard?.version === SHELL_VERSION) return;
window.__openboard?.dispose?.();
window.__megaKioskDispose?.();
document.getElementById('mega-display-controls')?.remove();
document.getElementById('openboard-shell')?.remove();

const LONG_PRESS_MS = 520;
const EDGE_PX = 28;

const bridge = (action, data = {}) => typeof window.openboardBridge === 'function'
  ? window.openboardBridge(JSON.stringify({ action, ...data })).catch(() => null)
  : Promise.resolve(null);

const CSS = `
:host{all:initial}
#root{position:fixed;inset:0;pointer-events:none;font-family:var(--ob-font);color:var(--ob-text);-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none;font-size:var(--ob-t)}
#root *{box-sizing:border-box;cursor:none!important}
button{appearance:none;border:0;background:none;color:inherit;font:inherit;padding:0;touch-action:manipulation}
svg.ob-icon{width:var(--ob-icon);height:var(--ob-icon);fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;flex:none}
.surface{position:relative;isolation:isolate;border-radius:var(--R,32px);background:var(--ob-glass-tint),var(--ob-glass-fill);border:1px solid var(--ob-glass-edge);box-shadow:var(--ob-glass-inset),var(--ob-glass-shadow);backdrop-filter:blur(var(--ob-glass-blur)) saturate(var(--ob-glass-saturate));-webkit-backdrop-filter:blur(var(--ob-glass-blur)) saturate(var(--ob-glass-saturate))}
#root.webgl #row .surface{backdrop-filter:none;-webkit-backdrop-filter:none;background:var(--ob-glass-tint)}
#root.glass-off .surface{backdrop-filter:none;-webkit-backdrop-filter:none;background:var(--ob-glass-fill-strong)}
.strong{background:var(--ob-glass-tint),var(--ob-glass-fill-strong)}

#indicator{position:absolute;left:50%;bottom:0;width:240px;height:30px;margin-left:-120px;pointer-events:auto;display:grid;place-items:center;opacity:0;transition:opacity .35s var(--ob-ease)}
#indicator::after{content:"";width:150px;height:6px;border-radius:3px;background:var(--ob-text);box-shadow:0 0 0 1px rgba(0,0,0,.25)}
#indicator.show{opacity:.42}
#root.open #indicator,#root.asleep #indicator,#root.indicator-never #indicator{opacity:0;pointer-events:none}

#row{position:absolute;left:50%;bottom:18px;display:flex;align-items:flex-end;gap:14px;max-width:calc(100vw - 24px);transform:translate(-50%,calc(100% + 60px));opacity:0;transition:transform var(--ob-dur-slow) var(--ob-spring),opacity var(--ob-dur) var(--ob-ease)}
#root.open #row{transform:translate(-50%,0);opacity:1;pointer-events:auto}
#lens{position:absolute;pointer-events:none;z-index:-1}
#tiles{display:flex;gap:14px;flex:none}
/* Nested corners follow inner = outer - (padding + 1px border). Cells touch the tile edge with
   the outer radius and each other with a small one. */
.tile-wrap{--R:32px;--P:8px;--ro:calc(var(--R) - var(--P) - 1px);--ri:9px;width:216px;height:104px;padding:var(--P);touch-action:none}
.tile-wrap .ob-tile{height:100%;padding:0}
.tile-wrap .ob-tile .ob-w{border-radius:var(--ri)}
.tile-wrap .ob-tile.size-full .ob-w{border-radius:var(--ro)}
.tile-wrap .ob-tile.size-half .ob-w:nth-child(1){border-radius:var(--ro) var(--ri) var(--ri) var(--ro)}
.tile-wrap .ob-tile.size-half .ob-w:nth-child(2){border-radius:var(--ri) var(--ro) var(--ro) var(--ri)}
.tile-wrap .ob-tile.size-quarter .ob-w:nth-child(1){border-radius:var(--ro) var(--ri) var(--ri) var(--ri)}
.tile-wrap .ob-tile.size-quarter .ob-w:nth-child(2){border-radius:var(--ri) var(--ro) var(--ri) var(--ri)}
.tile-wrap .ob-tile.size-quarter .ob-w:nth-child(3){border-radius:var(--ri) var(--ri) var(--ri) var(--ro)}
.tile-wrap .ob-tile.size-quarter .ob-w:nth-child(4){border-radius:var(--ri) var(--ri) var(--ro) var(--ri)}
#dock{--R:32px;--P:10px;display:flex;gap:8px;padding:var(--P);height:104px;align-items:center;touch-action:none;min-width:0}
.app{position:relative;flex:0 1 128px;min-width:80px;width:128px;height:84px;border-radius:calc(32px - 10px - 1px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;background:var(--ob-glass-pressed);transition:transform var(--ob-dur-fast) var(--ob-ease),background var(--ob-dur-fast)}
.app .ob-icon{width:34px;height:34px}
.app span{font-size:13px;font-weight:550;color:var(--ob-text-dim);max-width:calc(100% - 12px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.app.active{background:var(--ob-glass-selected);box-shadow:inset 0 0 0 1px var(--ob-glass-edge)}
.app.active span{color:var(--ob-text)}
.app::after{content:"";position:absolute;top:8px;right:9px;width:7px;height:7px;border-radius:50%;opacity:0;transition:opacity .2s}
.app.frozen::after{opacity:.9;box-shadow:inset 0 0 0 1.6px var(--ob-text-dim)}
.app.loading::after{opacity:1;background:var(--ob-warn)}
.app.terminated{opacity:.62}
.app:active,.app.pressed{transform:scale(.93)}
.divider{width:1px;align-self:stretch;margin:10px 2px;background:var(--ob-hair)}
#voice-btn.on{background:var(--ob-glass-selected);color:var(--ob-err)}

#bubble{--R:24px;position:absolute;left:50%;bottom:146px;transform:translateX(-50%);max-width:min(820px,80vw);padding:14px 22px;font-size:20px;line-height:1.35;display:none;pointer-events:auto;text-align:center}
#bubble.show{display:block;animation:pop var(--ob-dur) var(--ob-spring)}

#menu{--R:24px;position:absolute;display:none;min-width:250px;padding:8px;pointer-events:auto;z-index:4}
#menu.show{display:block;animation:pop var(--ob-dur) var(--ob-spring)}
#menu .title{padding:10px 14px 6px;font-size:13px;color:var(--ob-text-dim);font-weight:600;letter-spacing:.04em;text-transform:uppercase}
#menu button{display:flex;align-items:center;gap:14px;width:100%;min-height:54px;padding:0 14px;border-radius:calc(24px - 8px - 1px);font-size:18px;text-align:left}
#menu button:active{background:var(--ob-glass-pressed)}
#menu button:disabled{opacity:.4}
#menu .check{margin-left:auto;opacity:0}#menu .on .check{opacity:1}

#editor{position:absolute;left:50%;bottom:140px;transform:translateX(-50%);width:min(1180px,calc(100vw - 40px));height:min(440px,calc(100vh - 180px));--R:34px;display:none;grid-template-columns:220px 1fr;overflow:hidden;pointer-events:auto}
#editor.show{display:grid;animation:rise var(--ob-dur-slow) var(--ob-spring)}
#editor nav{padding:18px 12px;border-right:1px solid var(--ob-hair);display:flex;flex-direction:column;gap:4px}
#editor nav h2{margin:4px 10px 12px;font-size:22px;font-weight:650}
#cats{display:flex;flex-direction:column;gap:4px}
#editor nav button{width:100%;min-height:52px;border-radius:calc(34px - 12px - 1px);padding:0 14px;text-align:left;font-size:17px;color:var(--ob-text-dim)}
#editor nav button.on{background:var(--ob-glass-selected);color:var(--ob-text)}
#editor nav .spacer{flex:1}
#editor nav .done{background:var(--ob-accent);color:var(--ob-accent-ink);text-align:center;font-weight:650}
#library{padding:18px;overflow:auto;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:none}
#library .hint{color:var(--ob-text-dim);font-size:15px;margin:0 4px 14px;line-height:1.4}
#library .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:12px}
.lib{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:calc(34px - 18px - 1px);background:var(--ob-glass-pressed);touch-action:none}
.lib .preview{height:64px;display:flex}
.lib .preview .ob-w{flex:1;border-radius:calc(34px - 18px - 1px - 10px)}
.lib b{font-size:15px;font-weight:600}
.lib small{font-size:12.5px;color:var(--ob-text-dim);line-height:1.3}
#inspector{padding:22px 26px;overflow:auto;overscroll-behavior:contain;touch-action:pan-y;scrollbar-width:none}
#inspector h3{margin:0 0 4px;font-size:24px;font-weight:650;display:flex;align-items:center;gap:12px}
#inspector p{margin:0 0 18px;color:var(--ob-text-dim);font-size:15px}
.field{display:flex;align-items:center;gap:16px;min-height:62px;border-top:1px solid var(--ob-hair)}
.field label{flex:0 0 200px;font-size:17px}
.field .control{flex:1;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.chip{min-height:46px;padding:0 16px;border-radius:999px;background:var(--ob-glass-pressed);font-size:16px}
.chip.on{background:var(--ob-accent);color:var(--ob-accent-ink)}
.field input{flex:1;min-height:50px;border-radius:14px;border:1px solid var(--ob-border);background:var(--ob-bg-2);color:var(--ob-text);font:400 17px var(--ob-font);padding:0 14px;user-select:text;-webkit-user-select:text}
.icons{display:grid;grid-template-columns:repeat(auto-fill,52px);gap:6px;width:100%}
.icons button{width:52px;height:52px;border-radius:14px;display:grid;place-items:center;background:var(--ob-glass-pressed)}
.icons button.on{background:var(--ob-accent);color:var(--ob-accent-ink)}
.actions{display:flex;gap:10px;margin-top:20px}
.actions button{min-height:52px;padding:0 20px;border-radius:999px;background:var(--ob-glass-pressed);font-size:17px}
.actions .danger{background:var(--ob-err-bg);color:var(--ob-err)}
#root.editing .tile-wrap{animation:wiggle .32s ease-in-out infinite alternate}
#root.editing .tile-wrap:nth-child(2){animation-delay:-.16s}
.tile-wrap.drop{box-shadow:0 0 0 3px var(--ob-accent),var(--ob-glass-shadow)}
.tile-tools{display:none;gap:10px;align-items:center}
#root.editing .tile-tools{display:flex}
.tile-tools button{width:56px;height:56px;border-radius:50%;display:grid;place-items:center}
#ghost{--R:20px;position:absolute;width:156px;height:68px;padding:6px;display:none;z-index:9;pointer-events:none;opacity:.92;transform:translate(-50%,-50%) scale(1.05)}
#ghost.show{display:flex}
#ghost .ob-w{flex:1;border-radius:calc(20px - 6px - 1px)}
.badge-x{position:absolute;top:-6px;left:-6px;width:26px;height:26px;border-radius:50%;background:var(--ob-surface-3);color:var(--ob-text);display:none;place-items:center;box-shadow:0 2px 6px rgba(0,0,0,.4);z-index:2}
.badge-x svg{width:14px;height:14px}
#root.editing .badge-x{display:grid}
.ob-w{position:relative}

#prompts{position:absolute;top:22px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:12px;width:min(720px,calc(100vw - 40px))}
.prompt{--R:28px;padding:20px 22px 18px;pointer-events:auto;animation:drop var(--ob-dur-slow) var(--ob-spring)}
.prompt p{margin:0 0 14px;font-size:19px;line-height:1.4;display:flex;gap:14px}
.prompt .ob-icon{color:var(--ob-warn);flex:none;margin-top:2px}
.prompt .choices{display:flex;gap:10px;justify-content:flex-end}
.prompt .choices button{min-height:54px;padding:0 22px;border-radius:999px;background:var(--ob-glass-pressed);font-size:17px;font-weight:550}
.prompt .choices button:first-child{background:var(--ob-accent);color:var(--ob-accent-ink)}
.prompt .timer{height:3px;border-radius:2px;background:var(--ob-hair);margin-top:14px;overflow:hidden}
.prompt .timer i{display:block;height:100%;background:var(--ob-text-dim);transform-origin:left;animation:countdown linear forwards}
#toasts{position:absolute;top:22px;right:22px;display:flex;flex-direction:column;gap:10px;align-items:flex-end}
.toast{--R:20px;display:flex;align-items:center;gap:12px;padding:12px 18px;font-size:16px;animation:drop var(--ob-dur) var(--ob-spring);max-width:520px}

#keyboard{--kb:1;--R:calc(30px * var(--kb));--P:calc(12px * var(--kb));position:absolute;left:50%;bottom:16px;transform:translate(-50%,calc(100% + 40px));width:min(calc(1240px * var(--kb)),calc(100vw - 32px));padding:var(--P);pointer-events:auto;transition:transform var(--ob-dur) var(--ob-ease);touch-action:none}
#keyboard.show{transform:translate(-50%,0)}
#root.open #keyboard.show{transform:translate(-50%,calc(-100% - 140px))}
#keyboard.resizing{transition:none}
#keyboard .krow{display:flex;gap:calc(8px * var(--kb));justify-content:center;margin:calc(8px * var(--kb)) 0}
#keyboard button{flex:1 1 0;max-width:calc(96px * var(--kb));height:calc(66px * var(--kb));border-radius:calc(30px * var(--kb) - 12px * var(--kb) - 1px);background:var(--ob-glass-pressed);font-size:calc(24px * var(--kb));font-weight:450}
#keyboard button.wide{max-width:calc(150px * var(--kb));flex-grow:1.6;font-size:calc(17px * var(--kb))}
#keyboard button.space{max-width:calc(520px * var(--kb));flex-grow:6}
.kb-corner{position:absolute;width:44px;height:44px;touch-action:none;z-index:2}
.kb-corner::after{content:"";position:absolute;width:16px;height:16px;border:2.5px solid var(--ob-text-dim);opacity:.55;border-radius:0}
.kb-corner[data-corner="tl"]{left:-24px;top:-24px}.kb-corner[data-corner="tl"]::after{left:5px;top:5px;border-right:0;border-bottom:0;border-top-left-radius:9px}
.kb-corner[data-corner="tr"]{right:-24px;top:-24px}.kb-corner[data-corner="tr"]::after{right:5px;top:5px;border-left:0;border-bottom:0;border-top-right-radius:9px}
.kb-corner[data-corner="bl"]{left:-24px;bottom:-24px}.kb-corner[data-corner="bl"]::after{left:5px;bottom:5px;border-right:0;border-top:0;border-bottom-left-radius:9px}
.kb-corner[data-corner="br"]{right:-24px;bottom:-24px}.kb-corner[data-corner="br"]::after{right:5px;bottom:5px;border-left:0;border-top:0;border-bottom-right-radius:9px}
.kb-corner.drag::after{opacity:1;border-color:var(--ob-accent)}
#keyboard button.on{background:var(--ob-accent);color:var(--ob-accent-ink)}
#keyboard button:active{background:var(--ob-glass-selected);transform:scale(.96)}

#sleep{position:absolute;inset:0;background:#000;opacity:0;pointer-events:none;transition:opacity .9s var(--ob-ease)}
#root.asleep #sleep{opacity:1;pointer-events:auto}
#sleep .hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);color:#555;font-size:20px;opacity:0;transition:opacity 1s}
#sleep.hinted .hint{opacity:1}

@keyframes pop{from{opacity:0;transform:translateX(-50%) scale(.94)}to{opacity:1;transform:translateX(-50%) scale(1)}}
#menu.show{animation:fade var(--ob-dur) var(--ob-ease)}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes rise{from{opacity:0;transform:translate(-50%,24px)}to{opacity:1;transform:translate(-50%,0)}}
@keyframes drop{from{opacity:0;transform:translateY(-14px)}to{opacity:1;transform:none}}
@keyframes wiggle{from{transform:rotate(-.7deg)}to{transform:rotate(.7deg)}}
@keyframes countdown{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@media (prefers-reduced-motion:reduce){#root.editing .tile-wrap{animation:none}}
`;

const mount = () => {
  const events = new AbortController();
  const on = (target, name, handler, options = {}) => target.addEventListener(name, handler, { ...(typeof options === 'boolean' ? { capture: options } : options), signal: events.signal });
  const timers = new Set();
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const cancel = id => { clearTimeout(id); timers.delete(id); };

  // Document-level helpers: hidden cursor, fixed zoom, fonts (fonts can't load inside shadow DOM).
  const docStyle = document.createElement('style');
  docStyle.id = 'openboard-shell-doc';
  docStyle.textContent = `html,body,body *{cursor:none!important}${FONT_CSS}`;
  document.documentElement.appendChild(docStyle);
  let viewport = document.querySelector('meta[name="viewport"]'), viewportCreated = false;
  const viewportBefore = viewport?.getAttribute('content');
  if (!viewport) { viewport = document.createElement('meta'); viewport.name = 'viewport'; (document.head || document.documentElement).appendChild(viewport); viewportCreated = true; }
  viewport.setAttribute('content', 'width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no');
  on(window, 'wheel', event => { if (event.ctrlKey) event.preventDefault(); }, { capture: true, passive: false });
  on(window, 'keydown', event => { if ((event.ctrlKey || event.metaKey) && ['+', '-', '=', '0'].includes(event.key)) event.preventDefault(); }, true);
  for (const name of ['gesturestart', 'gesturechange']) on(document, name, event => event.preventDefault(), { capture: true, passive: false });
  on(document, 'contextmenu', event => event.preventDefault(), true);

  const host = document.createElement('div');
  host.id = 'openboard-shell';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;zoom:1';
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${TOKENS_CSS}${OBWidgets.css}${CSS}</style>
    <div id="root">
      <div id="sleep"><div class="hint">Zum Aufwecken tippen</div></div>
      <div id="prompts"></div><div id="toasts"></div>
      <div id="bubble" class="surface strong"></div>
      <div id="editor" class="surface strong" aria-label="Widgets bearbeiten">
        <nav><h2>Widgets</h2><div id="cats"></div><span class="spacer"></span><button class="done" id="editor-done">Fertig</button></nav>
        <section id="library"></section><section id="inspector" hidden></section>
      </div>
      <div id="row">
        <canvas id="lens"></canvas>
        <div class="tile-tools"><button class="surface" id="tile-add" aria-label="Kachel hinzufügen">${OBIcons.svg('plus')}</button></div>
        <div id="tiles"></div>
        <div id="dock" class="surface" role="toolbar" aria-label="Apps"></div>
      </div>
      <div id="menu" class="surface strong" role="menu"></div>
      <div id="keyboard" class="surface strong" aria-label="Bildschirmtastatur"></div>
      <div id="ghost" class="surface strong"></div>
      <div id="indicator" aria-label="Dock öffnen"></div>
    </div>`;
  document.documentElement.appendChild(host);
  const $ = id => shadow.getElementById(id);
  const root = $('root'), row = $('row'), dock = $('dock'), tilesEl = $('tiles'), indicator = $('indicator');

  let state = null, metrics = null, glance = null, mqttValues = {};
  let hideTimer, indicatorTimer, editing = false, inspecting = null, category = OBWidgets.categories[0];
  let dockSignature = '', tilesSignature = '';

  // ---------- Dock open / close ----------
  const isOpen = () => root.classList.contains('open');
  const scheduleHide = () => {
    cancel(hideTimer);
    if (editing) return;
    hideTimer = later(close, (state?.dock?.autoHideSeconds || 6) * 1000);
  };
  const open = () => {
    if (!state || root.classList.contains('asleep')) return;
    if (!isOpen()) { root.classList.add('open'); void bridge('metrics-subscribe', { on: true }); renderTiles(); startGlass(); }
    scheduleHide();
  };
  function close() {
    if (editing) closeEditor();
    if (!isOpen()) return;
    root.classList.remove('open'); hideMenu();
    cancel(hideTimer); void bridge('metrics-subscribe', { on: false }); stopGlass();
  }
  const showIndicator = () => {
    if (state?.dock?.indicator !== 'touch') return;
    indicator.classList.add('show'); cancel(indicatorTimer);
    indicatorTimer = later(() => indicator.classList.remove('show'), 2600);
  };
  on(indicator, 'pointerdown', event => { event.preventDefault(); open(); });

  // Swipe up from the bottom edge, like iPadOS. Capture phase so every app works.
  let swipe = null, lastActivity = 0;
  on(window, 'pointerdown', event => {
    if (performance.now() - lastActivity > 5000) { lastActivity = performance.now(); void bridge('activity'); }
    if (root.classList.contains('asleep')) return;
    if (event.clientY > innerHeight - 140) showIndicator();
    // Fingers are tracked with touch events below: on scrollable pages the
    // browser cancels pointer events as soon as it starts panning.
    if (event.pointerType !== 'touch' && event.clientY >= innerHeight - EDGE_PX && event.isPrimary) swipe = { id: event.pointerId, x: event.clientX, y: event.clientY };
    if (isOpen() && !event.composedPath().includes(host)) close();
  }, true);
  const gesture = { starts: 0, moves: 0, opens: 0 };
  const swipeMove = (id, x, y) => {
    if (!swipe || swipe.id !== id) return;
    gesture.moves++;
    const dy = swipe.y - y, dx = Math.abs(x - swipe.x);
    if (dy > 36 && dy > dx * 1.2) { swipe = null; gesture.opens++; open(); }
  };
  on(window, 'pointermove', event => swipeMove(event.pointerId, event.clientX, event.clientY), true);
  for (const name of ['pointerup', 'pointercancel']) on(window, name, event => { if (swipe?.id === event.pointerId) swipe = null; }, true);
  on(window, 'touchstart', event => {
    const touch = event.changedTouches[0];
    gesture.starts++;
    if (event.touches.length === 1 && touch.clientY >= innerHeight - EDGE_PX && !root.classList.contains('asleep')) swipe = { id: `t${touch.identifier}`, x: touch.clientX, y: touch.clientY };
  }, { capture: true, passive: true });
  on(window, 'touchmove', event => { for (const touch of event.changedTouches) swipeMove(`t${touch.identifier}`, touch.clientX, touch.clientY); }, { capture: true, passive: true });
  for (const name of ['touchend', 'touchcancel']) on(window, name, () => { if (typeof swipe?.id === 'string') swipe = null; }, { capture: true, passive: true });
  on(dock, 'pointerdown', () => cancel(hideTimer));
  on(row, 'pointerup', scheduleHide);

  // Swipe down on the dock closes it.
  let dockSwipe = null;
  on(row, 'pointerdown', event => { dockSwipe = { y: event.clientY, id: event.pointerId }; });
  on(row, 'pointermove', event => { if (dockSwipe?.id === event.pointerId && event.clientY - dockSwipe.y > 50 && !editing && !drag) { dockSwipe = null; close(); } });

  // ---------- Long press helper ----------
  const pressable = (element, { tap, hold }) => {
    let timer, start, held = false, moved = false;
    on(element, 'pointerdown', event => {
      if (event.button > 0) return;
      held = false; moved = false; start = { x: event.clientX, y: event.clientY, target: event.target };
      element.classList.add('pressed');
      timer = later(() => { held = true; element.classList.remove('pressed'); hold?.(event, start.target); }, LONG_PRESS_MS);
    });
    on(element, 'pointermove', event => { if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) { moved = true; cancel(timer); element.classList.remove('pressed'); } });
    const end = event => {
      cancel(timer); element.classList.remove('pressed');
      if (start && !held && !moved && event.type === 'pointerup') tap?.(event, start.target);
      start = null;
    };
    on(element, 'pointerup', end); on(element, 'pointercancel', end);
  };

  // ---------- Dock rendering ----------
  const runtimeOf = id => state?.apps?.find(app => app.id === id);
  const renderDock = () => {
    const apps = (state.dock?.order || []).map(runtimeOf).filter(app => app?.enabled);
    const voice = state.voice?.gemini && state.active === 'gev';
    const signature = apps.map(app => `${app.id}:${app.name}:${app.icon}`).join('|') + (voice ? '|voice' : '');
    if (signature !== dockSignature) {
      dockSignature = signature;
      dock.replaceChildren(...apps.map(app => {
        const button = document.createElement('button');
        button.className = 'app'; button.dataset.app = app.id; button.setAttribute('aria-label', app.name);
        button.innerHTML = `${OBIcons.svg(app.icon)}<span></span>`;
        button.querySelector('span').textContent = app.name;
        pressable(button, { tap: () => activate(app.id), hold: () => showAppMenu(app.id, button) });
        return button;
      }));
      if (voice) {
        const divider = document.createElement('span'); divider.className = 'divider';
        const button = document.createElement('button');
        button.className = 'app'; button.id = 'voice-btn'; button.setAttribute('aria-label', 'Gemini-Sprachsteuerung');
        button.innerHTML = `${OBIcons.svg('mic')}<span>Gemini</span>`;
        on(button, 'click', toggleVoice);
        dock.append(divider, button);
      }
    }
    for (const button of dock.querySelectorAll('[data-app]')) {
      const app = runtimeOf(button.dataset.app);
      button.classList.toggle('active', app.id === state.active);
      for (const name of ['frozen', 'loading', 'terminated']) button.classList.toggle(name, app.lifecycle === name);
    }
    $('voice-btn')?.classList.toggle('on', !!voiceSession);
  };
  const activate = async id => { await bridge('activate', { id }); close(); };

  // ---------- App menu (long press on an app) ----------
  const hideMenu = () => $('menu').classList.remove('show');
  const showAppMenu = (id, anchor) => {
    const app = runtimeOf(id); if (!app) return;
    const menu = $('menu');
    const item = (icon, label, action, { disabled = false, check = null } = {}) => {
      const button = document.createElement('button');
      if (check !== null) button.classList.toggle('on', check);
      button.disabled = disabled;
      button.innerHTML = `${OBIcons.svg(icon)}<span></span>${check !== null ? `<span class="check">${OBIcons.svg('check')}</span>` : ''}`;
      button.querySelector('span').textContent = label;
      on(button, 'click', async () => { hideMenu(); await action(); scheduleHide(); });
      return button;
    };
    const title = document.createElement('div'); title.className = 'title'; title.textContent = app.name;
    const status = { active: 'Im Vordergrund', background: 'Läuft im Hintergrund', frozen: 'Pausiert', terminated: 'Beendet', loading: 'Lädt …' }[app.lifecycle] || '';
    const sub = document.createElement('div'); sub.className = 'title'; sub.style.cssText = 'text-transform:none;letter-spacing:0;font-weight:500;padding-top:0';
    sub.textContent = `${status}${app.cpu ? ` · ${Math.round(app.cpu)} % CPU` : ''}${app.heapMB ? ` · ${app.heapMB} MB` : ''}`;
    menu.replaceChildren(title, sub,
      item('reload', 'Neu laden', () => bridge('app-action', { id, op: 'reload' }), { disabled: app.lifecycle === 'terminated' }),
      app.lifecycle === 'frozen'
        ? item('bolt', 'Fortsetzen', () => bridge('app-action', { id, op: 'resume' }))
        : item('sleep', 'Pausieren', () => bridge('app-action', { id, op: 'suspend' }), { disabled: app.id === state.active || app.lifecycle !== 'background' }),
      item('close', 'Beenden', () => bridge('app-action', { id, op: 'terminate' }), { disabled: app.id === state.active || app.lifecycle === 'terminated' }),
      item('pin', 'Immer aktiv halten', () => bridge('app-residency', { id, residency: app.residency === 'always' ? 'auto' : 'always' }), { check: app.residency === 'always' }),
    );
    menu.classList.add('show');
    const box = anchor.getBoundingClientRect(), width = 270;
    menu.style.left = `${Math.max(16, Math.min(innerWidth - width - 16, box.left + box.width / 2 - width / 2))}px`;
    menu.style.top = 'auto'; menu.style.bottom = `${innerHeight - box.top + 18}px`; menu.style.width = `${width}px`;
    cancel(hideTimer);
  };

  // ---------- Widget tiles ----------
  const tiles = () => state?.dock?.tiles || [];
  const widgetCtx = () => ({ state, metrics, glance, mqtt: mqttValues });
  const findItem = id => { for (const tile of tiles()) { const item = tile.items.find(entry => entry.id === id); if (item) return { tile, item }; } return null; };
  const renderTiles = () => {
    if (!state) return;
    const signature = tiles().map(tile => tile.id).join(',') + (editing ? ':edit' : '');
    if (signature !== tilesSignature) {
      tilesSignature = signature;
      tilesEl.replaceChildren(...tiles().map(tile => {
        const wrap = document.createElement('div');
        wrap.className = 'tile-wrap surface'; wrap.dataset.tileWrap = tile.id;
        const inner = document.createElement('div'); wrap.appendChild(inner);
        if (editing) {
          const remove = document.createElement('button'); remove.className = 'badge-x'; remove.innerHTML = OBIcons.svg('close');
          remove.setAttribute('aria-label', 'Kachel entfernen');
          on(remove, 'pointerdown', event => { event.stopPropagation(); void saveTiles(tiles().filter(entry => entry.id !== tile.id)); });
          wrap.appendChild(remove);
        }
        pressable(wrap, {
          tap: (event, target) => {
            const cell = target.closest?.('[data-item]');
            const found = cell && findItem(cell.dataset.item);
            if (editing) { if (found) openInspector(found.item.id); return; }
            if (found) void runWidget(found.item, target);
          },
          hold: (event, target) => {
            const cell = target.closest?.('[data-item]');
            openEditor(cell ? cell.dataset.item : null);
          },
        });
        on(wrap, 'pointerdown', event => { if (editing) startItemDrag(event, wrap); });
        return wrap;
      }));
    }
    for (const wrap of tilesEl.children) {
      const tile = tiles().find(entry => entry.id === wrap.dataset.tileWrap);
      if (tile) OBWidgets.renderTile(wrap.firstChild, tile, widgetCtx());
    }
    $('tile-add').parentElement.style.display = editing && tiles().length < 4 ? '' : 'none';
    paintGlass(true);
  };
  const runWidget = async (item, target) => {
    const detail = OBWidgets.actionFor(item, target);
    if (OBWidgets.byType[item.type]?.kind !== 'button') { openEditor(item.id); return; }
    if (item.type === 'action.voice') { if (state.active === 'gev' && state.voice?.gemini) await toggleVoice(); else await activate('astra'); return; }
    const result = await bridge('widget', { item: { id: item.id, type: item.type, options: OBWidgets.optionsOf(item) }, step: detail.step });
    if (result?.error) toast(result.error, 'warning');
    else if (result?.toast) toast(result.toast, result.icon);
    if (item.type === 'action.sleep' || item.type === 'action.app') close();
    scheduleHide();
  };
  const saveTiles = async next => {
    const result = await bridge('config-patch', { patch: { dock: { tiles: next } } });
    if (result?.error) toast(result.error, 'warning');
  };

  // ---------- Widget editor ----------
  const openEditor = (itemId = null) => {
    editing = true; root.classList.add('editing'); cancel(hideTimer);
    tilesSignature = ''; renderTiles(); renderCategories(); renderLibrary();
    $('editor').classList.add('show');
    if (itemId) openInspector(itemId); else closeInspector();
  };
  function closeEditor() {
    editing = false; inspecting = null; root.classList.remove('editing');
    $('editor').classList.remove('show'); tilesSignature = ''; renderTiles(); scheduleHide();
  }
  on($('editor-done'), 'click', closeEditor);
  on($('tile-add'), 'click', () => { if (tiles().length < 4) void saveTiles([...tiles(), { id: 't' + Math.random().toString(36).slice(2, 7), items: [] }]); });
  const renderCategories = () => {
    $('cats').replaceChildren(...OBWidgets.categories.map(name => {
      const button = document.createElement('button');
      button.textContent = name; button.classList.toggle('on', name === category && !inspecting);
      on(button, 'click', () => { category = name; closeInspector(); renderCategories(); renderLibrary(); });
      return button;
    }));
  };
  const renderLibrary = () => {
    const library = $('library');
    const hint = document.createElement('p'); hint.className = 'hint';
    hint.textContent = 'Ziehe ein Widget auf eine Kachel (bis zu vier je Kachel). Tippe ein Widget in einer Kachel an, um es einzustellen; ziehe es aus dem Dock, um es zu entfernen.';
    const grid = document.createElement('div'); grid.className = 'grid';
    for (const entry of OBWidgets.catalog.filter(item => item.category === category)) {
      const card = document.createElement('div'); card.className = 'lib'; card.dataset.type = entry.type;
      const preview = document.createElement('div'); preview.className = 'preview ob-tile size-half';
      const cell = document.createElement('div');
      const sample = OBWidgets.create(entry.type), view = OBWidgets.view(sample, widgetCtx());
      cell.className = `ob-w ${entry.kind === 'button' ? 'is-button' : 'is-display'} ${view.cls}`; cell.innerHTML = view.html;
      preview.appendChild(cell);
      const name = document.createElement('b'); name.textContent = entry.name;
      const description = document.createElement('small'); description.textContent = entry.description;
      card.append(preview, name, description);
      on(card, 'pointerdown', event => startLibraryDrag(event, entry.type));
      grid.appendChild(card);
    }
    library.replaceChildren(hint, grid);
  };
  const closeInspector = () => { inspecting = null; $('inspector').hidden = true; $('library').hidden = false; };
  const openInspector = itemId => {
    const found = findItem(itemId); if (!found) return;
    inspecting = itemId; renderCategories();
    const { item } = found, entry = OBWidgets.byType[item.type], options = OBWidgets.optionsOf(item);
    const panel = $('inspector'); panel.hidden = false; $('library').hidden = true;
    const update = async patch => {
      const next = tiles().map(tile => ({ ...tile, items: tile.items.map(entry => entry.id === itemId ? { ...entry, options: { ...OBWidgets.optionsOf(entry), ...patch } } : entry) }));
      await saveTiles(next);
    };
    const heading = document.createElement('h3'); heading.innerHTML = OBIcons.svg(entry?.icon || 'info'); heading.append(entry?.name || item.type);
    const description = document.createElement('p'); description.textContent = entry?.description || '';
    panel.replaceChildren(heading, description);
    for (const option of entry?.options || []) {
      const field = document.createElement('div'); field.className = 'field';
      const label = document.createElement('label'); label.textContent = option.label;
      const control = document.createElement('div'); control.className = 'control';
      const chips = list => list.map(([value, text]) => {
        const chip = document.createElement('button'); chip.className = 'chip'; chip.textContent = text;
        chip.classList.toggle('on', String(options[option.key]) === String(value));
        on(chip, 'click', () => void update({ [option.key]: value }));
        return chip;
      });
      if (option.type === 'select') control.append(...chips(option.options));
      else if (option.type === 'app') control.append(...chips([...(option.default === '' ? [['', 'Automatisch']] : []), ...(state.apps || []).map(app => [app.id, app.name])]));
      else if (option.type === 'number') {
        const minus = document.createElement('button'); minus.className = 'chip'; minus.innerHTML = OBIcons.svg('minus');
        const value = document.createElement('b'); value.textContent = options[option.key]; value.style.minWidth = '60px'; value.style.textAlign = 'center';
        const plus = document.createElement('button'); plus.className = 'chip'; plus.innerHTML = OBIcons.svg('plus');
        const step = option.key === 'step' ? 5 : 5;
        on(minus, 'click', () => void update({ [option.key]: Math.max(0, Number(options[option.key]) - step) }));
        on(plus, 'click', () => void update({ [option.key]: Math.min(100, Number(options[option.key]) + step) }));
        control.append(minus, value, plus);
      } else if (option.type === 'icon') {
        const grid = document.createElement('div'); grid.className = 'icons';
        for (const name of OBIcons.names) {
          const button = document.createElement('button'); button.innerHTML = OBIcons.svg(name); button.classList.toggle('on', options[option.key] === name);
          on(button, 'click', () => void update({ [option.key]: name }));
          grid.appendChild(button);
        }
        control.appendChild(grid);
      } else {
        const input = document.createElement('input'); input.value = options[option.key] ?? ''; input.spellcheck = false;
        on(input, 'change', () => void update({ [option.key]: input.value }));
        on(input, 'blur', () => void update({ [option.key]: input.value }));
        control.appendChild(input);
      }
      field.append(label, control); panel.appendChild(field);
    }
    const actions = document.createElement('div'); actions.className = 'actions';
    const back = document.createElement('button'); back.textContent = 'Zur Bibliothek';
    on(back, 'click', () => { closeInspector(); renderCategories(); });
    const remove = document.createElement('button'); remove.className = 'danger'; remove.textContent = 'Entfernen';
    on(remove, 'click', () => { void saveTiles(tiles().map(tile => ({ ...tile, items: tile.items.filter(entry => entry.id !== itemId) }))); closeInspector(); renderCategories(); });
    actions.append(back, remove); panel.appendChild(actions);
  };

  // ---------- Drag & drop (library → tile, tile → tile, tile → outside) ----------
  let drag = null;
  const ghost = $('ghost');
  const tileAt = (x, y) => shadow.elementsFromPoint(x, y).find(element => element.dataset?.tileWrap)?.dataset.tileWrap || null;
  const beginDrag = (event, payload) => {
    drag = { ...payload, id: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
    // Capture keeps the moves inside the shadow root while crossing the page.
    try { event.target.setPointerCapture(event.pointerId); } catch { /* pointer gone */ }
  };
  const startLibraryDrag = (event, type) => beginDrag(event, { kind: 'new', type });
  const startItemDrag = (event, wrap) => {
    const cell = event.target.closest?.('[data-item]');
    if (cell) beginDrag(event, { kind: 'move', itemId: cell.dataset.item, from: wrap.dataset.tileWrap });
  };
  on(shadow, 'pointermove', event => {
    if (!drag || drag.id !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 10) return;
    if (!drag.active) {
      drag.active = true;
      const item = drag.kind === 'new' ? OBWidgets.create(drag.type) : findItem(drag.itemId)?.item;
      const view = OBWidgets.view(item, widgetCtx());
      ghost.innerHTML = `<div class="ob-w ${view.cls}">${view.html}</div>`; ghost.classList.add('show');
    }
    ghost.style.left = `${event.clientX}px`; ghost.style.top = `${event.clientY}px`;
    const over = tileAt(event.clientX, event.clientY);
    for (const wrap of tilesEl.children) wrap.classList.toggle('drop', wrap.dataset.tileWrap === over);
  });
  on(shadow, 'pointerup', event => {
    if (!drag || drag.id !== event.pointerId) return;
    const current = drag; drag = null; ghost.classList.remove('show');
    for (const wrap of tilesEl.children) wrap.classList.remove('drop');
    if (!current.active) return;
    const target = tileAt(event.clientX, event.clientY);
    let next = structuredClone(tiles());
    if (current.kind === 'move') {
      const source = next.find(tile => tile.id === current.from);
      const item = source?.items.find(entry => entry.id === current.itemId);
      if (!item) return;
      if (target === current.from) return;
      source.items = source.items.filter(entry => entry.id !== current.itemId);
      if (target) {
        const destination = next.find(tile => tile.id === target);
        if (destination.items.length >= 4) { toast('Diese Kachel ist voll (max. 4)', 'warning'); return; }
        destination.items.push(item);
      }
    } else {
      if (!target) return;
      const destination = next.find(tile => tile.id === target);
      if (destination.items.length >= 4) { toast('Diese Kachel ist voll (max. 4)', 'warning'); return; }
      destination.items.push(OBWidgets.create(current.type));
    }
    void saveTiles(next);
  });

  // ---------- Prompts and toasts ----------
  const promptEls = new Map();
  const renderPrompts = () => {
    const prompts = state?.performance?.prompts || [];
    for (const [id, element] of promptEls) if (!prompts.some(prompt => prompt.id === id)) { element.remove(); promptEls.delete(id); }
    for (const prompt of prompts) {
      if (promptEls.has(prompt.id)) continue;
      const card = document.createElement('div'); card.className = 'prompt surface strong';
      const text = document.createElement('p'); text.innerHTML = OBIcons.svg('gauge'); text.append(prompt.text);
      const choices = document.createElement('div'); choices.className = 'choices';
      for (const choice of prompt.choices) {
        const button = document.createElement('button'); button.textContent = choice.label;
        on(button, 'click', () => { void bridge('prompt', { id: prompt.id, choice: choice.id }); card.remove(); promptEls.delete(prompt.id); });
        choices.appendChild(button);
      }
      const timer = document.createElement('div'); timer.className = 'timer';
      const bar = document.createElement('i'); bar.style.animationDuration = `${Math.max(0, prompt.expires - Date.now())}ms`;
      timer.appendChild(bar);
      card.append(text, choices, timer);
      $('prompts').appendChild(card); promptEls.set(prompt.id, card);
    }
  };
  const toast = (text, icon = 'info') => {
    const element = document.createElement('div'); element.className = 'toast surface strong';
    element.innerHTML = OBIcons.svg(icon); element.append(text);
    $('toasts').appendChild(element);
    later(() => element.remove(), 4200);
  };

  // ---------- On-screen keyboard ----------
  // Keys are sent to the controller, which types them as trusted input. That
  // works inside shadow DOM, frameworks and cross-origin apps alike.
  const keyboard = $('keyboard');
  const LAYOUTS = {
    lower: [['q', 'w', 'e', 'r', 't', 'z', 'u', 'i', 'o', 'p', 'ü'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ö', 'ä'], ['⇧', 'y', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '⌫'], ['123', '@', ' ', '-', '←', '→', '⏎', '⌄']],
    upper: [['Q', 'W', 'E', 'R', 'T', 'Z', 'U', 'I', 'O', 'P', 'Ü'], ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ö', 'Ä'], ['⇧', 'Y', 'X', 'C', 'V', 'B', 'N', 'M', ';', ':', '⌫'], ['123', '@', ' ', '_', '←', '→', '⏎', '⌄']],
    symbols: [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'ß'], ['/', ':', ';', '(', ')', '€', '&', '"', "'", '?', '!'], ['#', '%', '+', '=', '*', '<', '>', '[', ']', '|', '⌫'], ['ABC', '~', ' ', '\\', '←', '→', '⏎', '⌄']],
  };
  let layer = 'lower', shiftOnce = false, keyboardTarget = null;
  const SPECIAL = { '⌫': 'Backspace', '⏎': 'Enter', '←': 'ArrowLeft', '→': 'ArrowRight' };
  // The four corner grips resize the keyboard (it stays centred, keys scale with it).
  const KB_BASE = 1240, KB_MIN = 0.55, KB_MAX = 1.6;
  const kbMax = () => Math.min(KB_MAX, (innerWidth - 32) / KB_BASE);
  const applyKeyboardScale = value => keyboard.style.setProperty('--kb', String(Math.max(KB_MIN, Math.min(kbMax(), value))));
  let resize = null;
  const corners = ['tl', 'tr', 'bl', 'br'].map(corner => {
    const grip = document.createElement('i'); grip.className = 'kb-corner'; grip.dataset.corner = corner;
    on(grip, 'pointerdown', event => {
      event.preventDefault(); event.stopPropagation();
      resize = { id: event.pointerId, grip };
      grip.setPointerCapture(event.pointerId); grip.classList.add('drag'); keyboard.classList.add('resizing');
    });
    on(grip, 'pointermove', event => {
      if (resize?.id !== event.pointerId) return;
      applyKeyboardScale((2 * Math.abs(event.clientX - innerWidth / 2)) / KB_BASE);
    });
    const end = event => {
      if (resize?.id !== event.pointerId) return;
      resize = null; grip.classList.remove('drag'); keyboard.classList.remove('resizing');
      void bridge('config-patch', { patch: { appearance: { keyboardScale: Math.round(Number(keyboard.style.getPropertyValue('--kb')) * 100) / 100 } } });
    };
    on(grip, 'pointerup', end); on(grip, 'pointercancel', end);
    return grip;
  });
  const renderKeyboard = () => {
    keyboard.replaceChildren(...corners, ...LAYOUTS[layer].map(keys => {
      const line = document.createElement('div'); line.className = 'krow';
      for (const key of keys) {
        const button = document.createElement('button'); button.textContent = key === ' ' ? 'Leerzeichen' : key;
        if (key === ' ') button.className = 'space';
        else if (['⇧', '⌫', '123', 'ABC', '⏎', '⌄'].includes(key)) button.className = 'wide';
        if (key === '⇧' && layer === 'upper') button.classList.add('on');
        button.dataset.key = key;
        line.appendChild(button);
      }
      return line;
    }));
  };
  on(keyboard, 'pointerdown', event => {
    event.preventDefault(); // keep focus in the text field
    const key = event.target.closest?.('button')?.dataset.key;
    if (!key) return;
    if (key === '⇧') { layer = layer === 'upper' ? 'lower' : 'upper'; shiftOnce = layer === 'upper'; renderKeyboard(); return; }
    if (key === '123') { layer = 'symbols'; renderKeyboard(); return; }
    if (key === 'ABC') { layer = 'lower'; renderKeyboard(); return; }
    if (key === '⌄') { hideKeyboard(); keyboardTarget?.blur?.(); return; }
    if (SPECIAL[key]) void bridge('key', { key: SPECIAL[key] });
    else void bridge('key', { text: key });
    if (shiftOnce && layer === 'upper' && key.length === 1) { layer = 'lower'; shiftOnce = false; renderKeyboard(); }
  });
  const EDITABLE_TYPES = new Set(['text', 'search', 'url', 'email', 'password', 'tel', 'number', '']);
  const isEditable = element => element && ((element.tagName === 'INPUT' && EDITABLE_TYPES.has(element.type) && !element.readOnly && !element.disabled) || (element.tagName === 'TEXTAREA' && !element.readOnly) || element.isContentEditable);
  const showKeyboard = target => { keyboardTarget = target; if (!keyboard.firstChild) renderKeyboard(); keyboard.classList.add('show'); };
  function hideKeyboard() { keyboard.classList.remove('show'); keyboardTarget = null; }
  const onFocus = event => { const target = event.composedPath()[0]; if (isEditable(target)) showKeyboard(target); };
  const onBlur = () => later(() => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    const inner = shadow.activeElement;
    if (!isEditable(inner) && !isEditable(active)) hideKeyboard();
  }, 120);
  on(document, 'focusin', onFocus, true); on(document, 'focusout', onBlur, true);
  on(shadow, 'focusin', onFocus, true); on(shadow, 'focusout', onBlur, true);

  // ---------- Sleep ----------
  const sleep = $('sleep');
  on(sleep, 'pointerdown', event => { event.preventDefault(); event.stopPropagation(); void bridge('display', { value: 'wake' }); });
  const setAsleep = asleep => {
    if (asleep === root.classList.contains('asleep')) return;
    root.classList.toggle('asleep', asleep);
    if (asleep) { close(); hideKeyboard(); sleep.classList.add('hinted'); later(() => sleep.classList.remove('hinted'), 2500); }
  };

  // ---------- Liquid glass (WebGL refraction of the live page behind the dock) ----------
  // One renderer for the whole dock row: each tile and the dock are shapes.
  const glass = { renderer: null, error: '', frames: 0, last: 0, lastDom: 0, kind: '', unbind: null, timer: null };
  const lens = $('lens');
  // Frost = background blur + a little tint, so the page behind stays visible but
  // calm. Refraction (ior, bevel, height, refractScale, meniscus) is independent of it.
  const frostOf = () => Math.max(0, Math.min(1, state?.appearance?.frost ?? 0.55));
  const materialFor = frost => ({ ior: 1.5, dispersion: 0.035, bevel: 18, height: 22, refractScale: 2.4, meniscus: 1,
    blurPlateau: 2.5 + frost * 15, blurRim: 1 + frost * 12, specular: 0.36, fresnel: 1, saturation: 1.18 + frost * 0.22,
    tintAmount: 0.025 + frost * 0.13, tintColor: root.dataset.obTheme === 'light' ? [0.93, 0.95, 0.98] : [0.10, 0.15, 0.21],
    tintAdapt: 0, shadow: 0, edgeLine: 0.22 });
  let appliedFrost = null;
  const crop = document.createElement('canvas'), cropContext = crop.getContext('2d');
  const glassMode = () => state?.appearance?.glass || 'webgl';
  function paintGlass(force = false) {
    if (glassMode() !== 'webgl' || typeof MegaGlass === 'undefined' || !isOpen() || document.hidden) return;
    if (!force && performance.now() - glass.last < 140) return;
    glass.last = performance.now();
    try {
      const surfaces = [...tilesEl.children, dock];
      const rowBox = row.getBoundingClientRect();
      const margin = 48, cw = Math.round(rowBox.width + margin * 2), ch = Math.round(rowBox.height + margin * 2);
      if (!rowBox.width) return;
      lens.style.cssText = `left:-${margin}px;top:-${margin}px;width:${cw}px;height:${ch}px`;
      if (!glass.renderer) glass.renderer = new MegaGlass.WebGLGlass(lens, { compositeMode: 'overlay', material: materialFor(frostOf()) });
      appliedFrost = `${frostOf()}|${root.dataset.obTheme}`;
      if (crop.width !== cw || crop.height !== ch) { crop.width = cw; crop.height = ch; }
      const shapes = surfaces.map((element, index) => {
        const box = element.getBoundingClientRect();
        return { id: 's' + index, shape: 'rect', x: box.left - rowBox.left + margin, y: box.top - rowBox.top + margin, width: box.width, height: box.height, radius: parseFloat(getComputedStyle(element).borderTopLeftRadius) || 32 };
      });
      const signature = JSON.stringify(shapes);
      if (lens.width !== cw || lens.height !== ch || glass.signature !== signature) { glass.renderer.resize(cw, ch, 1); glass.renderer.setElements(shapes, false); glass.signature = signature; }
      const region = { x: rowBox.left - margin, y: rowBox.top - margin, width: cw, height: ch };
      const bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
      cropContext.setTransform(1, 0, 0, 1, 0, 0); cropContext.clearRect(0, 0, cw, ch);
      cropContext.fillStyle = bg === 'rgba(0, 0, 0, 0)' ? (root.dataset.obTheme === 'light' ? '#f6f7f9' : '#05080d') : bg; cropContext.fillRect(0, 0, cw, ch);
      const gev = window.__godsEyeView?.viewer?.scene?.canvas;
      const layers = gev ? [gev, ...['scope-mask', 'world-overlay-canvas'].map(id => document.getElementById(id)).filter(Boolean)]
        : [...document.querySelectorAll('canvas')].filter(canvas => canvas.width > 200 && canvas.height > 200);
      glass.kind = layers.length ? 'live-canvas+dom' : 'dom-repaint';
      const stages = window.__openboardDebugGlass ? [] : null;
      const probe = label => { if (stages) stages.push([label, Array.from(cropContext.getImageData(Math.round(cw / 2), 20, 1, 1).data)]); };
      probe('base');
      for (const layer of layers) {
        const box = layer.getBoundingClientRect(), style = getComputedStyle(layer);
        if (!box.width || !box.height || style.display === 'none' || style.visibility === 'hidden') continue;
        cropContext.globalAlpha = Number(style.opacity) || 0;
        const sx = (region.x - box.left) * layer.width / box.width, sy = (region.y - box.top) * layer.height / box.height, sw = cw * layer.width / box.width, sh = ch * layer.height / box.height;
        // Apps may restyle a canvas with CSS (Excalidraw inverts it in dark mode); sample what is shown.
        cropContext.filter = style.filter && style.filter !== 'none' ? style.filter : 'none';
        try { cropContext.drawImage(layer, sx, sy, sw, sh, 0, 0, cw, ch); } catch { /* tainted or lost context */ }
        cropContext.filter = 'none';
        probe(`${layer.className || layer.id} filter=${style.filter}`);
      }
      cropContext.globalAlpha = 1;
      if (MegaGlass.paintPageContent) {
        if (performance.now() - glass.lastDom > 1500) { MegaGlass.invalidatePageContent(); glass.lastDom = performance.now(); }
        cropContext.setTransform(1, 0, 0, 1, -region.x, -region.y);
        MegaGlass.paintPageContent(cropContext, region, null);
        cropContext.setTransform(1, 0, 0, 1, 0, 0);
      }
      probe('after-dom'); if (stages) glass.stages = stages;
      const frostKey = `${frostOf()}|${root.dataset.obTheme}`;
      if (frostKey !== appliedFrost) { glass.renderer.setMaterial(materialFor(frostOf()), false); appliedFrost = frostKey; }
      glass.renderer.setBackdrop(crop, { update: 'live', autoStart: false, shouldRender: false });
      glass.renderer.render({ dpr: 1 }); glass.frames++; glass.error = '';
    } catch (error) { glass.error = error.message; }
  }
  function startGlass() {
    root.classList.toggle('webgl', glassMode() === 'webgl' && typeof MegaGlass !== 'undefined');
    root.classList.toggle('glass-off', glassMode() === 'off');
    if (glassMode() !== 'webgl') return;
    const scene = window.__godsEyeView?.viewer?.scene;
    if (scene && !glass.unbind) glass.unbind = scene.postRender.addEventListener(() => paintGlass());
    // Other apps: 4 FPS while the dock is open, nothing while closed.
    clearInterval(glass.timer); glass.timer = setInterval(() => paintGlass(), 250);
    later(() => paintGlass(true), 30); later(() => paintGlass(true), 420);
  }
  function stopGlass() { clearInterval(glass.timer); glass.timer = null; glass.unbind?.(); glass.unbind = null; }
  window.__megaKioskRefreshGlass = () => paintGlass(true);

  // ---------- Gemini voice (GEV) ----------
  let voiceSession = null, playbackTime = 0;
  const players = new Set();
  const bubble = $('bubble');
  const say = text => { bubble.textContent = text; bubble.classList.toggle('show', !!text); };
  const stopAudio = () => {
    if (!voiceSession) return;
    const session = voiceSession; voiceSession = null;
    session.stream?.getTracks().forEach(track => track.stop());
    session.node?.disconnect(); session.source?.disconnect();
    for (const player of players) { try { player.stop(); } catch { /* ended */ } }
    players.clear(); playbackTime = 0;
    session.context?.close();
    renderDock();
  };
  async function toggleVoice() {
    if (voiceSession) { void bridge('voice-stop'); stopAudio(); say(''); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      const context = new AudioContext({ sampleRate: 48000 }); await context.resume();
      const source = context.createMediaStreamSource(stream);
      const session = { stream, context, source, node: null, ready: false };
      voiceSession = session;
      const sendPcm = input => {
        if (!session.ready) return;
        const ratio = context.sampleRate / 16000, pcm = new Int16Array(Math.floor(input.length / ratio));
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)])) * 32767;
        const bytes = new Uint8Array(pcm.buffer); let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        void bridge('voice-audio', { data: btoa(binary) });
      };
      try {
        // AudioWorklet keeps capture off the main thread.
        const code = `class C extends AudioWorkletProcessor{constructor(){super();this.b=[];this.n=0}process(i){const c=i[0]&&i[0][0];if(c){this.b.push(c.slice());this.n+=c.length;if(this.n>=4096){const o=new Float32Array(this.n);let k=0;for(const p of this.b){o.set(p,k);k+=p.length}this.port.postMessage(o,[o.buffer]);this.b=[];this.n=0}}return true}}registerProcessor('ob-capture',C)`;
        const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        await context.audioWorklet.addModule(url); URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(context, 'ob-capture');
        node.port.onmessage = event => sendPcm(event.data);
        session.node = node; source.connect(node);
      } catch {
        const node = context.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = event => sendPcm(event.inputBuffer.getChannelData(0));
        session.node = node; source.connect(node); node.connect(context.destination);
      }
      renderDock(); say('Verbinde …');
      await bridge('voice-start');
    } catch (error) { stopAudio(); say(error.message); later(() => say(''), 5000); }
  }
  const onVoice = message => {
    const session = voiceSession;
    if (message.event === 'ready' && session) { session.ready = true; say('Hört zu …'); }
    if (message.event === 'status') say(message.text);
    if (message.event === 'stop' || message.event === 'error') { stopAudio(); say(message.text || ''); if (message.text) later(() => say(''), 5000); }
    if (message.event === 'interrupted') { for (const player of players) { try { player.stop(); } catch { /* ended */ } } players.clear(); playbackTime = session?.context.currentTime || 0; }
    if (message.event === 'audio' && session) {
      const binary = atob(message.data), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
      const pcm = new Int16Array(bytes.buffer), buffer = session.context.createBuffer(1, pcm.length, message.rate || 24000);
      const samples = buffer.getChannelData(0); for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
      const player = session.context.createBufferSource(); player.buffer = buffer; player.connect(session.context.destination);
      playbackTime = Math.max(session.context.currentTime + 0.02, playbackTime); player.start(playbackTime); playbackTime += buffer.duration;
      players.add(player); player.onended = () => players.delete(player);
    }
  };
  on(document, 'visibilitychange', () => { if (document.hidden) { if (voiceSession) { void bridge('voice-stop'); stopAudio(); say(''); } close(); } });

  // ---------- Controller API ----------
  const update = next => {
    state = next;
    root.dataset.obTheme = next.theme || 'dark';
    if (!resize) applyKeyboardScale(next.appearance?.keyboardScale ?? 1);
    root.style.setProperty('--ob-glass-blur', `${Math.round(8 + frostOf() * 28)}px`);
    root.classList.toggle('indicator-never', next.dock?.indicator === 'never');
    indicator.classList.toggle('show', next.dock?.indicator === 'always');
    setAsleep(!!next.display?.asleep);
    renderDock(); renderPrompts();
    if (isOpen()) renderTiles();
  };
  const onEvent = message => {
    if (message.type === 'metrics') { metrics = message.metrics; if (message.glance) glance = message.glance; if (message.mqtt) mqttValues = message.mqtt; if (isOpen()) renderTiles(); }
    else if (message.type === 'toast') toast(message.text, message.icon);
    else if (message.type === 'voice') onVoice(message);
    else if (message.type === 'open-dock') open();
    else if (message.type === 'close-dock') close();
  };
  const dispose = () => {
    events.abort(); for (const id of timers) clearTimeout(id); stopGlass(); stopAudio();
    glass.renderer?.destroy?.(); host.remove(); docStyle.remove();
    if (viewportCreated) viewport.remove(); else if (viewportBefore != null) viewport.setAttribute('content', viewportBefore);
    if (window.__openboard?.dispose === dispose) delete window.__openboard;
  };
  window.__openboard = {
    version: SHELL_VERSION, update, event: onEvent, dispose,
    diagnostics: () => ({ version: SHELL_VERSION, open: isOpen(), editing, asleep: root.classList.contains('asleep'), apps: dock.querySelectorAll('[data-app]').length,
      tiles: tilesEl.children.length, keyboard: keyboard.classList.contains('show'), keyboardRect: JSON.parse(JSON.stringify(keyboard.getBoundingClientRect())), keyboardScale: Number(keyboard.style.getPropertyValue('--kb')) || 1, voice: !!voiceSession,
      dock: JSON.parse(JSON.stringify(dock.getBoundingClientRect())), indicator: JSON.parse(JSON.stringify(indicator.getBoundingClientRect())),
      gesture: { ...gesture }, glassFrames: glass.frames, glassError: glass.error, glassEngine: typeof MegaGlass !== 'undefined' ? MegaGlass.IOR_RENDERER : null, backdropKind: glass.kind }),
    open, close, openEditor, closeEditor,
    // Debug aid: the image handed to the glass renderer (what the lens refracts).
    glassCrop: () => crop.toDataURL('image/png'),
    glassStages: () => glass.stages || null,
  };
  window.__megaKiosk = true; // legacy marker for older tooling

  // Bindings may appear a moment after the script on brand-new documents.
  const ready = (attempt = 0) => {
    if (typeof window.openboardBridge === 'function') void bridge('ready');
    else if (attempt < 50) later(() => ready(attempt + 1), 200);
  };
  ready();
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();
