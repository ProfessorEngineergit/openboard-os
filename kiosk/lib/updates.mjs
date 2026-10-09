// Update status and post-update actions. The update itself runs in
// scripts/update.sh (systemd timer) so it can restart this controller.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const run = promisify(execFile);
export const STATE_DIR = process.env.OPENBOARD_STATE_DIR || resolve(homedir(), '.local/state/openboard');

async function git(base, ...args) {
  try { return (await run('git', ['-C', base, ...args], { timeout: 15000 })).stdout.trim(); } catch { return null; }
}

export class Updates {
  constructor({ base, dataDir }) { this.base = base; this.dataDir = dataDir; this.version = 'dev'; this.changedSinceLastRun = []; }

  async init() {
    this.version = (await git(this.base, 'rev-parse', '--short=10', 'HEAD')) || 'dev';
    const marker = resolve(this.dataDir, 'last-version');
    const previous = (await readFile(marker, 'utf8').catch(() => '')).trim();
    if (previous && previous !== this.version) {
      const diff = await git(this.base, 'diff', '--name-only', previous, this.version);
      this.changedSinceLastRun = diff ? diff.split('\n').filter(Boolean) : ['*'];
    }
    await writeFile(marker, this.version).catch(() => {});
    return this;
  }

  // Built-in apps whose files changed since the last controller run.
  changedApps(apps) {
    if (!this.changedSinceLastRun.length) return [];
    const all = this.changedSinceLastRun.includes('*');
    const uiChanged = all || this.changedSinceLastRun.some(file => file.startsWith('kiosk/ui/'));
    return apps.filter(app => app.builtin).filter(app => {
      const dir = new URL(app.url).pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      return uiChanged || this.changedSinceLastRun.some(file => file.startsWith(`kiosk/${dir}/`));
    }).map(app => app.id);
  }

  async status() {
    const state = JSON.parse(await readFile(resolve(STATE_DIR, 'update.json'), 'utf8').catch(() => '{}'));
    return {
      current: this.version, available: !!state.available, lastCheck: state.lastCheck || 0, lastResult: state.lastResult || null,
      lastUpdate: state.lastUpdate || null, previous: state.previous || null, message: state.message || null,
      pendingBrowserRestart: !!state.pendingBrowserRestart,
    };
  }

  async clearBrowserRestart() {
    const file = resolve(STATE_DIR, 'update.json');
    const state = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    if (!state.pendingBrowserRestart) return;
    state.pendingBrowserRestart = false;
    await writeFile(file, JSON.stringify(state, null, 2)).catch(() => {});
  }

  async log(lines = 200) {
    const text = await readFile(resolve(STATE_DIR, 'update.log'), 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).slice(-lines);
  }

  async check() {
    await run('systemctl', ['--user', 'start', '--no-block', 'openboard-update.service'], { timeout: 10000 });
  }
}
