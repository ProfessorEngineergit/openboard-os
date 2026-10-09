#!/usr/bin/env node
// Mock of the ASTRA display API v1 (see docs/ARCHITECTURE.md, "ASTRA-Display-Protokoll v1").
// Standalone, no dependencies, Node >= 22.
//
//   node scripts/dev/mock-astra.mjs [--port 18088] [--host 127.0.0.1] [--token dev] [--delay 350] [--quiet]
//
// Endpoints (all require "Authorization: Bearer <token>" except GET /health):
//   GET  /display/v1/hello    {name, version, capabilities}
//   POST /display/v1/message  text or 16 kHz WAV audio → German reply + 1–3 cards picked by keywords
//                             (wetter, kalender/termin/heute, zeichne/skizze, bild/foto, liste/einkauf,
//                             fakten, licht/haus/zuhause, wecker, erkläre/rezept, "alle karten"/demo).
//                             "#fail" in the text → HTTP 500, "#slow" → 4 s delay.
//   GET  /display/v1/glance   greeting, WeatherData, calendar, briefing, alarms
//   POST /display/v1/tts      {text} → {mime: "audio/wav", b64} (generated tone, not real speech)
//   GET  /display/v1/events   SSE: hello on connect, ping every 20 s, plus anything pushed below
//   POST /mock/push           {type, data} → broadcast to all SSE clients → {ok, clients}
//   GET  /mock/requests       last 50 requests (method, path, auth, body summary) for end-to-end tests
//   DELETE /mock/requests     clear that log
import http from 'node:http';
import { deflateSync, crc32 } from 'node:zlib';

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 18088);
const HOST = args.host ?? '127.0.0.1';
const TOKEN = String(args.token ?? 'dev');
const DELAY = Number(args.delay ?? 350);
const QUIET = Boolean(args.quiet);
const VERSION = '1.0.0-mock';

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(list[i]);
    if (!match) continue;
    if (match[2] !== undefined) out[match[1]] = match[2];
    else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) out[match[1]] = list[++i];
    else out[match[1]] = true;
  }
  return out;
}

const log = (...parts) => { if (!QUIET) console.log(new Date().toISOString().slice(11, 19), ...parts); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------------------------

function wav(samples, rate = 16000) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// A soft, speech-like murmur: a gliding tone with syllable-shaped amplitude.
function speechTone(text) {
  const rate = 16000;
  const seconds = Math.min(4, Math.max(0.6, String(text).length * 0.045));
  const n = Math.round(rate * seconds);
  const samples = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const freq = 190 + 35 * Math.sin(t * 2.1) + 18 * Math.sin(t * 7.3);
    phase += (2 * Math.PI * freq) / rate;
    const syllable = Math.pow(Math.max(0, Math.sin(t * Math.PI * 4.2)), 0.6);
    const edge = Math.min(1, t / 0.05, (seconds - t) / 0.08);
    samples[i] = 0.22 * edge * syllable * (Math.sin(phase) + 0.35 * Math.sin(phase * 2) + 0.15 * Math.sin(phase * 3));
  }
  return { mime: 'audio/wav', b64: wav(samples, rate).toString('base64') };
}

function wavInfo(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12, rate = 0, channels = 0, bits = 0, dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') { channels = buffer.readUInt16LE(offset + 10); rate = buffer.readUInt32LE(offset + 12); bits = buffer.readUInt16LE(offset + 22); }
    if (id === 'data') { dataBytes = Math.min(size, buffer.length - offset - 8); break; }
    offset += 8 + size + (size % 2);
  }
  if (!rate || !channels || !bits) return null;
  return { rate, channels, bits, seconds: dataBytes / (rate * channels * (bits / 8)) };
}

// ---------------------------------------------------------------------------------------------
// Image helpers (PNG encoder for a procedurally drawn landscape)
// ---------------------------------------------------------------------------------------------

function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

