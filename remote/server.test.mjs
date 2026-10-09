// node --test remote/server.test.mjs
// Unit tests for the access rules (rules.mjs) plus integration tests of the proxy against a fake controller.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { allowedHosts, isTrusted, hostAllowed, websocketAllowed, normalizeTarget, classify, upstreamHeaders, downstreamHeaders, securityHeaders } from './rules.mjs';
import { createRemoteServer } from './server.mjs';

// ------------------------------------------------------------------ rules
test('allowed hosts: loopback names on the console and tunnel port only', () => {
  const hosts = allowedHosts(6080);
  assert.deepEqual([...hosts].sort(), ['127.0.0.1:16080', '127.0.0.1:6080', 'localhost:16080', 'localhost:6080']);
  assert.equal(hostAllowed({ host: 'localhost:16080' }, hosts), true);
  for (const host of ['evil.com', 'localhost', 'localhost:4180', '127.0.0.1:4180', '192.0.2.1:6080', 'localhost:6080.evil.com', undefined]) assert.equal(hostAllowed({ host }, hosts), false, String(host));
  assert.ok(allowedHosts(7000).has('localhost:7000'));
});

test('same-origin check: Origin and Sec-Fetch-Site', () => {
  const hosts = allowedHosts(6080), host = 'localhost:16080';
  assert.equal(isTrusted({ host }, hosts), true, 'no Origin (curl, navigation)');
  assert.equal(isTrusted({ host, origin: 'http://localhost:16080' }, hosts), true);
  assert.equal(isTrusted({ host, origin: 'http://localhost:16080', 'sec-fetch-site': 'same-origin' }, hosts), true);
  assert.equal(isTrusted({ host, 'sec-fetch-site': 'none' }, hosts), true);
  assert.equal(isTrusted({ host, origin: 'http://evil.com' }, hosts), false);
  assert.equal(isTrusted({ host, origin: 'null' }, hosts), false);
  assert.equal(isTrusted({ host, origin: 'http://127.0.0.1:16080' }, hosts), false, 'different host name than Host');
  assert.equal(isTrusted({ host, 'sec-fetch-site': 'cross-site' }, hosts), false);
  assert.equal(isTrusted({ host, 'sec-fetch-site': 'same-site' }, hosts), false);
  assert.equal(isTrusted({ host: 'evil.com', origin: 'http://evil.com' }, hosts), false);
});

test('websocket upgrade requires an Origin equal to the host', () => {
  const hosts = allowedHosts(6080);
  assert.equal(websocketAllowed({ host: 'localhost:6080', origin: 'http://localhost:6080' }, hosts), true);
  assert.equal(websocketAllowed({ host: 'localhost:6080' }, hosts), false);
  assert.equal(websocketAllowed({ host: 'localhost:6080', origin: 'http://evil.com' }, hosts), false);
});

test('target normalisation refuses traversal and tricks', () => {
  assert.deepEqual(normalizeTarget('/api/local/state?x=1'), { pathname: '/api/local/state', search: '?x=1' });
  assert.equal(normalizeTarget('/api/local/../v1/state').pathname, '/api/v1/state', 'dot segments are resolved before classification');
  for (const bad of ['//evil.com/x', '/\\evil', '/api/local/%2e%2e/v1/state', '/ui/a%2fb', '/ui/a%5cb', '/ui/%00', '/ui/\u0000', 'http://evil.com/', '*', '', '/%E0%A4%A']) assert.equal(normalizeTarget(bad), null, JSON.stringify(bad));
  assert.equal(normalizeTarget('/' + 'a'.repeat(5000)), null);
});

