// Host integration: screen power, DDC/CI brightness, audio volume, services.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { STATE_DIR } from './updates.mjs';

const run = promisify(execFile);
const X11 = () => ({ ...process.env, DISPLAY: process.env.DISPLAY || ':0', XAUTHORITY: process.env.XAUTHORITY || `${process.env.HOME}/.Xauthority` });

async function tryRun(command, args, options = {}) {
  try { return (await run(command, args, { timeout: 8000, env: X11(), ...options })).stdout; }
  catch { return null; }
}

export function parseWpctl(text) {
  const match = /Volume:\s*([\d.]+)(\s*\[MUTED\])?/.exec(text || '');
  return match ? { volume: Math.round(Number(match[1]) * 100), muted: !!match[2] } : null;
}

export function parsePactl(volumeText, muteText) {
  const match = /(\d+)%/.exec(volumeText || '');
  return match ? { volume: Number(match[1]), muted: /yes/i.test(muteText || '') } : null;
}

export class SystemControl {
  constructor({ base }) { this.base = base; this.audio = null; this.brightness = null; this.ddcAvailable = null; }

  // Screen power. "black" is handled by the shell; DPMS turns the signal off.
  async screen(on, mode) {
    if (mode !== 'dpms') return;
    if (on) { await tryRun('xset', ['dpms', 'force', 'on']); await tryRun('xset', ['-dpms']); await tryRun('xset', ['s', 'off']); }
    else { await tryRun('xset', ['+dpms']); await tryRun('xset', ['dpms', 'force', 'off']); }
  }

  async readAudio() {
    const wp = parseWpctl(await tryRun('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@']));
    if (wp) { this.audio = { ...wp, tool: 'wpctl' }; return this.audio; }
    const pa = parsePactl(await tryRun('pactl', ['get-sink-volume', '@DEFAULT_SINK@']), await tryRun('pactl', ['get-sink-mute', '@DEFAULT_SINK@']));
    this.audio = pa ? { ...pa, tool: 'pactl' } : null;
    return this.audio;
  }

  async setVolume({ value, step, toggleMute }) {
    const current = this.audio || await this.readAudio();
    if (!current) throw new Error('Keine Audioausgabe gefunden');
    if (toggleMute) {
      if (current.tool === 'wpctl') await tryRun('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', 'toggle']);
      else await tryRun('pactl', ['set-sink-mute', '@DEFAULT_SINK@', 'toggle']);
    } else {
      const target = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : current.volume + (step || 0))));
      if (current.tool === 'wpctl') { await tryRun('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', (target / 100).toFixed(2)]); await tryRun('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', '0']); }
      else { await tryRun('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${target}%`]); await tryRun('pactl', ['set-sink-mute', '@DEFAULT_SINK@', '0']); }
    }
    return this.readAudio();
  }

  // DDC/CI (VCP 0x10). Requires ddcutil and i2c access; many large panels support it.
  async readBrightness() {
    const out = await tryRun('ddcutil', ['--brief', 'getvcp', '10'], { timeout: 6000 });
    const match = /VCP 10 C (\d+) (\d+)/.exec(out || '');
    this.ddcAvailable = !!match;
    this.brightness = match ? Math.round((Number(match[1]) / Number(match[2])) * 100) : null;
    return this.brightness;
  }

  async setBrightness({ value, step }) {
    const current = this.brightness ?? await this.readBrightness();
    if (current == null) throw new Error('Helligkeit per DDC/CI nicht verfügbar');
    const target = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : current + (step || 0))));
    if (await tryRun('ddcutil', ['setvcp', '10', String(target)], { timeout: 6000 }) == null) throw new Error('DDC/CI-Befehl fehlgeschlagen');
    this.brightness = target;
    return target;
  }

  // Writes the wish to the state file and lets the display watcher apply it
  // (xrandr rotation + touch matrix live in scripts/reconnect-display.py).
  async setOrientation(orientation, { apply = true } = {}) {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(resolve(STATE_DIR, 'orientation'), orientation);
    if (!apply) return;
    await run('python3', [resolve(this.base, 'scripts/reconnect-display.py'), '--once'], { timeout: 20000, env: { ...X11(), OPENBOARD_STATE_DIR: STATE_DIR } }).catch(error => { throw new Error(`Drehen fehlgeschlagen: ${error.stderr?.trim() || error.message}`); });
  }

  async service(action, unit) {
    await run('systemctl', ['--user', action, unit], { timeout: 20000 });
  }

  async exitKiosk() { await run('bash', [resolve(this.base, 'scripts/stop-kiosk.sh')], { timeout: 20000, env: X11() }); }
}
