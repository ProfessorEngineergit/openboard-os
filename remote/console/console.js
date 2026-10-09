// OpenBoard remote console (desktop). Served by remote/server.mjs on loopback
// :6080, used through an SSH tunnel (http://localhost:16080/). The controller
// API, /ui and /apps/settings are proxied by the same server, so everything
// here is same-origin. If the controller is down, the console stays usable:
// the overview shows an offline state and the VNC view keeps working.
import { h, icon, fmt, LIFECYCLE, PRESSURE, lifecycleBadge, badge, seg, createClient, createToaster, openSheet, confirmSheet } from '/apps/settings/common.js';

// The console only streams metrics (`/api/local/events?metrics=1`) while the overview is visible.
const client = createClient({ metrics: false });
const app = document.getElementById('console');
const toaster = createToaster(app);
const toast = (text, options) => toaster.show(text, options);
const post = (path, body) => client.api(path, { method: 'POST', body: body ?? {} });

// ------------------------------------------------------------------ theme
// 'auto' follows the display's effective theme (state.theme, like /ui/app.js does for the apps) and
// falls back to the browser's preference; 'light'/'dark' pin the console. console/boot.js applies the
// same rule before the first paint.
const THEME_KEY = 'ob.console.theme', DISPLAY_THEME_KEY = 'ob.console.display-theme';
const media = matchMedia('(prefers-color-scheme: light)');
const store = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};
let themePref = store.get(THEME_KEY) || 'auto';
let displayTheme = store.get(DISPLAY_THEME_KEY);
function applyTheme() {
  const theme = themePref === 'auto' ? (displayTheme || (media.matches ? 'light' : 'dark')) : themePref;
  if (document.documentElement.dataset.obTheme !== theme) document.documentElement.dataset.obTheme = theme;
}
media.addEventListener('change', applyTheme);
applyTheme();

// ------------------------------------------------------------------ layout
const VIEWS = [
  { id: 'uebersicht', title: 'Übersicht', icon: 'gauge' },
  { id: 'bildschirm', title: 'Bildschirm', icon: 'screen' },
  { id: 'dock', title: 'Dock & Widgets', icon: 'grid' },
  { id: 'einstellungen', title: 'Einstellungen', icon: 'settings' },
  { id: 'protokolle', title: 'Protokolle', icon: 'logs' },
];
const nav = h('nav', { class: 'rc-nav', 'aria-label': 'Bereiche' }, VIEWS.map(view => h('a', { href: `#${view.id}`, class: 'rc-nav-item', dataset: { view: view.id } }, icon(view.icon), h('span', null, view.title), h('i', { class: 'rc-nav-badge', hidden: true }))));
const connPill = h('div', { class: 'rc-conn' });
const themeSeg = seg([['auto', 'Auto'], ['light', 'Hell'], ['dark', 'Dunkel']], themePref, value => { themePref = value; store.set(THEME_KEY, value); applyTheme(); }, { label: 'Design der Konsole' });
const side = h('aside', { class: 'rc-side' },
  h('div', { class: 'rc-brand' }, h('span', { class: 'logo' }, icon('screen')), h('div', null, h('b', null, 'OpenBoard'), h('small', null, 'Konsole'))),
  nav,
  h('div', { class: 'rc-side-foot' }, connPill, h('div', { class: 'rc-theme' }, h('small', null, 'Design der Konsole'), themeSeg)));
const main = h('main', { class: 'rc-main' });
app.append(side, main);

function paintConnection() {
  const s = client.state, ok = client.connected && !!s;
  connPill.className = `rc-conn ${ok ? 'ok' : 'err'}`;
  connPill.replaceChildren(h('i', { class: 'dot' }), h('div', null, h('b', null, ok ? 'Display verbunden' : 'Controller offline'), h('small', null, ok ? `Version ${(s.version || '–').slice(0, 7)} · SSH-Tunnel` : 'Bildschirm (VNC) bleibt nutzbar')));
  const prompts = s?.performance?.prompts?.length || 0;
  const badgeEl = nav.querySelector('[data-view="uebersicht"] .rc-nav-badge');
  badgeEl.hidden = !prompts; badgeEl.textContent = String(prompts);
}
client.on('connection', paintConnection);
client.on('state', state => {
  paintConnection();
  if (state?.theme && state.theme !== displayTheme) { displayTheme = state.theme; store.set(DISPLAY_THEME_KEY, displayTheme); applyTheme(); }
});
client.on('toast', data => data?.text && toast(data.text, { kind: data.kind === 'error' ? 'err' : data.kind || 'info' }));
client.on('prompt', prompt => { if (prompt?.text) toast(`Rückfrage: ${prompt.text}`, { kind: 'info', timeout: 6000 }); });

