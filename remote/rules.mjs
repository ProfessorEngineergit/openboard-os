// Pure access rules of the remote console server (no I/O, unit tested in server.test.mjs).
//
// The console is reached through an SSH tunnel (browser: localhost:16080 -> display: 127.0.0.1:6080).
// Everything the browser sends is checked here before anything is forwarded:
//   * Host must be a loopback name on the console port or the tunnel port (DNS rebinding),
//   * Origin, if present, must be exactly http://<host> and Sec-Fetch-Site same-origin/none (CSRF),
//   * only an explicit allow-list of paths reaches the controller (never /api/v1, never the rest).

export const TUNNEL_PORT = 16080;
export const DEFAULT_PORT = 6080;
export const NAMES = ['localhost', '127.0.0.1'];

export function allowedHosts(port = DEFAULT_PORT) {
  const hosts = new Set();
  for (const name of NAMES) for (const p of [port, TUNNEL_PORT]) hosts.add(`${name}:${p}`);
  return hosts;
}

export function hostAllowed(headers, hosts) {
  return typeof headers.host === 'string' && hosts.has(headers.host);
}

// Same-origin check for every request that may change something or read live data.
export function isTrusted(headers, hosts) {
  if (!hostAllowed(headers, hosts)) return false;
  const origin = headers.origin, site = headers['sec-fetch-site'];
  if (origin !== undefined && origin !== `http://${headers.host}`) return false;
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  return true;
}

// WebSocket upgrade: browsers always send Origin, so it is mandatory here.
export function websocketAllowed(headers, hosts) {
  return hostAllowed(headers, hosts) && headers.origin === `http://${headers.host}`;
}

// Normalises the request target. Returns { pathname, search } or null if it is suspicious.
// Dot segments are resolved by the URL parser, encoded slashes, backslashes and NUL are refused.
export function normalizeTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096 || rawUrl[0] !== '/' || rawUrl[1] === '/' || rawUrl[1] === '\\') return null;
  if (/[\\\u0000-\u001f\u007f]/.test(rawUrl) || /%(2f|5c|00|2e)/i.test(rawUrl)) return null;
  let url;
  try { url = new URL(rawUrl, 'http://console.invalid'); } catch { return null; }
  if (url.host !== 'console.invalid') return null;
  try { decodeURIComponent(url.pathname); } catch { return null; }
  return { pathname: url.pathname, search: url.search };
}

export const ACTIONS = new Set(['/api/desktop', '/api/kiosk', '/api/terminal', '/api/chrome-setup']);
export const TAB = /^\/api\/tab\/(gev|home|astra|board)$/;
const API_METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE']);
const READ = new Set(['GET', 'HEAD']);

// What is this request for? kind:
//   health | favicon | redirect-settings | static | action | tab | proxy-api | proxy-static | method-not-allowed | not-found
export function classify(method, pathname) {
  if (pathname === '/favicon.ico') return READ.has(method) ? { kind: 'favicon' } : { kind: 'method-not-allowed' };
  if (pathname === '/health') return READ.has(method) ? { kind: 'health' } : { kind: 'method-not-allowed' };
  if (/^\/settings(\/status)?\/?$/.test(pathname)) return READ.has(method) ? { kind: 'redirect-settings' } : { kind: 'method-not-allowed' };
  if (ACTIONS.has(pathname)) return method === 'POST' ? { kind: 'action', action: pathname.slice(5) } : { kind: 'method-not-allowed' };
  const tab = TAB.exec(pathname);
  if (tab) return method === 'POST' ? { kind: 'tab', app: tab[1] } : { kind: 'method-not-allowed' };
  if (pathname.startsWith('/api/local/') && pathname.length > '/api/local/'.length) return API_METHODS.has(method) ? { kind: 'proxy-api' } : { kind: 'method-not-allowed' };
  if (pathname.startsWith('/ui/') || pathname.startsWith('/apps/settings/') || pathname === '/apps/settings') return READ.has(method) ? { kind: 'proxy-static' } : { kind: 'method-not-allowed' };
  if (pathname === '/' || pathname === '/index.html' || pathname.startsWith('/console/') || pathname.startsWith('/novnc/')) return READ.has(method) ? { kind: 'static' } : { kind: 'method-not-allowed' };
  return { kind: 'not-found' };
}

// Request headers that may be forwarded to the controller. No cookies, no Authorization, no Origin,
// no Sec-Fetch-*: the controller treats a request without Origin as same-origin, which is only
// safe because the check above already happened here.
const FORWARD = ['accept', 'content-type', 'if-none-match', 'if-modified-since', 'last-event-id', 'accept-language'];
export function upstreamHeaders(headers, controllerHost, { bodyLength } = {}) {
  const out = { host: controllerHost, 'accept-encoding': 'identity' };
  for (const name of FORWARD) if (typeof headers[name] === 'string' && headers[name].length < 1024) out[name] = headers[name];
  if (bodyLength != null) out['content-length'] = String(bodyLength);
  return out;
}

// Response headers passed back to the browser (the console adds its own security headers).
const BACK = ['content-type', 'content-length', 'etag', 'last-modified', 'content-disposition'];
export function downstreamHeaders(headers, { stream = false } = {}) {
  const out = {};
  for (const name of BACK) {
    if (stream && name === 'content-length') continue;
    if (typeof headers[name] === 'string') out[name] = headers[name];
  }
  out['cache-control'] = stream ? 'no-store' : (typeof headers['cache-control'] === 'string' ? headers['cache-control'] : 'no-cache');
  return out;
}

export function securityHeaders(hosts) {
  const ws = [...hosts].map(host => `ws://${host}`).join(' ');
  return {
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'content-security-policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${ws}; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  };
}

export const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