test('path allow-list', () => {
  const kind = (method, path) => classify(method, normalizeTarget(path).pathname).kind;
  assert.equal(kind('GET', '/'), 'static');
  assert.equal(kind('GET', '/console/console.js'), 'static');
  assert.equal(kind('GET', '/novnc/core/rfb.js'), 'static');
  assert.equal(kind('GET', '/health'), 'health');
  assert.equal(kind('GET', '/settings'), 'redirect-settings');
  assert.equal(kind('GET', '/settings/status'), 'redirect-settings');
  assert.equal(kind('POST', '/api/desktop'), 'action');
  assert.equal(kind('POST', '/api/chrome-setup'), 'action');
  assert.equal(kind('GET', '/api/desktop'), 'method-not-allowed');
  assert.equal(kind('POST', '/api/tab/gev'), 'tab');
  assert.equal(kind('POST', '/api/tab/evil'), 'not-found');
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']) assert.equal(kind(method, '/api/local/config'), 'proxy-api', method);
  assert.equal(kind('GET', '/api/local/events?metrics=1'), 'proxy-api');
  assert.equal(kind('OPTIONS', '/api/local/config'), 'method-not-allowed');
  assert.equal(kind('TRACE', '/api/local/config'), 'method-not-allowed');
  assert.equal(kind('GET', '/ui/tokens.css'), 'proxy-static');
  assert.equal(kind('GET', '/apps/settings/settings.js'), 'proxy-static');
  assert.equal(kind('POST', '/ui/tokens.css'), 'method-not-allowed');
  assert.equal(kind('PUT', '/apps/settings/x'), 'method-not-allowed');
  // never reachable
  for (const path of ['/api/v1/state', '/api/v1/apps/gev/activate', '/api/v1/say', '/api/local', '/api/local/../v1/state', '/health/x', '/apps/board/', '/apps/astra/index.html', '/apps/settingsx/', '/uix/a', '/api/state', '/api/tabs/gev/activate', '/server.mjs', '/rules.mjs', '/server.test.mjs', '/index.htm', '/gev', '/whiteboard', '/astra']) {
    assert.equal(kind('GET', path), 'not-found', path);
    assert.equal(kind('POST', path), 'not-found', path);
  }
});

test('forwarded headers: allow-list only, Host rewritten, no Origin/Authorization/cookies', () => {
  const out = upstreamHeaders({
    host: 'localhost:16080', origin: 'http://localhost:16080', authorization: 'Bearer secret', cookie: 'a=b', 'sec-fetch-site': 'same-origin',
    'x-forwarded-for': '1.2.3.4', accept: 'text/event-stream', 'content-type': 'application/json', 'accept-encoding': 'gzip', 'last-event-id': '7',
  }, '127.0.0.1:4180', { bodyLength: 12 });
  assert.deepEqual(out, { host: '127.0.0.1:4180', 'accept-encoding': 'identity', accept: 'text/event-stream', 'content-type': 'application/json', 'last-event-id': '7', 'content-length': '12' });
});

test('response headers: allow-list, streams never cached', () => {
  const out = downstreamHeaders({ 'content-type': 'text/css', 'set-cookie': 'x=1', 'content-security-policy': 'x', 'content-length': '5', etag: '"a"' });
  assert.deepEqual(out, { 'content-type': 'text/css', 'content-length': '5', etag: '"a"', 'cache-control': 'no-cache' });
  const stream = downstreamHeaders({ 'content-type': 'text/event-stream', 'content-length': '9', 'cache-control': 'max-age=5' }, { stream: true });
  assert.equal(stream['cache-control'], 'no-store');
  assert.equal(stream['content-length'], undefined);
});

test('CSP: scripts only from self, websockets only to the console hosts', () => {
  const csp = securityHeaders(allowedHosts(6080))['content-security-policy'];
  assert.match(csp, /script-src 'self';/);
  assert.match(csp, /connect-src 'self' ws:\/\/localhost:6080/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline/);
});

// ------------------------------------------------------------------ integration
function request(port, { method = 'GET', path = '/', headers = {}, body, host = `localhost:${port}`, stream } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...(body != null ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers }, agent: false }, res => {
      if (stream) return resolve({ status: res.statusCode, headers: res.headers, res, req });
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function fakeController() {
  const seen = [];
  const streams = new Set();
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url.startsWith('/api/local/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('event: state\ndata: {"n":1}\n\n');
      streams.add(res); res.on('close', () => streams.delete(res));
      return;
    }
    if (req.url === '/api/local/slow') return; // never answers
    if (req.url === '/ui/tokens.css') { res.writeHead(200, { 'content-type': 'text/css', 'set-cookie': 'x=1', 'content-security-policy': "default-src 'none'" }); return res.end('/* controller css */'); }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, received: Buffer.concat(chunks).length })); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, streams, port: server.address().port, close: () => new Promise(resolve => { for (const res of streams) res.destroy(); server.closeAllConnections(); server.close(resolve); }) };
}