let cachedImage = null;
function landscapeDataUrl() {
  if (cachedImage) return cachedImage;
  const W = 640, H = 400;
  const mix = (a, b, t) => a + (b - a) * t;
  const ridge = (x, base, amp, f1, f2) => base + amp * (Math.sin(x * f1) * 0.6 + Math.sin(x * f2 + 1.3) * 0.4);
  cachedImage = 'data:image/png;base64,' + png(W, H, (x, y) => {
    const t = y / H;
    let r = mix(32, 255, t ** 1.6), g = mix(48, 170, t ** 1.8), b = mix(110, 120, t);
    const dx = x - W * 0.62, dy = y - H * 0.58, d = Math.sqrt(dx * dx + dy * dy);
    if (d < 46) { r = 255; g = 214; b = 150; } else if (d < 140) { const k = (1 - (d - 46) / 94) ** 2 * 0.55; r = mix(r, 255, k); g = mix(g, 200, k); b = mix(b, 140, k); }
    if (y > ridge(x, H * 0.62, 26, 0.012, 0.031)) { r = 92; g = 70; b = 110; }
    if (y > ridge(x, H * 0.72, 22, 0.017, 0.043)) { r = 58; g = 44; b = 80; }
    if (y > ridge(x, H * 0.84, 14, 0.023, 0.051)) { r = 30; g = 24; b = 46; }
    return [r | 0, g | 0, b | 0];
  }).toString('base64');
  return cachedImage;
}

const SKETCH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320" width="480" height="320">
  <g fill="none" stroke="#1d2433" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M30 270 C 120 262, 360 262, 450 272"/>
    <path d="M110 268 L110 160 L190 96 L270 160 L270 268"/>
    <path d="M96 172 L190 90 L284 172" stroke="#d9480f"/>
    <rect x="168" y="200" width="44" height="68" rx="4"/>
    <rect x="128" y="176" width="30" height="30" rx="3" stroke="#1c7ed6"/>
    <rect x="222" y="176" width="30" height="30" rx="3" stroke="#1c7ed6"/>
    <circle cx="380" cy="80" r="34" stroke="#f08c00"/>
    <path d="M380 28v-14M380 146v-14M328 80h-14M446 80h-14M343 43l-10-10M427 127l-10-10M343 117l-10 10M427 33l-10 10" stroke="#f08c00"/>
    <path d="M330 268 C 330 230, 350 210, 360 200 C 370 210, 392 232, 390 268" stroke="#2b8a3e"/>
    <path d="M360 268 L360 220" stroke="#2b8a3e"/>
  </g>
  <text x="240" y="306" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#495057">Haus mit Sonne</text>
