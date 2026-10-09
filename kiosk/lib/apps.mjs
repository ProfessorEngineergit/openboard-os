// App manager: one browser tab per app inside the kiosk window, the shell in
// every top-level page, Home Assistant navigation without reloads, popup capture
// and the lifecycle primitives (freeze, resume, terminate) used by lifecycle.mjs.
import { EventEmitter } from 'node:events';
import puppeteer from 'puppeteer';

const DEBUG_PORT = Number(process.env.OPENBOARD_DEBUG_PORT || 9222);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const originOf = url => { try { return new URL(url).origin; } catch { return null; } };

// Runs inside apps with zoom != 1. The shell host is a sibling of <body> and stays unscaled.
function zoomScript(zoom) {
  const apply = () => {
    if (!document.body) return;
    document.body.style.zoom = String(zoom);
    document.body.style.minHeight = `${100 / zoom}vh`;
    document.body.style.height = `${100 / zoom}vh`;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
}

// Home Assistant is a single-page app. Links that would open a new window are
// routed through its own router (history + "location-changed"), never a reload.
function spaNavigationScript() {
  if (window.__openboardSpaNavigation) return;
  window.__openboardSpaNavigation = true;
  const navigate = (url, replace = false) => {
    history[replace ? 'replaceState' : 'pushState'](null, '', url);
    window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace } }));
  };
  window.__openboardNavigate = navigate;
  document.addEventListener('click', event => {
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (!link?.href || link.hasAttribute('download')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    if (link.target === '_blank' || event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1) {
      event.preventDefault(); event.stopImmediatePropagation();
      navigate(url.pathname + url.search + url.hash);
    }
  }, true);
  const open = window.open.bind(window);
  window.open = (url, name, features) => {
    if (url) {
      const target = new URL(url, location.href);
      if (target.origin === location.origin) { navigate(target.pathname + target.search + target.hash); return window; }
    }
    return open(url, name, features);
  };
}

function gevTuneScript(fps, scale) {
  window.__openboardGevQuality = { fps, scale };
  const apply = () => {
    const viewer = window.__godsEyeView?.viewer;
    if (!viewer) return false;
    const quality = window.__openboardGevQuality;
    viewer.targetFrameRate = quality.fps; viewer.resolutionScale = quality.scale;
    viewer.scene.msaaSamples = 1;
    if (window.__godsEyeView.tileset) window.__godsEyeView.tileset.maximumScreenSpaceError = 24;
    return true;
  };
  window.__openboardApplyGevQuality = apply;
  if (!apply()) { const timer = setInterval(() => { if (apply()) clearInterval(timer); }, 1000); }
}

export class AppManager extends EventEmitter {
  constructor({ config, shell, onBridge, log }) {
    super();
    this.config = config;          // () => current config
    this.shell = shell;            // () => { source, version }
    this.onBridge = onBridge;      // (id, message, page) => Promise
    this.log = log;
    this.browser = null; this.protocol = null;
    this.pages = new Map();        // app id → page
    this.runtime = new Map();      // app id → { lifecycle, lastActive, lastUrl, cdp, task, taskAt, cpu, heapMB, openedAt }
    this.attached = new Map();     // page → app id (includes transient popups as "popup:<n>")
    this.installed = new WeakMap(); // page → { version, scriptId }
    this.opening = new Map();
    this.active = null;
    this.connecting = null;
    this.popupCount = 0;
  }

  app(id) { return this.config().apps.find(app => app.id === id); }
  rt(id) {
    if (!this.runtime.has(id)) this.runtime.set(id, { lifecycle: 'terminated', lastActive: 0, lastUrl: null, cpu: 0, heapMB: null });
    return this.runtime.get(id);
  }
  get connected() { return !!this.browser?.connected; }

  appForUrl(url) {
    const apps = [...this.config().apps].sort((a, b) => b.url.length - a.url.length);
    return apps.find(app => url.startsWith(app.url)) || apps.find(app => originOf(app.url) === originOf(url) && !app.builtin);
  }

