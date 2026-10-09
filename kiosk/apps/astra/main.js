// ASTRA on the wall: ambient glance, answer-first conversation, voice input and alarms.
import { openboard } from '/ui/app.js';
import { h, icon, fmtTime, fmtDateLong, fmtDayLabel, parseDate, greetingFor } from './util.js';
import { renderCard, renderEvents } from './cards.js';
import { renderMarkdown, markdownToText } from './markdown.js';
import { renderWeather } from './weather.js';
import { Recorder, Player, AlarmSound, audioContext } from './audio.js';

const SESSION_ID = 'display-main';
const IDLE_MS = 120_000;
const SNOOZE_MS = 9 * 60_000;
const GLANCE_REFRESH_MS = 10 * 60_000;
const ALARM_SILENCE_MS = 10 * 60_000;
const SUGGESTIONS = [
  { label: 'Wie wird das Wetter?' },
  { label: 'Was steht heute an?' },
  { label: 'Zeichne mir …', fill: 'Zeichne mir ' },
];

const $ = id => document.getElementById(id);
const body = document.body;

const S = {
  view: 'glance', afterAlarm: null,
  turns: [], seen: new Set(),
  astra: { configured: null, connected: null }, sse: false,
  voice: 'idle',
  glance: null, glanceState: 'loading', glanceAt: 0, glanceFails: 0, glanceTimer: 0,
  alarm: null, snoozes: new Map(),
  lastActivity: Date.now(), freshSession: false, inflight: null,
  stopWhenReady: false, listenToken: null, press: null,
};

const recorder = new Recorder({ silenceMs: 1200 });
const player = new Player();
const alarmSound = new AlarmSound();
const ttlTimers = new Map();
let turnSeq = 0, cardSeq = 0;

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------
function setView(view) {
  if (S.alarm && view !== 'alarm') { S.afterAlarm = view; return; }
  if (S.view === view) return;
  S.view = view;
  body.dataset.view = view;
  if (view === 'glance') {
    renderGlance();
    if (Date.now() - S.glanceAt > GLANCE_REFRESH_MS) loadGlance();
  }
}
const markActivity = () => { S.lastActivity = Date.now(); };

// ---------------------------------------------------------------------------------------------
// Clock & glance
// ---------------------------------------------------------------------------------------------
let lastMinute = '';
function tick() {
  const now = new Date();
  const time = fmtTime(now);
  if (time !== lastMinute) {
    lastMinute = time;
    $('g-clock').textContent = time;
    $('g-date').textContent = fmtDateLong(now);
    $('c-clock').textContent = time;
    $('al-time').textContent = time;
    if (now.getMinutes() % 5 === 0 && S.view === 'glance') renderGlance();
  }
  setTimeout(tick, 1000 - (Date.now() % 1000) + 5);
}

async function loadGlance() {
  clearTimeout(S.glanceTimer);
  if (S.astra.configured === false) {
    // Nothing to fetch until ASTRA is set up; a state event with configured=true reloads.
    S.glanceState = 'unconfigured';
    S.glanceTimer = setTimeout(loadGlance, 120_000);
    renderGlance();
    return;
  }
  try {
    const data = await openboard.api('/api/local/astra/glance');
    S.glance = data && typeof data === 'object' ? data : null;
    S.glanceState = 'ok';
    S.glanceAt = Date.now();
    S.glanceFails = 0;
    S.glanceTimer = setTimeout(loadGlance, GLANCE_REFRESH_MS);
  } catch (error) {
    S.glanceFails++;
    S.glanceState = S.astra.configured === true ? 'offline' : 'unconfigured';
    if (S.glance && Date.now() - S.glanceAt > 3 * 3600_000) S.glance = null; // too stale to show
    S.glanceTimer = setTimeout(loadGlance, Math.min(120_000, 15_000 * 2 ** Math.min(3, S.glanceFails - 1)));
  }
  renderGlance();
}

