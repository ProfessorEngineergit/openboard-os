// noVNC remote view for the console's "Bildschirm" section. Loaded only while
// that section is open; noVNC itself is downloaded by install-remote-services.sh
// into remote/novnc/ (not part of the repository).
export async function createScreen(container, { onStatus = () => {} } = {}) {
  let RFB;
  try {
    const health = await fetch('/health').then(r => r.json()).catch(() => ({}));
    if (health.novnc === false) throw new Error('noVNC missing');
    RFB = (await import('../novnc/core/rfb.js')).default;
  } catch {
    onStatus('noVNC fehlt · scripts/install-remote-services.sh ausführen', 'err');
    container.replaceChildren(Object.assign(document.createElement('div'), { className: 'rc-screen-missing', textContent: 'noVNC ist auf diesem Rechner nicht installiert. Führe scripts/install-remote-services.sh aus; danach erscheint hier der Bildschirm des Displays.' }));
    return { destroy() {}, paste() {}, focus() {}, connected: () => false };
  }
  let rfb = null, reconnectTimer = null, closing = false, connected = false;
  function connect() {
    clearTimeout(reconnectTimer);
    container.replaceChildren();
    onStatus('Verbinde …', 'busy');
    const current = new RFB(container, `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/websockify`);
    rfb = current;
    current.scaleViewport = true; current.resizeSession = false; current.showDotCursor = true;
    current.qualityLevel = 6; current.compressionLevel = 3;
    current.addEventListener('connect', () => { if (rfb !== current) return; connected = true; onStatus('Verbunden · verschlüsselter SSH-Tunnel', 'ok'); });
    current.addEventListener('disconnect', () => {
      if (closing || rfb !== current) return;
      connected = false;
      onStatus('Verbindung unterbrochen · verbinde automatisch erneut …', 'warn');
      reconnectTimer = setTimeout(connect, 3000);
    });
  }
  const onUnload = () => { closing = true; clearTimeout(reconnectTimer); rfb?.disconnect(); };
  window.addEventListener('beforeunload', onUnload);
  connect();
  return {
    connected: () => connected,
    focus() { setTimeout(() => rfb?.focus(), 100); },
    paste(text) { if (!rfb) return; rfb.clipboardPasteFrom(text); rfb.focus(); },
    destroy() { window.removeEventListener('beforeunload', onUnload); onUnload(); container.replaceChildren(); },
  };
}
