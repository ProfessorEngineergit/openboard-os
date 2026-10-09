// Audio for the Astra app: one shared AudioContext, microphone capture (AudioWorklet → 16 kHz
// mono WAV with an energy VAD), speech playback with a level meter, and synthesized alarm sounds.
import { base64ToBytes, bytesToBase64 } from './util.js';

let ctx = null, workletReady = null;

export function audioContext() {
  if (!ctx) {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor({ latencyHint: 'interactive' });
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

const TARGET_RATE = 16000;

// --- Recorder --------------------------------------------------------------------------------
// start() resolves once the microphone is live. The recording ends through stop() (returns the
// WAV) or automatically: after `silenceMs` of silence following speech (onAutoStop), when no
// speech was heard within `noSpeechMs` (onNoSpeech) or after `maxMs`.
export class Recorder {
  constructor({ silenceMs = 1200, noSpeechMs = 8000, maxMs = 30000 } = {}) {
    Object.assign(this, { silenceMs, noSpeechMs, maxMs });
    this.active = false;
  }

  async start({ onLevel, onAutoStop, onNoSpeech } = {}) {
    if (this.active) return;
    const context = audioContext();
    if (!context) throw new Error('Audio wird nicht unterstützt');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Kein Mikrofon verfügbar');
    workletReady ||= context.audioWorklet.addModule('/apps/astra/recorder-worklet.js');
    const [stream] = await Promise.all([
      navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }),
      workletReady,
    ]);
    await context.resume().catch(() => {});
    this.active = true;
    this.stream = stream;
    this.rate = context.sampleRate;
    this.chunks = [];
    this.samples = 0;
    this.level = 0;
    this.noise = null;
    this.speech = false;
    this.loud = 0;
    this.silent = 0;
    this.started = performance.now();
    this.source = context.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(context, 'astra-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.sink = context.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(context.destination);
    this.node.port.onmessage = event => this.#chunk(event.data, { onLevel, onAutoStop, onNoSpeech });
  }

  #chunk(block, { onLevel, onAutoStop, onNoSpeech }) {
    if (!this.active) return;
    this.chunks.push(block);
    this.samples += block.length;
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    const ms = (block.length / this.rate) * 1000;
    const elapsed = performance.now() - this.started;
    // Noise floor: fast to settle in the first 300 ms, then follows only downward / slowly up.
    if (this.noise == null) this.noise = rms;
    else if (elapsed < 300) this.noise = this.noise * 0.7 + rms * 0.3;
    else if (rms < this.noise) this.noise = this.noise * 0.9 + rms * 0.1;
    else if (!this.speech) this.noise = this.noise * 0.995 + rms * 0.005;
    const threshold = Math.max(0.012, this.noise * 2.6);
    if (rms > threshold) { this.loud += ms; this.silent = 0; if (this.loud >= 120) this.speech = true; }
    else { this.loud = Math.max(0, this.loud - ms); if (this.speech) this.silent += ms; }

    const db = 20 * Math.log10(rms + 1e-6);
    const level = Math.min(1, Math.max(0, (db + 58) / 46));
    this.level = level > this.level ? level : this.level * 0.82 + level * 0.18;
    onLevel?.(this.level);

    if (this.speech && this.silent >= this.silenceMs) onAutoStop?.();
    else if (!this.speech && elapsed >= this.noSpeechMs) onNoSpeech?.();
    else if (elapsed >= this.maxMs) onAutoStop?.();
  }

  #teardown() {
    this.active = false;
    try { this.node?.port.postMessage('stop'); } catch {}
    try { this.source?.disconnect(); this.node?.disconnect(); this.sink?.disconnect(); } catch {}
    for (const track of this.stream?.getTracks() || []) track.stop();
    this.node = this.source = this.sink = this.stream = null;
  }

  cancel() { if (this.active) this.#teardown(); this.chunks = []; }

  // Returns {mime, b64, seconds, speech} or null when nothing was recorded.
  stop() {
    if (!this.active) return null;
    this.#teardown();
    const input = new Float32Array(this.samples);
    let offset = 0;
    for (const chunk of this.chunks) { input.set(chunk, offset); offset += chunk.length; }
    this.chunks = [];
    const pcm = downsample(input, this.rate, TARGET_RATE);
    if (!pcm.length) return null;
    return { mime: 'audio/wav', b64: bytesToBase64(encodeWav(pcm, TARGET_RATE)), seconds: pcm.length / TARGET_RATE, speech: this.speech };
  }
}

// Box-filter decimation: averages the input samples that fall into each output sample.
export function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio), end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : input[start] || 0;
  }
  return out;
}

export function encodeWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