function renderGlance() {
  const g = S.glance;
  const now = new Date();
  $('g-greeting').textContent = (g?.greeting && String(g.greeting)) || greetingFor(now);

  const briefing = g?.briefing?.text ? String(g.briefing.text) : '';
  $('g-briefing').hidden = !briefing;
  $('g-briefing').replaceChildren(briefing ? renderMarkdown(briefing, { className: 'md g-brief-md' }) : '');

  // Chips: next alarm, snoozed alarms, return to the conversation.
  const chips = [];
  for (const [, snooze] of S.snoozes) {
    chips.push(h('button', { class: 'g-chip warn', onclick: () => cancelSnooze(snooze.alarm.id, true) },
      icon('bell'), `Schlummert bis ${fmtTime(new Date(snooze.at))}`, h('span', { class: 'g-chip-x' }, icon('close'))));
  }
  const alarms = (Array.isArray(g?.alarms) ? g.alarms : [])
    .map(alarm => ({ ...alarm, _at: parseDate(alarm?.at) }))
    .filter(alarm => alarm._at && alarm._at > now)
    .sort((a, b) => a._at - b._at);
  if (alarms[0]) chips.push(h('div', { class: 'g-chip' }, icon('bell'),
    `${fmtDayLabel(alarms[0]._at, now)} ${fmtTime(alarms[0]._at)}`, alarms[0].label ? h('span', { class: 'g-chip-dim' }, ` · ${alarms[0].label}`) : null));
  if (S.turns.length) chips.push(h('button', { class: 'g-chip', onclick: () => { markActivity(); setView('conversation'); } }, icon('history'), 'Gespräch fortsetzen'));
  $('g-chips').replaceChildren(...chips);
  $('g-chips').hidden = !chips.length;

  const events = (Array.isArray(g?.calendar?.events) ? g.calendar.events : [])
    .filter(event => { const end = parseDate(event?.end) || parseDate(event?.start); return end && end > now; });
  $('g-events').hidden = !events.length;
  if (events.length) $('g-events').replaceChildren(h('div', { class: 'g-sec' }, icon('calendar'), 'Als Nächstes'), renderEvents(events, { limit: 4, compact: true }));

  const hint = $('g-hint');
  hint.hidden = S.glanceState === 'ok' || S.glanceState === 'loading';
  if (S.glanceState === 'unconfigured') {
    hint.replaceChildren(h('button', { class: 'g-connect ob-glass', onclick: openSettings },
      icon('astra'), h('span', null, 'ASTRA verbinden: ', h('b', null, 'Einstellungen → ASTRA')), icon('chevron')));
  } else if (S.glanceState === 'offline') {
    hint.replaceChildren(h('div', { class: 'g-offline' }, h('i', { class: 'dot err' }), 'ASTRA ist gerade nicht erreichbar – ich versuche es weiter.'));
  }

  const weather = g?.weather && typeof g.weather === 'object' ? g.weather : null;
  $('g-weather').replaceChildren(weather ? renderWeather(weather, { mode: 'glance' }) : '');
  $('glance').classList.toggle('no-weather', !weather);
  fitGlance();
}

// Drops trailing events (then the briefing) until the left column fits above the composer.
function fitGlance() {
  const left = document.querySelector('#glance .g-left');
  const overflowing = () => left.scrollHeight > left.clientHeight + 1;
  let guard = 12;
  while (overflowing() && guard--) {
    const rows = $('g-events').querySelectorAll('.tl-ev');
    if (rows.length > 1) {
      const last = rows[rows.length - 1];
      const prev = last.previousElementSibling;
      last.remove();
      if (prev?.classList.contains('tl-day') && !prev.nextElementSibling) prev.remove();
    } else if (!$('g-briefing').hidden) $('g-briefing').hidden = true;
    else { $('g-events').hidden = true; break; }
  }
}