// ------------------------------------------------------------------ router
let currentView = null, currentEl = null, currentApi = null;
const builders = { uebersicht: overviewView, bildschirm: screenView, dock: dockView, einstellungen: settingsView, protokolle: logsView };
function route() {
  const [id, sub, extra] = decodeURIComponent(location.hash.slice(1) || 'uebersicht').split('/');
  const view = VIEWS.find(v => v.id === id) ? id : 'uebersicht';
  if (view === currentView) { if (sub && currentApi?.show) currentApi.show(sub, extra); return; }
  currentApi?.destroy?.();
  currentView = view;
  for (const a of nav.children) a.setAttribute('aria-current', a.dataset.view === view ? 'page' : 'false');
  currentEl = h('section', { class: `rc-view rc-view--${view}` });
  main.replaceChildren(currentEl);
  document.title = `${VIEWS.find(v => v.id === view).title} · OpenBoard`;
  currentApi = builders[view](currentEl, sub, extra) || null;
}
window.addEventListener('hashchange', route);

function viewHead(title, sub, ...actions) {
  return h('header', { class: 'rc-head' }, h('div', { class: 'tt' }, h('h1', null, title), sub ? h('p', null, sub) : null), h('div', { class: 'acts' }, actions));
}

// ------------------------------------------------------------------ overview
function overviewView(el) {
  const switcher = h('div', { class: 'rc-switcher', role: 'group', 'aria-label': 'Aktive App' });
  const sleepBtn = h('button', { type: 'button', class: 'ob-btn' });
  const orientBtn = h('button', { type: 'button', class: 'ob-btn' });
  const offline = h('div', { class: 'rc-offline', hidden: true }, icon('warning'), h('div', null, h('b', null, 'Controller nicht erreichbar'), h('p', null, 'Live-Daten und Einstellungen sind gerade nicht verfügbar. Der Bildschirm per VNC funktioniert weiter; die Konsole verbindet sich automatisch neu.')),
    h('a', { class: 'ob-btn', href: '#bildschirm' }, icon('screen'), 'Bildschirm öffnen'));
  const prompts = h('div', { class: 'rc-prompts' });
  const charts = {
    cpu: chartCard('CPU', 'cpu', { max: 100, unit: '%' }),
    gpu: chartCard('GPU', 'gpu', { max: 100, unit: '%' }),
    ram: chartCard('Arbeitsspeicher', 'ram', { max: 100, unit: '%' }),
    temp: chartCard('Temperatur', 'temp', { min: 30, max: 100, unit: '°C' }),
    net: chartCard('Netzwerk ↓', 'net', { auto: true, unit: 'kB/s' }),
  };
  const pressureCard = h('div', { class: 'rc-card rc-pressure' });
  const appsTable = h('tbody');
  const statusCol = h('div', { class: 'rc-statuscol' });
  const actionsList = h('ol', { class: 'rc-actions' });
  el.append(
    viewHead('Übersicht', 'Live vom Display · alle 2 Sekunden', switcher, orientBtn, sleepBtn),
    offline, prompts,
    h('div', { class: 'rc-grid-charts' }, pressureCard, ...Object.values(charts).map(c => c.el)),
    h('div', { class: 'rc-grid-2' },
      h('div', { class: 'rc-card rc-apps' }, h('div', { class: 'rc-card-head' }, h('h2', null, 'Apps'), h('a', { class: 'rc-link', href: '#einstellungen/apps' }, 'Verwalten')),
        h('table', { class: 'rc-table' }, h('thead', null, h('tr', null, ['App', 'Status', 'Residenz', 'CPU', 'Speicher', 'Genutzt', ''].map((label, i) => h('th', { class: i >= 3 && i <= 4 ? 'num' : i === 6 ? 'act' : '' }, label)))), appsTable)),
      statusCol),
    h('div', { class: 'rc-card' }, h('div', { class: 'rc-card-head' }, h('h2', null, 'Letzte Eingriffe des Leistungsmanagers'), h('a', { class: 'rc-link', href: '#einstellungen/performance' }, 'Leistung einstellen')), actionsList));

  let promptKey = '';
  function paintState() {
    const s = client.state || {}, online = client.connected && !!client.state;
    offline.hidden = online;
    el.classList.toggle('is-offline', !online);
    // switcher
    const apps = (s.apps || []).filter(a => a.enabled !== false);
    switcher.replaceChildren(...apps.map(a => h('button', { type: 'button', class: 'rc-sw', 'aria-pressed': String(a.id === s.active), title: `${a.name} öffnen`, disabled: !online, onclick: () => activate(a) }, icon(a.icon || 'web'), h('span', null, a.name))));
    const asleep = !!s.display?.asleep;
    sleepBtn.replaceChildren(icon(asleep ? 'sun' : 'sleep'), asleep ? 'Aufwecken' : 'Schlafen');
    sleepBtn.className = `ob-btn ${asleep ? 'primary' : ''}`;
    sleepBtn.disabled = !online;
    sleepBtn.onclick = () => post(`/api/local/display/${asleep ? 'wake' : 'sleep'}`).then(() => toast(asleep ? 'Display wird geweckt' : 'Display schläft', { kind: 'ok' })).catch(error => toast(error.message, { kind: 'err' }));
    // orientation
    const orientation = s.display?.orientation || cfg?.display?.orientation || 'landscape', portrait = orientation.startsWith('portrait');
    orientBtn.replaceChildren(icon('rotate'), portrait ? 'Hochformat' : 'Querformat');
    orientBtn.title = portrait ? 'Auf Querformat drehen' : 'Auf Hochformat drehen';
    orientBtn.disabled = !online;
    orientBtn.onclick = async () => {
      const next = portrait ? orientation.replace('portrait', 'landscape') : orientation.replace('landscape', 'portrait');
      orientBtn.disabled = true;
      try { await client.api('/api/local/config', { method: 'PATCH', body: { display: { orientation: next } } }); cfg = { ...(cfg || {}), display: { ...(cfg?.display || {}), orientation: next } }; toast(portrait ? 'Display dreht auf Querformat' : 'Display dreht auf Hochformat', { kind: 'ok' }); }
      catch (error) { toast(error.message, { kind: 'err' }); }
      paintState();
    };
    // prompts
    const list = s.performance?.prompts || [];
    const key = list.map(p => p.id).join(',');
    if (key !== promptKey) { promptKey = key; prompts.replaceChildren(...list.map(promptCard)); }
    paintPressure(); paintApps(); paintStatus(); paintActions();
  }
  function paintPressure() {
    const s = client.state || {}, m = client.metrics || {}, perf = s.performance || {};
    const p = PRESSURE[s.pressure || m.pressure] || PRESSURE.normal;
    const t = perf.thresholds;
    const modeSeg = seg([['eco', 'Eco'], ['balanced', 'Ausgewogen'], ['max', 'Maximal']], perf.mode || 'balanced', mode => client.api('/api/local/config', { method: 'PATCH', body: { performance: { mode } } }).then(() => toast('Leistungsmodus gespeichert', { kind: 'ok', timeout: 1500 })).catch(error => toast(error.message, { kind: 'err' })), { label: 'Leistungsmodus' });
    pressureCard.replaceChildren(
      h('div', { class: 'rc-card-head' }, h('h2', null, 'Lastlage'), perf.thermalThrottled ? badge('Thermisch gedrosselt', 'warn') : null),
      h('div', { class: `rc-pressure-state ${client.connected ? p.kind : 'off'}` }, h('i', { class: 'pulse' }), h('div', null, h('b', null, client.connected ? p.label : '–'), h('small', null, client.connected ? p.text : 'Keine Daten'))),
      modeSeg,
      h('dl', { class: 'rc-facts' },
        h('dt', null, 'Eingriff ab'), h('dd', null, t ? `${t.elevated} % / ${t.critical} % CPU` : '–'),
        h('dt', null, 'Apps beenden'), h('dd', null, t?.terminate ? ({ ask: 'mit Rückfrage', auto: 'automatisch', never: 'nie' })[t.terminate] : '–'),
        h('dt', null, 'Vorhersage'), h('dd', null, perf.prediction?.id ? `${appName(perf.prediction.id)} (${Math.round((perf.prediction.share || 0) * 100)} %)` : '–'),
        h('dt', null, 'Systemplatte'), h('dd', null, m.disk ? `${fmt.pct(m.disk.pct)} belegt · ${String(m.disk.freeGB?.toFixed?.(0) ?? '–')} GB frei` : '–')));
  }
  function paintApps() {
    const s = client.state || {}, m = client.metrics || {};
    const live = Object.fromEntries((m.apps || []).map(a => [a.id, a]));
    const order = s.dock?.order || [];
    const apps = [...(s.apps || [])].sort((a, b) => (order.indexOf(a.id) + 1 || 99) - (order.indexOf(b.id) + 1 || 99));
    const maxCpu = Math.max(10, ...apps.map(a => live[a.id]?.cpu ?? a.cpu ?? 0));
    appsTable.replaceChildren(...(apps.length ? apps.map(a => {
      const lm = live[a.id] || {}, lifecycle = lm.lifecycle || a.lifecycle, cpu = lm.cpu ?? a.cpu, heap = lm.heapMB ?? a.heapMB;
      const running = lifecycle && lifecycle !== 'terminated', isActive = a.id === s.active;
      const act = (glyph, label, action, opts = {}) => h('button', { type: 'button', class: `rc-iconbtn ${opts.danger ? 'danger' : ''}`, title: label, 'aria-label': `${a.name}: ${label}`, onclick: async event => {
        if (opts.confirm && !await confirmSheet(app, { title: `${a.name} beenden?`, text: 'Die App wird geschlossen und beim nächsten Öffnen neu geladen.', confirm: 'Beenden', danger: true })) return;
        const button = event.currentTarget; button.disabled = true;
        try { await post(`/api/local/apps/${encodeURIComponent(a.id)}/${action}`); toast(`${a.name}: ${label}`, { kind: 'ok', timeout: 1500 }); } catch (error) { toast(error.message, { kind: 'err' }); } finally { button.disabled = false; }
      } }, icon(glyph));
      return h('tr', { class: a.enabled === false ? 'is-off' : '' },
        h('td', null, h('span', { class: 'rc-app' }, h('span', { class: 'ic' }, icon(a.icon || 'web')), h('span', null, h('b', null, a.name), isActive ? h('small', null, 'Geöffnet') : null))),
        h('td', null, a.enabled === false ? badge('Ausgeblendet') : lifecycleBadge(lifecycle)),
        h('td', { class: 'dim' }, ({ always: 'Immer aktiv', auto: 'Automatisch', eco: 'Sparsam' })[a.residency] || '–'),
        h('td', { class: 'num' }, running ? h('span', { class: 'rc-bar' }, h('span', { class: 'trk' }, h('i', { style: { width: `${Math.max(3, Math.min(100, (cpu || 0) / maxCpu * 100))}%` } })), h('span', null, fmt.pct(cpu))) : h('span', { class: 'dim' }, '–')),
        h('td', { class: 'num' }, running ? fmt.mb(heap) : h('span', { class: 'dim' }, '–')),
        h('td', { class: 'dim' }, a.lastActive ? fmt.ago(a.lastActive) : '–'),
        h('td', { class: 'act' }, h('span', { class: 'rc-acts' },
          !isActive && a.enabled !== false ? act('screen', 'Öffnen', 'activate') : null,
          running ? act('reload', 'Neu laden', 'reload') : null,
          lifecycle === 'frozen' ? act('bolt', 'Fortsetzen', 'resume') : running && !isActive ? act('sleep', 'Pausieren', 'suspend') : null,
          running && !isActive ? act('power', 'Beenden', 'terminate', { danger: true, confirm: true }) : null)));
    }) : [h('tr', null, h('td', { colspan: 7, class: 'dim empty' }, client.connected ? 'Keine Apps' : 'Keine Verbindung zum Controller'))]));
  }
  function paintStatus() {
    const s = client.state || {}, online = client.connected && !!client.state;
    const conn = (glyph, name, info, okText) => {
      const kind = !online ? 'off' : info?.connected ? 'ok' : info?.configured ? 'err' : 'off';
      return h('div', { class: 'rc-status-row' }, h('span', { class: `ic ${kind}` }, icon(glyph)), h('span', { class: 'tx' }, h('b', null, name), h('small', null, !online ? '–' : info?.connected ? okText : info?.configured ? 'Keine Verbindung' : 'Nicht eingerichtet')), h('i', { class: `rc-dot ${kind}` }));
    };
    const u = s.update || {};
    const d = s.display || {};
    statusCol.replaceChildren(
      h('div', { class: 'rc-card' }, h('div', { class: 'rc-card-head' }, h('h2', null, 'Verbindungen')),
        conn('astra', 'ASTRA', s.astra, 'Verbunden'),
        conn('mqtt', 'MQTT · Home Assistant', s.mqtt, 'Broker verbunden'),
        conn('mic', 'Sprachsteuerung GEV', { configured: !!s.voice?.gemini, connected: !!s.voice?.gemini }, s.voice?.listening ? 'Hört zu' : 'Bereit'),
        conn('globe', 'Browser', { configured: true, connected: s.connected !== false }, 'Verbunden über CDP')),
      h('div', { class: 'rc-card' }, h('div', { class: 'rc-card-head' }, h('h2', null, 'Update'), online ? h('button', { type: 'button', class: 'ob-btn sm', onclick: async event => {
        const b = event.currentTarget; b.disabled = true; b.classList.add('busy');
        try { await post('/api/local/system/update-check'); toast('Update-Prüfung abgeschlossen', { kind: 'ok' }); } catch (error) { toast(error.message, { kind: 'err' }); } finally { b.disabled = false; b.classList.remove('busy'); }
      } }, icon('reload'), 'Prüfen') : null),
        h('div', { class: 'rc-status-row' }, h('span', { class: `ic ${u.available ? 'warn' : u.lastResult && u.lastResult !== 'ok' ? 'err' : 'ok'}` }, icon('update')), h('span', { class: 'tx' }, h('b', null, !online ? '–' : u.available ? 'Update verfügbar' : u.lastResult === 'rolled-back' ? 'Zurückgerollt' : 'Aktuell'), h('small', null, online ? `${(u.current || s.version || '–').slice(0, 7)} · geprüft ${fmt.ago(u.lastCheck)}` : '–'))),
        u.pendingBrowserRestart ? h('p', { class: 'rc-note' }, 'Browser-Neustart steht aus (im Leerlauf).') : null),
      h('div', { class: 'rc-card' }, h('div', { class: 'rc-card-head' }, h('h2', null, 'Display')),
        h('div', { class: 'rc-status-row' }, h('span', { class: `ic ${d.asleep ? 'off' : 'ok'}` }, icon(d.asleep ? 'sleep' : 'sun')), h('span', { class: 'tx' }, h('b', null, !online ? '–' : d.asleep ? 'Schläft' : 'Wach'), h('small', null, d.since ? `seit ${fmt.time(d.since)} (${fmt.duration(Date.now() - d.since)})` : '–'))),
        s.system ? h('div', { class: 'rc-status-row' }, h('span', { class: 'ic' }, icon('volume')), h('span', { class: 'tx' }, h('b', null, s.system.volume == null ? '–' : `${s.system.volume} %${s.system.muted ? ' · stumm' : ''}`), h('small', null, 'Lautstärke')),
          h('span', { class: 'ic' }, icon('brightness')), h('span', { class: 'tx' }, h('b', null, s.system.brightness == null ? '–' : `${s.system.brightness} %`), h('small', null, 'Helligkeit'))) : null));
  }
  function paintActions() {
    const list = client.state?.performance?.actions || [];
    actionsList.replaceChildren(...(list.length ? list.slice(0, 8).map(entry => h('li', null, h('time', null, fmt.time(entry.at)), h('span', { class: 'ic' }, icon(appIcon(entry.app) || 'gauge')), h('span', { class: 'tx' }, entry.text), h('small', null, fmt.ago(entry.at))))
      : [h('li', { class: 'empty' }, client.connected ? 'Noch keine Eingriffe – es waren genug Reserven da.' : 'Keine Verbindung zum Controller')]));
  }
  function paintMetrics() {
    const m = client.metrics || {};
    if (!history.cpu.length && m.history) Object.assign(history, structuredClone(m.history));
    const s = client.state || {};
    charts.cpu.update(history.cpu, m.cpu?.pct, { sub: avgMax(history.cpu, '%'), line: s.performance?.thresholds?.elevated, lineLabel: 'Eingriff' });
    charts.gpu.update(history.gpu, m.gpu?.pct, { sub: m.gpu?.freqMHz ? `${m.gpu.freqMHz} von ${m.gpu.maxMHz} MHz${m.gpu.source === 'freq' ? ' · Takt' : ''}` : avgMax(history.gpu, '%') });
    charts.ram.update(history.ram, m.ram?.pct, { sub: m.ram ? `${fmt.mb(m.ram.usedMB)} von ${fmt.mb(m.ram.totalMB)}` : '' });
    charts.temp.update(history.temp, m.temp?.c, { sub: avgMax(history.temp, '°C'), line: limits.thermal, lineLabel: 'Grenze' });
    charts.net.update(history.net, m.net?.rxKBs, { sub: m.net ? `↑ ${fmt.kbs(m.net.txKBs)}` : '', format: fmt.kbs });
    paintPressure();
    paintApps();
  }
  const history = { cpu: [], gpu: [], ram: [], temp: [], net: [] };
  const limits = { thermal: null };
  let cfg = null, cfgTimer = null;
  let lastT = 0;
  function onMetrics(m) {
    if (m.history) Object.assign(history, structuredClone(m.history));
    else if (m.t !== lastT) {
      const add = (key, value) => { history[key].push(value ?? null); if (history[key].length > 300) history[key].shift(); };
      add('cpu', m.cpu?.pct); add('gpu', m.gpu?.pct); add('ram', m.ram?.pct); add('temp', m.temp?.c); add('net', m.net?.rxKBs);
    }
    lastT = m.t;
    client.metrics = m;
    paintMetrics();
  }
  async function loadHistory() {
    try { const m = await client.api('/api/local/metrics?history=1'); onMetrics(m); } catch { paintMetrics(); }
    try { cfg = await client.api('/api/local/config'); limits.thermal = cfg?.performance?.thermalLimitC ?? null; paintState(); } catch { /* offline */ }
  }
  async function activate(a) {
    try { await post(`/api/local/apps/${encodeURIComponent(a.id)}/activate`); toast(`${a.name} geöffnet`, { kind: 'ok', timeout: 1500 }); } catch (error) { toast(error.message, { kind: 'err' }); }
  }
  // Metrics stream only while this view is on screen and the tab is visible.
  const streamSync = () => client.setMetrics(!document.hidden);
  document.addEventListener('visibilitychange', streamSync);
  streamSync();
  const offs = [
    client.on('state', () => { paintState(); clearTimeout(cfgTimer); cfgTimer = setTimeout(() => client.api('/api/local/config').then(next => { cfg = next; limits.thermal = next?.performance?.thermalLimitC ?? limits.thermal; paintState(); }).catch(() => {}), 800); }),
    client.on('connection', ({ connected }) => { paintState(); if (connected) loadHistory(); }),
    client.on('metrics', onMetrics),
  ];
  // Fallback when the stream carries no metrics: poll.
  const poll = setInterval(() => { if (!document.hidden && client.connected && Date.now() - (client.metrics?.t || 0) > 5000) client.api('/api/local/metrics').then(onMetrics).catch(() => {}); }, 2000);
  const tick = setInterval(() => { paintStatus(); paintActions(); }, 30000);
  const resize = new ResizeObserver(() => Object.values(charts).forEach(c => c.redraw()));
  resize.observe(el);
  paintState(); loadHistory();
  return { destroy() { offs.forEach(off => off()); clearInterval(poll); clearInterval(tick); clearTimeout(cfgTimer); resize.disconnect(); document.removeEventListener('visibilitychange', streamSync); client.setMetrics(false); } };
}
const appName = id => (client.state?.apps || []).find(a => a.id === id)?.name || id;
const appIcon = id => (client.state?.apps || []).find(a => a.id === id)?.icon;
function avgMax(list, unit) {
  const values = (list || []).filter(Number.isFinite);
  if (!values.length) return '';
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return `Ø ${Math.round(avg)} ${unit} · max ${Math.round(Math.max(...values))} ${unit}`;
}
function promptCard(prompt) {
  const left = h('small', { class: 'left' });
  const card = h('div', { class: 'rc-prompt' }, icon('warning'),
    h('div', { class: 'tx' }, h('b', null, 'Rückfrage des Leistungsmanagers'), h('p', null, prompt.text), left),
    h('div', { class: 'acts' }, (prompt.choices || []).map(choice => h('button', {
      type: 'button', class: `ob-btn sm ${choice.id === 'terminate' ? 'danger' : choice.id === 'keep' ? 'primary' : ''}`,
      onclick: async () => {
        for (const b of card.querySelectorAll('button')) b.disabled = true;
        try { await post(`/api/local/prompt/${encodeURIComponent(prompt.id)}`, { choice: choice.id }); card.classList.add('answered'); toast('Antwort gesendet', { kind: 'ok', timeout: 1500 }); }
        catch (error) { toast(error.message, { kind: 'err' }); for (const b of card.querySelectorAll('button')) b.disabled = false; }
      },
    }, choice.label))));
  if (prompt.expiresAt) {
    const timer = setInterval(() => {
      if (!card.isConnected) return clearInterval(timer);
      const s = Math.max(0, Math.round((prompt.expiresAt - Date.now()) / 1000));
      left.textContent = s ? `Ohne Antwort gilt die Standardantwort in ${s} s` : 'Wird automatisch beantwortet …';
    }, 1000);
  }
  return card;
}