</svg>`;

// ---------------------------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------------------------

const CONDITIONS = ['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'snow', 'sleet', 'thunder', 'wind'];

function weatherData(location = 'Frankfurt am Main', forceCondition) {
  const now = new Date();
  const hour = now.getHours();
  const isDay = h => h >= 7 && h < 19;
  const dayCond = ['partly', 'clear', 'cloudy', 'rain', 'drizzle', 'partly', 'clear'];
  const current = forceCondition && CONDITIONS.includes(forceCondition) ? forceCondition : dayCond[now.getDate() % dayCond.length];
  const base = 11 + 5 * Math.sin((now.getMonth() - 3) / 12 * 2 * Math.PI);
  const tempAt = h => Math.round(base + 4.5 * Math.sin(((h - 9) / 24) * 2 * Math.PI));
  const hourly = [];
  for (let i = 0; i < 24; i++) {
    const at = new Date(now); at.setMinutes(0, 0, 0); at.setHours(hour + i);
    const h = at.getHours();
    const cond = i < 4 ? current : ['partly', 'cloudy', 'drizzle', 'rain', 'cloudy', 'clear'][Math.floor(i / 4) % 6];
    hourly.push({ time: at.toISOString(), temp: tempAt(h), condition: cond, is_day: isDay(h), pop: /rain|drizzle|thunder|sleet/.test(cond) ? 40 + (i * 7) % 45 : (i * 3) % 15 });
  }
  const daily = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(now); date.setDate(now.getDate() + d);
    const cond = d === 0 ? current : dayCond[(now.getDate() + d) % dayCond.length];
    const swing = Math.round(2 * Math.sin(d * 1.3));
    daily.push({ date: date.toISOString().slice(0, 10), min: Math.round(base - 5 + swing), max: Math.round(base + 4 + swing + (d % 3)), condition: cond, pop: /rain|drizzle|thunder|sleet/.test(cond) ? 60 : 10 });
  }
  const descriptions = { clear: 'Klar', partly: 'Teilweise bewölkt', cloudy: 'Bewölkt', fog: 'Nebel', drizzle: 'Nieselregen', rain: 'Regen', snow: 'Schnee', sleet: 'Schneeregen', thunder: 'Gewitter', wind: 'Windig' };
  return {
    location, updated: now.toISOString(),
    now: { temp: tempAt(hour), feels_like: tempAt(hour) - 2, condition: current, is_day: isDay(hour), description: descriptions[current],
      humidity: 72, wind_kmh: 14, high: daily[0].max, low: daily[0].min },
    hourly, daily,
  };
}

function at(dayOffset, h, m = 0) {
  const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString();
}
function dateOnly(dayOffset) {
  const d = new Date(); d.setDate(d.getDate() + dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function calendarEvents() {
  const today = [
    { title: 'Jour fixe Talentspring Academy Group', start: at(0, 9, 30), end: at(0, 10, 15), all_day: false, location: 'Raum Rhein', calendar: 'Arbeit', color: '#6aa8ff' },
    { title: 'Mittagessen mit Lea', start: at(0, 12, 30), end: at(0, 13, 30), all_day: false, location: 'Kleinmarkthalle', calendar: 'Privat', color: '#36d399' },
    { title: 'Review Maßnahmen-Dokumentation', start: at(0, 15, 0), end: at(0, 16, 0), all_day: false, calendar: 'Arbeit', color: '#6aa8ff' },
    { title: 'Laufen am Main', start: at(0, 18, 30), end: at(0, 19, 15), all_day: false, location: 'Eiserner Steg', calendar: 'Sport', color: '#f5c451' },
    { title: 'Anruf mit Papa', start: at(0, 21, 0), end: at(0, 21, 30), all_day: false, calendar: 'Privat', color: '#36d399' },
  ].filter(event => new Date(event.end) > new Date());
  return [
    ...today,
    { title: 'Geburtstag Mama', start: dateOnly(1), end: dateOnly(2), all_day: true, calendar: 'Familie', color: '#fb7185' },
    { title: 'Zahnarzt Dr. Weber', start: at(1, 8, 15), end: at(1, 9, 0), all_day: false, location: 'Berger Straße 112', calendar: 'Privat', color: '#36d399' },
    { title: 'Workshop KI im Vertrieb', start: at(1, 10, 0), end: at(1, 12, 0), all_day: false, location: 'Akademie, Raum 2', calendar: 'Arbeit', color: '#6aa8ff' },
  ];
}

function nextAlarm() {
  const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 6 ? 1 : 0)); d.setHours(6, 45, 0, 0);
  return { id: 'alarm-morning', at: d.toISOString(), label: 'Aufstehen' };
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Gute Nacht' : h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend';
}

let cardSeq = 0;
const card = (type, data, extra = {}) => ({ id: `mock-${type}-${++cardSeq}`, type, data, ...extra });

const CARD_BUILDERS = {
  weather: () => card('weather', weatherData(), { title: 'Wetter' }),
  calendar: () => card('calendar', { events: calendarEvents() }, { title: 'Kalender', subtitle: 'Heute und morgen' }),
  sketch: () => card('sketch', { svg: SKETCH_SVG }, { title: 'Skizze', subtitle: 'Ein Haus mit Sonne' }),
  image: () => card('image', { src: landscapeDataUrl(), alt: 'Sonnenuntergang über Hügeln', caption: 'Sonnenuntergang über dem Taunus (generiert)' }, { title: 'Bild' }),
  list: () => card('list', { items: [
    { title: 'Hafermilch', detail: '2 Packungen', meta: 'Rewe', icon: 'check' },
    { title: 'Tomaten', detail: 'Rispentomaten, 500 g', meta: 'Markt' },
    { title: 'Kaffeebohnen', detail: 'Espresso, ganze Bohne', meta: 'Rösterei' },
    { title: 'Batterien AA', meta: 'Drogerie' },
  ] }, { title: 'Einkaufsliste', subtitle: '4 Einträge' }),
  facts: () => card('facts', { rows: [
    { label: 'Höhe', value: '8.849 m' }, { label: 'Erstbesteigung', value: '29. Mai 1953' },
    { label: 'Gebirge', value: 'Himalaya' }, { label: 'Lage', value: 'Nepal / China' },
  ] }, { title: 'Mount Everest' }),
  home: () => card('home', { entities: [
    { name: 'Wohnzimmer', state: 'on', domain: 'light' }, { name: 'Küche', state: 'off', domain: 'light' },
    { name: 'Temperatur innen', state: '21.4', unit: '°C', domain: 'sensor' }, { name: 'Haustür', state: 'locked', domain: 'lock' },
    { name: 'Heizung', state: 'heat', domain: 'climate' }, { name: 'Rollladen Süd', state: 'open', domain: 'cover' },
  ] }, { title: 'Zuhause' }),
  alarm: () => card('alarm', nextAlarm(), { title: 'Wecker gestellt' }),
  markdown: () => card('markdown', { text: [
    '## Shakshuka für zwei',
    'Ein schnelles Pfannengericht mit **Eiern in Tomatensauce** – perfekt für ein spätes Frühstück.',
    '',
    '### Zutaten',
    '- 1 Dose *gehackte* Tomaten',
    '- 1 Paprika, 1 Zwiebel, 2 Knoblauchzehen',
    '- 4 Eier, Kreuzkümmel, Paprikapulver',
    '',
    '### Zubereitung',
    '1. Zwiebel und Paprika in Olivenöl anschwitzen.',
    '2. Tomaten und Gewürze zugeben, `10 min` köcheln.',
    '3. Mulden formen, Eier hineingleiten lassen, abgedeckt garen.',
    '',
    '> Tipp: Mit Feta und frischem Koriander servieren. Mehr unter [chefkoch.de](https://www.chefkoch.de).',
  ].join('\n') }, { title: 'Rezept' }),
};

function buildReply(text) {
  const q = String(text || '').toLowerCase();
  const pick = new Set();
  if (/alle karten|demo/.test(q)) Object.keys(CARD_BUILDERS).forEach(type => pick.add(type));
  if (/wetter|regen|temperatur|sonne/.test(q)) pick.add('weather');
  if (/kalender|termin|heute an|steht .* an|morgen an/.test(q)) pick.add('calendar');
  if (/zeichne|skizze|mal mir/.test(q)) pick.add('sketch');
  if (/bild|foto/.test(q)) pick.add('image');
  if (/liste|einkauf/.test(q)) pick.add('list');
  if (/fakten|wie hoch|everest/.test(q)) pick.add('facts');
  if (/licht|haus|zuhause|heizung/.test(q)) pick.add('home');
  if (/wecker|weck mich/.test(q)) pick.add('alarm');
  if (/erklär|rezept|wie koche|markdown/.test(q)) pick.add('markdown');
  const cards = [...pick].map(type => CARD_BUILDERS[type]());
  const sentences = {
    weather: 'Heute wird es überwiegend freundlich mit bis zu ' + cards.find(c => c.type === 'weather')?.data.now.high + ' Grad, am Nachmittag ziehen Wolken auf.',
    calendar: 'Heute stehen noch ' + calendarEvents().filter(e => !e.all_day && new Date(e.start).toDateString() === new Date().toDateString()).length + ' Termine an, morgen hat deine Mama Geburtstag.',
    sketch: 'Hier ist eine kleine Skizze von einem Haus mit Sonne.',
    image: 'Ich habe dir ein Bild herausgesucht.',
    list: 'Auf deiner Einkaufsliste stehen vier Dinge.',
    facts: 'Der Mount Everest ist mit 8.849 Metern der höchste Berg der Erde.',
    home: 'Im Wohnzimmer brennt Licht, die Haustür ist verriegelt und die Heizung läuft.',
    alarm: 'Dein Wecker ist für morgen um 6:45 Uhr gestellt.',
    markdown: 'Shakshuka ist schnell gemacht – das Rezept habe ich dir rechts aufgeschrieben.',
  };
  let reply = [...pick].map(type => sentences[type]).filter(Boolean).join(' ');
  if (!reply) reply = q.trim()
    ? `Gute Frage! Zu „${String(text).trim().slice(0, 80)}“ kann ich als Test-ASTRA nur so viel sagen: Die Verbindung zum Display funktioniert einwandfrei.`
    : 'Ich habe dich leider nicht verstanden. Magst du es noch einmal sagen?';
  const actions = /öffne .*(whiteboard|tafel)/.test(q) ? [{ type: 'open_app', app: 'board' }] : [];
  return { reply, cards: cards.slice(0, pick.size > 3 && !/alle karten|demo/.test(q) ? 3 : cards.length), actions };
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

const clients = new Set();
const requests = [];

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function readJson(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function summarize(body) {
  if (!body || typeof body !== 'object') return body;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'audio' && value && typeof value === 'object') out.audio = { mime: value.mime, bytes: value.b64 ? Buffer.from(value.b64, 'base64').length : 0 };
    else if (typeof value === 'string' && value.length > 300) out[key] = value.slice(0, 300) + '…';
    else out[key] = value;
  }
  return out;
}

function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const res of clients) res.write(frame);
  return clients.size;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, version: VERSION });

  const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
  let body;
  try {
    if (req.method === 'POST') body = await readJson(req);
  } catch (error) { return send(res, error.status || 400, { error: error.message }); }
  if (path !== '/mock/requests') {
    requests.push({ at: new Date().toISOString(), method: req.method, path, authorized, body: summarize(body) });
    if (requests.length > 50) requests.shift();
  }
  log(req.method, path, authorized ? '' : '(unauthorized)');
  if (!authorized) return send(res, 401, { error: 'Bearer token required' }, { 'www-authenticate': 'Bearer' });

  try {
    if (req.method === 'GET' && path === '/display/v1/hello') {
      return send(res, 200, { name: 'ASTRA (Mock)', version: VERSION, capabilities: ['message', 'audio', 'glance', 'tts', 'events', 'cards', 'alarms', 'board'] });
    }

    if (req.method === 'POST' && path === '/display/v1/message') {
      const sessionId = typeof body.session_id === 'string' && body.session_id ? body.session_id : null;
      if (!sessionId) return send(res, 400, { error: 'session_id required' });
      let text = typeof body.text === 'string' ? body.text : '';
      let transcript = text;
      if (!text && body.audio) {
        if (typeof body.audio.b64 !== 'string') return send(res, 400, { error: 'audio.b64 required' });
        const info = wavInfo(Buffer.from(body.audio.b64, 'base64'));
        if (!info) return send(res, 400, { error: 'audio must be a WAV file' });
        const samples = ['Wie wird das Wetter?', 'Was steht heute an?', 'Zeichne mir ein Haus', 'Mach das Licht im Wohnzimmer an', 'Wie hoch ist der Mount Everest?'];
        transcript = text = info.seconds < 0.4 ? '' : samples[Math.floor(info.seconds * 10) % samples.length];
        log(`  audio ${info.rate} Hz, ${info.channels} ch, ${info.bits} bit, ${info.seconds.toFixed(2)} s → „${transcript}“`);
      }
      if (!text && !body.audio) return send(res, 400, { error: 'text or audio required' });
      if (/#fail/.test(text)) { await sleep(DELAY); return send(res, 500, { error: 'Simulierter ASTRA-Fehler' }); }
      await sleep(/#slow/.test(text) ? 4000 : DELAY);
      const { reply, cards, actions } = buildReply(text);
      return send(res, 200, {
        session_id: sessionId, transcript, reply, cards, actions,
        speech: body.speak ? speechTone(reply) : null,
      });
    }

    if (req.method === 'GET' && path === '/display/v1/glance') {
      await sleep(Math.min(DELAY, 150));
      const condition = url.searchParams.get('condition') || undefined;
      return send(res, 200, {
        generated_at: new Date().toISOString(),
        greeting: greeting(),
        weather: weatherData('Frankfurt am Main', condition),
        calendar: { events: calendarEvents() },
        briefing: { text: 'Am Nachmittag ziehen Wolken auf, Regen erst morgen früh. Denk an den Geburtstag deiner Mama morgen – ein Geschenk ist noch nicht notiert.' },
        alarms: [nextAlarm()],
      });
    }

    if (req.method === 'POST' && path === '/display/v1/tts') {
      if (typeof body.text !== 'string' || !body.text.trim()) return send(res, 400, { error: 'text required' });
      return send(res, 200, speechTone(body.text));
    }

    if (req.method === 'GET' && path === '/display/v1/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ version: VERSION })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 20000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }

    if (req.method === 'POST' && path === '/mock/push') {
      if (typeof body.type !== 'string' || !body.type) return send(res, 400, { error: 'type required' });
      let data = body.data ?? {};
      // Convenience: {type: "card", data: {sample: "weather"}} expands to a sample card.
      if ((body.type === 'card') && typeof data.sample === 'string' && CARD_BUILDERS[data.sample]) data = { card: CARD_BUILDERS[data.sample]() };
      return send(res, 200, { ok: true, clients: broadcast(body.type, data) });
    }

    if (req.method === 'GET' && path === '/mock/requests') return send(res, 200, { requests });
    if (req.method === 'DELETE' && path === '/mock/requests') { requests.length = 0; return send(res, 200, { ok: true }); }

    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    return send(res, 500, { error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`mock ASTRA ${VERSION} on http://${HOST}:${PORT} (token "${TOKEN}")`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const res of clients) res.end(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); });