function openSettings() {
  markActivity();
  openboard.api('/api/local/apps/settings/activate', { method: 'POST', body: {} }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------------------------
function normalizeCards(list) {
  return (Array.isArray(list) ? list : [])
    .filter(card => card && typeof card === 'object')
    .slice(0, 24)
    .map(card => ({ ...card, id: card.id != null && card.id !== '' ? String(card.id) : `card-${++cardSeq}` }));
}

function addTurn(fields) {
  const turn = { id: `t${++turnSeq}`, kind: 'user', question: null, reply: '', cards: [], status: 'done', error: null, at: Date.now(), v: 0, ...fields };
  S.turns.push(turn);
  if (S.turns.length > 40) S.turns.splice(0, S.turns.length - 40);
  markActivity();
  renderThread({ scroll: true });
  return turn;
}
const currentTurn = () => S.turns.at(-1);
const touch = turn => { turn.v++; };

function mergeCards(turn, cards, replace = false) {
  if (replace) turn.cards = [];
  for (const card of cards) {
    const index = turn.cards.findIndex(existing => existing.id === card.id);
    if (index >= 0) turn.cards[index] = card; else turn.cards.push(card);
    armTtl(card);
  }
  touch(turn);
}

function armTtl(card) {
  const ttl = Number(card.ttl_seconds);
  if (!(ttl > 0)) return;
  clearTimeout(ttlTimers.get(card.id));
  ttlTimers.set(card.id, setTimeout(() => {
    ttlTimers.delete(card.id);
    for (const turn of S.turns) {
      const before = turn.cards.length;
      turn.cards = turn.cards.filter(existing => existing.id !== card.id);
      if (turn.cards.length !== before) touch(turn);
    }
    renderThread();
  }, Math.min(ttl, 86400) * 1000));
}

function pushCards(cards, replace) {
  const list = normalizeCards(cards);
  if (!list.length && !replace) return;
  let turn = currentTurn();
  const reuse = turn && (turn.kind === 'push' || turn.status === 'pending' || Date.now() - turn.at < 90_000);
  if (!reuse) turn = addTurn({ kind: 'push' });
  mergeCards(turn, list, replace);
  markActivity();
  renderThread();
  setView('conversation');
}

const turnCache = new Map();

function renderThread({ scroll = false } = {}) {
  const past = S.turns.slice(0, -1), current = currentTurn();
  const fresh = [];
  const pastEls = past.map(turn => {
    let cached = turnCache.get(turn.id);
    if (!cached || cached.v !== turn.v || cached.mode !== 'past' || cached.open !== Boolean(turn.open)) {
      cached = { v: turn.v, mode: 'past', open: Boolean(turn.open), el: renderPastTurn(turn) };
      turnCache.set(turn.id, cached);
      fresh.push(cached.el);
    }
    return cached.el;
  });
  $('history').replaceChildren(...(pastEls.length ? [h('div', { class: 'hist-label' }, icon('history'), 'Früher in diesem Gespräch'), ...pastEls] : []));
  if (current) {
    let cached = turnCache.get(current.id);
    if (!cached || cached.v !== current.v || cached.mode !== 'current') {
      cached = { v: current.v, mode: 'current', el: renderCurrentTurn(current) };
      turnCache.set(current.id, cached);
      fresh.push(cached.el);
    }
    if ($('current').firstElementChild !== cached.el) $('current').replaceChildren(cached.el);
  } else {
    $('current').replaceChildren(h('div', { class: 'empty-convo' },
      h('div', { class: 'empty-orb' }, icon('astra')),
      h('div', { class: 'empty-title' }, 'Was möchtest du wissen?'),
      h('div', { class: 'empty-sub' }, 'Tippe auf das Mikrofon oder schreib unten eine Frage.')));
  }
  const ids = new Set(S.turns.map(turn => turn.id));
  for (const id of turnCache.keys()) if (!ids.has(id)) turnCache.delete(id);
  for (const el of fresh) for (const grid of el.querySelectorAll('.cards')) layoutMasonry(grid);
  if (scroll) requestAnimationFrame(() => {
    const thread = $('thread');
    thread.scrollTo({ top: Math.max(0, $('current').offsetTop - 8), behavior: S.view === 'conversation' ? 'smooth' : 'auto' });
  });
}

function speakerLabel(turn) {
  const label = turn.kind === 'alarm' ? (turn.label || 'Wecker') : 'ASTRA';
  return h('div', { class: 'q q-astra' }, icon(turn.kind === 'alarm' ? 'bell' : 'astra'), label, h('span', { class: 'q-time' }, fmtTime(new Date(turn.at))));
}

function questionEl(turn) {
  if (turn.kind !== 'user' && !turn.question) return speakerLabel(turn);
  const text = turn.question || (turn.audio ? 'Spracheingabe …' : '');
  return h('div', { class: `q${turn.question ? '' : ' q-pending'}` }, text);
}

function replyEl(turn) {
  if (turn.status === 'pending') return h('div', { class: 'thinking' }, h('span', { class: 'thinking-dots' }, h('i'), h('i'), h('i')), 'Denkt nach …');
  if (turn.status === 'error') {
    return h('div', { class: 'reply-error' },
      h('div', { class: 'err-text' }, icon('warning'), turn.error || 'Etwas ist schiefgelaufen.'),
      turn.retry ? h('button', { class: 'ob-btn glass retry', onclick: () => { markActivity(); ask(turn.retry); } }, icon('reload'), 'Erneut versuchen') : null);
  }
  if (!turn.reply) return null;
  const plain = markdownToText(turn.reply);
  return renderMarkdown(turn.reply, { className: `md reply${plain.length > 420 ? ' long' : plain.length < 90 ? ' short' : ''}` });
}

function cardGrid(cards, columns) {
  const grid = h('div', { class: 'cards', 'data-cols': columns, style: { '--cols': columns } });
  grid._cards = cards.map((card, index) => {
    const el = renderCard(card);
    if (!S.seen.has(card.id)) {
      S.seen.add(card.id);
      el.classList.add('enter');
      el.style.animationDelay = `${index * 70}ms`;
    }
    return el;
  });
  return grid;
}

// Greedy masonry: each card goes into the currently shortest column (reading order stays natural).
function layoutMasonry(grid) {
  const cards = grid._cards || [];
  const columns = Math.max(1, Number(grid.dataset.cols) || 1);
  const cols = Array.from({ length: Math.min(columns, Math.max(1, cards.length)) }, () => h('div', { class: 'cards-col' }));
  grid.replaceChildren(...cols);
  const heights = cols.map(() => 0);
  cards.forEach((card, index) => {
    const target = index < cols.length ? index : heights.indexOf(Math.min(...heights));
    cols[target].append(card);
    heights[target] = cols[target].offsetHeight;
  });
}

function renderCurrentTurn(turn) {
  const hasCards = turn.cards.length > 0;
  const hasAnswer = Boolean(turn.reply) || turn.status !== 'done' || turn.kind === 'user';
  const split = hasCards && hasAnswer;
  const answer = h('div', { class: 'answer' }, questionEl(turn), replyEl(turn));
  const columns = split ? (turn.cards.length > 1 ? 2 : 1) : Math.min(3, turn.cards.length);
  const grid = hasCards ? cardGrid(turn.cards, columns) : null;
  if (grid && turn.cards.length === 1 && SMALL_CARDS.has(turn.cards[0].type)) grid.classList.add('narrow');
  return h('article', { class: `turn current${split ? ' split' : ''}${!hasAnswer ? ' cards-only' : ''}`, 'data-turn': turn.id },
    hasAnswer || !hasCards ? answer : speakerLabel(turn),
    grid);
}

function renderPastTurn(turn) {
  const text = turn.status === 'error' ? (turn.error || '') : markdownToText(turn.reply);
  const el = h('article', { class: `turn past${turn.open ? ' open' : ''}`, 'data-turn': turn.id },
    h('button', { class: 'past-head', onclick: () => { markActivity(); turn.open = !turn.open; renderThread(); } },
      h('div', { class: 'past-main' },
        turn.kind === 'user' || turn.question ? h('div', { class: 'past-q' }, turn.question || 'Spracheingabe') : h('div', { class: 'past-q astra' }, icon(turn.kind === 'alarm' ? 'bell' : 'astra'), turn.kind === 'alarm' ? (turn.label || 'Wecker') : 'ASTRA'),
        !turn.open && text ? h('div', { class: 'past-a' }, text) : null,
        !turn.open && turn.cards.length ? h('div', { class: 'past-cards' }, turn.cards.slice(0, 5).map(card => h('span', { class: 'past-chip' }, String(card.title || TYPE_NAMES[card.type] || card.type)))) : null),
      h('span', { class: 'past-time' }, fmtTime(new Date(turn.at))),
      h('span', { class: 'past-chev' }, icon('chevron'))));
  if (turn.open) {
    const reply = replyEl(turn);
    el.append(h('div', { class: 'past-body' }, reply, turn.cards.length ? cardGrid(turn.cards, Math.min(3, turn.cards.length)) : null));
  }
  return el;
}
const SMALL_CARDS = new Set(['alarm', 'facts', 'list', 'home']);
const TYPE_NAMES = { weather: 'Wetter', calendar: 'Kalender', list: 'Liste', markdown: 'Text', image: 'Bild', sketch: 'Skizze', facts: 'Fakten', home: 'Zuhause', alarm: 'Wecker' };

function newConversation() {
  markActivity();
  S.inflight?.abort();
  S.inflight = null;
  cancelListening();
  player.stop();
  S.turns = [];
  turnCache.clear();
  S.freshSession = true;
  setVoice('idle');
  renderThread();
  setView('conversation');
  $('ask-input').focus({ preventScroll: true });
  $('ask-input').blur();
}

// ---------------------------------------------------------------------------------------------
// Asking ASTRA
// ---------------------------------------------------------------------------------------------
function errorText(error) {
  if (error?.name === 'AbortError') return 'Abgebrochen.';
  if (error?.status === 503) return S.astra.configured === false ? 'ASTRA ist noch nicht eingerichtet (Einstellungen → ASTRA).' : 'ASTRA ist gerade nicht erreichbar.';
  if (error?.status === 502) return `ASTRA hat einen Fehler gemeldet${error.message && error.message !== 'Bad Gateway' ? `: ${error.message}` : '.'}`;
  if (error?.status) return `Fehler ${error.status}: ${error.message}`;
  return 'Keine Verbindung zum Controller.';
}

async function ask({ text, audio }) {
  S.inflight?.abort();
  player.stop();
  const turn = addTurn({ kind: 'user', question: text || null, audio: Boolean(audio), status: 'pending' });
  setView('conversation');
  setVoice('thinking');
  if (S.astra.configured === false) {
    Object.assign(turn, { status: 'error', error: 'ASTRA ist noch nicht eingerichtet (Einstellungen → ASTRA).', retry: { text, audio } });
    touch(turn);
    renderThread();
    setVoice('idle');
    return;
  }
  const controller = new AbortController();
  S.inflight = controller;
  const request = {
    session_id: SESSION_ID,
    speak: Boolean(audio),
    context: { active_app: openboard.state?.active || 'astra', locale: 'de-DE', theme: document.documentElement.dataset.obTheme || 'dark' },
  };
  if (S.freshSession) request.context.new_conversation = true;
  if (text) request.text = text; else request.audio = { mime: audio.mime, b64: audio.b64 };
  try {
    const res = await openboard.api('/api/local/astra/message', { method: 'POST', body: request, signal: controller.signal });
    if (S.inflight !== controller) return;
    S.inflight = null;
    S.freshSession = false;
    if (res?.transcript) turn.question = String(res.transcript);
    await applyReply(turn, res || {});
  } catch (error) {
    if (S.inflight === controller) S.inflight = null;
    turn.status = 'error';
    turn.error = errorText(error);
    turn.retry = error?.name === 'AbortError' ? null : { text, audio };
    touch(turn);
    renderThread();
    if (S.voice === 'thinking' && !S.inflight) setVoice('idle');
  }
}

async function applyReply(turn, res) {
  turn.reply = typeof res.reply === 'string' ? res.reply : '';
  turn.status = 'done';
  mergeCards(turn, normalizeCards(res.cards));
  renderThread();
  markActivity();
  if (S.voice === 'thinking') setVoice('idle');
  const actions = Array.isArray(res.actions) ? res.actions : [];
  if (res.speech?.b64) await speak(res.speech);
  runActions(actions);
}

function runActions(actions) {
  for (const action of actions) {
    if (action?.type === 'open_app' && /^[a-z0-9_-]{1,40}$/i.test(String(action.app || ''))) {
      openboard.api(`/api/local/apps/${action.app}/activate`, { method: 'POST', body: {} }).catch(() => {});
    }
  }
}

async function speak(speech) {
  if (S.alarm) return false;
  setVoice('speaking');
  const done = await player.play(speech, { onLevel: setLevel });
  if (S.voice === 'speaking') setVoice('idle');
  markActivity();
  return done;
}

async function speakText(text) {
  if (!text) return;
  try {
    const speech = await openboard.api('/api/local/astra/tts', { method: 'POST', body: { text } });
    if (speech?.b64 && S.voice === 'idle') await speak(speech);
  } catch (error) { console.warn('[astra] tts failed', error.message); }
}

// ---------------------------------------------------------------------------------------------
// Voice input & orb
// ---------------------------------------------------------------------------------------------
const VOICE_LABEL = { idle: '', listening: 'Ich höre zu …', thinking: 'Denkt nach …', speaking: 'Tippen zum Unterbrechen' };
let flashTimer = 0;

function setVoice(voice) {
  S.voice = voice;
  body.dataset.voice = voice;
  $('orb').dataset.state = voice;
  $('orb').setAttribute('aria-label', voice === 'listening' ? 'Aufnahme beenden' : voice === 'speaking' ? 'Sprachausgabe unterbrechen' : voice === 'thinking' ? 'Anfrage abbrechen' : 'Sprechen');
  clearTimeout(flashTimer);
  $('voice-label').textContent = VOICE_LABEL[voice];
  $('voice-label').classList.remove('flash');
  if (voice === 'idle') setLevel(0);
}

function flash(text) {
  $('voice-label').textContent = text;
  $('voice-label').classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (S.voice === 'idle') $('voice-label').textContent = ''; $('voice-label').classList.remove('flash'); }, 3500);
}

