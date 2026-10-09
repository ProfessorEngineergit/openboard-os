import { mkdir, readFile, writeFile, rename, open } from 'node:fs/promises';
import { resolve } from 'node:path';

export function validateDrawing(data) {
  if (!data || !Array.isArray(data.strokes) || data.strokes.length > 20000 || typeof data.dark !== 'boolean') throw new Error('Invalid drawing');
  let points = 0;
  for (const stroke of data.strokes) {
    if (stroke.clear === true) continue;
    if (!/^#[0-9a-f]{6}$/i.test(stroke.color) || !Number.isFinite(stroke.width) || stroke.width < 1 || stroke.width > 200 || typeof stroke.erase !== 'boolean' || !Array.isArray(stroke.points) || !stroke.points.length) throw new Error('Invalid stroke');
    points += stroke.points.length;
    if (points > 500000) throw new Error('Drawing is too large');
    for (const point of stroke.points) if (![point.x, point.y].every(n => Number.isFinite(n) && Math.abs(n) <= 100000)) throw new Error('Invalid point');
  }
  return { strokes: data.strokes, dark: data.dark };
}

export class WhiteboardStore {
  constructor(directory) {
    this.directory = directory;
    this.file = resolve(directory, 'current.json');
    this.queue = Promise.resolve();
    this.lastSnapshot = 0;
  }
  async read() {
    try { return JSON.parse(await readFile(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  save(data) {
    const drawing = validateDrawing(data);
    const task = this.queue.catch(() => {}).then(async () => {
      await mkdir(resolve(this.directory, 'snapshots'), { recursive: true, mode: 0o700 });
      const now = Date.now();
      if (now - this.lastSnapshot >= 300000) {
        const name = new Date(now).toISOString().replaceAll(':', '-') + '.json';
        try { await writeFile(resolve(this.directory, 'snapshots', name), await readFile(this.file), { mode: 0o600, flush: true }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        this.lastSnapshot = now;
      }
      const value = { ...drawing, savedAt: new Date(now).toISOString() };
      // A successful save means the drawing reached disk, including the rename.
      await writeFile(this.file + '.tmp', JSON.stringify(value), { mode: 0o600, flush: true });
      await rename(this.file + '.tmp', this.file);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return { ok: true, savedAt: value.savedAt };
    });
    this.queue = task;
    return task;
  }
}
