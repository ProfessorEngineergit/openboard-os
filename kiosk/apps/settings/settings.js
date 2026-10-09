// OpenBoard settings. One module for the touch app on the display
// (/apps/settings/, layout 'touch') and the remote console (layout 'desktop').
//
//   import { mountSettings } from '/apps/settings/settings.js';
//   const view = mountSettings(root, { layout: 'desktop', api, section: 'apps', single: false });
//
// `api` has the interface of the `openboard` helper from /ui/app.js:
//   { api(path, {method, body}) → Promise<json>, on(type, cb) → off, state }.
// Every change is saved immediately with PATCH /api/local/config (text fields
// after a short pause, secrets only on an explicit "Speichern").
import { h, icon, debounce, clone, getPath, patchFor, isSecretSet, equal, fmt, LIFECYCLE, PRESSURE, lifecycleBadge, badge,
  switchEl, seg, select, stepper, slider, iconGrid, createToaster, openSheet, confirmSheet, injectStylesheet } from './common.js';
import { createDockEditor } from './dock-editor.js';

// ------------------------------------------------------------------ store
function createStore(client) {
  const listeners = new Map();
  const store = {
    config: null, state: client.state || null, metrics: null, glance: null, mqtt: {}, connected: true,
    api: (path, options) => client.api(path, options),
    on(type, cb) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(cb); return () => listeners.get(type)?.delete(cb); },
    emit(type, data) { for (const cb of listeners.get(type) || []) { try { cb(data); } catch (error) { console.error(error); } } },
    async loadConfig() {
      const next = await client.api('/api/local/config');
      if (!equal(next, store.config)) { store.config = next; store.emit('config', next); }
      return next;
    },
    patch(body) {
      const run = chain.then(async () => {
        store.emit('saving', true);
        try {
          const next = await client.api('/api/local/config', { method: 'PATCH', body });
          if (next && typeof next === 'object' && next.apps) store.config = next; else await store.loadConfig();
          lastOwnPatch = Date.now();
          store.emit('config', store.config);
          store.emit('saved', body);
          return store.config;
        } catch (error) {
          store.emit('error', error);
          store.loadConfig().catch(() => {});
          throw error;
        } finally { store.emit('saving', false); }
      });
      chain = run.catch(() => {});
      return run;
    },
  };
  let chain = Promise.resolve(), lastOwnPatch = 0, refetch = null, lastMetricsEvent = 0;
  const offs = [];
  // Another client (shell, console, MQTT) may change the config. The state
  // stream tells us something changed; re-read the config shortly after.
  offs.push(client.on('state', state => {
    store.state = state; store.connected = true;
    store.emit('state', state);
    clearTimeout(refetch);
    refetch = setTimeout(() => { if (Date.now() - lastOwnPatch > 600) store.loadConfig().catch(() => {}); }, 700);
  }));
  offs.push(client.on('metrics', metrics => { lastMetricsEvent = Date.now(); mergeMetrics(metrics); }));
  offs.push(client.on('connection', ({ connected }) => {
    store.connected = connected; store.emit('connection', connected);
    if (connected) { store.loadConfig().catch(() => {}); loadMetrics(true); }
  }));
  for (const type of ['prompt', 'update', 'toast']) offs.push(client.on(type, data => store.emit(type, data)));
  function mergeMetrics(next) {
    const prev = store.metrics;
    const history = next.history || prev?.history || { cpu: [], gpu: [], ram: [], temp: [], net: [] };
    if (!next.history && prev && next.t !== prev.t) {
      const add = (key, value) => { (history[key] ||= []).push(value ?? null); if (history[key].length > 300) history[key].shift(); };
      add('cpu', next.cpu?.pct); add('gpu', next.gpu?.pct); add('ram', next.ram?.pct); add('temp', next.temp?.c); add('net', next.net?.rxKBs);
    }
    store.metrics = { ...next, history };
    store.emit('metrics', store.metrics);
  }
  async function loadMetrics(withHistory) {
    try { mergeMetrics(await client.api('/api/local/metrics' + (withHistory ? '?history=1' : ''))); } catch { /* controller offline */ }
  }
  async function loadGlance() {
    try { store.glance = await client.api('/api/local/astra/glance'); store.emit('glance', store.glance); } catch { /* ASTRA optional */ }
  }
  // Metrics only flow while someone watches: poll if the stream stays quiet.
  const poll = setInterval(() => { if (!document.hidden && Date.now() - lastMetricsEvent > 5000) loadMetrics(false); }, 2000);
  const glanceTimer = setInterval(loadGlance, 10 * 60e3);
  store.ready = Promise.allSettled([
    store.loadConfig(),
    store.state ? null : client.api('/api/local/state').then(state => { store.state = state; store.emit('state', state); }),
    loadMetrics(true), loadGlance(),
  ]);
  store.destroy = () => { offs.forEach(off => off?.()); clearInterval(poll); clearInterval(glanceTimer); clearTimeout(refetch); };
  return store;
}

// ------------------------------------------------------------------ sections
const SECTIONS = [
  { id: 'general', title: 'Allgemein', icon: 'settings', color: '#8e8e93', group: 0, keywords: 'version laufzeit start neustart browser controller kiosk beenden lautstärke ton' },
  { id: 'appearance', title: 'Darstellung', icon: 'theme', color: '#0a84ff', group: 0, keywords: 'design dunkel hell auto glas webgl akzent farbe' },
  { id: 'dock', title: 'Dock & Widgets', icon: 'grid', color: '#5e5ce6', group: 0, keywords: 'kacheln widgets reihenfolge ausblenden griff' },
  { id: 'apps', title: 'Apps', icon: 'web', color: '#32ade6', group: 0, keywords: 'web app url symbol zoom residenz immer automatisch sparsam neu laden pausieren beenden hinzufügen' },
  { id: 'performance', title: 'Leistung', icon: 'gauge', color: '#ff9f0a', group: 1, keywords: 'cpu ram eco ausgewogen maximal schwellen beenden rückfrage vorwärmen temperatur gev fps' },
  { id: 'display', title: 'Display & Ruhezustand', icon: 'sleep', color: '#bf5af2', group: 1, keywords: 'schlafen dpms schwarz helligkeit ddc zeitplan aufwachen' },
  { id: 'astra', title: 'ASTRA', icon: 'astra', color: '#ff375f', group: 2, keywords: 'token url briefing stimme verbindung testen' },
  { id: 'mqtt', title: 'Home Assistant & MQTT', icon: 'home', color: '#30d158', group: 2, keywords: 'mqtt broker discovery entitäten auslöser home assistant' },
  { id: 'voice', title: 'Sprachsteuerung GEV', icon: 'mic', color: '#ff453a', group: 2, keywords: 'gemini key modell sprache' },
  { id: 'board', title: 'Whiteboard', icon: 'board', color: '#ffb800', group: 2, keywords: 'papier latenz vorhersage stift' },
  { id: 'updates', title: 'Updates', icon: 'update', color: '#636366', group: 3, keywords: 'git branch intervall prüfen version rollback' },
  { id: 'logs', title: 'Protokolle', icon: 'logs', color: '#48484a', group: 3, keywords: 'log controller update fehler' },
];

const RESIDENCY = [
  ['always', 'Immer aktiv', 'Läuft immer weiter und wird nie eingefroren oder beendet. Für Apps, die sofort bereit sein müssen, z. B. Home Assistant oder Astra.'],
  ['auto', 'Automatisch', 'Läuft im Hintergrund weiter, solange Reserven da sind. Unter Last wird die App eingefroren und nur im Notfall beendet.'],
  ['eco', 'Sparsam', 'Wird eingefroren, sobald sie in den Hintergrund geht. Spart am meisten; beim Öffnen läuft sie sofort weiter, Inhalte aktualisieren sich erst dann.'],
];
const ACCENTS = [['#f4f5f8', 'Platin'], ['#6aa8ff', 'Blau'], ['#8b7cff', 'Indigo'], ['#36d399', 'Grün'], ['#f5c451', 'Gold'], ['#ff8a5c', 'Orange'], ['#fb7185', 'Rosé']];