test('proxy', async t => {
  const controller = await fakeController();
  const remote = createRemoteServer({ port: 0, controller: `http://127.0.0.1:${controller.port}`, vncPort: 1 });
  const port = await remote.listen(0);
  t.after(async () => { await remote.close(); await controller.close(); });

  await t.test('console and health', async () => {
    const index = await request(port, { path: '/' });
    assert.equal(index.status, 200);
    assert.match(index.headers['content-type'], /text\/html/);
    assert.match(index.headers['content-security-policy'], /script-src 'self'/);
    assert.equal(index.headers['x-frame-options'], 'DENY');
    const health = await request(port, { path: '/health' });
    assert.equal(health.json.ok, true);
    assert.equal(typeof health.json.novnc, 'boolean');
    assert.equal((await request(port, { path: '/console/console.js' })).status, 200);
    assert.equal((await request(port, { path: '/server.mjs' })).status, 404);
    assert.equal((await request(port, { path: '/console/../server.mjs' })).status, 404, 'dot segments normalised, then not on the allow-list');
    assert.equal((await request(port, { path: '/console/%2e%2e/server.mjs' })).status, 400);
    assert.equal((await request(port, { path: '/novnc/missing.js' })).status, 404);
  });

  await t.test('invalid host is refused everywhere', async () => {
    for (const path of ['/', '/health', '/api/local/state', '/ui/tokens.css']) assert.equal((await request(port, { path, host: 'evil.com' })).status, 403, path);
    assert.equal((await request(port, { path: '/api/local/state', host: 'localhost:4180' })).status, 403);
    assert.equal(controller.seen.length, 0, 'nothing reached the controller');
  });

  await t.test('foreign Origin / cross-site requests are refused with 403', async () => {
    const before = controller.seen.length;
    for (const headers of [{ origin: 'http://evil.com' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      assert.equal((await request(port, { path: '/api/local/state', headers })).status, 403, JSON.stringify(headers));
      assert.equal((await request(port, { method: 'POST', path: '/api/local/display/sleep', headers, body: '{}' })).status, 403);
      assert.equal((await request(port, { method: 'POST', path: '/api/desktop', headers })).status, 403);
      assert.equal((await request(port, { path: '/ui/tokens.css', headers })).status, 403);
    }
    assert.equal(controller.seen.length, before);
  });

  await t.test('token API and everything off the allow-list is not reachable', async () => {
    const before = controller.seen.length;
    for (const path of ['/api/v1/state', '/api/v1/say', '/api/local/../v1/state', '/apps/board/', '/api/state', '/api/local']) {
      const response = await request(port, { path, headers: { authorization: 'Bearer x' } });
      assert.ok([404, 403].includes(response.status), `${path} -> ${response.status}`);
    }
    assert.equal((await request(port, { method: 'POST', path: '/api/v1/apps/gev/activate' })).status, 404);
    assert.equal((await request(port, { path: '//evil.com/x' })).status, 400);
    assert.equal(controller.seen.length, before, 'nothing reached the controller');
  });

  await t.test('api requests are forwarded with Host rewritten and without Origin/Authorization', async () => {
    const response = await request(port, {
      method: 'PATCH', path: '/api/local/config?x=1', body: '{"a":1}',
      headers: { origin: `http://localhost:${port}`, 'sec-fetch-site': 'same-origin', authorization: 'Bearer secret', cookie: 'a=b', 'content-type': 'application/json', 'content-length': '7' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.received, 7);
    const last = controller.seen.at(-1);
    assert.equal(last.method, 'PATCH');
    assert.equal(last.url, '/api/local/config?x=1');
    assert.equal(last.headers.host, `127.0.0.1:${controller.port}`);
    for (const name of ['origin', 'authorization', 'cookie', 'sec-fetch-site']) assert.equal(last.headers[name], undefined, name);
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) assert.equal((await request(port, { method, path: '/api/local/board/boards', body: method === 'GET' ? undefined : '{}' })).status, 200, method);
  });

  await t.test('request body limit', async () => {
    const big = 'x'.repeat(1024 * 1024 + 10);
    const response = await request(port, { method: 'POST', path: '/api/local/config/test/astra', body: big, headers: { 'content-type': 'application/json', 'content-length': String(big.length) } });
    assert.equal(response.status, 413);
  });

  await t.test('static files: controller answer passes through without its cookies/CSP, console CSP is applied', async () => {
    const css = await request(port, { path: '/ui/tokens.css', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(css.status, 200);
    assert.equal(css.text, '/* controller css */');
    assert.equal(css.headers['set-cookie'], undefined);
    assert.match(css.headers['content-security-policy'], /script-src 'self'/);
  });

  await t.test('settings redirect', async () => {
    for (const path of ['/settings', '/settings/status']) {
      const response = await request(port, { path });
      assert.equal(response.status, 302);
      assert.equal(response.headers.location, '/#einstellungen');
    }
    assert.equal((await request(port, { method: 'POST', path: '/settings' })).status, 405);
  });

  await t.test('SSE is streamed unbuffered and closes with the client', async () => {
    const { res, req, status, headers } = await request(port, { path: '/api/local/events?metrics=1', stream: true, headers: { accept: 'text/event-stream' } });
    assert.equal(status, 200);
    assert.match(headers['content-type'], /text\/event-stream/);
    assert.equal(headers['cache-control'], 'no-store');
    assert.equal(controller.seen.at(-1).url, '/api/local/events?metrics=1');
    const next = () => new Promise(resolve => res.once('data', chunk => resolve(chunk.toString())));
    assert.match(await next(), /event: state/);        // first event arrives while the stream is still open
    const second = next();
    controller.streams.values().next().value.write('event: metrics\ndata: {"n":2}\n\n');
    assert.match(await second, /event: metrics/);      // and so does a later one, immediately
    req.destroy();
    for (let i = 0; i < 40 && controller.streams.size; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(controller.streams.size, 0, 'upstream stream closed after the client left');
  });

  await t.test('websocket: foreign or missing Origin is refused, other paths too', async () => {
    const upgrade = (path, origin) => new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: localhost:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${origin ? `Origin: ${origin}\r\n` : ''}\r\n`));
      let data = ''; socket.on('data', chunk => { data += chunk; if (data.includes('\r\n')) { socket.destroy(); } }); socket.on('close', () => resolve(data)); socket.setTimeout(3000, () => socket.destroy());
    });
    assert.match(await upgrade('/websockify', 'http://evil.com'), /^HTTP\/1.1 403/);
    assert.match(await upgrade('/websockify'), /^HTTP\/1.1 403/);
    assert.match(await upgrade('/api/local/events', `http://localhost:${port}`), /^HTTP\/1.1 403/);
    assert.match(await upgrade('/websockify', `http://localhost:${port}`), /^HTTP\/1.1 101/);
  });

  await t.test('controller down: api answers 502 offline, static UI is served from the checkout, console and actions still work', async () => {
    await controller.close();
    const api = await request(port, { path: '/api/local/state' });
    assert.equal(api.status, 502);
    assert.equal(api.json.offline, true);
    const events = await request(port, { path: '/api/local/events?metrics=1' });
    assert.equal(events.status, 502);
    const css = await request(port, { path: '/ui/tokens.css' });
    assert.equal(css.status, 200);
    assert.match(css.text, /--ob-bg/);
    assert.equal((await request(port, { path: '/apps/settings/settings.js' })).status, 200);
    assert.equal((await request(port, { path: '/ui/../../etc/passwd' })).status, 404);
    assert.equal((await request(port, { path: '/' })).status, 200);
    assert.equal((await request(port, { path: '/health' })).json.ok, true);
    assert.equal((await request(port, { method: 'POST', path: '/api/tab/gev' })).status, 502);
  });
});
