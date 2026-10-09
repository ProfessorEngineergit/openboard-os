// System metrics from /proc and /sys. Sampling costs a few file reads every 2 s;
// the GPU busy probe (intel_gpu_top) runs only while someone watches.
import { readFile, readdir, statfs } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const HISTORY = 300;

export function parseCpu(text) {
  const fields = text.split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
  const idle = fields[3] + (fields[4] || 0);
  return { idle, total: fields.reduce((sum, value) => sum + value, 0) };
}

export function parseMeminfo(text) {
  const value = key => Number(new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)?.[1] || 0) / 1024;
  const totalMB = value('MemTotal'), availableMB = value('MemAvailable');
  return { totalMB: Math.round(totalMB), usedMB: Math.round(totalMB - availableMB), availableMB: Math.round(availableMB), pct: totalMB ? (1 - availableMB / totalMB) * 100 : null };
}

export function parseNetDev(text) {
  let rx = 0, tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, data] = line.split(':');
    if (!data || name.trim() === 'lo') continue;
    const fields = data.trim().split(/\s+/).map(Number);
    rx += fields[0]; tx += fields[8];
  }
  return { rx, tx };
}

const readNumber = async file => Number((await readFile(file, 'utf8')).trim());

async function findTemperatureSources() {
  const sources = [];
  try {
    for (const entry of await readdir('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${entry}`;
      const name = (await readFile(`${base}/name`, 'utf8').catch(() => '')).trim();
      if (!['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'acpitz'].includes(name)) continue;
      const files = (await readdir(base)).filter(file => /^temp\d+_input$/.test(file));
      // coretemp temp1 is the package sensor; others report the hottest input.
      const preferred = name === 'coretemp' && files.includes('temp1_input') ? ['temp1_input'] : files;
      sources.push({ priority: name === 'acpitz' ? 1 : 0, files: preferred.map(file => `${base}/${file}`) });
    }
  } catch { /* no hwmon */ }
  sources.sort((a, b) => a.priority - b.priority);
  return sources[0]?.files || [];
}

async function findGpu() {
  try {
    for (const card of (await readdir('/sys/class/drm')).filter(name => /^card\d+$/.test(name))) {
      const base = `/sys/class/drm/${card}`;
      const busy = `${base}/device/gpu_busy_percent`;
      if (await readNumber(busy).then(() => true, () => false)) return { kind: 'busy-file', busy };
      for (const [act, max] of [[`${base}/gt_act_freq_mhz`, `${base}/gt_RP0_freq_mhz`], [`${base}/gt/gt0/rps_act_freq_mhz`, `${base}/gt/gt0/rps_RP0_freq_mhz`]]) {
        if (await readNumber(act).then(() => true, () => false)) return { kind: 'i915', act, max };
      }
    }
  } catch { /* no drm */ }
  return null;
}

export class Metrics extends EventEmitter {
  constructor({ interval = 2000 } = {}) {
    super();
    this.interval = interval;
    this.latest = { t: Date.now(), cpu: { pct: null }, gpu: { pct: null, source: null }, ram: { pct: null }, temp: { c: null }, net: {}, disk: { pct: null } };
    this.history = { cpu: [], gpu: [], ram: [], temp: [], net: [] };
    this.watchers = 0;
    this.gpuBusy = null; this.gpuProbe = null; this.gpuProbeFailed = false;
  }

  async start() {
    this.tempFiles = await findTemperatureSources();
    this.gpu = await findGpu();
    await this.sample();
    this.timer = setInterval(() => { void this.sample().catch(error => console.error(`Metrics: ${error.message}`)); }, this.interval);
    this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.stopGpuProbe(); }

  // Reference counted: the GPU busy probe only runs while somebody looks.
  watch() {
    if (++this.watchers === 1) this.startGpuProbe();
    let released = false;
    return () => { if (released) return; released = true; if (--this.watchers === 0) this.stopGpuProbe(); };
  }

  startGpuProbe() {
    if (this.gpuProbe || this.gpuProbeFailed || this.gpu?.kind !== 'i915') return;
    // intel_gpu_top needs CAP_PERFMON (setcap, see scripts/install-runtime-extras.sh).
    const child = spawn('intel_gpu_top', ['-J', '-s', String(this.interval)], { stdio: ['ignore', 'pipe', 'ignore'] });
    this.gpuProbe = child;
    let buffer = '', depth = 0, start = -1;
    child.stdout.on('data', chunk => {
      buffer += chunk;
      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === '{') { if (depth++ === 0) start = i; }
        else if (buffer[i] === '}' && --depth === 0 && start >= 0) {
          try {
            const sample = JSON.parse(buffer.slice(start, i + 1));
            const render = Object.entries(sample.engines || {}).find(([name]) => /render|3d/i.test(name))?.[1];
            if (render && Number.isFinite(render.busy)) this.gpuBusy = { pct: render.busy, at: Date.now() };
          } catch { /* partial frame */ }
          buffer = buffer.slice(i + 1); i = -1; start = -1;
        }
      }
      if (buffer.length > 1e6) buffer = '';
    });
    child.on('error', () => { this.gpuProbeFailed = true; this.gpuProbe = null; });
    child.on('exit', code => { if (this.gpuProbe === child) { this.gpuProbe = null; if (code) this.gpuProbeFailed = true; } });
  }

  stopGpuProbe() { this.gpuProbe?.kill(); this.gpuProbe = null; this.gpuBusy = null; }

  async readGpu() {
    if (this.gpuBusy && Date.now() - this.gpuBusy.at < this.interval * 3) return { pct: this.gpuBusy.pct, source: 'busy' };
    if (this.gpu?.kind === 'busy-file') return { pct: await readNumber(this.gpu.busy).catch(() => null), source: 'busy' };
    if (this.gpu?.kind === 'i915') {
      const [act, max] = await Promise.all([readNumber(this.gpu.act), readNumber(this.gpu.max)]).catch(() => [null, null]);
      return { pct: act && max ? (act / max) * 100 : null, freqMHz: act, maxMHz: max, source: 'freq' };
    }
    return { pct: null, source: null };
  }

  async sample() {
    const now = Date.now();
    const [stat, meminfo, netdev, gpu, temps, disk] = await Promise.all([
      readFile('/proc/stat', 'utf8').catch(() => null),
      readFile('/proc/meminfo', 'utf8').catch(() => null),
      readFile('/proc/net/dev', 'utf8').catch(() => null),
      this.readGpu(),
      Promise.all((this.tempFiles || []).map(file => readNumber(file).catch(() => null))),
      statfs('/').catch(() => null),
    ]);
    const next = { t: now, cpu: { pct: null }, gpu, ram: { pct: null }, temp: { c: null }, net: {}, disk: { pct: null } };
    if (stat) {
      const cpu = parseCpu(stat);
      if (this.lastCpu) {
        const total = cpu.total - this.lastCpu.total, idle = cpu.idle - this.lastCpu.idle;
        next.cpu.pct = total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : null;
      }
      this.lastCpu = cpu;
    }
    if (meminfo) next.ram = parseMeminfo(meminfo);
    const validTemps = temps.filter(Number.isFinite);
    if (validTemps.length) next.temp.c = Math.max(...validTemps) / 1000;
    if (netdev) {
      const net = parseNetDev(netdev);
      if (this.lastNet) {
        const seconds = (now - this.lastNet.t) / 1000;
        next.net = { rxKBs: Math.max(0, (net.rx - this.lastNet.rx) / 1024 / seconds), txKBs: Math.max(0, (net.tx - this.lastNet.tx) / 1024 / seconds) };
      }
      this.lastNet = { ...net, t: now };
    }
    if (disk) next.disk = { pct: (1 - disk.bavail / disk.blocks) * 100, freeGB: Math.round((disk.bavail * disk.bsize) / 1e9 * 10) / 10 };
    this.latest = next;
    const push = (key, value) => { const list = this.history[key]; list.push(Number.isFinite(value) ? Math.round(value * 10) / 10 : null); if (list.length > HISTORY) list.shift(); };
    push('cpu', next.cpu.pct); push('gpu', next.gpu.pct); push('ram', next.ram.pct); push('temp', next.temp.c); push('net', next.net.rxKBs);
    this.emit('sample', next);
    return next;
  }

  snapshot({ history = false } = {}) {
    return { ...this.latest, history: history ? this.history : Object.fromEntries(Object.entries(this.history).map(([key, list]) => [key, list.slice(-40)])) };
  }
}
