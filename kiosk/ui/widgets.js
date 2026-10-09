// OpenBoard widgets: catalog and renderer shared by the shell (touch) and the
// remote console (desktop). Classic script: defines the global OBWidgets and
// expects OBIcons. A widget item is { id, type, options }; a tile holds 1–4 items.
var OBWidgets = (() => {
  const ICON = name => OBIcons.svg(name);
  const pct = value => Number.isFinite(value) ? Math.round(value) : null;
  const level = (value, options, warn = 75, crit = 90) => value == null ? '' : value >= (options.crit ?? crit) ? 'crit' : value >= (options.warn ?? warn) ? 'warn' : '';

  const STYLE = { key: 'style', label: 'Darstellung', type: 'select', default: 'ring', options: [['ring', 'Ring'], ['number', 'Zahl'], ['spark', 'Verlauf']] };
  const WARN = (w, c) => [{ key: 'warn', label: 'Warnung ab', type: 'number', default: w }, { key: 'crit', label: 'Kritisch ab', type: 'number', default: c }];

  // Each entry: type, kind (display|button), category, name, icon, description, options.
  const catalog = [
    { type: 'metric.cpu', kind: 'display', category: 'System', name: 'CPU', icon: 'cpu', description: 'Prozessorlast des Displays', options: [STYLE, ...WARN(75, 92)] },
    { type: 'metric.gpu', kind: 'display', category: 'System', name: 'GPU', icon: 'gpu', description: 'Grafiklast (bzw. GPU-Takt, wenn keine Last messbar ist)', options: [STYLE, ...WARN(80, 95)] },
    { type: 'metric.ram', kind: 'display', category: 'System', name: 'RAM', icon: 'ram', description: 'Belegter Arbeitsspeicher', options: [STYLE, ...WARN(80, 92)] },
    { type: 'metric.temp', kind: 'display', category: 'System', name: 'Temperatur', icon: 'temp', description: 'CPU-Temperatur in °C', options: [{ ...STYLE, default: 'number' }, ...WARN(80, 90)] },
    { type: 'metric.net', kind: 'display', category: 'System', name: 'Netzwerk', icon: 'net', description: 'Empfangen/Senden', options: [{ key: 'style', label: 'Darstellung', type: 'select', default: 'number', options: [['number', 'Zahl'], ['spark', 'Verlauf']] }] },
    { type: 'metric.disk', kind: 'display', category: 'System', name: 'Speicher', icon: 'disk', description: 'Belegung der Systemplatte', options: [{ ...STYLE, options: STYLE.options.slice(0, 2) }, ...WARN(85, 95)] },
    { type: 'metric.app', kind: 'display', category: 'System', name: 'App-Last', icon: 'gauge', description: 'Größter Verbraucher oder eine bestimmte App', options: [{ key: 'app', label: 'App', type: 'app', default: '' }] },
    { type: 'info.clock', kind: 'display', category: 'Info', name: 'Uhr', icon: 'clock', description: 'Uhrzeit', options: [{ key: 'seconds', label: 'Sekunden', type: 'select', default: 'no', options: [['no', 'Aus'], ['yes', 'An']] }] },
    { type: 'info.date', kind: 'display', category: 'Info', name: 'Datum', icon: 'calendar', description: 'Wochentag und Datum', options: [] },
    { type: 'info.weather', kind: 'display', category: 'ASTRA', name: 'Wetter', icon: 'weather', description: 'Aktuelles Wetter von ASTRA', options: [] },
    { type: 'info.next-event', kind: 'display', category: 'ASTRA', name: 'Nächster Termin', icon: 'calendar', description: 'Nächster Kalendereintrag von ASTRA', options: [] },
    { type: 'info.astra', kind: 'display', category: 'ASTRA', name: 'ASTRA-Status', icon: 'astra', description: 'Verbindung zu ASTRA', options: [] },
    { type: 'info.update', kind: 'display', category: 'System', name: 'Updates', icon: 'update', description: 'Version und Update-Status', options: [] },
    { type: 'mqtt.value', kind: 'display', category: 'Verknüpfungen', name: 'MQTT-Wert', icon: 'mqtt', description: 'Beliebiger Wert aus einem MQTT-Topic (z. B. Home Assistant)', options: [{ key: 'label', label: 'Name', type: 'text', default: 'Wert' }, { key: 'topic', label: 'Topic', type: 'text', default: '' }, { key: 'jsonPath', label: 'JSON-Feld (optional)', type: 'text', default: '' }, { key: 'unit', label: 'Einheit', type: 'text', default: '' }, { key: 'icon', label: 'Symbol', type: 'icon', default: 'mqtt' }] },
    { type: 'action.sleep', kind: 'button', category: 'Steuerung', name: 'Ruhezustand', icon: 'sleep', description: 'Bildschirm schwarz, Apps pausieren', options: [] },
    { type: 'action.theme', kind: 'button', category: 'Steuerung', name: 'Design', icon: 'theme', description: 'Dunkel, Hell, Automatisch', options: [] },
    { type: 'action.reload', kind: 'button', category: 'Steuerung', name: 'Neu laden', icon: 'reload', description: 'Aktuelle App neu laden', options: [] },
    { type: 'action.voice', kind: 'button', category: 'Steuerung', name: 'Sprechen', icon: 'mic', description: 'Sprachsteuerung (GEV: Gemini, sonst ASTRA)', options: [] },
    { type: 'action.performance', kind: 'button', category: 'Steuerung', name: 'Leistung', icon: 'bolt', description: 'Eco, Ausgewogen, Maximal', options: [] },
    { type: 'action.volume', kind: 'button', category: 'Steuerung', name: 'Lautstärke', icon: 'volume', description: 'Tippen: stumm; groß: Regler', options: [{ key: 'step', label: 'Schritt', type: 'number', default: 10 }] },
    { type: 'action.brightness', kind: 'button', category: 'Steuerung', name: 'Helligkeit', icon: 'brightness', description: 'Displayhelligkeit per DDC/CI', options: [{ key: 'step', label: 'Schritt', type: 'number', default: 10 }] },
    { type: 'action.app', kind: 'button', category: 'Steuerung', name: 'App öffnen', icon: 'grid', description: 'Schnellstart einer App', options: [{ key: 'app', label: 'App', type: 'app', default: 'board' }] },
    { type: 'action.astra', kind: 'button', category: 'ASTRA', name: 'ASTRA-Auftrag', icon: 'astra', description: 'Fester Auftrag an ASTRA, z. B. „Briefing“', options: [{ key: 'label', label: 'Name', type: 'text', default: 'Briefing' }, { key: 'prompt', label: 'Auftrag', type: 'text', default: 'Gib mir ein kurzes Briefing für heute.' }, { key: 'icon', label: 'Symbol', type: 'icon', default: 'astra' }] },
    { type: 'action.mqtt', kind: 'button', category: 'Verknüpfungen', name: 'HA-Auslöser', icon: 'mqtt', description: 'Erscheint in Home Assistant als Geräte-Auslöser für Automationen', options: [{ key: 'label', label: 'Name', type: 'text', default: 'Szene' }, { key: 'name', label: 'Auslöser-ID', type: 'text', default: 'szene_1' }, { key: 'payload', label: 'Payload', type: 'text', default: 'press' }, { key: 'icon', label: 'Symbol', type: 'icon', default: 'bolt' }] },
    { type: 'action.webhook', kind: 'button', category: 'Verknüpfungen', name: 'Webhook', icon: 'link', description: 'HTTP-Aufruf, z. B. an n8n oder Home Assistant', options: [{ key: 'label', label: 'Name', type: 'text', default: 'Webhook' }, { key: 'url', label: 'URL', type: 'text', default: '' }, { key: 'method', label: 'Methode', type: 'select', default: 'POST', options: [['POST', 'POST'], ['GET', 'GET'], ['PUT', 'PUT']] }, { key: 'body', label: 'Body (JSON)', type: 'text', default: '' }, { key: 'icon', label: 'Symbol', type: 'icon', default: 'link' }] },
  ];
  const byType = Object.fromEntries(catalog.map(entry => [entry.type, entry]));
  const categories = [...new Set(catalog.map(entry => entry.category))];

  const defaults = type => Object.fromEntries((byType[type]?.options || []).map(option => [option.key, option.default]));
  const create = type => ({ id: 'w' + Math.random().toString(36).slice(2, 9), type, options: defaults(type) });
  const optionsOf = item => ({ ...defaults(item.type), ...(item.options || {}) });
  const sizeFor = count => count <= 1 ? 'full' : count === 2 ? 'half' : 'quarter';

  const ring = (value, cls) => {
    const v = Math.max(0, Math.min(100, value ?? 0)), r = 15, c = 2 * Math.PI * r;
    return `<svg class="ring ${cls}" viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="${r}"/><circle class="bar" cx="18" cy="18" r="${r}" stroke-dasharray="${(v / 100) * c} ${c}"/></svg>`;
  };
  const spark = (values = []) => {
    const list = values.filter(Number.isFinite).slice(-40);
    if (list.length < 2) return '<svg class="spark" viewBox="0 0 100 30"></svg>';
    const max = Math.max(100, ...list), step = 100 / (list.length - 1);
    const points = list.map((v, i) => `${(i * step).toFixed(1)},${(30 - (v / max) * 28 - 1).toFixed(1)}`).join(' ');
    return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none"><polyline points="${points}"/></svg>`;
  };
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const kb = value => !Number.isFinite(value) ? '–' : value >= 1024 ? (value / 1024).toFixed(1) + ' MB/s' : Math.round(value) + ' kB/s';
  const time = (date, seconds) => date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  const pickJson = (raw, path) => {
    if (!path) return raw;
    try { return path.split('.').reduce((value, key) => value?.[key], JSON.parse(raw)); } catch { return raw; }
  };
  const CONDITION_ICON = { clear: 'sun', partly: 'weather', cloudy: 'weather', fog: 'weather', drizzle: 'weather', rain: 'weather', snow: 'snow', sleet: 'snow', thunder: 'bolt', wind: 'weather' };

  // Returns { html, cls } for the item's current view.
  function view(item, ctx) {
    const options = optionsOf(item), entry = byType[item.type] || { name: item.type, icon: 'info' };
    const m = ctx.metrics || {}, s = ctx.state || {};
    const metricView = (label, icon, value, text, history) => {
      const cls = level(value, options);
      if (options.style === 'spark') return { cls: 'metric ' + cls, html: `<div class="head">${ICON(icon)}<b>${text}</b></div>${spark(history)}<span class="label">${label}</span>` };
      if (options.style === 'number') return { cls: 'metric number ' + cls, html: `${ICON(icon)}<b>${text}</b><span class="label">${label}</span>` };
      return { cls: 'metric ' + cls, html: `<div class="ringwrap">${ring(value, cls)}${ICON(icon)}</div><b>${text}</b><span class="label">${label}</span>` };
    };
    switch (item.type) {
      case 'metric.cpu': { const v = pct(m.cpu?.pct); return metricView('CPU', 'cpu', v, v == null ? '–' : v + ' %', m.history?.cpu); }
      case 'metric.gpu': { const v = pct(m.gpu?.pct); return metricView(m.gpu?.source === 'freq' ? 'GPU-Takt' : 'GPU', 'gpu', v, v == null ? '–' : v + ' %', m.history?.gpu); }
      case 'metric.ram': { const v = pct(m.ram?.pct); return metricView('RAM', 'ram', v, v == null ? '–' : v + ' %', m.history?.ram); }
      case 'metric.temp': { const v = pct(m.temp?.c); return metricView('Temp.', 'temp', v, v == null ? '–' : v + '°', m.history?.temp); }
      case 'metric.disk': { const v = pct(m.disk?.pct); return metricView('Platte', 'disk', v, v == null ? '–' : v + ' %', null); }
      case 'metric.net': {
        if (options.style === 'spark') return { cls: 'metric', html: `<div class="head">${ICON('net')}<b>${kb(m.net?.rxKBs)}</b></div>${spark(m.history?.net)}<span class="label">Netz ↓</span>` };
        return { cls: 'metric number', html: `${ICON('net')}<b>${kb(m.net?.rxKBs)}</b><span class="label">↑ ${kb(m.net?.txKBs)}</span>` };
      }
      case 'metric.app': {
        const apps = (s.apps || []).filter(app => app.lifecycle !== 'terminated');
        const app = options.app ? apps.find(a => a.id === options.app) : [...apps].sort((a, b) => (b.cpu || 0) - (a.cpu || 0))[0];
        if (!app) return { cls: 'metric number', html: `${ICON('gauge')}<b>–</b><span class="label">Apps</span>` };
        return { cls: 'metric number ' + level(app.cpu, options, 50, 80), html: `${ICON(app.icon || 'web')}<b>${pct(app.cpu) ?? 0} %</b><span class="label">${esc(app.name)}</span>` };
      }
      case 'info.clock': { const now = new Date(); return { cls: 'info clock', html: `<b>${time(now, options.seconds === 'yes')}</b><span class="label">${now.toLocaleDateString('de-DE', { weekday: 'short' })}</span>` }; }
      case 'info.date': { const now = new Date(); return { cls: 'info', html: `<b>${now.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' })}</b><span class="label">${now.toLocaleDateString('de-DE', { weekday: 'long' })}</span>` }; }
      case 'info.weather': {
        const w = ctx.glance?.weather;
        if (!w) return { cls: 'info muted', html: `${ICON('weather')}<b>–</b><span class="label">Wetter</span>` };
        return { cls: 'info', html: `${ICON(CONDITION_ICON[w.now?.condition] || 'weather')}<b>${Math.round(w.now?.temp)}°</b><span class="label">${esc(w.location || w.now?.description || '')}</span>` };
      }
      case 'info.next-event': {
        const now = Date.now(), event = (ctx.glance?.calendar?.events || []).find(e => new Date(e.end || e.start).getTime() > now);
        if (!event) return { cls: 'info muted', html: `${ICON('calendar')}<b>Frei</b><span class="label">Keine Termine</span>` };
        return { cls: 'info', html: `${ICON('calendar')}<b>${event.all_day ? 'Ganztägig' : time(new Date(event.start))}</b><span class="label">${esc(event.title)}</span>` };
      }
      case 'info.astra': {
        const a = s.astra || {};
        return { cls: 'info ' + (a.connected ? 'ok' : a.configured ? 'crit' : 'muted'), html: `${ICON('astra')}<b>${a.connected ? 'Online' : a.configured ? 'Offline' : 'Aus'}</b><span class="label">ASTRA</span>` };
      }
      case 'info.update': {
        const u = s.update || {};
        return { cls: 'info ' + (u.lastResult === 'rolled-back' ? 'crit' : u.available ? 'warn' : ''), html: `${ICON('update')}<b>${esc((u.current || s.version || '–').slice(0, 7))}</b><span class="label">${u.lastResult === 'rolled-back' ? 'Zurückgerollt' : u.available ? 'Update bereit' : 'Aktuell'}</span>` };
      }
      case 'mqtt.value': {
        const raw = ctx.mqtt?.[options.topic], value = raw == null ? '–' : pickJson(raw, options.jsonPath);
        return { cls: 'info', html: `${ICON(options.icon || 'mqtt')}<b>${esc(value)}${value === '–' ? '' : esc(options.unit)}</b><span class="label">${esc(options.label)}</span>` };
      }
      case 'action.sleep': return { cls: 'button', html: `${ICON('sleep')}<span class="label">Ruhe</span>` };
      case 'action.theme': {
        const t = s.appearance?.theme || 'dark';
        return { cls: 'button', html: `${ICON(t === 'light' ? 'sun' : t === 'auto' ? 'theme' : 'moon')}<span class="label">${t === 'light' ? 'Hell' : t === 'auto' ? 'Auto' : 'Dunkel'}</span>` };
      }
      case 'action.reload': return { cls: 'button', html: `${ICON('reload')}<span class="label">Neu laden</span>` };
      case 'action.voice': return { cls: 'button' + (s.voice?.listening ? ' on' : ''), html: `${ICON(s.voice?.listening ? 'mic-off' : 'mic')}<span class="label">${s.voice?.listening ? 'Stopp' : 'Sprechen'}</span>` };
      case 'action.performance': {
        const mode = s.performance?.mode || 'balanced';
        return { cls: 'button', html: `${ICON(mode === 'eco' ? 'leaf' : mode === 'max' ? 'bolt' : 'gauge')}<span class="label">${mode === 'eco' ? 'Eco' : mode === 'max' ? 'Maximal' : 'Ausgewogen'}</span>` };
      }
      case 'action.volume': {
        const v = s.system?.volume, muted = s.system?.muted;
        return { cls: 'button stepper' + (muted ? ' off' : ''), html: `<i data-step="-1">${ICON('minus')}</i><span class="mid">${ICON(muted ? 'volume-off' : 'volume')}<span class="label">${v == null ? 'Ton' : v + ' %'}</span></span><i data-step="1">${ICON('plus')}</i>` };
      }
      case 'action.brightness': {
        const v = s.system?.brightness;
        return { cls: 'button stepper', html: `<i data-step="-1">${ICON('minus')}</i><span class="mid">${ICON('brightness')}<span class="label">${v == null ? 'Hell.' : v + ' %'}</span></span><i data-step="1">${ICON('plus')}</i>` };
      }
      case 'action.app': {
        const app = (s.apps || []).find(a => a.id === options.app);
        return { cls: 'button', html: `${ICON(app?.icon || 'grid')}<span class="label">${esc(app?.name || 'App')}</span>` };
      }
      case 'action.astra': case 'action.mqtt': case 'action.webhook':
        return { cls: 'button', html: `${ICON(options.icon || entry.icon)}<span class="label">${esc(options.label || entry.name)}</span>` };
      default: return { cls: 'info muted', html: `${ICON(entry.icon || 'info')}<span class="label">${esc(entry.name)}</span>` };
    }
  }

  // Renders a tile into `container`. ctx: { state, metrics, glance, mqtt, onAction(item, detail) }.
  function renderTile(container, tile, ctx) {
    const items = (tile.items || []).slice(0, 4);
    container.className = `ob-tile size-${sizeFor(items.length)}${items.length ? '' : ' empty'}`;
    container.dataset.tile = tile.id;
    const signature = items.map(item => item.id).join(',');
    if (container.dataset.signature !== signature) {
      container.dataset.signature = signature;
      container.replaceChildren(...items.map(item => {
        const cell = document.createElement('div');
        cell.dataset.item = item.id;
        return cell;
      }));
      if (!items.length) container.innerHTML = `<div class="placeholder">${ICON('plus')}<span class="label">Gedrückt halten</span></div>`;
    }
    for (const item of items) {
      const cell = container.querySelector(`[data-item="${item.id}"]`);
      if (!cell) continue;
      const v = view(item, ctx), entry = byType[item.type];
      const cls = `ob-w ${entry?.kind === 'button' ? 'is-button' : 'is-display'} ${v.cls}`;
      if (cell.className !== cls) cell.className = cls;
      if (cell.dataset.html !== v.html) { cell.dataset.html = v.html; cell.innerHTML = v.html; }
    }
  }

  // Tap handling: returns the action detail for a pointer target inside a tile.
  function actionFor(item, target) {
    const step = target?.closest?.('[data-step]')?.dataset.step;
    return { type: item.type, options: optionsOf(item), step: step ? Number(step) : 0 };
  }

  const css = `
  .ob-tile{position:relative;display:grid;gap:4px;padding:4px;border-radius:var(--ob-r);color:var(--ob-text);font-family:var(--ob-font)}
  .ob-tile.size-full{grid-template-columns:1fr}
  .ob-tile.size-half{grid-template-columns:1fr 1fr}
  .ob-tile.size-quarter{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
  .ob-tile.empty .placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;opacity:.5}
  .ob-w{position:relative;display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;min-height:0;border-radius:calc(var(--ob-r) - 6px);background:var(--ob-glass-pressed);padding:4px 8px;overflow:hidden;transition:transform var(--ob-dur-fast) var(--ob-ease),background var(--ob-dur-fast)}
  .ob-w.is-button:active{transform:scale(.94)}
  .ob-w .ob-icon{width:22px;height:22px}
  .ob-w b{font-weight:650;font-size:17px;font-variant-numeric:tabular-nums;white-space:nowrap}
  .ob-w .label{font-size:12px;color:var(--ob-text-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
  .size-full .ob-w,.size-half .ob-w{flex-direction:column;gap:2px}
  .size-full .ob-w.metric:not(.number){flex-direction:row;gap:10px}
  .size-full .ob-w b{font-size:22px}
  .size-quarter .ob-w{flex-direction:row;gap:5px;padding:2px 6px}
  .size-quarter .ob-w .label{display:none}
  .size-quarter .ob-w .ob-icon{width:18px;height:18px}
  .size-quarter .ob-w b{font-size:14px}
  .ob-w .ringwrap{position:relative;width:34px;height:34px;flex:none}
  .ob-w .ringwrap .ob-icon{position:absolute;inset:8px;width:18px;height:18px}
  .size-quarter .ob-w .ringwrap{width:24px;height:24px}
  .size-quarter .ob-w .ringwrap .ob-icon{inset:6px;width:12px;height:12px}
  .ring{width:100%;height:100%;transform:rotate(-90deg)}
  .ring circle{fill:none;stroke-width:3.4}
  .ring .track{stroke:var(--ob-hair)}
  .ring .bar{stroke:var(--ob-accent);stroke-linecap:round;transition:stroke-dasharray var(--ob-dur) var(--ob-ease)}
  .ring.warn .bar{stroke:var(--ob-warn)}.ring.crit .bar{stroke:var(--ob-err)}
  .ob-w.warn b{color:var(--ob-warn)}.ob-w.crit b{color:var(--ob-err)}.ob-w.ok b{color:var(--ob-ok)}
  .ob-w.muted{opacity:.6}.ob-w.off{opacity:.6}.ob-w.on{background:var(--ob-glass-selected)}
  .ob-w .head{display:flex;align-items:center;gap:6px}
  .spark{width:100%;height:22px}.spark polyline{fill:none;stroke:var(--ob-accent);stroke-width:1.6;vector-effect:non-scaling-stroke}
  .size-quarter .spark{display:none}
  .ob-w.stepper{justify-content:space-between;flex-direction:row!important;padding:0 2px}
  .ob-w.stepper i{display:grid;place-items:center;width:30px;height:100%;font-style:normal;opacity:.7}
  .ob-w.stepper .mid{display:flex;flex-direction:column;align-items:center;min-width:0}
  .size-quarter .ob-w.stepper i{width:18px}.size-quarter .ob-w.stepper i .ob-icon{width:12px;height:12px}
  .ob-w.clock b{font-size:24px}.size-quarter .ob-w.clock b{font-size:15px}
  `;

  return { catalog, byType, categories, defaults, create, optionsOf, sizeFor, view, renderTile, actionFor, css, esc };
})();
