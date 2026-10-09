// Minimal HTTP router shared by every OpenBoard module.
// Access levels:
//   public - any request with a valid local Host header
//   local  - additionally same-origin (Origin / Sec-Fetch-Site), used by built-in apps
//   token  - Bearer token from kiosk/api-token, used by assistants and scripts
import { timingSafeEqual } from 'node:crypto';

// The controller port is 4180; OPENBOARD_PORT exists for isolated test runs.
export const PORT = Number(process.env.OPENBOARD_PORT || 4180);
export const LOCAL_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, 'localhost:14180', '127.0.0.1:14180']);

export function sameOrigin(req) {
  const host = req.headers.host, origin = req.headers.origin, site = req.headers['sec-fetch-site'];
  // The remote console proxies through loopback and marks itself as same-origin.
  return LOCAL_HOSTS.has(host) && (!origin || origin === `http://${host}`) && (!site || site === 'same-origin' || site === 'none');
}

export function bearer(req, token) {
  const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, '') || '');
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function compile(pattern) {
  const keys = [];
  const source = pattern.replace(/\/:([a-zA-Z_]+)(\*)?/g, (_, key, rest) => { keys.push(key); return rest ? '/(.*)' : '/([^/]+)'; });
  return { regex: new RegExp(`^${source}$`), keys };
}

export function createRouter({ token }) {
  const routes = [];
  const add = method => (pattern, handler, { access = 'local', limit = 64 * 1024 } = {}) => {
    routes.push({ method, ...compile(pattern), handler, access, limit });
  };
  async function handle(req, res) {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (!LOCAL_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'Invalid host' });
    for (const route of routes) {
      if (route.method !== req.method && !(route.method === 'GET' && req.method === 'HEAD')) continue;
      const match = route.regex.exec(url.pathname);
      if (!match) continue;
      if (route.access === 'local' && !sameOrigin(req)) return send(res, 403, { error: 'Same-origin required' });
      if (route.access === 'token' && !bearer(req, token())) return send(res, 401, { error: 'Bearer token required' });
      const params = Object.fromEntries(route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
      const ctx = {
        req, res, url, params,
        raw: () => readBody(req, route.limit),
        body: async () => { const raw = await readBody(req, route.limit); return raw.length ? JSON.parse(raw.toString('utf8')) : {}; },
        json: (status, data) => send(res, status, data),
      };
      try {
        const result = await route.handler(ctx);
        if (result !== undefined && !res.headersSent) send(res, 200, result);
      } catch (error) {
        if (!res.headersSent) send(res, error.status || 400, { error: error.message });
        else res.end();
      }
      return;
    }
    send(res, 404, { error: 'Not found' });
  }
  return { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE'), handle };
}

export async function readBody(req, limit) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new HttpError(413, 'Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Server-sent events with heartbeat. Returns { send(type, data), closed }.
export function openStream(ctx) {
  const { req, res } = ctx;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 2000\n\n');
  let open = true;
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
  const stream = {
    send(type, data) { if (open) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); },
    get closed() { return !open; },
    onClose: null,
  };
  req.on('close', () => { open = false; clearInterval(heartbeat); stream.onClose?.(); });
  return stream;
}
