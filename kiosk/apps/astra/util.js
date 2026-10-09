// Small DOM and formatting helpers for the Astra app.
// Untrusted strings only ever reach the DOM through text nodes or attributes; markup strings
// passed to `trusted()` are constants defined in this app or in /ui/icons.js.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) if (v != null) el.style.setProperty(prop, String(v));
    } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const template = document.createElement('template');
export function trusted(markup) {
  template.innerHTML = markup;
  return template.content.firstElementChild.cloneNode(true);
}

// Extra stroke icons in the OBIcons style (24×24, round caps) used by cards.
const EXTRA = {
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.3 1 2.2h5.2c0-.9.4-1.7 1-2.2A6 6 0 0 0 12 3Z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.7-1.5"/>',
  plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4"/>',
  thermo: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0Z"/><path d="M12 9v7"/>',
  blinds: '<path d="M4 4h16M5 4v13M19 4v13M5 8h14M5 12h14M5 16h14M12 17v3"/>',
  fan: '<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4C11 6 13 3 15.5 4.2 17.6 5.3 16 9 13.4 11M13.6 12c4.3-.9 7.3 1.1 6.1 3.6-1.1 2.1-4.8.5-6.8-2.1M11 13.4c-.9 4.4-3.9 6.4-5.4 4.4-1.5-2 .4-5.3 4-6.2"/>',
  media: '<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8 21h8M10.5 8.5v5l4-2.5-4-2.5Z"/>',
  door: '<path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21M4 21h16M14.5 12.5h.01"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  sparkle: '<path d="M12 3.5 13.9 9 19.5 11 13.9 13 12 18.5 10.1 13 4.5 11 10.1 9Z"/>',
  send: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none"/>',
  location: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  dot: '<circle cx="12" cy="12" r="3.5" fill="currentColor"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/><path d="M12 8v4l3 2"/>',
};

export function icon(name, cls = '') {
  const paths = (globalThis.OBIcons?.paths?.[name]) || EXTRA[name] || EXTRA.dot;
  const el = trusted(`<svg class="ob-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`);
  if (cls) el.classList.add(...cls.split(/\s+/).filter(Boolean));
  return el;
}
export const hasIcon = name => Boolean(globalThis.OBIcons?.paths?.[name] || EXTRA[name]);

// --- Formatting (German) ---------------------------------------------------------------------
const LOCALE = 'de-DE';
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const dateLongFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
const weekdayShortFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });
const weekdayLongFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'long' });
const dayMonthFmt = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });

export const fmtTime = date => timeFmt.format(date);
export const fmtDateLong = date => dateLongFmt.format(date);
export const fmtWeekdayShort = date => weekdayShortFmt.format(date).replace('.', '');

// Accepts ISO date-times and plain dates ("2026-10-10" is local midnight, not UTC).
export function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  if (typeof value === 'number') return new Date(value < 1e12 ? value * 1000 : value);
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (plain) return new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]));
  const date = new Date(String(value));
  return isNaN(date) ? null : date;
}

const startOfDay = date => new Date(date.getFullYear(), date.getMonth(), date.getDate());
export function dayDiff(date, now = new Date()) {
  return Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
}
export function fmtDayLabel(date, now = new Date()) {
  const diff = dayDiff(date, now);
  if (diff === 0) return 'Heute';
  if (diff === 1) return 'Morgen';
  if (diff === -1) return 'Gestern';
  if (diff > 1 && diff < 7) return weekdayLongFmt.format(date);
  return dayMonthFmt.format(date);
}

export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  return hour < 5 ? 'Gute Nacht' : hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend';
}

export const num = (value, digits = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(LOCALE, { maximumFractionDigits: digits }) : '–';
};
export const deg = value => (Number.isFinite(Number(value)) ? `${Math.round(Number(value))}°` : '–');

// --- Encoding ---------------------------------------------------------------------------------
export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function base64ToBytes(b64) {
  const binary = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
export const utf8ToBase64 = text => bytesToBase64(new TextEncoder().encode(String(text)));

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
