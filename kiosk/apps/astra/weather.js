// iOS-Weather-style panel for WeatherData (see docs/ARCHITECTURE.md, Card "weather").
import { h, trusted, parseDate, fmtWeekdayShort, dayDiff, deg, num, icon, clamp } from './util.js';

export const CONDITION_LABEL = {
  clear: ['Sonnig', 'Klar'], partly: ['Teilweise bewölkt', 'Teilweise bewölkt'], cloudy: ['Bewölkt', 'Bewölkt'],
  fog: ['Nebel', 'Nebel'], drizzle: ['Nieselregen', 'Nieselregen'], rain: ['Regen', 'Regen'], snow: ['Schnee', 'Schnee'],
  sleet: ['Schneeregen', 'Schneeregen'], thunder: ['Gewitter', 'Gewitter'], wind: ['Windig', 'Windig'],
};
const KNOWN = new Set(Object.keys(CONDITION_LABEL));
const norm = condition => (KNOWN.has(condition) ? condition : 'cloudy');
export const conditionLabel = (condition, isDay = true) => CONDITION_LABEL[norm(condition)][isDay ? 0 : 1];

// Sky gradients per condition and day/night: [top, bottom, glow].
const SKY = {
  clear: { day: ['#1f6fd1', '#5ea7ec', 'rgba(255,230,150,.45)'], night: ['#050b1f', '#1a2a52', 'rgba(140,170,255,.18)'] },
  partly: { day: ['#3a74b8', '#7eaedd', 'rgba(255,236,170,.30)'], night: ['#0a1124', '#25365a', 'rgba(150,170,230,.14)'] },
  cloudy: { day: ['#4f6178', '#8494a8', 'rgba(255,255,255,.14)'], night: ['#11151d', '#2c3441', 'rgba(170,180,200,.10)'] },
  fog: { day: ['#6f7a85', '#a3abb3', 'rgba(255,255,255,.22)'], night: ['#1a1d22', '#3a3f47', 'rgba(200,205,215,.10)'] },
  drizzle: { day: ['#41566b', '#71879b', 'rgba(170,210,255,.16)'], night: ['#0c121a', '#25313f', 'rgba(120,160,220,.12)'] },
  rain: { day: ['#33475b', '#5f7489', 'rgba(140,190,255,.18)'], night: ['#090e15', '#1f2b39', 'rgba(110,150,220,.12)'] },
  snow: { day: ['#5d7894', '#9fb4ca', 'rgba(255,255,255,.30)'], night: ['#141b26', '#344358', 'rgba(220,230,255,.14)'] },
  sleet: { day: ['#4b5e72', '#8193a6', 'rgba(220,235,255,.18)'], night: ['#10161f', '#2b3646', 'rgba(170,190,230,.12)'] },
  thunder: { day: ['#262a3d', '#4d5370', 'rgba(255,214,120,.16)'], night: ['#08090f', '#23263a', 'rgba(255,200,110,.10)'] },
  wind: { day: ['#3d6c96', '#7ea3c4', 'rgba(255,255,255,.18)'], night: ['#0b1424', '#26385a', 'rgba(160,190,240,.12)'] },
};
export function skyStyle(condition, isDay) {
  const [top, bottom, glow] = SKY[norm(condition)][isDay ? 'day' : 'night'];
  return `radial-gradient(120% 70% at 85% -10%, ${glow}, transparent 60%), linear-gradient(180deg, ${top}, ${bottom})`;
}