let levelValue = 0;
function setLevel(level) {
  const v = Math.round(level * 100) / 100;
  if (v === levelValue) return;
  levelValue = v;
  $('orb').style.setProperty('--lvl', v);
}

function micError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'Kein Zugriff auf das Mikrofon.';
  if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'Kein Mikrofon gefunden.';
  return error?.message || 'Mikrofon nicht verfügbar.';
}

async function startListening() {
  if (S.voice === 'listening') return;
  player.stop();
  S.stopWhenReady = false;
  const token = S.listenToken = {};
  setVoice('listening');
  try {
    await recorder.start({
      onLevel: setLevel,
      onAutoStop: () => finishListening(),
      onNoSpeech: () => { if (!S.press?.hold) { cancelListening(); flash('Ich habe nichts gehört.'); } },
    });
    if (S.listenToken !== token) { recorder.cancel(); return; }
    if (S.stopWhenReady) finishListening();
  } catch (error) {
    if (S.listenToken !== token) return;
    S.listenToken = null;
    setVoice('idle');
    flash(micError(error));
    console.warn('[astra] microphone', error);
  }
}

function finishListening({ force = false } = {}) {
  if (S.voice !== 'listening') return;
  if (!recorder.active) { S.stopWhenReady = true; return; }
  S.listenToken = null;
  const audio = recorder.stop();
  setLevel(0);
  if (!audio || audio.seconds < 0.3 || (!audio.speech && !force)) { setVoice('idle'); flash('Ich habe nichts gehört.'); return; }
  ask({ audio: { mime: audio.mime, b64: audio.b64 } });
}