// ------------------------------------------------------------------ mount
export function mountSettings(root, { layout = 'touch', api, section, single = false, onNavigate, onOpenApp: openAppExternal, app: initialApp } = {}) {
  if (!api) throw new Error('mountSettings: api fehlt');
  const css = injectStylesheet('./settings.css');
  const touch = layout === 'touch';
  const store = createStore(api);
  const sections = single && section ? SECTIONS.filter(s => s.id === section) : SECTIONS;
  let current = sections.find(s => s.id === section)?.id || readLast() || sections[0].id;
  if (!sections.some(s => s.id === current)) current = sections[0].id;
  let page = null;      // { bindings, lives, flushers, cleanups, stack }
  let filter = '';

  // ---------------- skeleton
  const nav = h('nav', { class: 'obs-nav', 'aria-label': 'Bereiche' });
  const search = h('input', { class: 'ob-input obs-search', type: 'search', placeholder: 'Suchen', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Einstellungen durchsuchen' });
  const deviceCard = h('button', { type: 'button', class: 'obs-device', onclick: () => go('general') });
  const side = single ? null : h('aside', { class: 'obs-side' },
    h('div', { class: 'obs-side-head' }, h('h1', null, 'Einstellungen'), h('label', { class: 'obs-searchwrap' }, icon('search', 'lead'), search)),
    h('div', { class: 'obs-side-scroll ob-scroll' }, deviceCard, nav));
  const backBtn = h('button', { type: 'button', class: 'obs-back', hidden: true }, icon('back'), h('span'));
  const titleEl = h('h2', { class: 'obs-title' });
  const savedEl = h('span', { class: 'obs-saved', 'aria-live': 'polite' }, icon('check'), 'Gespeichert');
  const offlineEl = h('span', { class: 'ob-badge err obs-offline', hidden: true }, 'Controller nicht erreichbar');
  const content = h('div', { class: 'obs-page' });
  const scroller = h('div', { class: 'obs-scroll ob-scroll' }, content);
  const main = h('main', { class: 'obs-main' }, h('header', { class: 'obs-head' }, backBtn, titleEl, h('span', { class: 'obs-head-sp' }), offlineEl, savedEl), scroller);
  const shell = h('div', { class: `obs obs--${layout}${single ? ' obs--single' : ''}` }, side, main);
  root.append(shell);
  const toaster = createToaster(shell);
  const toast = (text, options) => toaster.show(text, options);
  const confirm = options => confirmSheet(shell, options);

  search.addEventListener('input', () => { filter = search.value.trim().toLowerCase(); renderNav(); });
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { const first = nav.querySelector('.obs-nav-item'); if (first) go(first.dataset.section); search.blur(); } });

  // ---------------- feedback
  let savedTimer;
  const offs = [
    store.on('saved', () => { savedEl.classList.add('show'); clearTimeout(savedTimer); savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1600); }),
    store.on('error', error => toast(`Nicht gespeichert: ${error.message}`, { kind: 'err' })),
    store.on('config', () => syncBindings()),
    store.on('state', () => { runLives(); renderDevice(); }),
    store.on('metrics', () => runLives('metrics')),
    store.on('connection', connected => { offlineEl.hidden = connected; renderDevice(); }),
  ];

  // ---------------- navigation
  function readLast() { try { return touch && !single ? localStorage.getItem('ob.settings.section') : null; } catch { return null; } }
  function renderNav() {
    if (single) return;
    const groups = [];
    for (const s of sections) {
      if (filter && !`${s.title} ${s.keywords}`.toLowerCase().includes(filter)) continue;
      (groups[s.group] ||= []).push(s);
    }
    const nodes = groups.filter(Boolean).map(list => h('div', { class: 'obs-nav-group' }, list.map(s => h('button', {
      type: 'button', class: 'obs-nav-item', dataset: { section: s.id }, 'aria-current': s.id === current ? 'page' : null, onclick: () => go(s.id),
    }, h('span', { class: 'sq', style: { '--sq': s.color } }, icon(s.icon)), h('span', { class: 'tx' }, s.title), navBadge(s.id)))));
    nav.replaceChildren(...(nodes.length ? nodes : [h('p', { class: 'obs-nav-empty' }, 'Keine Treffer')]));
  }
  function navBadge(id) {
    const s = store.state;
    if (!s) return null;
    if (id === 'performance' && s.performance?.prompts?.length) return h('span', { class: 'obs-count' }, String(s.performance.prompts.length));
    if (id === 'updates' && s.update?.available) return h('span', { class: 'obs-count' }, '1');
    if (id === 'astra' && s.astra?.configured && !s.astra.connected) return h('span', { class: 'obs-dot err' });
    if (id === 'mqtt' && s.mqtt?.configured && !s.mqtt.connected) return h('span', { class: 'obs-dot err' });
    return null;
  }
  function renderDevice() {
    if (single) return;
    const s = store.state, online = store.connected && !!s;
    deviceCard.replaceChildren(
      h('span', { class: 'logo' }, icon('screen')),
      h('span', { class: 'tx' }, h('b', null, 'OpenBoard'), h('small', null, online ? `${s.connected === false ? 'Browser getrennt' : 'Verbunden'} · ${(s.version || '–').slice(0, 7)}` : 'Keine Verbindung')),
      h('span', { class: `obs-dot ${online ? (s.pressure === 'critical' ? 'err' : s.pressure === 'elevated' ? 'warn' : 'ok') : 'err'}` }));
    const signature = JSON.stringify([s?.performance?.prompts?.length, s?.update?.available, s?.astra, s?.mqtt]);
    if (signature !== renderDevice.last) { renderDevice.last = signature; renderNav(); }
  }
  function go(id, { replace = false } = {}) {
    if (!sections.some(s => s.id === id)) return;
    current = id;
    try { if (touch && !single) localStorage.setItem('ob.settings.section', id); } catch { /* storage unavailable */ }
    renderNav();
    openPage();
    if (!replace) onNavigate?.(id);
  }

  // ---------------- page lifecycle
  function leavePage() {
    if (!page) return;
    page.flushers.forEach(flush => flush());
    page.cleanups.forEach(fn => fn());
    page = null;
  }
  function openPage(sub) {
    const keepScroll = sub?.keepScroll ? scroller.scrollTop : 0;
    const stack = sub?.stack || [];
    leavePage();
    page = { bindings: [], lives: [], flushers: [], cleanups: [], stack };
    const s = sections.find(x => x.id === current);
    const top = stack[stack.length - 1];
    titleEl.textContent = top ? top.title : s.title;
    backBtn.hidden = !top;
    backBtn.querySelector('span').textContent = stack.length > 1 ? stack[stack.length - 2].title : s.title;
    backBtn.onclick = () => openPage({ stack: stack.slice(0, -1) });
    shell.dataset.section = current;
    content.replaceChildren();
    content.className = `obs-page obs-page--${current}${top ? ' is-sub' : ''}`;
    try {
      if (!store.config && !top) content.append(loadingView());
      else (top ? top.build : BUILDERS[current])(ctx(), content);
    } catch (error) {
      console.error(error);
      content.append(h('div', { class: 'obs-empty' }, icon('warning'), h('p', null, 'Dieser Bereich konnte nicht geladen werden.'), h('small', null, error.message)));
    }
    scroller.scrollTop = keepScroll;
    runLives();
  }
  function loadingView() {
    return h('div', { class: 'obs-empty' }, h('div', { class: 'obs-spinner' }), h('p', null, store.connected ? 'Lade Einstellungen …' : 'Keine Verbindung zum Controller.'), store.connected ? null : h('small', null, 'Die Ansicht aktualisiert sich automatisch, sobald er wieder erreichbar ist.'));
  }
  function syncBindings() {
    if (!page) return;
    if (content.querySelector('.obs-empty .obs-spinner') && store.config) { openPage({ stack: page.stack }); return; }
    for (const binding of page.bindings) {
      if (binding.editing?.()) continue;
      try { binding.set(binding.get(store.config)); } catch (error) { console.error(error); }
    }
    runLives('config');
  }
  function runLives(reason) {
    if (!page) return;
    for (const live of page.lives) { if (reason && live.on && !live.on.includes(reason)) continue; try { live.fn(); } catch (error) { console.error(error); } }
  }

  // ---------------- builder context
  function ctx() {
    const p = page;
    const acc = spec => typeof spec === 'string' ? { get: cfg => getPath(cfg, spec), patch: value => patchFor(spec, value) } : spec;
    const save = (spec, value) => store.patch(spec.patch(value)).catch(() => {});
    const bind = binding => { p.bindings.push(binding); return binding; };
    const c = {
      store, toast, confirm, layout, touch, shell,
      get config() { return store.config; },
      get state() { return store.state || {}; },
      api: (path, options) => store.api(path, options),
      push(title, build) { openPage({ stack: [...p.stack, { title, build }] }); scroller.scrollTop = 0; },
      back() { openPage({ stack: p.stack.slice(0, -1) }); },
      go,
      rerender() { openPage({ stack: p.stack, keepScroll: true }); },
      cleanup(fn) { p.cleanups.push(fn); },
      live(fn, on) { p.lives.push({ fn, on }); return fn; },
      group(title, rows, hint) {
        return h('section', { class: 'obs-group' }, title ? h('h3', { class: 'ob-group-title' }, title) : null, h('div', { class: 'ob-group' }, rows), hint ? h('p', { class: 'ob-hint' }, hint) : null);
      },
      row({ label, sub, control, lead, onClick, chevron, value, cls = '', stacked = false, danger = false }) {
        const labelEl = h('div', { class: 'label' }, h('span', { class: 'lt' }, label), sub ? h('small', null, sub) : null);
        const leadEl = lead ? (typeof lead === 'string' ? h('span', { class: 'lead' }, icon(lead)) : lead) : null;
        const inner = [leadEl, labelEl, value != null ? h('span', { class: 'value' }, value) : null, control || null, chevron ? icon('chevron', 'chev') : null];
        if (onClick) return h('button', { type: 'button', class: `ob-row obs-row is-link ${danger ? 'is-danger' : ''} ${cls}`, onclick: onClick }, inner);
        return h('div', { class: `ob-row obs-row ${stacked ? 'is-stacked' : ''} ${cls}` }, inner);
      },
      toggle(spec, label) {
        const a = acc(spec);
        const el = switchEl(a.get(store.config), value => save(a, value), label);
        bind({ get: a.get, set: el.set });
        return el;
      },
      segment(spec, options, label) {
        const a = acc(spec);
        const el = seg(options, a.get(store.config), value => save(a, value), { label });
        bind({ get: a.get, set: el.set });
        return el;
      },
      choose(spec, options, label) {
        const a = acc(spec);
        const el = select(options, a.get(store.config), value => save(a, value), { label });
        bind({ get: a.get, set: el.set });
        return el;
      },
      number(spec, options) {
        const a = acc(spec);
        const el = stepper({ ...options, value: a.get(store.config), onChange: value => save(a, value) });
        bind({ get: a.get, set: el.set, editing: el.editing });
        return el;
      },
      text(spec, { placeholder = '', type = 'text', inputmode, validate, wide = false, label, mono = false } = {}) {
        const a = acc(spec);
        const input = h('input', { class: `ob-input obs-text${wide ? ' wide' : ''}${mono ? ' mono' : ''}`, type, placeholder, inputmode, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': label || placeholder });
        input.value = a.get(store.config) ?? '';
        const commit = debounce(() => {
          const value = input.value.trim();
          const problem = validate?.(value);
          input.classList.toggle('invalid', !!problem);
          input.title = problem || '';
          if (problem) return;
          if (value !== (a.get(store.config) ?? '')) save(a, value);
        }, 800);
        input.addEventListener('input', () => { input.classList.remove('invalid'); commit(); });
        input.addEventListener('blur', () => { commit.flush(); if (input.classList.contains('invalid')) toast(input.title, { kind: 'err' }); });
        input.addEventListener('keydown', event => { if (event.key === 'Enter') input.blur(); });
        p.flushers.push(commit.flush);
        bind({ get: a.get, set: value => { input.value = value ?? ''; input.classList.remove('invalid'); }, editing: () => document.activeElement === input || commit.pending() });
        return input;
      },
      // Touch friendly slider bound to a config value; saves ~150 ms after the finger rests (and on release).
      range(spec, { min = 0, max = 1, step = 0.01, format = v => v, label, fallback, debounceMs = 150 } = {}) {
        const a = acc(spec);
        const read = cfg => a.get(cfg) ?? fallback;
        const el = slider({ value: read(store.config), min, max, step, format, label, debounceMs, onChange: value => save(a, value) });
        p.flushers.push(el.flush);
        bind({ get: read, set: el.set, editing: el.editing });
        return el;
      },
      time(spec, label) {
        const a = acc(spec);
        const input = h('input', { class: 'ob-input obs-time', type: 'time', 'aria-label': label || '' });
        input.value = a.get(store.config) || '';
        input.addEventListener('change', () => { if (input.value) save(a, input.value); });
        bind({ get: a.get, set: value => { input.value = value || ''; }, editing: () => document.activeElement === input });
        return input;
      },
      // Write-only secret: the controller only says {set:true}.
      secret(path, { label, placeholder = 'Neuen Wert eingeben', help } = {}) {
        const input = h('input', { class: 'ob-input obs-text', type: 'password', placeholder, autocomplete: 'new-password', spellcheck: 'false', 'aria-label': label });
        const state = h('span', { class: 'ob-badge' });
        const saveBtn = h('button', { type: 'button', class: 'ob-btn primary sm', disabled: true }, 'Speichern');
        const clearBtn = h('button', { type: 'button', class: 'ob-btn ghost sm' }, 'Entfernen');
        const paint = () => {
          const set = isSecretSet(getPath(store.config, path));
          state.className = `ob-badge ${set ? 'ok' : ''}`;
          state.textContent = set ? 'Gespeichert' : 'Nicht gesetzt';
          clearBtn.hidden = !set;
          input.placeholder = set ? '•••••••• (zum Ändern neu eingeben)' : placeholder;
        };
        input.addEventListener('input', () => { saveBtn.disabled = !input.value.trim(); });
        input.addEventListener('keydown', event => { if (event.key === 'Enter' && input.value.trim()) saveBtn.click(); });
        saveBtn.addEventListener('click', async () => {
          const value = input.value.trim();
          if (!value) return;
          saveBtn.disabled = true;
          try { await store.patch(patchFor(path, value)); input.value = ''; toast(`${label} gespeichert`, { kind: 'ok' }); } catch { saveBtn.disabled = false; }
        });
        clearBtn.addEventListener('click', async () => {
          if (!await confirm({ title: `${label} entfernen?`, text: 'Der gespeicherte Wert wird gelöscht. Die Verbindung funktioniert danach nicht mehr.', confirm: 'Entfernen', danger: true })) return;
          store.patch(patchFor(path, '')).then(() => toast(`${label} entfernt`)).catch(() => {});
        });
        bind({ get: () => null, set: paint });
        paint();
        return c.row({ label, sub: help, stacked: true, cls: 'obs-secret', control: h('div', { class: 'obs-secret-ctl' }, input, h('div', { class: 'obs-secret-actions' }, state, clearBtn, saveBtn)) });
      },
      // Button that shows progress and reports errors.
      action(label, run, { kind = '', iconName, confirmText, small = false } = {}) {
        const button = h('button', { type: 'button', class: `ob-btn ${kind}${small ? ' sm' : ''}` }, iconName ? icon(iconName) : null, h('span', null, label));
        button.addEventListener('click', async () => {
          if (confirmText && !await confirm({ ...confirmText, danger: kind === 'danger' })) return;
          button.disabled = true; button.classList.add('busy');
          try { await run(); } catch (error) { toast(error.message || 'Fehlgeschlagen', { kind: 'err' }); } finally { button.disabled = false; button.classList.remove('busy'); }
        });
        return button;
      },
      // "Verbindung testen" row with inline result.
      tester(target, label = 'Verbindung testen') {
        const result = h('small', { class: 'obs-test-result' }, 'Prüft die gespeicherten Werte.');
        const button = c.action(label, async () => {
          page?.flushers.forEach(flush => flush());
          await new Promise(resolve => setTimeout(resolve, 50));
          result.className = 'obs-test-result busy'; result.textContent = 'Teste …';
          try {
            const r = await store.api(`/api/local/config/test/${target}`, { method: 'POST', body: {} });
            result.className = `obs-test-result ${r.ok ? 'ok' : 'err'}`;
            result.replaceChildren(icon(r.ok ? 'check' : 'warning'), r.detail || (r.ok ? 'Verbindung erfolgreich' : 'Fehlgeschlagen'));
          } catch (error) { result.className = 'obs-test-result err'; result.replaceChildren(icon('warning'), error.message); }
        }, { iconName: 'link' });
        return h('div', { class: 'ob-row obs-row' }, h('div', { class: 'label' }, h('span', { class: 'lt' }, label), result), button);
      },
      statusCard(parts, cls = '') { return h('div', { class: `obs-card ${cls}` }, parts); },
    };
    return c;
  }

  // ------------------------------------------------------------------ section builders
  const appName = id => store.config?.apps?.find(a => a.id === id)?.name || id;
  const appAcc = (id, key) => ({
    get: cfg => cfg?.apps?.find(app => app.id === id)?.[key],
    patch: value => ({ apps: store.config.apps.map(app => app.id === id ? { ...app, [key]: value } : app) }),
  });
  const PROTECTED = ['gev', 'home', 'astra', 'board', 'settings'];
  const isRemovable = app => !app.builtin && !PROTECTED.includes(app.id);
  const urlCheck = (schemes = ['http', 'https']) => value => !value || new RegExp(`^(${schemes.join('|')})://[^\\s]+$`, 'i').test(value) ? '' : `Bitte eine gültige Adresse (${schemes.map(s => s + '://').join(', ')}) eingeben.`;
  const systemAction = (action, body) => store.api(`/api/local/system/${action}`, { method: 'POST', body: body || {} });

  const BUILDERS = {
    general(c, el) {
      const hero = c.statusCard([
        h('span', { class: 'obs-hero-logo' }, icon('screen')),
        h('div', { class: 'obs-hero-tx' }, h('h3', null, 'OpenBoard'), h('p', { class: 'obs-hero-sub' })),
        h('div', { class: 'obs-hero-badges' }),
      ], 'obs-hero');
      c.live(() => {
        const s = c.state;
        hero.querySelector('.obs-hero-sub').textContent = `Whiteboard-OS · Version ${(s.update?.current || s.version || '–').slice(0, 7)}`;
        hero.querySelector('.obs-hero-badges').replaceChildren(
          badge(s.connected === false ? 'Browser getrennt' : 'Browser verbunden', s.connected === false ? 'err' : 'ok'),
          badge(s.display?.asleep ? 'Schläft' : 'Wach', s.display?.asleep ? '' : 'ok'));
      });
      const version = h('span'), uptime = h('span'), active = h('span'), pressure = h('span');
      c.live(() => {
        const s = c.state;
        version.textContent = (s.update?.current || s.version || '–');
        const started = s.startedAt || (Number.isFinite(s.uptime) ? Date.now() - s.uptime * 1000 : null);
        uptime.textContent = started ? fmt.duration(Date.now() - started) : '–';
        active.textContent = s.active ? appName(s.active) : '–';
        const p = PRESSURE[s.pressure] || PRESSURE.normal;
        pressure.replaceChildren(badge(p.label, p.kind));
      });
      const apps = () => (store.config.apps || []).filter(app => app.enabled !== false).map(app => [app.id, app.name]);
      el.append(hero,
        c.group('Info', [
          c.row({ label: 'Version', value: version }),
          c.row({ label: 'Laufzeit des Controllers', value: uptime }),
          c.row({ label: 'Aktive App', value: active }),
          c.row({ label: 'Lastlage', value: pressure, onClick: () => go('performance'), chevron: true }),
        ]),
        c.group('Start', [c.row({ label: 'Start-App', sub: 'Öffnet sich nach dem Einschalten und nach einem Neustart des Browsers.', control: c.choose('startApp', apps(), 'Start-App') })]));
      if (c.state.system?.volume != null) {
        const vol = slider({ value: c.state.system.volume, format: v => `${v} %`, label: 'Lautstärke', onInput: v => systemAction('volume', { value: v }).catch(() => {}), onChange: v => systemAction('volume', { value: v }).catch(error => toast(error.message, { kind: 'err' })) });
        c.live(() => vol.set(c.state.system?.volume), ['undefined']);
        el.append(c.group('Ton', [c.row({ label: 'Lautstärke', lead: 'volume', control: vol, cls: 'has-slider' })]));
      }
      el.append(c.group('Neustart', [
        c.row({ label: 'Browser neu starten', sub: 'Lädt alle Apps neu. Das Display ist etwa 10 Sekunden schwarz.', control: c.action('Neu starten', () => systemAction('restart-browser').then(() => toast('Browser wird neu gestartet')), { confirmText: { title: 'Browser neu starten?', text: 'Alle Apps werden neu geladen. Ungespeicherte Eingaben in Web-Apps gehen verloren.', confirm: 'Neu starten' } }) }),
        c.row({ label: 'Controller neu starten', sub: 'Startet den OpenBoard-Dienst neu. Der Browser bleibt offen; die Shell verbindet sich von selbst wieder.', control: c.action('Neu starten', () => systemAction('restart-controller').then(() => toast('Controller wird neu gestartet')), { confirmText: { title: 'Controller neu starten?', text: 'Für einige Sekunden reagieren Dock und Einstellungen nicht.', confirm: 'Neu starten' } }) }),
        c.row({ label: 'Kiosk beenden', sub: 'Schließt den Vollbildmodus und zeigt den Ubuntu-Desktop. Zurück über die Konsole („Kiosk starten“) oder einen Neustart.', control: c.action('Beenden', () => systemAction('exit-kiosk'), { kind: 'danger', confirmText: { title: 'Kiosk beenden?', text: 'Das Display zeigt danach den Desktop. Ohne Tastatur kommst du nur über die Konsole zurück.', confirm: 'Kiosk beenden' } }) }),
      ]));
    },

    appearance(c, el) {
      const a = { get: cfg => cfg?.appearance?.theme, patch: value => ({ appearance: { theme: value } }) };
      const cards = h('div', { class: 'obs-themes', role: 'radiogroup', 'aria-label': 'Design' }, [['light', 'Hell'], ['dark', 'Dunkel'], ['auto', 'Automatisch']].map(([value, label]) =>
        h('button', { type: 'button', class: 'obs-theme', role: 'radio', dataset: { value }, onclick: () => { paint(value); store.patch(a.patch(value)).catch(() => {}); } },
          h('span', { class: `pv pv-${value}` }, h('i', { class: 'win' }, h('b'), h('b'), h('b')), h('i', { class: 'dock' })),
          h('span', { class: 'lb' }, h('i', { class: 'radio' }, icon('check')), label))));
      const paint = value => { for (const card of cards.children) card.setAttribute('aria-checked', String(card.dataset.value === value)); times.hidden = value !== 'auto'; };
      const times = h('div', null,
        c.row({ label: 'Hell ab', lead: 'sun', control: c.time('appearance.lightFrom', 'Hell ab') }),
        c.row({ label: 'Dunkel ab', lead: 'moon', control: c.time('appearance.darkFrom', 'Dunkel ab') }));
      c.live(() => paint(a.get(store.config)), ['config']);
      paint(a.get(store.config));
      const swatches = h('div', { class: 'obs-swatches', role: 'radiogroup', 'aria-label': 'Akzentfarbe' });
      const custom = h('input', { type: 'color', class: 'obs-colorpick', 'aria-label': 'Eigene Farbe', title: 'Eigene Farbe' });
      const paintAccent = value => {
        for (const sw of swatches.querySelectorAll('.sw[data-value]')) sw.setAttribute('aria-checked', String(sw.dataset.value.toLowerCase() === String(value).toLowerCase()));
        custom.value = /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#f4f5f8';
        custom.parentElement?.setAttribute('aria-checked', String(!ACCENTS.some(([v]) => v.toLowerCase() === String(value).toLowerCase())));
      };
      for (const [value, label] of ACCENTS) swatches.append(h('button', { type: 'button', class: 'sw', role: 'radio', title: label, 'aria-label': label, dataset: { value }, style: { '--sw': value }, onclick: () => { paintAccent(value); store.patch({ appearance: { accent: value } }).catch(() => {}); } }));
      swatches.append(h('label', { class: 'sw custom', title: 'Eigene Farbe' }, custom, icon('plus')));
      custom.addEventListener('change', () => { paintAccent(custom.value); store.patch({ appearance: { accent: custom.value } }).catch(() => {}); });
      c.live(() => paintAccent(store.config?.appearance?.accent), ['config']);
      paintAccent(store.config?.appearance?.accent);
      el.append(
        c.group('Design', [h('div', { class: 'ob-row obs-row is-block' }, cards), times], 'Automatisch wechselt zu den angegebenen Uhrzeiten zwischen Hell und Dunkel. Das Whiteboard-Papier kann eigene Regeln haben (siehe Whiteboard).'),
        c.group('Glas', [
          c.row({ label: 'Glas-Effekt', sub: 'Für Dock, Kacheln und Rückfragen.', control: c.segment('appearance.glass', [['webgl', 'WebGL'], ['css', 'CSS'], ['off', 'Aus']], 'Glas-Effekt') }),
          c.row({ label: 'Milchglas', sub: 'Mehr Unschärfe hinter dem Dock, die Lichtbrechung am Rand bleibt.', cls: 'has-slider',
            control: c.range('appearance.frost', { min: 0, max: 1, step: 0.01, fallback: 0.55, format: v => `${Math.round(v * 100)} %`, label: 'Milchglas' }) })],
          'WebGL bricht das Licht wie echtes Glas (Brechung, Fresnel) und kostet auf der Intel-GPU etwa 2–4 % Last, solange das Dock sichtbar ist. CSS ist ein weicher Weichzeichner ohne Lichtbrechung. Aus zeigt matte Flächen und spart am meisten.'),
        c.group('Akzentfarbe', [h('div', { class: 'ob-row obs-row is-block' }, swatches)], 'Färbt Ringe, Verläufe und ausgewählte Elemente der Shell.'),
        c.group('Bildschirmtastatur', [
          c.row({ label: 'Tastaturgröße', sub: 'Lässt sich auch an den Ecken der Tastatur ziehen.', lead: 'keyboard', cls: 'has-slider',
            control: c.range('appearance.keyboardScale', { min: 0.5, max: 1.6, step: 0.05, fallback: 1, format: v => `${Math.round(v * 100)} %`, label: 'Tastaturgröße' }) })]));
    },

    dock(c, el) {
      const host = h('div', { class: 'obs-dock-host' });
      el.append(host);
      const editor = createDockEditor(host, { layout, store, toast, onOpenApp: sections.some(x => x.id === 'apps') ? id => { go('apps'); openApp(c, id, true); } : openAppExternal });
      c.cleanup(() => editor.destroy());
      el.append(
        c.group('Dock', [
          c.row({ label: 'Automatisch ausblenden', sub: 'Sekunden ohne Berührung, bis das Dock wieder verschwindet. 0 = bleibt sichtbar, bis du wegwischst.', control: c.number('dock.autoHideSeconds', { min: 0, max: 120, step: 1, unit: 's', label: 'Automatisch ausblenden' }) }),
          c.row({ label: 'Griff am unteren Rand', sub: 'Der schmale Balken, der zeigt, wo das Dock wartet.', control: c.segment('dock.indicator', [['always', 'Immer'], ['touch', 'Bei Berührung'], ['never', 'Nie']], 'Griff') }),
        ], 'Am Display: vom unteren Rand nach oben wischen öffnet das Dock. Langes Drücken auf eine Kachel öffnet denselben Editor direkt über dem Dock.'));
    },

    apps(c, el) {
      const list = h('div', { class: 'ob-group obs-applist' });
      c.live(() => {
        const live = Object.fromEntries((c.state.apps || []).map(app => [app.id, app]));
        const order = store.config?.dock?.order || [];
        const apps = [...(store.config?.apps || [])].sort((a, b) => (order.indexOf(a.id) + 1 || 999) - (order.indexOf(b.id) + 1 || 999));
        list.replaceChildren(...apps.map(app => {
          const l = live[app.id] || {};
          const metrics = l.lifecycle && l.lifecycle !== 'terminated' ? `${fmt.pct(l.cpu)} CPU · ${fmt.mb(l.heapMB)}` : (app.enabled === false ? 'Ausgeblendet' : 'Nicht geladen');
          return h('button', { type: 'button', class: `ob-row obs-row is-link${app.enabled === false ? ' is-off' : ''}`, onclick: () => openApp(c, app.id) },
            h('span', { class: 'appicon' }, icon(app.icon || 'web')),
            h('div', { class: 'label' }, h('span', { class: 'lt' }, app.name), h('small', null, metrics)),
            app.enabled === false ? badge('Aus') : lifecycleBadge(l.lifecycle), icon('chevron', 'chev'));
        }));
      });
      el.append(
        h('section', { class: 'obs-group' }, h('h3', { class: 'ob-group-title' }, 'Apps'), list, h('p', { class: 'ob-hint' }, 'Die Reihenfolge im Dock änderst du unter „Dock & Widgets“.')),
        c.group(null, [c.row({ label: 'Web-App hinzufügen', lead: 'plus', onClick: () => addAppSheet(c), cls: 'is-accent' })], 'Jede Webseite kann eine App werden, z. B. ein Dashboard, ein Kalender oder eine Kamera. Sie läuft wie die eingebauten Apps in einem eigenen Tab.'),
        c.group('Ressourcen-Verhalten', RESIDENCY.map(([, label, text]) => c.row({ label, sub: text }))));
    },

    performance(c, el) {
      const live = h('div', { class: 'obs-perf' });
      const prompts = h('div', { class: 'obs-prompts' });
      const actionsList = h('div', { class: 'ob-group' });
      const actions = h('section', { class: 'obs-group', hidden: true }, h('h3', { class: 'ob-group-title' }, 'Letzte Eingriffe'), actionsList);
      let promptKey = '';
      c.live(() => {
        const s = c.state, m = store.metrics || {}, p = PRESSURE[s.pressure || m.pressure] || PRESSURE.normal;
        live.replaceChildren(
          h('div', { class: `obs-perf-state ${p.kind}` }, h('span', { class: 'pulse' }), h('div', null, h('b', null, `Lastlage: ${p.label}`), h('small', null, p.text))),
          h('div', { class: 'obs-perf-stats' },
            stat('CPU', fmt.pct(m.cpu?.pct), m.cpu?.pct), stat(m.gpu?.source === 'freq' ? 'GPU-Takt' : 'GPU', fmt.pct(m.gpu?.pct), m.gpu?.pct),
            stat('RAM', fmt.pct(m.ram?.pct), m.ram?.pct, m.ram ? `${fmt.mb(m.ram.usedMB)} von ${fmt.mb(m.ram.totalMB)}` : ''), stat('Temperatur', fmt.temp(m.temp?.c), m.temp?.c, '', store.config?.performance?.thermalLimitC)));
        const perf = s.performance || {}, t = perf.thresholds;
        const facts = [];
        if (t) facts.push(h('span', null, `Eingriff ab ${t.elevated} % · kritisch ab ${t.critical} % CPU`));
        if (t?.terminate) facts.push(h('span', null, `Beenden: ${({ ask: 'mit Rückfrage', auto: 'automatisch', never: 'nie' })[t.terminate] || t.terminate}`));
        if (perf.prediction?.id) facts.push(h('span', null, `Als Nächstes erwartet: ${appName(perf.prediction.id)}${Number.isFinite(perf.prediction.share) ? ` (${Math.round(perf.prediction.share * 100)} %)` : ''}`));
        if (perf.thermalThrottled) facts.push(badge('Gedrosselt wegen Temperatur', 'warn'));
        if (facts.length) live.append(h('div', { class: 'obs-perf-facts' }, facts));
        const recent = perf.actions || [];
        actions.hidden = !recent.length;
        actionsList.replaceChildren(...recent.slice(0, 8).map(entry => c.row({ label: entry.text, lead: (store.config?.apps || []).find(x => x.id === entry.app)?.icon || 'gauge', value: fmt.ago(entry.at) })));
        const list = s.performance?.prompts || [];
        const key = list.map(x => x.id).join(',');
        if (key === promptKey) return;
        promptKey = key;
        prompts.replaceChildren(...list.map(prompt => promptCard(prompt, store, toast)));
      });
      const ask = h('div', null,
        c.row({ label: 'Wartezeit auf Antwort', sub: 'Danach gilt die Standardantwort.', control: c.number('performance.askTimeoutSeconds', { min: 5, max: 300, step: 5, unit: 's', label: 'Wartezeit' }) }),
        c.row({ label: 'Ohne Antwort', control: c.segment('performance.askDefault', [['keep', 'Behalten'], ['terminate', 'Beenden']], 'Ohne Antwort') }));
      c.live(() => { ask.hidden = store.config?.performance?.terminate !== 'ask'; }, ['config']);
      ask.hidden = store.config?.performance?.terminate !== 'ask';
      const scale = slider({ value: store.config?.performance?.gev?.resolutionScale ?? 0.8, min: 0.5, max: 1, step: 0.05, format: v => `${Math.round(v * 100)} %`, label: 'Auflösung', onChange: v => store.patch({ performance: { gev: { resolutionScale: v } } }).catch(() => {}) });
      page.bindings.push({ get: cfg => cfg?.performance?.gev?.resolutionScale, set: v => scale.set(v) });
      el.append(live, prompts,
        c.group('Modus', [c.row({ label: 'Leistungsmodus', control: c.segment('performance.mode', [['eco', 'Eco'], ['balanced', 'Ausgewogen'], ['max', 'Maximal']], 'Leistungsmodus') })],
          'Eco greift 15 Prozentpunkte früher ein, Maximal 8 Punkte später und beendet nie Apps. Ausgewogen nutzt die Schwellen unten unverändert.'),
        c.group('Schwellen', [
          c.row({ label: 'Erhöhte Last ab', sub: 'Ab hier werden ungenutzte Hintergrund-Apps eingefroren.', control: c.number('performance.elevatedCpu', { min: 30, max: 99, step: 1, unit: '% CPU', label: 'Erhöhte Last' }) }),
          c.row({ label: 'Kritische Last ab', sub: 'Ab hier wird eine ungenutzte App beendet (oder nachgefragt).', control: c.number('performance.criticalCpu', { min: 40, max: 100, step: 1, unit: '% CPU', label: 'Kritische Last' }) }),
          c.row({ label: 'Anhaltend für', sub: 'So lange muss die Last bestehen, bevor eingegriffen wird.', control: c.number('performance.sustainSeconds', { min: 4, max: 300, step: 2, unit: 's', label: 'Anhaltend für' }) }),
          c.row({ label: 'Freier Arbeitsspeicher mindestens', sub: 'Darunter gilt die Lage sofort als kritisch.', control: c.number('performance.memoryFloorMB', { min: 100, max: 8000, step: 50, unit: 'MB', label: 'Speicher-Untergrenze' }) }),
        ]),
        c.group('Apps beenden', [
          c.row({ label: 'Bei kritischer Last', control: c.segment('performance.terminate', [['ask', 'Fragen'], ['auto', 'Automatisch'], ['never', 'Nie']], 'Apps beenden') }),
          ask,
          c.row({ label: 'Einfrieren nach', sub: 'Mindestens so lange ungenutzt (Residenz „Automatisch“).', control: c.number('performance.freezeMinIdleMinutes', { min: 0, max: 240, step: 1, unit: 'min', label: 'Einfrieren nach' }) }),
          c.row({ label: 'Beenden frühestens nach', sub: 'Eine App muss mindestens so lange ungenutzt sein.', control: c.number('performance.terminateMinIdleMinutes', { min: 1, max: 720, step: 1, unit: 'min', label: 'Beenden nach' }) }),
        ], 'Nie betroffen: die geöffnete App, Apps mit „Immer aktiv“ und Apps mit laufender Sprachsitzung oder Audiowiedergabe. Eingefrorene Apps laufen beim Öffnen sofort weiter; beendete laden ihre letzte Seite neu.'),
        c.group('Vorhersage & Temperatur', [
          c.row({ label: 'Apps vorwärmen', sub: 'Lernt, wann du welche App nutzt, und lädt sie 5 Minuten vorher – nur bei normaler Last.', control: c.toggle('performance.prewarm', 'Vorwärmen') }),
          c.row({ label: 'Temperaturgrenze', sub: 'Darüber senkt OpenBoard God’s Eye View auf 20 FPS und 60 % Auflösung, bis es 5 °C kühler ist.', control: c.number('performance.thermalLimitC', { min: 60, max: 100, step: 1, unit: '°C', label: 'Temperaturgrenze' }) }),
        ]),
        c.group('God’s Eye View', [
          c.row({ label: 'Bildrate', control: c.segment('performance.gev.fps', [[20, '20'], [30, '30'], [45, '45'], [60, '60 FPS']], 'Bildrate') }),
          c.row({ label: 'Auflösung', sub: 'Renderauflösung des Globus. 80 % sieht auf 60″ kaum anders aus und spart deutlich GPU.', control: scale, cls: 'has-slider' }),
        ]), actions);
    },

    display(c, el) {
      const card = h('div', { class: 'obs-card obs-sleep' });
      c.live(() => {
        const d = c.state.display || {};
        card.replaceChildren(
          h('span', { class: `obs-sleep-ic ${d.asleep ? 'asleep' : ''}` }, icon(d.asleep ? 'sleep' : 'sun')),
          h('div', { class: 'tx' }, h('b', null, d.asleep ? 'Display schläft' : 'Display ist wach'), h('small', null, d.since ? `seit ${fmt.time(d.since)} · ${fmt.duration(Date.now() - d.since)}` : '')),
          c.action(d.asleep ? 'Aufwecken' : 'Jetzt schlafen', () => store.api(`/api/local/display/${d.asleep ? 'wake' : 'sleep'}`, { method: 'POST' }), { kind: d.asleep ? 'primary' : '', iconName: d.asleep ? 'sun' : 'sleep' }));
      });
      const explain = h('div', { class: 'obs-explain' });
      const paintExplain = () => {
        const mode = store.config?.display?.sleepMode;
        explain.replaceChildren(...(mode === 'dpms' ? [
          h('p', null, h('b', null, 'Signal aus (DPMS): '), 'Der Rechner schaltet das Bildsignal ab. Das Sharp-Display geht nach einigen Sekunden in Standby und spart wirklich Strom.'),
          h('p', null, h('b', null, 'Aber: '), 'Je nach Modell und Einstellung des Displays weckt eine Berührung es nicht zuverlässig auf, und das Aufwachen dauert 3–8 Sekunden. Wecken klappt immer über Zeitplan, Home Assistant oder die Konsole.'),
        ] : [
          h('p', null, h('b', null, 'Schwarzbild: '), 'OpenBoard legt eine schwarze Fläche über alles und friert die Apps ein. Eine Berührung weckt sofort.'),
          h('p', null, h('b', null, 'Aber: '), 'Die Hintergrundbeleuchtung des LCD bleibt an. Das spart nur die Rechenleistung, kaum Strom; im Dunkeln ist ein leichtes Leuchten sichtbar.'),
        ]));
      };
      c.live(paintExplain, ['config']);
      paintExplain();
      const brightness = slider({ value: c.state.system?.brightness ?? 50, format: v => `${v} %`, label: 'Helligkeit', onInput: v => systemAction('brightness', { value: v }).catch(() => {}), onChange: v => systemAction('brightness', { value: v }).catch(error => toast(error.message, { kind: 'err' })) });
      const brightRow = c.row({ label: 'Helligkeit', lead: 'brightness', control: brightness, cls: 'has-slider' });
      const noBright = c.row({ label: 'Helligkeit', sub: 'Das Display meldet sich nicht per DDC/CI. Prüfe am Display, ob DDC/CI im Menü aktiviert ist.', value: 'Nicht verfügbar' });
      c.live(() => {
        const ddc = store.config?.display?.useDdc, value = c.state.system?.brightness;
        brightRow.hidden = !ddc || value == null; noBright.hidden = !ddc || value != null;
        if (value != null) brightness.set(value);
      });
      const schedule = h('div', null,
        c.row({ label: 'Schlafen um', control: c.time('display.schedule.sleepAt', 'Schlafen um') }),
        c.row({ label: 'Aufwachen um', control: c.time('display.schedule.wakeAt', 'Aufwachen um') }));
      c.live(() => { schedule.hidden = !store.config?.display?.schedule?.enabled; }, ['config']);
      schedule.hidden = !store.config?.display?.schedule?.enabled;
      el.append(card,
        c.group('Ausrichtung', [c.row({ label: 'Bildausrichtung', control: c.segment('display.orientation', [['landscape', 'Quer'], ['portrait', 'Hoch'], ['landscape-flipped', 'Quer ↻'], ['portrait-flipped', 'Hoch ↻']], 'Ausrichtung') })],
          'Dreht Bild und Touch (xrandr und Koordinatenmatrix). Hochformat = 1080 × 1920; ↻ dreht um 180°.'),
        c.group('Ruhezustand', [
          c.row({ label: 'Art', control: c.segment('display.sleepMode', [['black', 'Schwarzbild'], ['dpms', 'Signal aus (DPMS)']], 'Art des Ruhezustands') }),
          h('div', { class: 'ob-row obs-row is-block' }, explain),
          c.row({ label: 'Automatisch schlafen nach', sub: 'Ohne Berührung. 0 = nie.', control: c.number('display.idleSleepMinutes', { min: 0, max: 600, step: 5, unit: 'min', label: 'Automatisch schlafen' }) }),
        ]),
        c.group('Zeitplan', [c.row({ label: 'Nach Zeitplan schlafen', sub: 'Jeden Tag zur gleichen Zeit.', control: c.toggle('display.schedule.enabled', 'Zeitplan') }), schedule]),
        c.group('Helligkeit', [c.row({ label: 'Helligkeit per DDC/CI', sub: 'Steuert die Hintergrundbeleuchtung über das HDMI- bzw. DisplayPort-Kabel.', control: c.toggle('display.useDdc', 'DDC/CI') }), brightRow, noBright]));
    },

    astra(c, el) {
      const status = h('div', { class: 'obs-card obs-status' });
      c.live(() => statusInto(status, 'astra', 'ASTRA', c.state.astra, { ok: 'Verbunden', off: 'Nicht eingerichtet', err: 'Keine Verbindung' }));
      el.append(status,
        c.group('Verbindung', [
          c.row({ label: 'Adresse', sub: 'z. B. http://astra.local:8088', control: c.text('astra.url', { placeholder: 'http://astra.local:8088', type: 'url', inputmode: 'url', validate: urlCheck(), label: 'ASTRA-Adresse' }) }),
          c.secret('astra.token', { label: 'Display-Token', help: 'In ASTRA unter Admin → Displays bzw. ASTRA_DISPLAY_TOKEN. Der Browser sieht den Token nie.' }),
          c.tester('astra'),
        ]),
        c.group('Funktionen', [
          c.row({ label: 'Sprachausgabe', sub: 'ASTRA spricht Antworten und Wecker über die Lautsprecher des Displays.', control: c.toggle('astra.voice', 'Sprachausgabe') }),
          c.row({ label: 'Briefing auf dem Display', sub: 'Morgendliches Briefing und Wecker erscheinen als Karte, auch wenn eine andere App offen ist.', control: c.toggle('astra.briefingOnDisplay', 'Briefing auf dem Display') }),
        ]));
    },

    mqtt(c, el) {
      const status = h('div', { class: 'obs-card obs-status' });
      c.live(() => statusInto(status, 'mqtt', 'MQTT', c.state.mqtt, { ok: 'Mit dem Broker verbunden', off: 'Nicht eingerichtet', err: 'Keine Verbindung zum Broker' }));
      const home = store.config?.apps?.find(app => app.id === 'home');
      el.append(status);
      if (home) el.append(c.group('Home Assistant', [c.row({ label: 'Adresse', sub: 'Wird als App „Home Assistant“ im Dock geöffnet.', control: c.text(appAcc('home', 'url'), { placeholder: 'http://homeassistant.local:8123/', type: 'url', inputmode: 'url', validate: urlCheck(), label: 'Home-Assistant-Adresse' }) })]));
      el.append(
        c.group('MQTT-Broker', [
          c.row({ label: 'Broker', sub: 'z. B. mqtt://homeassistant.local:1883 (Mosquitto-Add-on)', control: c.text('mqtt.url', { placeholder: 'mqtt://homeassistant.local:1883', inputmode: 'url', validate: urlCheck(['mqtt', 'mqtts', 'ws', 'wss']), label: 'Broker' }) }),
          c.row({ label: 'Benutzer', control: c.text('mqtt.username', { placeholder: 'openboard', label: 'Benutzer' }) }),
          c.secret('mqtt.password', { label: 'Passwort' }),
          c.row({ label: 'Discovery-Präfix', sub: 'Standard in Home Assistant: homeassistant', control: c.text('mqtt.discoveryPrefix', { placeholder: 'homeassistant', label: 'Discovery-Präfix', mono: true }) }),
          c.row({ label: 'Geräte-ID', sub: 'Eindeutig pro Display, wenn du mehrere hast.', control: c.text('mqtt.nodeId', { placeholder: 'openboard', label: 'Geräte-ID', mono: true }) }),
          c.tester('mqtt'),
        ]),
        c.group('Das erscheint in Home Assistant', [
          entity('screen', 'Bildschirm', 'Schalter', 'An = wach, aus = Ruhezustand'),
          entity('grid', 'App', 'Auswahl', 'Zeigt und wechselt die geöffnete App'),
          entity('gauge', 'Leistungsmodus · Design', 'Auswahl', 'Eco / Ausgewogen / Maximal · Dunkel / Hell / Auto'),
          entity('astra', 'Sagen', 'Text', 'Text wird über ASTRA auf dem Display gesprochen'),
          entity('reload', 'Neu laden · Browser neu starten', 'Knöpfe', ''),
          entity('cpu', 'CPU, GPU, RAM, Temperatur, aktive App, letzte Berührung, Version', 'Sensoren', ''),
          entity('info', 'ASTRA verbunden · Update verfügbar', 'Binärsensoren', ''),
        ], 'Alle Entitäten gehören zum Gerät „OpenBoard“. Ist das Display aus, zeigt Home Assistant sie als „nicht verfügbar“.'),
        c.group('Widget-Auslöser', [c.row({ label: 'HA-Auslöser im Dock', sub: 'Lege unter „Dock & Widgets“ ein Widget „HA-Auslöser“ an. Jeder Druck darauf erscheint in Home Assistant als Geräte-Auslöser: Automation → Auslöser → Gerät → OpenBoard → z. B. „szene_1 gedrückt“.', lead: 'mqtt', onClick: () => go('dock'), chevron: true })]));
      function entity(glyph, name, kind, text) {
        return c.row({ label: name, sub: text || null, lead: glyph, value: kind });
      }
    },

    voice(c, el) {
      const status = h('div', { class: 'obs-card obs-status' });
      c.live(() => {
        const v = c.state.voice || {}, set = isSecretSet(store.config?.gemini?.key);
        statusInto(status, 'mic', 'Gemini Live', { configured: set, connected: set && v.gemini !== false }, { ok: v.listening ? 'Hört gerade zu' : 'Bereit', off: 'Kein API-Key', err: 'Nicht bereit' });
      });
      el.append(status,
        c.group('Gemini', [
          c.secret('gemini.key', { label: 'API-Key', placeholder: 'Key aus Google AI Studio', help: 'Bleibt auf dem Display. Der Controller spricht direkt mit Google; der Browser sieht den Key nie.' }),
          c.row({ label: 'Modell', sub: 'Ein Live-Modell mit Audio-Ein- und -Ausgabe.', control: c.text('gemini.model', { placeholder: 'gemini-3.8-live', label: 'Modell', mono: true }) }),
          c.tester('gemini'),
        ], 'Die Sprachsteuerung bedient God’s Eye View („Zeig mir Tokio“, „Wetterebene an“). Sie startet nur, wenn du am Display auf das Mikrofon tippst, und endet nach einer Pause von selbst. In anderen Apps übernimmt ASTRA.'));
    },

    board(c, el) {
      el.append(
        c.group('Papier', [c.row({ label: 'Hintergrund', sub: 'Automatisch folgt dem Design des Displays.', control: c.segment('board.paper', [['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']], 'Papier') })]),
        c.group('Stift', [
          c.row({ label: 'Niedrige Latenz', sub: 'Zeichnet den Strich sofort auf einer eigenen Ebene unter dem Finger, bevor das Whiteboard ihn übernimmt.', control: c.toggle('board.lowLatency', 'Niedrige Latenz') }),
          c.row({ label: 'Strichvorhersage', sub: 'Sagt die Bewegung einige Millisekunden voraus. Fühlt sich direkter an, kann bei schnellen Kurven minimal überschießen.', control: c.toggle('board.prediction', 'Strichvorhersage') }),
        ]),
        c.group(null, [c.row({ label: 'Whiteboard öffnen', lead: 'board', onClick: () => store.api('/api/local/apps/board/activate', { method: 'POST' }).catch(error => toast(error.message, { kind: 'err' })), chevron: true })]));
    },

    updates(c, el) {
      const card = h('div', { class: 'obs-card obs-update' });
      c.live(() => {
        const u = c.state.update || {};
        const result = { ok: ['Aktuell', 'ok'], 'rolled-back': ['Zurückgerollt', 'err'], failed: ['Fehlgeschlagen', 'err'], dirty: ['Lokale Änderungen', 'warn'] }[u.lastResult] || [u.lastResult || '–', ''];
        card.replaceChildren(
          h('span', { class: 'obs-update-ic' }, icon('update')),
          h('div', { class: 'tx' }, h('b', null, u.available ? 'Update verfügbar' : 'OpenBoard ist aktuell'),
            h('small', null, `Version ${(u.current || c.state.version || '–').slice(0, 7)} · zuletzt geprüft ${fmt.ago(u.lastCheck)}`),
            h('span', { class: 'obs-update-badges' }, badge(result[0], result[1]), u.pendingBrowserRestart ? badge('Browser-Neustart ausstehend', 'warn') : null)),
          c.action('Jetzt prüfen', async () => { await systemAction('update-check'); toast('Prüfung abgeschlossen', { kind: 'ok' }); loadLog(); }, { iconName: 'reload' }));
      });
      const log = h('pre', { class: 'obs-log short' });
      async function loadLog() {
        try { const data = await store.api('/api/local/logs'); fillLog(log, (data.update || []).slice(-80), ''); } catch (error) { log.textContent = `Protokoll nicht verfügbar: ${error.message}`; }
      }
      loadLog();
      const timer = setInterval(() => { if (!document.hidden) loadLog(); }, 8000);
      c.cleanup(() => clearInterval(timer));
      const offUpdate = store.on('update', () => loadLog());
      c.cleanup(offUpdate);
      el.append(card,
        c.group('Automatische Updates', [
          c.row({ label: 'Automatisch aktualisieren', sub: 'Holt neue Versionen per Git und rollt bei Fehlern zurück.', control: c.toggle('updates.enabled', 'Automatisch aktualisieren') }),
          c.row({ label: 'Branch', control: c.text('updates.branch', { placeholder: 'main', label: 'Branch', mono: true, validate: v => /^[\w./-]+$/.test(v) ? '' : 'Ungültiger Branch-Name' }) }),
          c.row({ label: 'Prüfen alle', control: c.number('updates.intervalSeconds', { min: 60, max: 86400, step: 60, unit: 's', label: 'Intervall' }) }),
          c.row({ label: 'Browser neu starten', sub: 'Nur nötig, wenn sich das Startskript des Browsers geändert hat.', control: c.segment('updates.restartBrowser', [['idle', 'Im Leerlauf'], ['now', 'Sofort'], ['never', 'Nie']], 'Browser neu starten') }),
        ], 'Im Leerlauf heißt: sobald das Display schläft oder 2 Minuten niemand es berührt hat. Shell und eingebaute Apps aktualisieren sich ohne Neustart.'),
        h('section', { class: 'obs-group' }, h('h3', { class: 'ob-group-title' }, 'Update-Protokoll'), log));
    },

    logs(c, el) {
      let source = 'controller', auto = true, needle = '';
      const pre = h('pre', { class: 'obs-log tall', tabindex: 0 });
      const searchBox = h('input', { class: 'ob-input obs-text', type: 'search', placeholder: 'Filtern', spellcheck: 'false', 'aria-label': 'Protokoll filtern' });
      const stamp = h('small', { class: 'obs-log-stamp' });
      let data = { controller: [], update: [] };
      // Leistungsmanager: the controller may serve its own log; otherwise the action list from the state is shown.
      const stampLine = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
      const performanceLines = () => data.performance || [...(c.state.performance?.actions || [])].reverse().map(entry => `${stampLine(entry.at)} ${entry.text}`);
      async function load() {
        try { data = await store.api('/api/local/logs'); stamp.textContent = `Stand ${new Date().toLocaleTimeString('de-DE')}`; paint(); }
        catch (error) { pre.textContent = `Protokolle nicht verfügbar: ${error.message}`; }
      }
      function paint() {
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        fillLog(pre, source === 'performance' ? performanceLines() : data[source] || [], needle);
        if (atBottom || !paint.done) pre.scrollTop = pre.scrollHeight;
        paint.done = true;
      }
      searchBox.addEventListener('input', () => { needle = searchBox.value.trim().toLowerCase(); paint(); });
      const timer = setInterval(() => { if (auto && !document.hidden) load(); }, 3000);
      c.cleanup(() => clearInterval(timer));
      c.live(() => { if (source === 'performance') paint(); }, ['state']);
      load();
      el.append(h('div', { class: 'obs-logbar' },
        seg([['controller', 'Controller'], ['update', 'Updates'], ['performance', 'Leistung']], source, value => { source = value; paint.done = false; paint(); }, { label: 'Protokoll' }),
        searchBox,
        h('label', { class: 'obs-inline' }, switchEl(auto, value => { auto = value; if (value) load(); }, 'Automatisch aktualisieren'), 'Live'),
        stamp), pre);
    },
  };

  function stat(label, text, value, sub = '', limit) {
    const level = value == null ? '' : label === 'Temperatur' ? (value >= (limit || 88) ? 'crit' : value >= (limit || 88) - 8 ? 'warn' : '') : value >= 90 ? 'crit' : value >= 75 ? 'warn' : '';
    return h('div', { class: `obs-stat ${level}` }, h('small', null, label), h('b', null, text), h('div', { class: 'ob-meter' }, h('i', { style: { width: `${Math.max(0, Math.min(100, label === 'Temperatur' ? (value ?? 0) / (limit || 100) * 100 : value ?? 0))}%` } })), sub ? h('small', { class: 'sub' }, sub) : null);
  }
  function statusInto(el, glyph, name, s = {}, text) {
    const kind = s?.connected ? 'ok' : s?.configured ? 'err' : 'off';
    el.replaceChildren(h('span', { class: `obs-status-ic ${kind}` }, icon(glyph)), h('div', { class: 'tx' }, h('b', null, name), h('small', null, text[kind])), badge(kind === 'ok' ? 'Online' : kind === 'err' ? 'Offline' : 'Aus', kind === 'ok' ? 'ok' : kind === 'err' ? 'err' : ''));
  }

  // ---------------- app detail
  function openApp(c, id, fromDock) {
    const build = (cc, el) => {
      const app = () => store.config?.apps?.find(a => a.id === id);
      if (!app()) { el.append(h('div', { class: 'obs-empty' }, h('p', null, 'Diese App gibt es nicht mehr.'))); return; }
      cc.live(() => { if (!app()) cc.back(); }, ['config']);
      const a = app();
      const head = h('div', { class: 'obs-card obs-apphead' });
      cc.live(() => {
        const cur = app(); if (!cur) return;
        const l = (cc.state.apps || []).find(x => x.id === id) || {};
        const running = l.lifecycle && l.lifecycle !== 'terminated';
        const act = (label, action, opts = {}) => cc.action(label, () => store.api(`/api/local/apps/${encodeURIComponent(id)}/${action}`, { method: 'POST' }).then(() => toast(`${cur.name}: ${label}`, { kind: 'ok', timeout: 1600 })), { small: true, ...opts });
        head.replaceChildren(
          h('span', { class: 'appicon big' }, icon(cur.icon || 'web')),
          h('div', { class: 'tx' }, h('b', null, cur.name), h('small', null, cur.url),
            h('span', { class: 'obs-appstats' }, lifecycleBadge(l.lifecycle), running ? h('span', null, `CPU ${fmt.pct(l.cpu)}`) : null, running ? h('span', null, `Speicher ${fmt.mb(l.heapMB)}`) : null, l.lastActive ? h('span', null, `genutzt ${fmt.ago(l.lastActive)}`) : null)),
          h('div', { class: 'obs-appacts' },
            cur.enabled !== false && cc.state.active !== id ? act('Öffnen', 'activate', { iconName: 'screen' }) : null,
            running ? act('Neu laden', 'reload', { iconName: 'reload' }) : null,
            l.lifecycle === 'frozen' ? act('Fortsetzen', 'resume', { iconName: 'bolt' }) : running && cc.state.active !== id ? act('Pausieren', 'suspend', { iconName: 'sleep' }) : null,
            running && cc.state.active !== id ? act('Beenden', 'terminate', { iconName: 'power', kind: 'danger', confirmText: { title: `${cur.name} beenden?`, text: 'Die App wird geschlossen und beim nächsten Öffnen neu geladen.', confirm: 'Beenden' } }) : null));
      });
      const resText = h('small', { class: 'obs-res-text' });
      const paintRes = () => { resText.textContent = RESIDENCY.find(([v]) => v === app()?.residency)?.[2] || ''; };
      cc.live(paintRes, ['config']); paintRes();
      const iconPreview = h('span', { class: 'appicon' }, icon(a.icon || 'web'));
      const grid = iconGrid(a.icon || 'web', value => { iconPreview.replaceChildren(icon(value)); store.patch(appAcc(id, 'icon').patch(value)).catch(() => {}); });
      grid.hidden = true;
      cc.store && page.bindings.push({ get: cfg => appAcc(id, 'icon').get(cfg), set: value => { grid.set(value); iconPreview.replaceChildren(icon(value || 'web')); } });
      el.append(head,
        cc.group(null, [
          cc.row({ label: 'Im Dock anzeigen', sub: 'Ausgeblendete Apps werden nicht geladen.', control: cc.toggle(appAcc(id, 'enabled'), 'Im Dock anzeigen') }),
          cc.row({ label: 'Name', control: cc.text(appAcc(id, 'name'), { placeholder: 'Name', label: 'Name', validate: v => v ? '' : 'Der Name darf nicht leer sein.' }) }),
          a.builtin ? cc.row({ label: 'Adresse', value: a.url, sub: 'Eingebaute App' }) : cc.row({ label: 'Adresse', control: cc.text(appAcc(id, 'url'), { placeholder: 'https://…', type: 'url', inputmode: 'url', validate: v => /^https?:\/\/\S+$/i.test(v) ? '' : 'Bitte eine http(s)-Adresse eingeben.', label: 'Adresse' }) }),
          cc.row({ label: 'Symbol', control: h('span', { class: 'obs-iconsel' }, iconPreview, h('button', { type: 'button', class: 'ob-btn sm', onclick: event => { grid.hidden = !grid.hidden; event.currentTarget.textContent = grid.hidden ? 'Ändern' : 'Fertig'; } }, 'Ändern')) }),
          h('div', { class: 'ob-row obs-row is-block obs-gridrow' }, grid),
          cc.row({ label: 'Zoom', sub: 'Skaliert die Seite, z. B. 75 % für dichte Dashboards.', control: cc.number(appAcc(id, 'zoom'), { min: 0.3, max: 2, step: 0.05, scale: 100, unit: '%', label: 'Zoom' }) }),
        ]),
        cc.group('Ressourcen', [
          h('div', { class: 'ob-row obs-row is-stacked' }, h('div', { class: 'label' }, h('span', { class: 'lt' }, 'Im Hintergrund'), resText), cc.segment(appAcc(id, 'residency'), RESIDENCY.map(([v, l]) => [v, l]), 'Residenz')),
        ], a.weight ? `Startwert für die Kosten: ${({ heavy: 'schwer', standard: 'mittel', light: 'leicht' })[a.weight] || a.weight}. OpenBoard misst den tatsächlichen Verbrauch und passt ihn an.` : null),
        isRemovable(a) ? cc.group(null, [cc.row({ label: 'App entfernen', danger: true, lead: 'trash', onClick: async () => {
          if (!await confirm({ title: `${a.name} entfernen?`, text: 'Die App verschwindet aus dem Dock und wird geschlossen.', confirm: 'Entfernen', danger: true })) return;
          try { await store.api(`/api/local/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }); await store.loadConfig(); toast(`${a.name} entfernt`); cc.back(); } catch (error) { toast(error.message, { kind: 'err' }); }
        } })]) : null);
    };
    const title = appName(id);
    if (fromDock) openPage({ stack: [{ title, build }] });
    else c.push(title, build);
  }
  function addAppSheet(c) {
    let chosen = 'web';
    const name = h('input', { class: 'ob-input', placeholder: 'z. B. Kalender', autocomplete: 'off', 'aria-label': 'Name' });
    const url = h('input', { class: 'ob-input', type: 'url', inputmode: 'url', placeholder: 'https://…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Adresse' });
    const err = h('small', { class: 'obs-form-err' });
    const content = h('div', { class: 'obs-form' },
      h('label', null, h('span', null, 'Name'), name),
      h('label', null, h('span', null, 'Adresse'), url),
      h('div', null, h('span', { class: 'obs-form-lbl' }, 'Symbol'), iconGrid(chosen, value => { chosen = value; })), err);
    openSheet(shell, {
      title: 'Web-App hinzufügen', content, wide: true,
      actions: [
        { label: 'Abbrechen', kind: 'ghost' },
        { label: 'Hinzufügen', kind: 'primary', run: async () => {
          if (!name.value.trim()) { err.textContent = 'Bitte einen Namen eingeben.'; name.focus(); return false; }
          if (!/^https?:\/\/\S+$/i.test(url.value.trim())) { err.textContent = 'Bitte eine Adresse mit http:// oder https:// eingeben.'; url.focus(); return false; }
          try {
            const app = await store.api('/api/local/apps', { method: 'POST', body: { name: name.value.trim(), url: url.value.trim(), icon: chosen } });
            await store.loadConfig();
            toast(`${name.value.trim()} hinzugefügt`, { kind: 'ok' });
            if (app?.id) openApp(c, app.id);
            else c.rerender();
          } catch (error) { err.textContent = error.message; return false; }
        } },
      ],
    });
  }

  // ---------------- boot
  renderNav();
  renderDevice();
  openPage();
  store.ready.then(() => {
    if (!store.config) { store.connected = false; offlineEl.hidden = false; }   // controller unreachable: say so instead of spinning
    if (page && content.querySelector('.obs-spinner')) openPage({ stack: page.stack });
    if (initialApp && current === 'apps' && store.config?.apps?.some(a => a.id === initialApp)) openApp(ctx(), initialApp, true);
    renderDevice();
  });
  css.then(() => shell.classList.add('is-ready'));

  return {
    el: shell,
    store,
    show(id) { go(id, { replace: true }); },
    openApp(id) { go('apps', { replace: true }); openApp(ctx(), id); },
    get section() { return current; },
    destroy() { leavePage(); offs.forEach(off => off?.()); store.destroy(); toaster.destroy(); shell.remove(); },
  };
}

// ------------------------------------------------------------------ shared bits
function promptCard(prompt, store, toast) {
  const app = (store.state?.apps || []).find(a => a.id === prompt.app);
  const left = h('small', { class: 'left' });
  const card = h('div', { class: 'obs-prompt' },
    h('span', { class: 'appicon' }, icon(app?.icon || 'warning')),
    h('div', { class: 'tx' }, h('b', null, 'Rückfrage des Leistungsmanagers'), h('p', null, prompt.text), left),
    h('div', { class: 'acts' }, (prompt.choices || []).map(choice => h('button', {
      type: 'button', class: `ob-btn sm ${choice.id === 'terminate' ? 'danger' : choice.id === 'keep' ? 'primary' : ''}`,
      onclick: async event => {
        for (const b of card.querySelectorAll('button')) b.disabled = true;
        event.currentTarget.classList.add('busy');
        try { await store.api(`/api/local/prompt/${encodeURIComponent(prompt.id)}`, { method: 'POST', body: { choice: choice.id } }); card.classList.add('answered'); }
        catch (error) { toast(error.message, { kind: 'err' }); for (const b of card.querySelectorAll('button')) b.disabled = false; }
      },
    }, choice.label))));
  if (prompt.expiresAt) {
    const tick = () => { if (!card.isConnected) return clearInterval(timer); const s = Math.max(0, Math.round((prompt.expiresAt - Date.now()) / 1000)); left.textContent = s ? `Automatische Antwort in ${s} s` : 'Wird automatisch beantwortet …'; };
    const timer = setInterval(tick, 1000); tick();
  }
  return card;
}
export { promptCard };

function fillLog(pre, lines, needle) {
  const list = needle ? lines.filter(line => line.toLowerCase().includes(needle)) : lines;
  pre.replaceChildren(...(list.length ? list.map(line => {
    const kind = /(error|fehler|failed|fehlgeschlagen|rolled.?back|zurückgerollt|exception)/i.test(line) ? 'err' : /(warn|warnung|timeout|langsam)/i.test(line) ? 'warn' : '';
    const m = /^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?Z?)\s(.*)$/.exec(line);
    return h('span', { class: `ln ${kind}` }, m ? [h('i', { class: 'ts' }, m[1].replace('T', ' ').replace(/\.\d+Z?$/, '').replace('Z', '')), ' ', m[2]] : line, '\n');
  }) : [h('span', { class: 'ln empty' }, needle ? 'Keine passenden Zeilen.' : 'Noch keine Einträge.')]));
}
export { fillLog };

// ------------------------------------------------------------------ auto-mount (touch app)
if (document.body?.hasAttribute('data-ob-settings-app')) {
  const { openboard } = await import('/ui/app.js');
  const client = await openboard.connect({ metrics: true });
  mountSettings(document.getElementById('app') || document.body, { layout: 'touch', api: client });
}