// --- Icons (64×64, multicolour like iOS) --------------------------------------------------------
const CLOUD = 'M19 46h27a10 10 0 0 0 0-20h-.6A14 14 0 0 0 19.5 27 9.5 9.5 0 0 0 19 46Z';
const SUN = (cx, cy, r) => {
  let rays = '';
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4, c = Math.cos(a), s = Math.sin(a);
    rays += `M${(cx + c * (r + 4)).toFixed(1)} ${(cy + s * (r + 4)).toFixed(1)}L${(cx + c * (r + 9)).toFixed(1)} ${(cy + s * (r + 9)).toFixed(1)}`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffd43b"/><path d="${rays}" stroke="#ffd43b" stroke-width="3.6" stroke-linecap="round"/>`;
};
const MOON = (dx = 0, dy = 0, s = 1) => `<path transform="translate(${dx} ${dy}) scale(${s})" d="M40 12a17 17 0 1 0 14 26.6A14.5 14.5 0 0 1 40 12Z" fill="#e8edf7"/>`;
const cloud = (fill = '#f4f7fb', dx = 0, dy = 0, s = 1) => `<path transform="translate(${dx} ${dy}) scale(${s})" d="${CLOUD}" fill="${fill}"/>`;
const drops = (color = '#5ac8fa', n = 3, len = 7) => {
  let d = '';
  for (let k = 0; k < n; k++) { const x = 24 + k * 9; d += `M${x} 51l-2.5 ${len}`; }
  return `<path d="${d}" stroke="${color}" stroke-width="3.4" stroke-linecap="round"/>`;
};
const flakes = (color = '#ffffff') => [22, 33, 44].map((x, k) => `<circle cx="${x}" cy="${54 + (k % 2) * 4}" r="2.6" fill="${color}"/>`).join('');

export function weatherIconSvg(condition, isDay = true) {
  const c = norm(condition);
  let body;
  switch (c) {
    case 'clear': body = isDay ? SUN(32, 32, 12) : MOON(-4, 0, 1.08); break;
    case 'partly': body = (isDay ? SUN(23, 22, 9) : MOON(-14, -8, 0.8)) + cloud('#f4f7fb', 4, 6, 0.92); break;
    case 'cloudy': body = cloud('#c9d2de', 8, -2, 0.8) + cloud('#f4f7fb', -2, 4, 1); break;
    case 'fog': body = cloud('#dfe5ec', 0, -6, 0.95) + '<path d="M12 46h40M16 53h34M12 60h30" stroke="#dfe5ec" stroke-width="3.6" stroke-linecap="round"/>'; break;
    case 'drizzle': body = cloud('#eef2f7', 0, -6) + '<path d="M24 50v.01M33 54v.01M42 50v.01M28 59v.01M38 61v.01" stroke="#5ac8fa" stroke-width="4" stroke-linecap="round"/>'; break;
    case 'rain': body = cloud('#eef2f7', 0, -6) + drops('#5ac8fa', 3, 9); break;
    case 'snow': body = cloud('#f4f7fb', 0, -6) + flakes(); break;
    case 'sleet': body = cloud('#eef2f7', 0, -6) + '<path d="M24 50l-2.5 8M42 50l-2.5 8" stroke="#5ac8fa" stroke-width="3.4" stroke-linecap="round"/><circle cx="33" cy="56" r="2.6" fill="#fff"/>'; break;
    case 'thunder': body = cloud('#c3cad6', 0, -8) + '<path d="M34 38 25 52h7l-3 10 11-15h-7l3-9Z" fill="#ffd43b"/>'; break;
    case 'wind': body = '<path d="M8 26h30a6 6 0 1 0-6-6M8 36h42a6 6 0 1 1-6 6M8 46h22" stroke="#eef2f7" stroke-width="3.8" stroke-linecap="round" fill="none"/>'; break;
  }
  return `<svg class="wx-icon" viewBox="0 0 64 64" aria-hidden="true">${body}</svg>`;
}
export const weatherIcon = (condition, isDay) => trusted(weatherIconSvg(condition, isDay));