function cancelListening() {
  S.listenToken = null;
  S.stopWhenReady = false;
  recorder.cancel();
  if (S.voice === 'listening') setVoice('idle');
}

function setupOrb() {
  const orb = $('orb');
  let holdTimer = 0;
  orb.addEventListener('pointerdown', event => {
    event.preventDefault();
    markActivity();
    try { orb.setPointerCapture(event.pointerId); } catch {}
    audioContext();
    if (S.voice === 'speaking') { player.stop(); setVoice('idle'); return; }
    if (S.voice === 'thinking') { S.inflight?.abort(); setVoice('idle'); return; }
    if (S.voice === 'listening') { finishListening({ force: true }); return; }
    S.press = { hold: false };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { if (S.press) { S.press.hold = true; orb.classList.add('holding'); } }, 450);
    startListening();
  });
  const release = () => {
    clearTimeout(holdTimer);
    orb.classList.remove('holding');
    if (S.press?.hold && S.voice === 'listening') finishListening({ force: true });
    S.press = null;
  };
  orb.addEventListener('pointerup', release);
  orb.addEventListener('pointercancel', release);
  orb.addEventListener('contextmenu', event => event.preventDefault());
  orb.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (S.voice === 'listening') finishListening({ force: true });
    else if (S.voice === 'speaking') { player.stop(); setVoice('idle'); }
    else if (S.voice === 'idle') startListening();
  });
}