// --- Player ----------------------------------------------------------------------------------
// Plays {mime, b64} through an <audio> element routed via WebAudio so the orb can show the level.
export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.url = null;
    this.done = null;
    this.raf = 0;
  }

  get playing() { return Boolean(this.done); }

  #route() {
    if (this.analyser !== undefined) return;
    this.analyser = null;
    const context = audioContext();
    if (!context) return;
    try {
      const source = context.createMediaElementSource(this.audio);
      this.analyser = context.createAnalyser();
      this.analyser.fftSize = 1024;
      source.connect(this.analyser).connect(context.destination);
      this.buffer = new Float32Array(this.analyser.fftSize);
    } catch (error) { console.warn('[astra] playback meter unavailable', error); }
  }

  // Resolves true when playback finished, false when it was interrupted or failed.
  async play(speech, { onLevel } = {}) {
    this.stop();
    if (!speech?.b64) return false;
    this.#route();
    let bytes;
    try { bytes = base64ToBytes(speech.b64); } catch { return false; }
    this.url = URL.createObjectURL(new Blob([bytes], { type: speech.mime || 'audio/mpeg' }));
    this.audio.src = this.url;
    const finished = new Promise(resolve => { this.done = resolve; });
    this.audio.onended = () => this.#finish(true);
    this.audio.onerror = () => this.#finish(false);
    try {
      await audioContext()?.resume();
      await this.audio.play();
    } catch (error) {
      console.warn('[astra] playback failed', error);
      this.#finish(false);
      return finished;
    }
    const started = performance.now();
    const tick = () => {
      if (!this.done) return;
      let level;
      if (this.analyser) {
        this.analyser.getFloatTimeDomainData(this.buffer);
        let sum = 0;
        for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
        level = Math.min(1, Math.max(0, (20 * Math.log10(Math.sqrt(sum / this.buffer.length) + 1e-6) + 52) / 40));
      } else {
        const t = (performance.now() - started) / 1000;
        level = 0.45 + 0.3 * Math.sin(t * 9) * Math.sin(t * 2.3);
      }
      onLevel?.(level);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    return finished;
  }

  #finish(completed) {
    cancelAnimationFrame(this.raf);
    const done = this.done;
    this.done = null;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
    done?.(completed);
  }

  stop() {
    if (!this.done) return;
    try { this.audio.pause(); } catch {}
    this.#finish(false);
  }
}

// --- Alarm sounds ----------------------------------------------------------------------------
// "gentle": a soft rising chime (E major arpeggio) that grows louder over ~90 s.
// "classic": four short beeps per second-and-a-half, like a bedside alarm clock.
export class AlarmSound {
  constructor() { this.timer = 0; this.master = null; }

  get active() { return Boolean(this.master); }

  start(kind = 'gentle') {
    this.stop();
    if (kind === 'none') return;
    const context = audioContext();
    if (!context) return;
    const master = context.createGain();
    master.connect(context.destination);
    const t0 = context.currentTime;
    if (kind === 'classic') {
      master.gain.setValueAtTime(0.25, t0);
      master.gain.linearRampToValueAtTime(0.5, t0 + 30);
    } else {
      master.gain.setValueAtTime(0.0001, t0);
      master.gain.exponentialRampToValueAtTime(0.06, t0 + 1.5);
      master.gain.exponentialRampToValueAtTime(0.55, t0 + 90);
    }
    this.master = master;
    this.kind = kind;
    let next = t0 + 0.1;
    const period = kind === 'classic' ? 1.5 : 3.2;
    const schedule = () => {
      if (this.master !== master) return;
      while (next < context.currentTime + 2) {
        if (kind === 'classic') this.#beeps(context, master, next);
        else this.#chime(context, master, next);
        next += period;
      }
    };
    schedule();
    this.timer = setInterval(schedule, 500);
  }

  #chime(context, out, at) {
    [659.25, 830.61, 987.77, 1318.51].forEach((freq, index) => {
      const start = at + index * 0.22;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.5, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 2.6);
      gain.connect(out);
      for (const [mult, amp] of [[1, 1], [2, 0.18], [3.01, 0.06]]) {
        const osc = context.createOscillator();
        const partial = context.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq * mult;
        partial.gain.value = amp;
        osc.connect(partial).connect(gain);
        osc.start(start);
        osc.stop(start + 2.7);
      }
    });
  }

  #beeps(context, out, at) {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 3200;
    filter.connect(out);
    for (let k = 0; k < 4; k++) {
      const start = at + k * 0.16;
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'square';
      osc.frequency.value = 1046.5;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.008);
      gain.gain.setValueAtTime(0.35, start + 0.09);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.11);
      osc.connect(gain).connect(filter);
      osc.start(start);
      osc.stop(start + 0.12);
    }
  }

  stop() {
    clearInterval(this.timer);
    const master = this.master;
    this.master = null;
    if (master && ctx) {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + 0.25);
      setTimeout(() => master.disconnect(), 400);
    }
  }
}
