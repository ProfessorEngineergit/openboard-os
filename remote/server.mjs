// OpenBoard remote console: desktop console, VNC proxy and a narrow reverse proxy to the controller.
//
//   node remote/server.mjs
//   OPENBOARD_CONTROLLER=http://127.0.0.1:4180   controller base URL (loopback)
//   OPENBOARD_REMOTE_PORT=6080                   listen port (loopback only), e.g. for tests
//   OPENBOARD_VNC_PORT=5900                      VNC server behind /websockify
//
// Reached through an SSH tunnel only (browser http://localhost:16080/ -> 127.0.0.1:6080).
//   /                    the console (remote/index.html, remote/console/*)
//   /novnc/*             noVNC (installed by scripts/install-remote-services.sh, not part of the repository)
//   /websockify          WebSocket proxy to the VNC server on 127.0.0.1:5900
//   /api/desktop|kiosk|terminal|chrome-setup, /api/tab/<id>   POST actions (scripts/*.sh)
//   /api/local/*         controller API incl. SSE (/api/local/events), streamed unbuffered
//   /ui/*, /apps/settings/*   shared UI kit and the settings module (served from the repository if the controller is down)
//   /settings            redirect into the console's settings section
// Nothing else reaches the controller: never /api/v1 (token API), never other paths. See rules.mjs.
import http from 'node:http';
import net from 'node:net';
import { readFile, stat, access } from 'node:fs/promises';
import { resolve, dirname, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { allowedHosts, hostAllowed, isTrusted, websocketAllowed, normalizeTarget, classify, upstreamHeaders, downstreamHeaders, securityHeaders, MIME, DEFAULT_PORT } from './rules.mjs';

const require = createRequire(new URL('../kiosk/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

const BODY_LIMIT = 1024 * 1024;          // largest request body forwarded to the controller
const API_TIMEOUT = 20000;               // controller must answer within 20 s
const STREAM_IDLE = 70000;               // SSE: the controller pings every 20 s; silence for 70 s means a dead stream
const MAX_STREAMS = 8;                   // concurrent SSE streams through this proxy
const ACTION_TIMEOUT = 60000;

export function createRemoteServer({
  port = Number(process.env.OPENBOARD_REMOTE_PORT) || DEFAULT_PORT,
  controller = process.env.OPENBOARD_CONTROLLER || 'http://127.0.0.1:4180',
  vncPort = Number(process.env.OPENBOARD_VNC_PORT) || 5900,
  root = here,
  kioskRoot = resolve(repo, 'kiosk'),
  actions = true,
} = {}) {
  const upstream = new URL(controller);
  if (upstream.protocol !== 'http:') throw new Error('OPENBOARD_CONTROLLER must be an http:// URL');
  const hosts = allowedHosts(port);
  const common = securityHeaders(hosts);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
  let streams = 0;

  const send = (res, status, data, extra = {}) => {
    if (res.headersSent) return res.end();
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...common, ...extra });
    res.end(JSON.stringify(data));
  };

  // ------------------------------------------------------------ static files
  async function serveFile(req, res, base, relative, { index = true } = {}) {
    const dir = resolve(base);
    let file = resolve(dir, relative);
    if (file !== dir && !file.startsWith(dir + sep)) return send(res, 403, { error: 'Invalid path' });
    let info;
    try { info = await stat(file); } catch { return send(res, 404, { error: 'Not found' }); }
    if (info.isDirectory()) {
      if (!index) return send(res, 404, { error: 'Not found' });
      file = resolve(file, 'index.html');
      try { info = await stat(file); } catch { return send(res, 404, { error: 'Not found' }); }
    }
    const data = req.method === 'HEAD' ? null : await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store', ...common });
    res.end(data);
  }

  // ------------------------------------------------------------ controller proxy
  async function readBody(req) {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > BODY_LIMIT) throw Object.assign(new Error('Request too large'), { status: 413 });
    const chunks = []; let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > BODY_LIMIT) throw Object.assign(new Error('Request too large'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Resolves to { offline: true } if the controller cannot be reached (so callers can fall back).
  function forward(req, res, { pathname, search, body, cacheFallback }) {
    return new Promise(resolvePromise => {
      const headers = upstreamHeaders(req.headers, upstream.host, { bodyLength: body?.length });
      const isEvents = pathname === '/api/local/events';
      if (isEvents && streams >= MAX_STREAMS) { send(res, 429, { error: 'Too many streams' }); return resolvePromise({}); }
      const proxyReq = http.request({
        hostname: upstream.hostname, port: upstream.port || 80, method: req.method === 'HEAD' ? 'HEAD' : req.method,
        path: pathname + search, headers, agent: isEvents ? false : agent,
      });
      let settled = false, counted = false;
      const done = value => { if (!settled) { settled = true; resolvePromise(value); } };
      proxyReq.setTimeout(API_TIMEOUT, () => proxyReq.destroy(Object.assign(new Error('Controller timeout'), { code: 'ETIMEDOUT' })));
      proxyReq.on('response', upstreamRes => {
        const type = String(upstreamRes.headers['content-type'] || '');
        const stream = type.startsWith('text/event-stream');
        const out = downstreamHeaders(upstreamRes.headers, { stream });
        const location = upstreamRes.headers.location;
        if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && typeof location === 'string' && location[0] === '/' && location[1] !== '/') out.location = location;
        if (stream) {
          counted = true; streams++;
          proxyReq.setTimeout(0);
          upstreamRes.socket?.setNoDelay?.(true);
          upstreamRes.socket?.setTimeout(STREAM_IDLE, () => upstreamRes.destroy());
          out['x-accel-buffering'] = 'no'; out.connection = 'keep-alive';
          res.socket?.setNoDelay?.(true);
        }
        res.writeHead(upstreamRes.statusCode, { ...out, ...common });
        if (stream) res.flushHeaders();
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => res.destroy());
        res.on('close', () => { upstreamRes.destroy(); proxyReq.destroy(); });
        upstreamRes.on('close', () => { if (counted) { counted = false; streams--; } res.end(); done({}); });
      });
      proxyReq.on('error', error => {
        if (counted) { counted = false; streams--; }
        if (res.headersSent) { res.destroy(); return done({}); }
        const offline = ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'EPIPE'].includes(error.code);
        if (offline && cacheFallback) return done({ offline: true });
        send(res, offline ? 502 : 504, { error: offline ? 'Controller nicht erreichbar' : 'Controller antwortet nicht', offline });
        done({});
      });
      res.on('close', () => { if (!res.writableEnded) proxyReq.destroy(); });
      proxyReq.end(body && body.length ? body : undefined);
    });
  }

  // Static files of the shared UI come from the controller; if it is down the same files are
  // served from the checkout the console runs from, so the console still renders.
  function diskFallback(req, res, pathname) {
    if (pathname.startsWith('/ui/')) return serveFile(req, res, resolve(kioskRoot, 'ui'), decodeURIComponent(pathname.slice(4)), { index: false });
    const m = /^\/apps\/settings\/(.*)$/.exec(pathname);
    if (m) return serveFile(req, res, resolve(kioskRoot, 'apps/settings'), decodeURIComponent(m[1]));
    return send(res, 502, { error: 'Controller nicht erreichbar', offline: true });
  }

  // ------------------------------------------------------------ actions (old behaviour)
  const script = name => resolve(repo, 'scripts', name);
  const terminalEnv = () => ({ ...process.env, DISPLAY: ':0', XAUTHORITY: `${process.env.HOME}/.Xauthority` });
  async function runAction(action) {
    if (action === 'desktop') return run('bash', [script('stop-kiosk.sh')], { timeout: ACTION_TIMEOUT });
    if (action === 'kiosk') return run('bash', [script('start-kiosk.sh')], { timeout: ACTION_TIMEOUT });
    if (action === 'terminal') {
      await run('bash', [script('stop-kiosk.sh')], { timeout: ACTION_TIMEOUT });
      execFile('/usr/bin/xfce4-terminal', [], { env: terminalEnv() }, () => {});
      return;
    }
    if (action === 'chrome-setup') {
      await run('bash', [script('stop-kiosk.sh')], { timeout: ACTION_TIMEOUT });
      execFile('/usr/bin/xfce4-terminal', ['--execute', '/usr/bin/bash', script('setup-chrome-interactive.sh')], { env: terminalEnv() }, () => {});
    }
  }

  // ------------------------------------------------------------ http
  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers, hosts)) return send(res, 403, { error: 'Invalid host' });
      const target = normalizeTarget(req.url);
      if (!target) return send(res, 400, { error: 'Invalid path' });
      const { pathname, search } = target;
      const route = classify(req.method, pathname);
      switch (route.kind) {
        case 'method-not-allowed': return send(res, 405, { error: 'Method not allowed' });
        case 'not-found': return send(res, 404, { error: 'Not found' });
        case 'favicon': res.writeHead(204, { 'cache-control': 'max-age=86400', ...common }); return res.end();
        case 'health': {
          const novnc = await access(resolve(root, 'novnc/core/rfb.js')).then(() => true, () => false);
          return send(res, 200, { ok: true, transport: 'SSH tunnel only', novnc, controller: upstream.origin });
        }
        case 'redirect-settings':
          res.writeHead(302, { location: '/#einstellungen', 'cache-control': 'no-store', ...common });
          return res.end();
        case 'static':
          return await serveFile(req, res, root, pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1));
      }
      // Everything below is same-origin only.
      if (!isTrusted(req.headers, hosts)) return send(res, 403, { error: 'Same-origin required' });
      if (route.kind === 'action' || route.kind === 'tab') {
        if (!actions) return send(res, 404, { error: 'Unknown action' });
        if (route.kind === 'tab') {
          // Old per-app buttons: now routed through the local API (no bearer token needed).
          const result = await forwardJson(`/api/local/apps/${route.app}/activate`);
          return send(res, result.status, result.body);
        }
        try { await runAction(route.action); } catch (error) { return send(res, 500, { error: String(error.stderr || error.message || 'Aktion fehlgeschlagen').trim().split('\n').pop().slice(0, 300) }); }
        return send(res, 200, { ok: true });
      }
      if (route.kind === 'proxy-api') {
        const body = ['GET', 'HEAD'].includes(req.method) ? null : await readBody(req);
        await forward(req, res, { pathname, search, body });
        return;
      }
      if (route.kind === 'proxy-static') {
        if (pathname === '/apps/settings') { res.writeHead(302, { location: '/apps/settings/', ...common }); return res.end(); }
        const result = await forward(req, res, { pathname, search, cacheFallback: true });
        if (result.offline) await diskFallback(req, res, pathname);
        return;
      }
      return send(res, 404, { error: 'Not found' });
    } catch (error) {
      send(res, error.status || (error.code === 'ENOENT' ? 404 : 500), { error: error.status ? error.message : error.code === 'ENOENT' ? 'Not found' : 'Internal error' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;

  // Small JSON POST to the controller on behalf of the old per-app buttons.
  function forwardJson(pathname) {
    return new Promise(resolvePromise => {
      const request = http.request({ hostname: upstream.hostname, port: upstream.port || 80, method: 'POST', path: pathname, headers: { host: upstream.host, 'content-length': '0' }, agent, timeout: API_TIMEOUT }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => { let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; } resolvePromise({ status: response.statusCode, body }); });
      });
      request.on('timeout', () => request.destroy(new Error('timeout')));
      request.on('error', () => resolvePromise({ status: 502, body: { error: 'Controller nicht erreichbar', offline: true } }));
      request.end();
    });
  }

  // ------------------------------------------------------------ VNC websocket
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const target = normalizeTarget(req.url);
    if (!target || target.pathname !== '/websockify' || !websocketAllowed(req.headers, hosts)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const tcp = net.createConnection({ host: '127.0.0.1', port: vncPort });
      ws.on('message', data => tcp.write(data));
      tcp.on('data', data => { if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true }); });
      tcp.on('error', () => ws.close(1011, 'VNC unavailable'));
      tcp.on('end', () => ws.close());
      ws.on('close', () => tcp.destroy());
      ws.on('error', () => tcp.destroy());
    });
  });

  return {
    server, hosts, upstream,
    listen: (listenPort = port) => new Promise((ok, fail) => {
      server.once('error', fail);
      server.listen(listenPort, '127.0.0.1', () => {
        server.off('error', fail);
        // An ephemeral port (tests) is a valid console host as well.
        const actual = server.address().port;
        for (const name of ['localhost', '127.0.0.1']) hosts.add(`${name}:${actual}`);
        Object.assign(common, securityHeaders(hosts));
        ok(actual);
      });
    }),
    close: () => new Promise(ok => { agent.destroy(); server.closeAllConnections?.(); server.close(() => ok()); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const remote = createRemoteServer();
  remote.listen().then(port => console.log(`Remote console on loopback:${port}; access through SSH. Controller: ${remote.upstream.origin}`)).catch(error => { console.error(error.message); process.exit(1); });
}
