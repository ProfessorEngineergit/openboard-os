// Card renderers for the ASTRA display protocol v1. Every renderer receives untrusted data and
// builds DOM nodes with text content only. Images are only loaded from data: (and https:, which
// the app CSP blocks unless the controller inlines them); sketches are shown as <img> data URLs.
import { h, icon, hasIcon, parseDate, fmtTime, fmtDayLabel, dayDiff, utf8ToBase64, num } from './util.js';
import { renderMarkdown } from './markdown.js';
import { renderWeather } from './weather.js';

const TYPE_ICON = { calendar: 'calendar', list: 'logs', markdown: 'sparkle', image: 'image', sketch: 'board', facts: 'info', home: 'home', alarm: 'bell' };

export function renderCard(card) {
  const type = typeof card?.type === 'string' ? card.type : 'unknown';
  const data = card?.data ?? {};
  const renderer = Object.hasOwn(RENDERERS, type) ? RENDERERS[type] : renderUnknown;
  const el = h('section', { class: `card ob-glass card-${type.replace(/[^a-z0-9-]/gi, '')}`, 'data-card-id': card?.id ?? null, 'data-type': type });
  if (type !== 'weather') {
    const title = card?.title ?? (renderer === renderUnknown ? type : null);
    if (title || card?.subtitle) {
      el.append(h('header', { class: 'card-head' },
        h('span', { class: 'card-ico' }, icon(TYPE_ICON[type] || 'info')),
        h('div', { class: 'card-titles' },
          title ? h('h3', { class: 'card-title' }, String(title)) : null,
          card?.subtitle ? h('div', { class: 'card-sub' }, String(card.subtitle)) : null)));
    }
  }
  let body;
  try { body = renderer(data, card); } catch (error) { console.warn('[astra] card render failed', type, error); body = renderUnknown(data); }
  el.append(body);
  return el;
}

const RENDERERS = {
  weather: data => renderWeather(data, { mode: 'card' }),
  calendar: data => renderEvents(Array.isArray(data?.events) ? data.events : [], { limit: 12 }),
  list: renderList,
  markdown: data => renderMarkdown(data?.text ?? '', { className: 'md card-md' }),
  image: renderImage,
  sketch: renderSketch,
  facts: data => renderFacts(Array.isArray(data?.rows) ? data.rows : []),
  home: renderHome,
  alarm: renderAlarm,
};

// --- calendar ------------------------------------------------------------------------------
export function eventTime(event) {
  const start = parseDate(event.start), end = parseDate(event.end);
  if (event.all_day || !start) return [h('b', null, 'Ganztägig')];
  return [h('b', null, fmtTime(start)), end && end > start ? h('span', null, `bis ${fmtTime(end)}`) : null];
}

export function renderEvents(events, { limit = 6, compact = false } = {}) {
  const sorted = events
    .map(event => ({ ...event, _start: parseDate(event?.start) }))
    .filter(event => event && event.title)
    .sort((a, b) => (a._start?.getTime() ?? 0) - (b._start?.getTime() ?? 0) || (b.all_day ? 1 : 0) - (a.all_day ? 1 : 0))
    .slice(0, limit);
  if (!sorted.length) return h('div', { class: 'empty' }, 'Keine Termine.');
  const root = h('div', { class: `timeline${compact ? ' compact' : ''}` });
  let lastDay = null;
  const now = new Date();
  for (const event of sorted) {
    const day = event._start ? dayDiff(event._start, now) : null;
    if (day !== lastDay) {
      root.append(h('div', { class: 'tl-day' }, event._start ? fmtDayLabel(event._start, now) : 'Ohne Datum'));
      lastDay = day;
    }
    const end = parseDate(event.end);
    const live = event._start && !event.all_day && event._start <= now && end && end > now;
    const color = /^#[0-9a-f]{3,8}$|^rgb/i.test(event.color || '') ? event.color : null;
    root.append(h('div', { class: `tl-ev${live ? ' live' : ''}${event.all_day ? ' allday' : ''}`, style: { '--ev': color } },
      h('div', { class: 'tl-time' }, eventTime(event)),
      h('div', { class: 'tl-dot' }),
      h('div', { class: 'tl-body' },
        h('div', { class: 'tl-title' }, String(event.title)),
        event.location || event.calendar ? h('div', { class: 'tl-sub' }, [event.location, event.calendar].filter(Boolean).map(String).join(' · ')) : null)));
  }
  return root;
}

// --- list ----------------------------------------------------------------------------------
function renderList(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return h('div', { class: 'empty' }, 'Keine Einträge.');
  return h('ul', { class: 'list' }, items.slice(0, 40).map(item => {
    const it = typeof item === 'object' && item ? item : { title: String(item) };
    return h('li', { class: 'list-row' },
      h('span', { class: 'list-ico' }, it.icon && hasIcon(it.icon) ? icon(it.icon) : h('i', { class: 'list-dot' })),
      h('div', { class: 'list-main' },
        h('div', { class: 'list-title' }, String(it.title ?? '')),
        it.detail ? h('div', { class: 'list-detail' }, String(it.detail)) : null),
      it.meta ? h('div', { class: 'list-meta' }, String(it.meta)) : null);
  }));
}