// ---------------------------------------------------------------------------------------------
// Composer (text + chips)
// ---------------------------------------------------------------------------------------------
function setupComposer() {
  const input = $('ask-input');
  $('ask').addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.blur();
    ask({ text });
  });
  input.addEventListener('focus', () => { body.classList.add('typing'); markActivity(); });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) body.classList.remove('typing'); }, 120));
  input.addEventListener('input', markActivity);

  $('chips').replaceChildren(...SUGGESTIONS.map(chip => h('button', {
    class: 'chip', type: 'button',
    onclick: () => {
      markActivity();
      if (chip.fill) { input.value = chip.fill; input.focus(); input.setSelectionRange(chip.fill.length, chip.fill.length); }
      else ask({ text: chip.label });
    },
  }, chip.label)));

  $('c-glance').addEventListener('click', () => { markActivity(); setView('glance'); });
  $('c-new').addEventListener('click', newConversation);
}

// ---------------------------------------------------------------------------------------------
// Alarm
// ---------------------------------------------------------------------------------------------
let alarmSilenceTimer = 0;

function triggerAlarm(data = {}) {
  const alarm = {
    id: data.id != null ? String(data.id) : `alarm-${Date.now()}`,
    label: data.label ? String(data.label) : 'Wecker',
    sound: ['gentle', 'classic', 'none'].includes(data.sound) ? data.sound : 'gentle',
    speak: typeof data.speak === 'string' ? data.speak : '',
    speech: data.speech?.b64 ? data.speech : null,
    cards: normalizeCards(data.cards),
  };
  cancelSnooze(alarm.id);
  cancelListening();
  player.stop();
  if (S.view !== 'alarm') S.afterAlarm = S.view;
  S.alarm = alarm;
  $('al-label').textContent = alarm.label;
  $('alarm').dataset.sound = alarm.sound;
  $('alarm').hidden = false;
  S.view = 'alarm';
  body.dataset.view = 'alarm';
  setVoice('idle');
  alarmSound.start(alarm.sound);
  clearTimeout(alarmSilenceTimer);
  alarmSilenceTimer = setTimeout(() => alarmSound.stop(), ALARM_SILENCE_MS);
  bringToFront();
  requestAnimationFrame(() => $('al-stop').focus({ preventScroll: true }));
}