// Single-series area chart (SVG) with crosshair tooltip. Samples are 2 s apart.
function chartCard(label, glyph, { min = 0, max = 100, auto = false, unit = '' } = {}) {
  const valueEl = h('b', { class: 'val' }, '–'), subEl = h('small', { class: 'sub' });
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'rc-chart'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${label}, letzte 10 Minuten`);
  const tip = h('div', { class: 'rc-tip', hidden: true });
  const plot = h('div', { class: 'rc-plot' }, svg, tip);
  const el = h('div', { class: 'rc-card rc-chartcard' },
    h('div', { class: 'rc-chart-head' }, h('span', { class: 'ic' }, icon(glyph)), h('span', { class: 'lb' }, label), valueEl),
    subEl, plot,
    h('div', { class: 'rc-axis' }, h('span', null, '−10 min'), h('span', null, '−5 min'), h('span', null, 'jetzt')));
  let data = [], opts = {}, hoverIndex = null, format = v => `${Math.round(v)} ${unit}`;
  const W = () => Math.max(120, plot.clientWidth || 300), H = 110;
  function scaleMax() {
    if (!auto) return max;
    const peak = Math.max(1, ...data.filter(Number.isFinite));
    const step = peak > 2000 ? 1000 : peak > 500 ? 250 : peak > 100 ? 100 : peak > 20 ? 20 : 5;
    return Math.ceil(peak * 1.1 / step) * step;
  }
  function draw() {
    const w = W(), top = scaleMax(), n = 300;
    const x = i => (i + (n - data.length)) / (n - 1) * w;
    const y = v => H - 4 - (Math.max(min, Math.min(top, v)) - min) / (top - min) * (H - 10);
    svg.setAttribute('viewBox', `0 0 ${w} ${H}`);
    svg.setAttribute('width', w); svg.setAttribute('height', H);
    let line = '', area = '', started = false, firstX = 0, lastX = 0;
    data.forEach((v, i) => {
      if (!Number.isFinite(v)) { started = false; return; }
      const px = x(i).toFixed(1), py = y(v).toFixed(1);
      if (!started) { line += `M${px},${py}`; if (!area) firstX = px; started = true; } else line += `L${px},${py}`;
      lastX = px;
    });
    const valid = data.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v));
    if (valid.length > 1) area = `M${x(valid[0][1]).toFixed(1)},${H}` + valid.map(([v, i]) => `L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('') + `L${x(valid[valid.length - 1][1]).toFixed(1)},${H}Z`;
    const grid = [0.25, 0.5, 0.75].map(f => `<line class="grid" x1="0" x2="${w}" y1="${(H - 4 - f * (H - 10)).toFixed(1)}" y2="${(H - 4 - f * (H - 10)).toFixed(1)}"/>`).join('');
    const ref = Number.isFinite(opts.line) && opts.line > min && opts.line < top ? `<line class="ref" x1="0" x2="${w}" y1="${y(opts.line).toFixed(1)}" y2="${y(opts.line).toFixed(1)}"/><text class="reflabel" x="${w - 4}" y="${(y(opts.line) - 4).toFixed(1)}" text-anchor="end">${opts.lineLabel || ''} ${Math.round(opts.line)}</text>` : '';
    const topLabel = `<text class="ylabel" x="4" y="12">${auto ? format(top) : `${top} ${unit}`}</text>`;
    let hover = '';
    if (hoverIndex != null && Number.isFinite(data[hoverIndex])) {
      const hx = x(hoverIndex), hy = y(data[hoverIndex]);
      hover = `<line class="cross" x1="${hx.toFixed(1)}" x2="${hx.toFixed(1)}" y1="0" y2="${H}"/><circle class="hdot" cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="4.5"/>`;
    }
    const end = valid.length ? `<circle class="end" cx="${x(valid[valid.length - 1][1]).toFixed(1)}" cy="${y(valid[valid.length - 1][0]).toFixed(1)}" r="3.5"/>` : '';
    svg.innerHTML = `<defs><linearGradient id="g-${glyph}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="s0"/><stop offset="1" class="s1"/></linearGradient></defs>${grid}${topLabel}${ref}<path class="area" fill="url(#g-${glyph})" d="${area}"/><path class="line" d="${line}"/>${end}${hover}`;
    void firstX; void lastX;
  }
  plot.addEventListener('pointermove', event => {
    if (!data.length) return;
    const rect = plot.getBoundingClientRect(), w = rect.width, n = 300;
    const slot = Math.round((event.clientX - rect.left) / w * (n - 1)) - (n - data.length);
    if (slot < 0 || slot >= data.length || !Number.isFinite(data[slot])) { hoverIndex = null; tip.hidden = true; draw(); return; }
    hoverIndex = slot;
    const secondsAgo = (data.length - 1 - slot) * 2;
    tip.hidden = false;
    tip.replaceChildren(h('b', null, format(data[slot])), h('span', null, secondsAgo ? `vor ${secondsAgo >= 60 ? `${Math.floor(secondsAgo / 60)}:${String(secondsAgo % 60).padStart(2, '0')} min` : `${secondsAgo} s`}` : 'jetzt'));
    const left = Math.min(Math.max(event.clientX - rect.left, 50), w - 50);
    tip.style.left = `${left}px`;
    draw();
  });
  plot.addEventListener('pointerleave', () => { hoverIndex = null; tip.hidden = true; draw(); });
  return {
    el,
    update(list, current, options = {}) {
      data = (list || []).slice(-300); opts = options;
      if (options.format) format = options.format;
      valueEl.textContent = Number.isFinite(current) ? format(current) : '–';
      const level = !Number.isFinite(current) ? '' : unit === '%' ? (current >= 90 ? 'crit' : current >= 75 ? 'warn' : '') : unit === '°C' && Number.isFinite(options.line) ? (current >= options.line ? 'crit' : current >= options.line - 8 ? 'warn' : '') : '';
      el.dataset.level = level;
      subEl.textContent = options.sub || '';
      draw();
    },
    redraw: draw,
  };
}