// --- image / sketch ------------------------------------------------------------------------
const SAFE_IMG = /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml)[;,]/i;
function renderImage(data) {
  const src = String(data?.src ?? '');
  const alt = String(data?.alt ?? '');
  const fig = h('figure', { class: 'img' });
  if (SAFE_IMG.test(src) || /^https:\/\//i.test(src)) {
    const img = h('img', { src, alt, decoding: 'async', referrerpolicy: 'no-referrer', draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'img-missing' }, icon('image'), alt || 'Bild nicht verfügbar')), { once: true });
    fig.append(img);
  } else fig.append(h('div', { class: 'img-missing' }, icon('image'), alt || 'Bild nicht verfügbar'));
  if (data?.caption) fig.append(h('figcaption', null, String(data.caption)));
  return fig;
}

function renderSketch(data) {
  const raw = String(data?.svg ?? '').trim();
  let src = null;
  if (/^data:image\/svg\+xml[;,]/i.test(raw)) src = raw;
  else if (/<svg[\s>]/i.test(raw)) {
    // Ensure the namespace so the image decoder accepts it; scripts never run inside <img>.
    const svg = /\sxmlns=/.test(raw) ? raw : raw.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    src = `data:image/svg+xml;base64,${utf8ToBase64(svg)}`;
  }
  const fig = h('figure', { class: 'sketch' });
  if (src) {
    const img = h('img', { src, alt: String(data?.alt ?? 'Skizze'), draggable: 'false' });
    img.addEventListener('error', () => img.replaceWith(h('div', { class: 'img-missing' }, icon('board'), 'Skizze konnte nicht angezeigt werden')), { once: true });
    fig.append(img);
  } else fig.append(h('div', { class: 'img-missing' }, icon('board'), 'Keine Skizze'));
  if (data?.caption) fig.append(h('figcaption', null, String(data.caption)));
  return fig;
}

// --- facts / unknown -----------------------------------------------------------------------
export function renderFacts(rows) {
  if (!rows.length) return h('div', { class: 'empty' }, 'Keine Angaben.');
  return h('dl', { class: 'facts' }, rows.slice(0, 40).map(row => h('div', { class: 'fact' },
    h('dt', null, String(row?.label ?? '')),
    h('dd', null, valueText(row?.value)))));
}

function valueText(value) {
  if (value == null) return '–';
  if (typeof value === 'number') return num(value, 2);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (typeof value === 'string') return value;
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

function renderUnknown(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return renderFacts(Object.entries(data).map(([label, value]) => ({ label, value })));
  }
  return renderFacts([{ label: 'Inhalt', value: data }]);
}

// --- home ----------------------------------------------------------------------------------
const STATE_LABEL = {
  on: 'An', off: 'Aus', open: 'Offen', opening: 'Öffnet', closed: 'Geschlossen', closing: 'Schließt',
  locked: 'Verriegelt', unlocked: 'Entriegelt', unavailable: 'Nicht verfügbar', unknown: 'Unbekannt',
  home: 'Zuhause', not_home: 'Abwesend', playing: 'Spielt', paused: 'Pausiert', idle: 'Bereit', standby: 'Standby',
  heat: 'Heizen', cool: 'Kühlen', auto: 'Automatik', heat_cool: 'Automatik', dry: 'Entfeuchten', fan_only: 'Lüften',
  detected: 'Erkannt', clear: 'Frei', armed_away: 'Scharf', disarmed: 'Unscharf',
};
const ACTIVE = new Set(['on', 'open', 'opening', 'unlocked', 'playing', 'heat', 'cool', 'auto', 'heat_cool', 'home', 'detected', 'armed_away']);
const DOMAIN_ICON = {
  light: 'bulb', switch: 'plug', sensor: 'gauge', binary_sensor: 'info', lock: 'lock', climate: 'thermo', cover: 'blinds',
  fan: 'fan', media_player: 'media', person: 'person', device_tracker: 'person', door: 'door', weather: 'weather', alarm_control_panel: 'lock',
};

function renderHome(data) {
  const entities = Array.isArray(data?.entities) ? data.entities : [];
  if (!entities.length) return h('div', { class: 'empty' }, 'Keine Geräte.');
  return h('div', { class: 'home' }, entities.slice(0, 24).map(entity => {
    const domain = String(entity?.domain ?? '');
    const state = String(entity?.state ?? '');
    const active = ACTIVE.has(state);
    const numeric = state !== '' && Number.isFinite(Number(state));
    const label = numeric ? num(Number(state), 1) : (STATE_LABEL[state] ?? state);
    const name = domain === 'lock' ? (state === 'unlocked' ? 'unlock' : 'lock') : (DOMAIN_ICON[domain] || 'home');
    return h('div', { class: `ent${active ? ' on' : ''} dom-${domain.replace(/[^a-z_]/g, '')}` },
      h('span', { class: 'ent-ico' }, icon(name)),
      h('div', { class: 'ent-name' }, String(entity?.name ?? domain)),
      h('div', { class: 'ent-state' }, label, entity?.unit ? h('small', null, ` ${String(entity.unit)}`) : null));
  }));
}

// --- alarm ---------------------------------------------------------------------------------
function renderAlarm(data) {
  const at = parseDate(data?.at);
  return h('div', { class: 'alarm-card' },
    h('span', { class: 'alarm-card-ico' }, icon('bell')),
    h('div', null,
      h('div', { class: 'alarm-card-time' }, at ? fmtTime(at) : '–'),
      h('div', { class: 'alarm-card-sub' }, [at ? fmtDayLabel(at) : null, data?.label ? String(data.label) : null].filter(Boolean).join(' · '))));
}