  async connect() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        this.browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null, protocolTimeout: 30000 });
        this.protocol = 'cdp';
      } catch {
        this.browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${DEBUG_PORT}/session`, protocol: 'webDriverBiDi', defaultViewport: null });
        this.protocol = 'bidi';
      }
      const browser = this.browser;
      for (const app of this.config().apps) {
        const origin = originOf(app.url);
        if (origin) await browser.defaultBrowserContext().overridePermissions(origin, ['microphone']).catch(() => {});
      }
      browser.on('disconnected', () => {
        if (this.browser !== browser) return;
        this.pages.clear(); this.attached.clear(); this.opening.clear();
        for (const runtime of this.runtime.values()) { runtime.lifecycle = 'terminated'; runtime.cdp = null; }
        this.emit('disconnected');
      });
      browser.on('targetcreated', target => { void this.onTarget(target).catch(error => this.log(`Popup: ${error.message}`)); });
      await this.adoptExistingPages();
      const enabled = this.config().apps.filter(app => app.enabled);
      if (!this.active || !this.pages.has(this.active)) await this.activate(this.pages.has(this.config().startApp) ? this.config().startApp : enabled[0]?.id);
      // Warm every app except "eco" ones. Switching later only brings a tab forward.
      const warm = enabled.filter(app => app.residency !== 'eco' && !this.pages.has(app.id));
      await Promise.allSettled(warm.map(app => this.ensurePage(app.id)));
      // Firefox may focus a tab while it loads in the background.
      if (warm.length) await this.activate(this.active);
      this.emit('connected');
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async topLevel(page) { return page.evaluate(() => window.top === window).catch(() => false); }

  // Maps existing tabs to apps; duplicates of the same app are closed unless they hold typed input.
  async adoptExistingPages() {
    for (const page of await this.browser.pages()) {
      if (page.isClosed() || this.attached.has(page) || !await this.topLevel(page)) continue;
      const app = this.appForUrl(page.url());
      if (!app) continue;
      const existing = this.pages.get(app.id);
      if (existing && !existing.isClosed()) {
        const hasInput = await page.evaluate(() => [...document.querySelectorAll('input,textarea')].some(element => element.value)).catch(() => false);
        if (!hasInput) { await page.close().catch(() => {}); continue; }
        await this.attachPopup(page);
        continue;
      }
      this.pages.set(app.id, page);
      const runtime = this.rt(app.id);
      runtime.lifecycle = 'background'; runtime.openedAt ||= Date.now();
      await this.install(page, app.id);
      if (await page.evaluate(() => !document.hidden).catch(() => false)) { this.active = app.id; runtime.lifecycle = 'active'; }
    }
  }

  async newBackgroundPage() {
    const context = this.browser.defaultBrowserContext();
    const anchor = [...this.pages.values()].find(page => !page.isClosed())?.mainFrame().browsingContext;
    if (this.protocol === 'bidi' && anchor && context.userContext) {
      // Firefox BiDi needs a reference window when several kiosk windows exist.
      const created = await context.userContext.createBrowsingContext('tab', { referenceContext: anchor, background: true });
      const page = (await context.pages()).find(candidate => candidate.mainFrame().browsingContext.id === created.id);
      if (!page) throw new Error('Background tab unavailable');
      return page;
    }
    return context.newPage({ type: 'tab', background: true });
  }

  async ensurePage(id) {
    const app = this.app(id);
    if (!app) throw new Error('Unbekannte App');
    if (!this.connected) throw new Error('Browser verbindet sich neu');
    const existing = this.pages.get(id);
    if (existing && !existing.isClosed()) return existing;
    if (this.opening.has(id)) return this.opening.get(id);
    const task = (async () => {
      const runtime = this.rt(id);
      runtime.lifecycle = 'loading'; this.emit('change');
      const page = await this.newBackgroundPage();
      this.pages.set(id, page);
      await this.install(page, id);
      runtime.openedAt = Date.now();
      await page.goto(runtime.lastUrl && originOf(runtime.lastUrl) === originOf(app.url) ? runtime.lastUrl : app.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
        .catch(error => this.log(`Navigation ${id}: ${error.message}`));
      runtime.lifecycle = this.active === id ? 'active' : 'background';
      this.emit('change');
      return page;
    })().finally(() => this.opening.delete(id));
    this.opening.set(id, task);
    return task;
  }

  async activate(id) {
    const app = this.app(id);
    if (!app || !app.enabled) throw new Error('Unbekannte App');
    if (!this.connected) throw new Error('Browser verbindet sich neu');
    const previous = this.active;
    if (previous && previous !== id) {
      this.emit('deactivate', previous);
      const runtime = this.rt(previous);
      runtime.lastActive = Date.now();
      if (runtime.lifecycle === 'active') runtime.lifecycle = 'background';
    }
    const page = await this.ensurePage(id);
    if (this.rt(id).lifecycle === 'frozen') await this.resume(id);
    await page.bringToFront();
    this.active = id;
    const runtime = this.rt(id);
    runtime.lifecycle = 'active'; runtime.lastActive = Date.now();
    await this.closePopups();
    this.emit('activate', id, previous);
    this.emit('change');
    return { ok: true, active: id };
  }

  async cdp(id) {
    const runtime = this.rt(id), page = this.pages.get(id);
    if (this.protocol !== 'cdp' || !page || page.isClosed()) return null;
    if (runtime.cdp && runtime.cdpPage === page) return runtime.cdp;
    try {
      runtime.cdp = await page.createCDPSession(); runtime.cdpPage = page;
      await runtime.cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
      runtime.task = null;
      return runtime.cdp;
    } catch { runtime.cdp = null; return null; }
  }

  // Freezing stops all tasks of a hidden page; it resumes instantly.
  async freeze(id) {
    const runtime = this.rt(id);
    if (id === this.active || runtime.lifecycle !== 'background') return false;
    const session = await this.cdp(id);
    if (!session) return false;
    await session.send('Page.setWebLifecycleState', { state: 'frozen' });
    runtime.lifecycle = 'frozen'; runtime.frozenAt = Date.now();
    this.emit('change');
    return true;
  }

  async resume(id) {
    const runtime = this.rt(id);
    if (runtime.lifecycle !== 'frozen') return false;
    const session = await this.cdp(id);
    if (session) await session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    runtime.lifecycle = id === this.active ? 'active' : 'background';
    runtime.task = null;
    this.emit('change');
    const page = this.pages.get(id);
    if (page) void this.pushState(page);
    return true;
  }

  // Terminating closes the tab but remembers where the app was.
  async terminate(id) {
    if (id === this.active) throw new Error('Die aktive App wird nicht beendet');
    const page = this.pages.get(id), runtime = this.rt(id);
    if (!page) return false;
    runtime.lastUrl = page.url();
    if (runtime.lifecycle === 'frozen') await this.resume(id);
    this.pages.delete(id); this.attached.delete(page);
    runtime.cdp = null; runtime.lifecycle = 'terminated'; runtime.cpu = 0; runtime.heapMB = null; runtime.terminatedAt = Date.now();
    await page.close().catch(() => {});
    this.emit('change');
    return true;
  }

  async reload(id) {
    const page = this.pages.get(id);
    if (!page) return this.ensurePage(id);
    if (this.rt(id).lifecycle === 'frozen') await this.resume(id);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    return page;
  }

  // Per-app main-thread load (share of one core) and JS heap, via CDP.
  async sample() {
    const now = performance.now();
    await Promise.all([...this.pages.keys()].map(async id => {
      const runtime = this.rt(id);
      if (runtime.lifecycle === 'frozen') { runtime.cpu = 0; return; }
      const session = await this.cdp(id);
      if (!session) return;
      try {
        const { metrics } = await session.send('Performance.getMetrics');
        const value = name => metrics.find(metric => metric.name === name)?.value;
        const task = value('TaskDuration');
        if (runtime.task != null && now > runtime.taskAt) {
          const cpu = Math.max(0, Math.min(100, ((task - runtime.task) / ((now - runtime.taskAt) / 1000)) * 100));
          runtime.cpu = runtime.cpu == null ? cpu : runtime.cpu * 0.6 + cpu * 0.4;
        }
        runtime.task = task; runtime.taskAt = now;
        runtime.heapMB = Math.round((value('JSHeapUsedSize') || 0) / 1048576);
      } catch { runtime.cdp = null; }
    }));
  }

  async install(page, id) {
    const { source, version } = this.shell();
    const previous = this.installed.get(page);
    if (previous?.version === version) return;
    const firstTime = !previous;
    if (firstTime) {
      this.attached.set(page, id);
      await page.exposeFunction('openboardBridge', async raw => {
        try {
          if (typeof raw !== 'string' || raw.length > 200000) return null;
          return await this.onBridge(this.attached.get(page), JSON.parse(raw), page);
        } catch (error) { this.log(`Bridge: ${error.message}`); return { error: error.message }; }
      }).catch(error => this.log(`Bridge ${id}: ${error.message}`));
      page.on('domcontentloaded', () => { void this.pushState(page); });
      page.on('framenavigated', frame => {
        const owner = this.attached.get(page);
        if (frame === page.mainFrame() && owner && !owner.startsWith('popup:')) this.rt(owner).lastUrl = frame.url();
      });
      page.on('close', () => {
        const owner = this.attached.get(page);
        this.attached.delete(page);
        if (owner && this.pages.get(owner) === page) {
          this.pages.delete(owner);
          const runtime = this.rt(owner);
          if (runtime.lifecycle !== 'terminated') { runtime.lifecycle = 'terminated'; runtime.cdp = null; this.emit('change'); }
        }
      });
      const app = this.app(id);
      if (app && app.zoom !== 1) await this.addScript(page, zoomScript, app.zoom);
      if (app && !app.builtin) await this.addScript(page, spaNavigationScript);
      if (id === 'gev') {
        const { fps, resolutionScale } = this.config().performance.gev;
        await this.addScript(page, gevTuneScript, fps, resolutionScale);
      }
    }
    if (previous?.scriptId) await page.removeScriptToEvaluateOnNewDocument(previous.scriptId).catch(() => {});
    const registration = await page.evaluateOnNewDocument(source).catch(() => null);
    this.installed.set(page, { version, scriptId: registration?.identifier });
    if (this.rt(id)?.lifecycle !== 'frozen') await page.evaluate(source).catch(() => {});
  }

  async addScript(page, fn, ...args) {
    await page.evaluateOnNewDocument(fn, ...args).catch(() => {});
    await page.evaluate(fn, ...args).catch(() => {});
  }

  // Re-injects the shell after an update without reloading any app.
  async reinstallShell() {
    await Promise.allSettled([...this.attached].map(([page, id]) => this.install(page, id)));
  }

  async setGevQuality(fps, scale) {
    const page = this.pages.get('gev');
    if (!page || this.rt('gev').lifecycle === 'frozen') return;
    await page.evaluate((fps, scale) => { window.__openboardGevQuality = { fps, scale }; window.__openboardApplyGevQuality?.(); }, fps, scale).catch(() => {});
  }

  // New windows: same-app URLs are opened inside the existing app tab.
  async onTarget(target) {
    if (target.type() !== 'page' || !this.connected) return;
    const page = await target.page();
    if (!page || this.attached.has(page) || [...this.pages.values()].includes(page) || this.opening.size) return;
    const openerPage = await target.opener()?.page().catch(() => null);
    let url = page.url();
    for (let attempt = 0; attempt < 20 && (!url || url === 'about:blank'); attempt++) { await delay(100); url = page.url(); }
    const openerApp = openerPage ? this.attached.get(openerPage) : null;
    const app = this.appForUrl(url) || (openerApp ? this.app(openerApp) : null);
    if (app && originOf(url) === originOf(app.url)) {
      await page.close().catch(() => {});
      const appPage = await this.ensurePage(app.id);
      const spa = await appPage.evaluate(next => {
        if (!window.__openboardNavigate) return false;
        const target = new URL(next); window.__openboardNavigate(target.pathname + target.search + target.hash); return true;
      }, url).catch(() => false);
      if (!spa) await appPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await this.activate(app.id);
      this.emit('toast', { text: `${app.name}: im selben Tab geöffnet`, icon: app.icon });
      return;
    }
    // Foreign windows stay as transient popups with the shell; they close on the next app switch.
    await this.attachPopup(page);
  }

  async attachPopup(page) {
    const id = `popup:${++this.popupCount}`;
    await this.install(page, id);
  }

  async closePopups() {
    for (const [page, id] of this.attached) if (id.startsWith('popup:')) { this.attached.delete(page); await page.close().catch(() => {}); }
  }

  async pushState(page, state = this.lastState) {
    if (!state || page.isClosed()) return;
    const id = this.attached.get(page);
    if (id && this.rt(id)?.lifecycle === 'frozen') return;
    await page.evaluate(next => window.__openboard?.update(next), { ...state, current: state.active, page: id }).catch(() => {});
  }

  // Publishes state to every live page (frozen pages get it on resume).
  async publish(state) {
    this.lastState = state;
    await Promise.allSettled([...this.attached.keys()].map(page => this.pushState(page, state)));
  }

  async event(data, { only } = {}) {
    const targets = [...this.attached].filter(([page, id]) => (!only || only.includes(id)) && this.rt(id)?.lifecycle !== 'frozen' && !page.isClosed());
    await Promise.allSettled(targets.map(([page]) => page.evaluate(value => window.__openboard?.event(value), data)));
  }

  activePage() { return this.pages.get(this.active); }

  // Network error pages are retried; loaded apps, logins and drawings stay intact.
  async recoverFailedPages() {
    for (const [id, page] of this.pages) {
      if (page.isClosed() || this.opening.has(id) || this.rt(id).lifecycle === 'frozen') continue;
      const failed = await page.evaluate(() => {
        const uri = document.documentURI;
        if (uri.startsWith('about:neterror')) return true;
        return uri.startsWith('chrome-error:') && !/ERR_CERT_|ERR_SSL_/i.test(document.body?.textContent || '');
      }).catch(() => false);
      if (!failed) continue;
      const url = this.app(id)?.url;
      if (page.url() === url) await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      else await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }
  }

  async disconnect() { await this.browser?.disconnect().catch(() => {}); }

  snapshot() {
    return this.config().apps.map(app => {
      const runtime = this.rt(app.id);
      return { id: app.id, name: app.name, icon: app.icon, url: app.url, enabled: app.enabled, builtin: !!app.builtin, residency: app.residency, weight: app.weight,
        lifecycle: this.pages.has(app.id) || runtime.lifecycle === 'loading' ? runtime.lifecycle : 'terminated',
        lastActive: runtime.lastActive, cpu: Math.round((runtime.cpu || 0) * 10) / 10, heapMB: runtime.heapMB };
    });
  }
}
