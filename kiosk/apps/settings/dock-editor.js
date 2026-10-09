// Dock & tile editor, shared by the settings app (touch) and the remote console
// (desktop). Pointer events only, so the same code works with fingers and mice.
//
//   const editor = createDockEditor(host, { layout, store, toast, onOpenApp });
//   store: { config, state, metrics, glance, patch(obj) → Promise, on(type, cb) → off }
//
// Model: config.dock.tiles = [{ id, items: [{ id, type, options }] (≤ 4) }] (0–4 tiles),
//        config.dock.order = [appId…], config.apps[].enabled.
import { h, icon, debounce, clone, equal, uid, seg, select, stepper, iconGrid, switchEl, lifecycleBadge, injectStyle } from './common.js';

const MAX_TILES = 4, MAX_ITEMS = 4;

export function createDockEditor(host, { layout = 'touch', store, toast, onOpenApp } = {}) {
  injectStyle('ob-widgets-css', OBWidgets.css);
  const touch = layout === 'touch';
  let model = readModel();
  let selection = null;      // { kind: 'item'|'app'|'tile', id }
  let drag = null, pending = null, lastPersist = 0, query = '';
  const tileEls = new Map();

  // ------------------------------------------------------------ skeleton
  const tilesEl = h('div', { class: 'obd-tiles' });
  const appsEl = h('div', { class: 'obd-apps' });
  const dockEl = h('div', { class: 'obd-dock' }, tilesEl, h('i', { class: 'obd-sep' }), appsEl);
  const stage = h('div', { class: 'obd-stage', 'aria-label': 'Dock-Vorschau' },
    h('div', { class: 'obd-stage-hint' }, icon('drag'), touch ? 'Widgets auf eine Kachel ziehen · Antippen zum Bearbeiten · Aus dem Dock ziehen zum Entfernen' : 'Widgets auf eine Kachel ziehen · Klicken zum Bearbeiten · Aus dem Dock ziehen oder Entf zum Entfernen'),
    dockEl);
  const searchInput = h('input', { class: 'ob-input obd-search', type: 'search', placeholder: 'Widgets suchen', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Widgets suchen' });
  const libraryList = h('div', { class: 'obd-lib-list' });
  const library = h('section', { class: 'obd-library', 'aria-label': 'Widget-Bibliothek' },
    h('div', { class: 'obd-panel-head' }, h('h3', null, 'Bibliothek'), h('span', { class: 'obd-count' })),
    h('label', { class: 'obd-searchwrap' }, icon('search'), searchInput),
    libraryList);
  const inspector = h('section', { class: 'obd-inspector', 'aria-label': 'Inspektor' });
  const root = h('div', { class: `obd obd--${layout}` }, stage, h('div', { class: 'obd-panels' }, inspector, library));
  host.append(root);

  searchInput.addEventListener('input', () => { query = searchInput.value.trim().toLowerCase(); renderLibrary(); });

  // ------------------------------------------------------------ model
  function readModel() {
    const dock = store.config?.dock || store.state?.dock || {};
    const apps = store.config?.apps || store.state?.apps || [];
    const order = (dock.order || []).filter(id => apps.some(app => app.id === id));
    for (const app of apps) if (!order.includes(app.id)) order.push(app.id);
    return { tiles: clone(dock.tiles || []), order };
  }
  const appsById = () => Object.fromEntries((store.config?.apps || []).map(app => [app.id, app]));
  const liveApp = id => (store.state?.apps || []).find(app => app.id === id);
  const findItem = (tiles, id) => { for (const tile of tiles) { const index = tile.items.findIndex(item => item.id === id); if (index >= 0) return { tile, index, item: tile.items[index] }; } return null; };

  const persistTiles = debounce(() => persist({ dock: { tiles: model.tiles } }), 450);
  async function persist(patch) {
    lastPersist = Date.now();
    try { await store.patch(patch); } catch { model = readModel(); render(); }
  }
  function commitTiles({ debounced = false } = {}) {
    render();
    if (debounced) persistTiles(); else { persistTiles.cancel(); persist({ dock: { tiles: model.tiles } }); }
  }
  function commitOrder() {
    const order = model.order, apps = [...(store.config?.apps || [])].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    render();
    persist({ dock: { order }, apps });
  }
  function setEnabled(id, enabled) {
    const apps = (store.config?.apps || []).map(app => app.id === id ? { ...app, enabled } : app);
    persist({ apps }).then(() => { render(); renderInspector(); });
  }

  // ------------------------------------------------------------ dock rendering
  function unit() {
    const width = stage.clientWidth || host.clientWidth || 1200;
    const apps = model.order.length, tiles = Math.max(model.tiles.length + (model.tiles.length < MAX_TILES ? 0.6 : 0), 1);
    const base = touch ? 84 : 66;
    const needed = tiles * 2.24 + apps * 1.18 + 1.2;
    return Math.max(44, Math.min(base, Math.floor((width - 64) / needed)));
  }
  function ctx() { return { state: store.state || {}, metrics: store.metrics || {}, glance: store.glance || null, mqtt: store.mqtt || {} }; }

  function render() {
    stage.style.setProperty('--u', unit() + 'px');
    const view = drag?.draft || { tiles: model.tiles, order: model.order };
    renderTiles(view.tiles);
    renderApps(view.order);
    root.classList.toggle('is-dragging', !!drag?.active);
    updateCount();
  }
  function renderTiles(tiles) {
    const keep = new Set();
    const children = [];
    tiles.forEach((tile, index) => {
      keep.add(tile.id);
      let wrap = tileEls.get(tile.id);
      if (!wrap) {
        const inner = h('div');
        wrap = h('div', { class: 'obd-tile', dataset: { tileId: tile.id } }, inner,
          h('button', { type: 'button', class: 'obd-tile-del', 'aria-label': 'Kachel entfernen', title: 'Kachel entfernen', dataset: { delTile: tile.id } }, icon('minus')));
        wrap.inner = inner;
        tileEls.set(tile.id, wrap);
      }
      wrap.dataset.index = String(index + 1);
      OBWidgets.renderTile(wrap.inner, tile, ctx());
      const placeholder = wrap.inner.querySelector('.placeholder .label');
      if (placeholder) placeholder.textContent = touch ? 'Widget hierher ziehen' : 'Widget hierher ziehen';
      for (const cell of wrap.inner.querySelectorAll('[data-item]')) {
        cell.classList.toggle('is-ghost', !!(drag?.active && drag.item && cell.dataset.item === drag.item.id && drag.target));
        cell.classList.toggle('is-selected', !!(selection?.kind === 'item' && selection.id === cell.dataset.item));
        if (!cell.hasAttribute('tabindex')) { cell.tabIndex = 0; cell.setAttribute('role', 'button'); }
        const entry = OBWidgets.byType[tile.items.find(item => item.id === cell.dataset.item)?.type];
        cell.setAttribute('aria-label', entry?.name || 'Widget');
      }
      wrap.classList.toggle('is-selected', !!(selection?.kind === 'tile' && selection.id === tile.id));
      wrap.classList.toggle('is-target', !!(drag?.active && drag.target?.tileId === tile.id && !drag.target.full));
      wrap.classList.toggle('is-full', !!(drag?.active && drag.full === tile.id));
      children.push(wrap);
    });
    for (const id of [...tileEls.keys()]) if (!keep.has(id)) tileEls.delete(id);
    if (tiles.length < MAX_TILES) {
      children.push(h('button', { type: 'button', class: `obd-addtile${drag?.active && drag.target?.newTile ? ' is-target' : ''}`, dataset: { addTile: '1' }, 'aria-label': 'Kachel hinzufügen', title: 'Kachel hinzufügen' }, icon('plus')));
    }
    tilesEl.replaceChildren(...children);
  }
  function renderApps(order) {
    const apps = appsById(), active = store.state?.active;
    appsEl.replaceChildren(...order.filter(id => apps[id]).map(id => {
      const app = apps[id], live = liveApp(id);
      const lifecycle = live?.lifecycle;
      return h('div', {
        class: `obd-app${app.enabled === false ? ' is-disabled' : ''}${id === active ? ' is-active' : ''}${lifecycle === 'active' || lifecycle === 'background' ? ' is-running' : ''}${selection?.kind === 'app' && selection.id === id ? ' is-selected' : ''}${drag?.active && drag.kind === 'app' && drag.id === id ? ' is-ghost' : ''}`,
        dataset: { app: id }, title: app.name + (app.enabled === false ? ' (ausgeblendet)' : ''), tabindex: 0, role: 'button', 'aria-label': app.name,
      }, h('span', { class: 'glyph' }, icon(app.icon || 'web')), h('i', { class: 'run' }));
    }));
  }
  function updateCount() {
    const items = model.tiles.reduce((sum, tile) => sum + tile.items.length, 0);
    library.querySelector('.obd-count').textContent = `${model.tiles.length}/${MAX_TILES} Kacheln · ${items} Widgets`;
  }

  // ------------------------------------------------------------ library
  function renderLibrary() {
    const groups = [];
    for (const category of OBWidgets.categories) {
      const entries = OBWidgets.catalog.filter(entry => entry.category === category && (!query || `${entry.name} ${entry.description} ${entry.type} ${category}`.toLowerCase().includes(query)));
      if (!entries.length) continue;
      groups.push(h('div', { class: 'obd-lib-group' }, h('div', { class: 'obd-lib-title' }, category),
        h('div', { class: 'obd-lib-grid' }, entries.map(entry => h('div', { class: 'obd-card', dataset: { type: entry.type }, tabindex: 0, role: 'button', 'aria-label': `${entry.name} hinzufügen`, title: entry.description },
          h('span', { class: 'ic' }, icon(entry.icon)),
          h('span', { class: 'txt' }, h('b', null, entry.name), h('small', null, entry.description)),
          h('span', { class: 'kind' }, entry.kind === 'button' ? 'Knopf' : 'Anzeige'))))));
    }
    libraryList.replaceChildren(...(groups.length ? groups : [h('p', { class: 'obd-empty' }, 'Kein Widget gefunden.')]));
  }
  function addFromLibrary(type) {
    const preferred = selection?.kind === 'tile' ? selection.id : selection?.kind === 'item' ? findItem(model.tiles, selection.id)?.tile.id : null;
    let tile = model.tiles.find(t => t.id === preferred && t.items.length < MAX_ITEMS) || model.tiles.find(t => t.items.length < MAX_ITEMS);
    if (!tile) {
      if (model.tiles.length >= MAX_TILES) return toast(`Alle Kacheln sind voll (je ${MAX_ITEMS} Widgets).`, { kind: 'err' });
      tile = { id: uid('t'), items: [] }; model.tiles.push(tile);
    }
    const item = OBWidgets.create(type);
    tile.items.push(item);
    selection = { kind: 'item', id: item.id };
    commitTiles();
    renderInspector();
    pulse(item.id);
    toast(`${OBWidgets.byType[type]?.name || 'Widget'} zu Kachel ${model.tiles.indexOf(tile) + 1} hinzugefügt`, { kind: 'ok', timeout: 1800 });
  }
  function pulse(itemId) {
    requestAnimationFrame(() => tilesEl.querySelector(`[data-item="${itemId}"]`)?.animate([{ transform: 'scale(.6)', opacity: 0 }, { transform: 'scale(1.06)', opacity: 1 }, { transform: 'scale(1)' }], { duration: 340, easing: 'cubic-bezier(.34,1.42,.64,1)' }));
  }

  // ------------------------------------------------------------ tile operations
  function removeItem(id) {
    const before = clone(model.tiles), found = findItem(model.tiles, id);
    if (!found) return;
    found.tile.items.splice(found.index, 1);
    if (selection?.id === id) selection = { kind: 'tile', id: found.tile.id };
    commitTiles(); renderInspector();
    toast(`${OBWidgets.byType[found.item.type]?.name || 'Widget'} entfernt`, { action: { label: 'Widerrufen', run: () => { model.tiles = before; commitTiles(); renderInspector(); } } });
  }
  function removeTile(id) {
    const before = clone(model.tiles), index = model.tiles.findIndex(tile => tile.id === id);
    if (index < 0) return;
    model.tiles.splice(index, 1);
    if (selection && (selection.id === id || !findItem(model.tiles, selection.id))) selection = selection.kind === 'app' ? selection : null;
    commitTiles(); renderInspector();
    toast(`Kachel ${index + 1} entfernt`, { action: { label: 'Widerrufen', run: () => { model.tiles = before; commitTiles(); renderInspector(); } } });
  }
  function addTile() {
    if (model.tiles.length >= MAX_TILES) return toast(`Höchstens ${MAX_TILES} Kacheln`, { kind: 'err' });
    const tile = { id: uid('t'), items: [] };
    model.tiles.push(tile);
    selection = { kind: 'tile', id: tile.id };
    commitTiles(); renderInspector();
  }
  function setOption(itemId, key, value, debounced) {
    const found = findItem(model.tiles, itemId);
    if (!found) return;
    found.item.options = { ...(found.item.options || {}), [key]: value };
    commitTiles({ debounced });
  }

  // ------------------------------------------------------------ inspector
  function renderInspector() {
    const parts = [];
    if (selection?.kind === 'item' && findItem(model.tiles, selection.id)) parts.push(...itemInspector(findItem(model.tiles, selection.id)));
    else if (selection?.kind === 'app' && appsById()[selection.id]) parts.push(...appInspector(appsById()[selection.id]));
    else if (selection?.kind === 'tile' && model.tiles.some(tile => tile.id === selection.id)) parts.push(...tileInspector(model.tiles.find(tile => tile.id === selection.id)));
    else {
      selection = null;
      parts.push(h('div', { class: 'obd-insp-empty' },
        h('span', { class: 'big' }, icon('grid')),
        h('h3', null, 'Nichts ausgewählt'),
        h('p', null, touch ? 'Tippe auf ein Widget oder eine App im Dock, um sie zu bearbeiten. Ziehe Widgets aus der Bibliothek auf eine Kachel.' : 'Klicke auf ein Widget oder eine App im Dock, um sie zu bearbeiten. Ziehe Widgets aus der Bibliothek auf eine Kachel.'),
        h('ul', { class: 'obd-facts' },
          h('li', null, h('b', null, '1'), ' Widget füllt die Kachel'),
          h('li', null, h('b', null, '2'), ' stehen nebeneinander'),
          h('li', null, h('b', null, '3–4'), ' teilen sich ein 2×2-Raster'))));
    }
    inspector.replaceChildren(...parts.filter(Boolean));
  }
  function inspectorHead(glyph, title, sub, extra) {
    return h('div', { class: 'obd-insp-head' }, h('span', { class: 'ic' }, icon(glyph)), h('div', { class: 'tt' }, h('h3', null, title), sub ? h('p', null, sub) : null), extra || null,
      h('button', { type: 'button', class: 'ob-btn ghost icon obd-close', 'aria-label': 'Auswahl aufheben', onclick: () => { selection = null; render(); renderInspector(); } }, icon('close')));
  }
  function itemInspector({ item, tile }) {
    const entry = OBWidgets.byType[item.type] || { name: item.type, icon: 'info', options: [], description: '' };
    const options = OBWidgets.optionsOf(item);
    const rows = entry.options.map(option => {
      const value = options[option.key];
      let control;
      if (option.type === 'select') control = option.options.length <= 3 ? seg(option.options, value, v => setOption(item.id, option.key, v)) : select(option.options, value, v => setOption(item.id, option.key, v));
      else if (option.type === 'number') {
        const percent = ['warn', 'crit'].includes(option.key);
        control = stepper({ value: Number(value), min: percent ? 0 : 1, max: percent ? (item.type === 'metric.temp' ? 110 : 100) : 50, step: 1, unit: percent ? (item.type === 'metric.temp' ? '°C' : '%') : '', onChange: v => setOption(item.id, option.key, v), label: option.label });
      } else if (option.type === 'text') {
        control = h('input', { class: 'ob-input', value: value ?? '', spellcheck: 'false', autocomplete: 'off', 'aria-label': option.label, placeholder: option.key === 'topic' ? 'z. B. homeassistant/sensor/…/state' : option.key === 'url' ? 'https://…' : '' });
        control.addEventListener('input', () => setOption(item.id, option.key, control.value, true));
        control.addEventListener('blur', () => persistTiles.flush());
      } else if (option.type === 'app') {
        const apps = (store.config?.apps || []).filter(app => app.enabled !== false);
        control = select([['', item.type === 'metric.app' ? 'Größter Verbraucher' : '– Keine –'], ...apps.map(app => [app.id, app.name])], value, v => setOption(item.id, option.key, v), { label: option.label });
      } else if (option.type === 'icon') {
        control = iconGrid(value, v => setOption(item.id, option.key, v));
      }
      const stacked = ['text', 'icon'].includes(option.type) || (option.type === 'select' && option.options.length > 3);
      return h('div', { class: `obd-field${stacked ? ' stacked' : ''}` }, h('span', { class: 'lbl' }, option.label), control);
    });
    return [
      inspectorHead(entry.icon, entry.name, entry.description),
      h('div', { class: 'obd-insp-meta' }, h('span', { class: 'ob-badge' }, entry.category), h('span', { class: 'ob-badge' }, entry.kind === 'button' ? 'Knopf' : 'Anzeige'), h('span', { class: 'ob-badge' }, `Kachel ${model.tiles.indexOf(tile) + 1}`),
        item.type === 'action.mqtt' ? h('span', { class: 'ob-badge info' }, 'Home-Assistant-Auslöser') : null),
      rows.length ? h('div', { class: 'obd-fields' }, rows) : h('p', { class: 'obd-note' }, 'Dieses Widget hat keine Einstellungen.'),
      item.type === 'action.mqtt' ? h('p', { class: 'obd-note' }, 'Erscheint in Home Assistant unter dem Gerät „OpenBoard“ als Auslöser. Verwende ihn in einer Automation: Auslöser → Gerät → OpenBoard.') : null,
      h('div', { class: 'obd-insp-actions' }, h('button', { type: 'button', class: 'ob-btn danger', onclick: () => removeItem(item.id) }, icon('trash'), 'Aus Kachel entfernen')),
    ];
  }
  function tileInspector(tile) {
    const index = model.tiles.indexOf(tile);
    return [
      inspectorHead('grid', `Kachel ${index + 1}`, `${tile.items.length} von ${MAX_ITEMS} Widgets`),
      h('p', { class: 'obd-note' }, 'Tippe ein Widget in der Bibliothek an, um es dieser Kachel hinzuzufügen, oder ziehe es direkt hinein.'),
      tile.items.length ? h('div', { class: 'obd-list' }, tile.items.map(item => {
        const entry = OBWidgets.byType[item.type] || { name: item.type, icon: 'info' };
        return h('button', { type: 'button', class: 'obd-list-row', onclick: () => { selection = { kind: 'item', id: item.id }; render(); renderInspector(); } }, icon(entry.icon), h('span', null, entry.name), icon('chevron', 'chev'));
      })) : null,
      h('div', { class: 'obd-insp-actions' }, h('button', { type: 'button', class: 'ob-btn danger', onclick: () => removeTile(tile.id) }, icon('trash'), 'Kachel entfernen')),
    ];
  }
  function appInspector(app) {
    const live = liveApp(app.id);
    return [
      inspectorHead(app.icon || 'web', app.name, app.url, live ? lifecycleBadge(live.lifecycle) : null),
      h('div', { class: 'obd-fields' },
        h('div', { class: 'obd-field' }, h('span', { class: 'lbl' }, 'Im Dock anzeigen', h('small', null, 'Ausgeblendete Apps laufen nicht und erscheinen nicht im Dock.')), switchEl(app.enabled !== false, value => setEnabled(app.id, value), 'Im Dock anzeigen')),
        h('div', { class: 'obd-field' }, h('span', { class: 'lbl' }, 'Position'), h('span', { class: 'val' }, `${model.order.indexOf(app.id) + 1} von ${model.order.length}`, h('span', { class: 'obd-movebtns' },
          h('button', { type: 'button', class: 'ob-btn icon ghost', 'aria-label': 'Nach links', onclick: () => moveApp(app.id, -1) }, icon('back')),
          h('button', { type: 'button', class: 'ob-btn icon ghost', 'aria-label': 'Nach rechts', onclick: () => moveApp(app.id, 1) }, icon('chevron')))))),
      h('div', { class: 'obd-insp-actions' },
        h('button', { type: 'button', class: 'ob-btn', disabled: app.enabled === false, onclick: () => store.api(`/api/local/apps/${encodeURIComponent(app.id)}/activate`, { method: 'POST' }).then(() => toast(`${app.name} geöffnet`, { kind: 'ok' }), error => toast(error.message, { kind: 'err' })) }, icon('screen'), 'Auf dem Display öffnen'),
        onOpenApp ? h('button', { type: 'button', class: 'ob-btn', onclick: () => onOpenApp(app.id) }, icon('settings'), 'App-Einstellungen') : null),
    ];
  }
  function moveApp(id, delta) {
    const index = model.order.indexOf(id), next = index + delta;
    if (index < 0 || next < 0 || next >= model.order.length) return;
    model.order.splice(index, 1); model.order.splice(next, 0, id);
    commitOrder(); renderInspector();
  }

  // ------------------------------------------------------------ drag & drop
  function computeTarget(x, y) {
    if (drag.kind === 'app') {
      const rect = appsEl.getBoundingClientRect();
      if (y < rect.top - 70 || y > rect.bottom + 70 || x < rect.left - 90 || x > rect.right + 90) return null;
      const others = [...appsEl.querySelectorAll('.obd-app')].filter(el => el.dataset.app !== drag.id);
      let index = others.findIndex(el => { const r = el.getBoundingClientRect(); return x < r.left + r.width / 2; });
      if (index < 0) index = others.length;
      return { index };
    }
    for (const [tileId, wrap] of tileEls) {
      if (!wrap.isConnected) continue;
      const r = wrap.getBoundingClientRect();
      if (x < r.left - 10 || x > r.right + 10 || y < r.top - 16 || y > r.bottom + 16) continue;
      const tile = model.tiles.find(t => t.id === tileId);
      if (!tile) { if (tileId === drag.newTileId) return { newTile: true }; continue; }
      const others = tile.items.filter(item => item.id !== drag.item.id).length;
      const slots = Math.min(others + 1, MAX_ITEMS);
      const col = x < r.left + r.width / 2 ? 0 : 1, row = y < r.top + r.height / 2 ? 0 : 1;
      let index = slots <= 1 ? 0 : slots === 2 ? col : row * 2 + col;
      return { tileId, index: Math.min(index, others), full: others >= MAX_ITEMS };
    }
    const add = tilesEl.querySelector('.obd-addtile');
    if (add) { const r = add.getBoundingClientRect(); if (x > r.left - 12 && x < r.right + 12 && y > r.top - 16 && y < r.bottom + 16) return { newTile: true }; }
    return null;
  }
  function draftFor(target) {
    if (drag.kind === 'app') {
      const order = model.order.filter(id => id !== drag.id);
      if (target) order.splice(target.index, 0, drag.id); else return { tiles: model.tiles, order: model.order };
      return { tiles: model.tiles, order };
    }
    const tiles = clone(model.tiles);
    for (const tile of tiles) tile.items = tile.items.filter(item => item.id !== drag.item.id);
    if (target?.newTile) tiles.push({ id: drag.newTileId, items: [drag.item] });
    else if (target && !target.full) tiles.find(t => t.id === target.tileId).items.splice(target.index, 0, drag.item);
    return { tiles, order: model.order };
  }
  function startDrag(p) {
    const base = { pointerId: p.pointerId, kind: p.kind, active: true, target: null, full: null };
    if (p.kind === 'app') {
      const app = appsById()[p.id];
      drag = { ...base, id: p.id, ghost: h('div', { class: 'obd-ghost app' }, h('span', { class: 'glyph' }, icon(app?.icon || 'web'))) };
    } else {
      const item = p.kind === 'new' ? OBWidgets.create(p.type) : findItem(model.tiles, p.id)?.item;
      if (!item) return;
      const entry = OBWidgets.byType[item.type] || { icon: 'info', name: item.type };
      drag = { ...base, item: clone(item), fromLibrary: p.kind === 'new', newTileId: uid('t'), ghost: h('div', { class: 'obd-ghost' }, h('span', { class: 'ic' }, icon(entry.icon)), h('b', null, entry.name), h('span', { class: 'state' })) };
      if (p.kind === 'item') { selection = { kind: 'item', id: item.id }; renderInspector(); }
    }
    // Pin the (centred) dock's left edge while dragging, so a growing draft
    // only extends to the right and nothing jumps under the pointer.
    const stageRect = stage.getBoundingClientRect(), dockRect = dockEl.getBoundingClientRect();
    stage.classList.add('is-pinned');
    dockEl.style.marginLeft = `${dockRect.left - stageRect.left - parseFloat(getComputedStyle(stage).paddingLeft)}px`;
    document.body.append(drag.ghost);
    p.sourceEl?.classList.add('is-lifted');
    drag.sourceEl = p.sourceEl;
    moveDrag(p.lastX, p.lastY);
    navigator.vibrate?.(8);
  }
  function moveDrag(x, y) {
    drag.ghost.style.transform = `translate(${x}px, ${y}px)`;
    const target = computeTarget(x, y);
    const key = JSON.stringify(target);
    drag.full = target?.full ? target.tileId : null;
    drag.ghost.dataset.mode = drag.kind === 'app' ? '' : target?.full ? 'full' : !target ? (drag.fromLibrary ? 'cancel' : 'remove') : 'ok';
    const label = drag.ghost.querySelector('.state');
    if (label) label.textContent = drag.ghost.dataset.mode === 'full' ? 'Kachel voll' : drag.ghost.dataset.mode === 'remove' ? 'Entfernen' : '';
    if (key === drag.targetKey) return;
    drag.targetKey = key;
    drag.target = target;
    drag.draft = draftFor(target);
    render();
  }
  function endDrag(commit) {
    const current = drag;
    drag = null;
    current.ghost.remove();
    stage.classList.remove('is-pinned');
    dockEl.style.marginLeft = '';
    current.sourceEl?.classList.remove('is-lifted');
    if (!commit) { render(); return; }
    if (current.kind === 'app') {
      if (current.target && !equal(current.draft.order, model.order)) { model.order = current.draft.order; commitOrder(); }
      else render();
      return;
    }
    if (current.target?.full) {
      render();
      toast(`Eine Kachel fasst höchstens ${MAX_ITEMS} Widgets`, { kind: 'err' });
      tileEls.get(current.target.tileId)?.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 });
      return;
    }
    if (!current.target) {
      if (current.fromLibrary) { render(); return; }
      removeItem(current.item.id);
      return;
    }
    if (equal(current.draft.tiles, model.tiles)) { render(); return; }
    model.tiles = current.draft.tiles;
    selection = { kind: 'item', id: current.item.id };
    commitTiles(); renderInspector();
    if (current.fromLibrary) pulse(current.item.id);
  }

  function onPointerDown(event) {
    if (event.button !== 0 || drag || pending) return;
    const del = event.target.closest('[data-del-tile]');
    if (del) return;
    const cell = event.target.closest('.obd-tiles [data-item]');
    const app = event.target.closest('.obd-app');
    const card = event.target.closest('.obd-card');
    const tile = event.target.closest('.obd-tile');
    let p = null;
    if (cell) p = { kind: 'item', id: cell.dataset.item, sourceEl: cell };
    else if (app) p = { kind: 'app', id: app.dataset.app, sourceEl: app };
    else if (card) p = { kind: 'new', type: card.dataset.type, sourceEl: card };
    else if (tile) p = { kind: 'tile', id: tile.dataset.tileId };
    if (!p) return;
    Object.assign(p, { pointerId: event.pointerId, pointerType: event.pointerType, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, lifted: false });
    if (p.kind !== 'tile') p.timer = setTimeout(() => {
      if (pending !== p) return;
      p.lifted = true;
      if (p.kind === 'new' || p.pointerType !== 'mouse') startDrag(p);
    }, p.kind === 'new' ? 320 : 420);
    pending = p;
    if (p.kind !== 'new' || event.pointerType === 'mouse') event.preventDefault();
  }
  function onPointerMove(event) {
    if (drag && event.pointerId === drag.pointerId) { event.preventDefault(); moveDrag(event.clientX, event.clientY); return; }
    const p = pending;
    if (!p || event.pointerId !== p.pointerId) return;
    p.lastX = event.clientX; p.lastY = event.clientY;
    const dx = event.clientX - p.x, dy = event.clientY - p.y, dist = Math.hypot(dx, dy);
    if (p.kind === 'tile') { if (dist > 10) cancelPending(); return; }
    const threshold = p.pointerType === 'mouse' ? 5 : 10;
    if (dist < threshold) return;
    // Library cards scroll vertically on touch: only a sideways move (or a long press) lifts them.
    if (p.kind === 'new' && p.pointerType !== 'mouse' && !p.lifted && Math.abs(dy) > Math.abs(dx)) { cancelPending(); return; }
    clearTimeout(p.timer);
    pending = null;
    startDrag(p);
    if (drag) moveDrag(event.clientX, event.clientY);
  }
  function onPointerUp(event) {
    if (drag && event.pointerId === drag.pointerId) { endDrag(event.type === 'pointerup'); return; }
    const p = pending;
    if (!p || event.pointerId !== p.pointerId) return;
    cancelPending();
    if (event.type !== 'pointerup') return;
    tap(p);
  }
  function cancelPending() { if (pending) clearTimeout(pending.timer); pending = null; }
  function tap(p) {
    if (p.kind === 'new') return addFromLibrary(p.type);
    selection = (selection?.kind === p.kind && selection.id === p.id && p.kind !== 'item' && p.kind !== 'app') ? null : { kind: p.kind, id: p.id };
    render(); renderInspector();
  }
  function onClick(event) {
    const del = event.target.closest('[data-del-tile]');
    if (del) return removeTile(del.dataset.delTile);
    if (event.target.closest('[data-add-tile]') && !drag) return addTile();
  }
  function onKey(event) {
    const cell = event.target.closest?.('.obd-tiles [data-item]'), app = event.target.closest?.('.obd-app'), card = event.target.closest?.('.obd-card');
    if (event.key === 'Enter' || event.key === ' ') {
      if (card) { event.preventDefault(); addFromLibrary(card.dataset.type); }
      else if (cell) { event.preventDefault(); selection = { kind: 'item', id: cell.dataset.item }; render(); renderInspector(); }
      else if (app) { event.preventDefault(); selection = { kind: 'app', id: app.dataset.app }; render(); renderInspector(); }
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && cell) { event.preventDefault(); removeItem(cell.dataset.item); }
    else if (app && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.altKey) { event.preventDefault(); moveApp(app.dataset.app, event.key === 'ArrowLeft' ? -1 : 1); requestAnimationFrame(() => appsEl.querySelector(`[data-app="${app.dataset.app}"]`)?.focus()); }
  }
  const blockTouchScroll = event => { if (drag || pending?.lifted) event.preventDefault(); };
  const onWindowKey = event => { if (event.key === 'Escape' && drag) endDrag(false); };

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('keydown', onWindowKey);
  document.addEventListener('touchmove', blockTouchScroll, { passive: false });
  root.addEventListener('contextmenu', event => { if (event.target.closest('.obd-stage,.obd-card')) event.preventDefault(); });

  // ------------------------------------------------------------ live updates
  function sync() {
    if (drag || persistTiles.pending() || Date.now() - lastPersist < 800) return;
    const next = readModel();
    if (!equal(next, model)) { model = next; render(); renderInspector(); }
  }
  const offs = [store.on('config', sync), store.on('state', () => { if (!drag) render(); })];
  const tick = setInterval(() => { if (!drag && root.isConnected && !document.hidden) for (const tile of model.tiles) { const wrap = tileEls.get(tile.id); if (wrap) OBWidgets.renderTile(wrap.inner, tile, ctx()); } }, 1000);
  const resize = new ResizeObserver(() => { if (!drag) stage.style.setProperty('--u', unit() + 'px'); });
  resize.observe(stage);

  renderLibrary();
  render();
  renderInspector();

  return {
    el: root,
    refresh: () => { sync(); render(); },
    select(kind, id) { selection = { kind, id }; render(); renderInspector(); },
    destroy() {
      offs.forEach(off => off?.());
      clearInterval(tick); resize.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('keydown', onWindowKey);
      document.removeEventListener('touchmove', blockTouchScroll);
      persistTiles.flush();
      if (drag) endDrag(false);
      root.remove();
    },
  };
}