function bringToFront() {
  const state = openboard.state;
  if (state?.display?.asleep) openboard.api('/api/local/display/wake', { method: 'POST', body: {} }).catch(() => {});
  if (state && state.active && state.active !== 'astra') openboard.api('/api/local/apps/astra/activate', { method: 'POST', body: {} }).catch(() => {});
}

function closeAlarm() {
  const alarm = S.alarm;
  S.alarm = null;
  alarmSound.stop();
  clearTimeout(alarmSilenceTimer);
  $('alarm').hidden = true;
  return alarm;
}

function stopAlarm() {
  const alarm = closeAlarm();
  if (!alarm) return;
  markActivity();
  if (alarm.speak || alarm.speech || alarm.cards.length) {
    S.view = null;
    addTurn({ kind: 'alarm', label: alarm.label, reply: alarm.speak, cards: alarm.cards });
    for (const card of alarm.cards) armTtl(card);
    setView('conversation');
    if (alarm.speech) speak(alarm.speech);
    else if (alarm.speak) speakText(alarm.speak);
  } else {
    S.view = null;
    setView(S.afterAlarm === 'conversation' ? 'conversation' : 'glance');
  }
  S.afterAlarm = null;
}

function snoozeAlarm() {
  const alarm = closeAlarm();
  if (!alarm) return;
  markActivity();
  const at = Date.now() + SNOOZE_MS;
  S.snoozes.set(alarm.id, { at, alarm, timer: setTimeout(() => { S.snoozes.delete(alarm.id); triggerAlarm(alarm); }, SNOOZE_MS) });
  S.view = null;
  S.afterAlarm = null;
  setView('glance');
}

function cancelSnooze(id, rerender = false) {
  const snooze = S.snoozes.get(id);
  if (!snooze) return;
  clearTimeout(snooze.timer);
  S.snoozes.delete(id);
  if (rerender) renderGlance();
}

// ---------------------------------------------------------------------------------------------
// Push events from ASTRA (via /api/local/events)
// ---------------------------------------------------------------------------------------------
function updateStatus(patch) {
  const was = S.astra.connected;
  if (patch && typeof patch === 'object') {
    if ('configured' in patch) S.astra.configured = patch.configured;
    if ('connected' in patch) S.astra.connected = patch.connected;
  }
  const ok = S.sse && S.astra.connected === true;
  body.dataset.connected = ok ? 'yes' : 'no';
  $('c-status').replaceChildren(h('i', { class: `dot ${ok ? 'ok' : 'err'}` }),
    ok ? 'ASTRA' : S.astra.configured === false ? 'ASTRA nicht eingerichtet' : 'ASTRA nicht verbunden');
  if ((!was && S.astra.connected || patch?.configured === true) && S.glanceState !== 'ok') loadGlance();
  else if (patch?.configured === false && S.glanceState !== 'unconfigured') loadGlance();
}