// ------------------------------------------------------------------ screen (VNC)
function screenView(el) {
  const status = h('span', { class: 'rc-screen-status busy' }, 'Lade …');
  const stage = h('div', { class: 'rc-screen-stage' });
  const appBar = h('div', { class: 'rc-screen-apps', role: 'group', 'aria-label': 'App öffnen' });
  let screen = null, destroyed = false;
  const remoteAction = async (path, label) => {
    try { const response = await fetch(path, { method: 'POST' }); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || response.statusText); toast(label, { kind: 'ok', timeout: 1800 }); screen?.focus(); }
    catch (error) { toast(error.message, { kind: 'err' }); }
  };
  const paste = () => {
    const area = h('textarea', { class: 'ob-input rc-paste', rows: 6, placeholder: 'Text, der in die Zwischenablage des Display-Rechners kopiert wird', spellcheck: 'false' });
    openSheet(app, { title: 'Text einfügen', text: 'Der Text landet in der Zwischenablage des Displays. Füge ihn dort mit Strg+V ein.', content: area, actions: [{ label: 'Abbrechen', kind: 'ghost' }, { label: 'In Zwischenablage', kind: 'primary', run: () => { if (area.value) { screen?.paste(area.value); toast('Text übertragen', { kind: 'ok' }); } } }] });
  };
  const fullscreen = () => document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen();
  const tool = (glyph, label, run, title) => h('button', { type: 'button', class: 'rc-tool', title: title || label, onclick: run }, icon(glyph), h('span', null, label));
  el.append(
    h('header', { class: 'rc-head rc-screen-head' }, h('div', { class: 'tt' }, h('h1', null, 'Bildschirm'), status), appBar,
      h('div', { class: 'rc-toolbar' },
        tool('keyboard', 'Text einfügen', paste, 'Text in die Zwischenablage des Displays kopieren'),
        tool('screen', 'Vollbild', fullscreen),
        h('i', { class: 'rc-tsep' }),
        tool('grid', 'Desktop', () => remoteAction('/api/desktop', 'Kiosk beendet, Desktop sichtbar'), 'Kiosk beenden und Desktop zeigen'),
        tool('terminal', 'Terminal', () => remoteAction('/api/terminal', 'Terminal geöffnet'), 'Kiosk beenden und Terminal öffnen'),
        tool('globe', 'Chromium einrichten', () => remoteAction('/api/chrome-setup', 'Chromium-Einrichtung gestartet'), 'Interaktive Chromium-Einrichtung im Terminal'),
        tool('power', 'Kiosk starten', () => remoteAction('/api/kiosk', 'Kiosk wird gestartet')))),
    stage,
    h('footer', { class: 'rc-screen-foot' }, 'Du bedienst den echten Bildschirm. Für Installationen: Desktop oder Terminal öffnen, danach „Kiosk starten“.'));
  function paintApps() {
    const apps = (client.state?.apps || []).filter(a => a.enabled !== false);
    appBar.replaceChildren(...apps.map(a => h('button', { type: 'button', class: 'rc-sw', 'aria-pressed': String(a.id === client.state?.active), title: `${a.name} öffnen`, onclick: () => post(`/api/local/apps/${encodeURIComponent(a.id)}/activate`).then(() => screen?.focus()).catch(error => toast(error.message, { kind: 'err' })) }, icon(a.icon || 'web'), h('span', null, a.name))));
    appBar.hidden = !apps.length;
  }
  const offs = [client.on('state', paintApps), client.on('connection', paintApps)];
  paintApps();
  import('./screen.js').then(({ createScreen }) => createScreen(stage, { onStatus: (text, kind) => { status.textContent = text; status.className = `rc-screen-status ${kind}`; } }))
    .then(result => { if (destroyed) result.destroy(); else screen = result; });
  return { destroy() { destroyed = true; offs.forEach(off => off()); screen?.destroy(); if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } };
}