// Temperature → colour for the min/max range bars (iOS style).
const STOPS = [[-15, [94, 92, 230]], [-5, [90, 160, 255]], [5, [100, 210, 220]], [12, [140, 220, 120]], [18, [250, 215, 70]], [25, [255, 155, 60]], [33, [255, 80, 60]]];
export function tempColor(t) {
  if (!Number.isFinite(t)) return 'rgb(200,200,200)';
  if (t <= STOPS[0][0]) return `rgb(${STOPS[0][1]})`;
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i];
    if (t <= t1) {
      const [t0, c0] = STOPS[i - 1], k = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`;
    }
  }
  return `rgb(${STOPS.at(-1)[1]})`;
}

// --- Panel ---------------------------------------------------------------------------------
// mode: 'glance' (large: 12 hours, 7 days) or 'card' (compact: 8 hours, 5 days)
export function renderWeather(data, { mode = 'card' } = {}) {
  const now = data?.now || {};
  const isDay = now.is_day !== false;
  const condition = norm(now.condition);
  const hourly = Array.isArray(data?.hourly) ? data.hourly : [];
  const daily = Array.isArray(data?.daily) ? data.daily : [];
  const compact = mode !== 'glance';
  const panel = h('div', { class: `wx wx-${mode} wx-${condition}${isDay ? ' day' : ' night'}`, style: { background: skyStyle(condition, isDay) } });

  const description = now.description || conditionLabel(condition, isDay);
  const location = h('div', { class: 'wx-loc' }, icon('location'), String(data?.location || 'Wetter'));
  if (compact) panel.append(location);
  panel.append(h('div', { class: 'wx-head' },
    h('div', { class: 'wx-now' },
      weatherIcon(condition, isDay),
      h('div', { class: 'wx-temp' }, deg(now.temp))),
    h('div', { class: 'wx-meta' },
      compact ? null : location,
      h('div', { class: 'wx-desc' }, description),
      h('div', { class: 'wx-hl' }, `H: ${deg(now.high ?? daily[0]?.max)}  T: ${deg(now.low ?? daily[0]?.min)}`),
      compact ? null : h('div', { class: 'wx-extra' },
        Number.isFinite(Number(now.feels_like)) ? `Gefühlt ${deg(now.feels_like)}` : null,
        Number.isFinite(Number(now.wind_kmh)) ? h('span', null, ` · Wind ${num(now.wind_kmh)} km/h`) : null,
        Number.isFinite(Number(now.humidity)) ? h('span', null, ` · ${num(now.humidity)} %`) : null))));

  const hours = hourly.slice(0, compact ? 6 : 12);
  if (hours.length) {
    panel.append(h('div', { class: 'wx-section wx-hourly', style: { '--n': hours.length } },
      hours.map((hour, index) => {
        const time = parseDate(hour.time);
        const pop = Number(hour.pop);
        return h('div', { class: 'wx-hour' },
          h('div', { class: 'wx-hour-t' }, index === 0 ? 'Jetzt' : time ? (compact ? `${time.getHours()} Uhr` : String(time.getHours())) : '–'),
          h('div', { class: 'wx-hour-i' }, weatherIcon(hour.condition, hour.is_day !== false),
            pop >= 20 ? h('span', { class: 'wx-pop' }, `${Math.round(pop)} %`) : null),
          h('div', { class: 'wx-hour-v' }, deg(hour.temp)));
      })));
  }

  const days = daily.slice(0, compact ? 5 : 7);
  if (days.length) {
    const mins = days.map(d => Number(d.min)).filter(Number.isFinite);
    const maxs = days.map(d => Number(d.max)).filter(Number.isFinite);
    const lo = Math.min(...mins), hi = Math.max(...maxs), span = Math.max(1, hi - lo);
    const list = h('div', { class: 'wx-section wx-daily' },
      compact ? null : h('div', { class: 'wx-section-title' }, icon('calendar'), `${days.length}-Tage-Vorhersage`));
    days.forEach((day, index) => {
      const date = parseDate(day.date);
      const min = Number(day.min), max = Number(day.max);
      const left = clamp((min - lo) / span, 0, 1) * 100, right = clamp((max - lo) / span, 0, 1) * 100;
      const bar = h('div', { class: 'wx-bar' }, h('i', {
        style: { left: `${left}%`, width: `${Math.max(4, right - left)}%`, background: `linear-gradient(90deg, ${tempColor(min)}, ${tempColor(max)})` },
      }));
      if (index === 0 && Number.isFinite(Number(now.temp))) {
        bar.append(h('b', { class: 'wx-bar-now', style: { left: `${clamp((Number(now.temp) - lo) / span, 0, 1) * 100}%` } }));
      }
      const pop = Number(day.pop);
      list.append(h('div', { class: 'wx-day' },
        h('div', { class: 'wx-day-n' }, date ? (dayDiff(date) === 0 ? 'Heute' : fmtWeekdayShort(date)) : '–'),
        h('div', { class: 'wx-day-i' }, weatherIcon(day.condition, true), pop >= 20 ? h('span', { class: 'wx-pop' }, `${Math.round(pop)} %`) : null),
        h('div', { class: 'wx-day-min' }, deg(min)),
        bar,
        h('div', { class: 'wx-day-max' }, deg(max))));
    });
    panel.append(list);
  }
  return panel;
}