function handleEvent(type, data) {
  data = data && typeof data === 'object' ? data : {};
  switch (type) {
    case 'card': pushCards([data.card ?? data], false); break;
    case 'cards': pushCards(data.cards, Boolean(data.replace)); break;
    case 'say': {
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text && !data.speech) break;
      const turn = addTurn({ kind: 'say', reply: text });
      if (Array.isArray(data.cards)) mergeCards(turn, normalizeCards(data.cards));
      setView('conversation');
      if (S.alarm) break;
      if (S.voice === 'listening') break;
      if (data.speech?.b64) speak(data.speech); else speakText(text);
      break;
    }
    case 'reply': {
      const turn = addTurn({ kind: data.transcript ? 'user' : 'reply', question: data.transcript ? String(data.transcript) : null });
      setView('conversation');
      applyReply(turn, data);
      break;
    }
    case 'alarm': triggerAlarm(data); break;
    case 'hello': updateStatus({ connected: true }); break;
    case 'status': updateStatus(data); break;
    case 'command': break; // handled by the controller
    default: break;
  }
}

// ---------------------------------------------------------------------------------------------
// Idle handling & burn-in protection
// ---------------------------------------------------------------------------------------------
function idleCheck() {
  const typing = document.activeElement === $('ask-input');
  if (S.view === 'conversation' && S.voice === 'idle' && !S.inflight && !typing && Date.now() - S.lastActivity > IDLE_MS) {
    $('thread').scrollTop = 0;
    setView('glance');
  }
}

function shiftPixels() {
  const r = () => Math.round((Math.random() * 2 - 1) * 6);
  const app = $('app');
  app.style.setProperty('--shift-x', `${r()}px`);
  app.style.setProperty('--shift-y', `${r()}px`);
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------
function exposeDiagnostics() {
  window.__openboardAstra = {
    diagnostics() {
      const cards = [];
      for (const turn of S.turns) for (const card of turn.cards) cards.push({ id: card.id, type: card.type, title: card.title ?? null });
      return {
        view: S.view, cards,
        listening: S.voice === 'listening', speaking: S.voice === 'speaking', thinking: S.voice === 'thinking',
        connected: S.sse && S.astra.connected === true,
        configured: S.astra.configured, turns: S.turns.length, glance: S.glanceState,
        alarm: S.alarm ? { id: S.alarm.id, label: S.alarm.label, sound: S.alarm.sound } : null,
        snoozed: [...S.snoozes.values()].map(s => ({ id: s.alarm.id, at: new Date(s.at).toISOString() })),
      };
    },
    injectEvent(type, data) { handleEvent(String(type || '').replace(/^astra\./, ''), data); return true; },
  };
}

async function boot() {
  body.dataset.view = 'glance';
  setVoice('idle');
  exposeDiagnostics();
  tick();
  setupOrb();
  setupComposer();
  $('al-stop').addEventListener('click', stopAlarm);
  $('al-snooze').addEventListener('click', snoozeAlarm);
  renderThread();
  renderGlance();

  for (const type of ['card', 'cards', 'say', 'reply', 'alarm', 'command', 'status', 'hello']) {
    openboard.on(`astra.${type}`, data => handleEvent(type, data));
  }
  openboard.on('state', state => {
    if (state?.astra) updateStatus(state.astra);
    if (state?.active && state.active !== 'astra' && S.voice === 'listening') cancelListening();
  });
  openboard.on('connection', ({ connected }) => {
    const was = S.sse;
    S.sse = Boolean(connected);
    updateStatus();
    if (!was && S.sse && S.glanceState !== 'ok') loadGlance();
  });

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) window.addEventListener(type, markActivity, { passive: true, capture: true });
  setInterval(idleCheck, 5000);
  setInterval(shiftPixels, 180_000);
  document.fonts?.ready.then(() => renderGlance());
  window.addEventListener('resize', () => renderGlance());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - S.glanceAt > GLANCE_REFRESH_MS) loadGlance();
    if (document.visibilityState === 'hidden' && S.voice === 'listening') cancelListening();
  });

  await openboard.connect();
  if (openboard.state?.astra) updateStatus(openboard.state.astra);
  else updateStatus({ configured: openboard.state ? false : null });
  await loadGlance();
}

boot();