// ------------------------------------------------------------------ settings-backed views
let settingsModule = null;
async function loadSettings() {
  settingsModule ||= import('/apps/settings/settings.js');
  return settingsModule;
}
function mountFromSettings(el, options) {
  let view = null, destroyed = false;
  const holder = h('div', { class: 'rc-settings-host' }, h('div', { class: 'rc-loading' }, 'Lade …'));
  el.append(holder);
  loadSettings().then(({ mountSettings }) => {
    if (destroyed) return;
    holder.replaceChildren();
    view = mountSettings(holder, { layout: 'desktop', api: client, ...options });
  }).catch(error => { holder.replaceChildren(h('div', { class: 'rc-loading err' }, `Einstellungen konnten nicht geladen werden: ${error.message}`)); settingsModule = null; });
  return {
    show(id, appId) { if (id === 'apps' && appId) view?.openApp(appId); else view?.show(id); },
    destroy() { destroyed = true; view?.destroy(); },
  };
}
function settingsView(el, sub, appId) {
  return mountFromSettings(el, { section: sub || 'general', app: appId, onNavigate: id => history.replaceState(null, '', `#einstellungen/${id}`) });
}
function dockView(el) { return mountFromSettings(el, { section: 'dock', single: true, onOpenApp: id => { location.hash = `#einstellungen/apps/${encodeURIComponent(id)}`; } }); }
function logsView(el) { return mountFromSettings(el, { section: 'logs', single: true }); }

// ------------------------------------------------------------------ boot
paintConnection();
client.connect().then(() => paintConnection());
route();
document.documentElement.classList.add('is-ready');
