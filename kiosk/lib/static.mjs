import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg',
};

// Built-in apps load only their own code. Inline styles stay allowed for React/Excalidraw.
export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'";

// Serves files below `root`. Directory requests resolve to index.html.
export function serveDirectory(root, { csp = APP_CSP, cache = 'no-cache' } = {}) {
  const base = resolve(root);
  return async ctx => {
    const relative = decodeURIComponent(ctx.params.path || '');
    let file = resolve(base, relative);
    if (file !== base && !file.startsWith(base + sep)) return ctx.json(403, { error: 'Invalid path' });
    try {
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const data = await readFile(file);
      ctx.res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': cache, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY',
        'content-security-policy': csp,
      });
      ctx.res.end(ctx.req.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return ctx.json(404, { error: 'Not found' });
      throw error;
    }
  };
}
