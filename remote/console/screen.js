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
    const hint = document.createElement('div');
    hint.className = 'rc-screen-missing';
    const title = document.createElement('b'); title.textContent = 'noVNC ist nicht installiert';
    const text = document.createElement('p'); text.textContent = 'Der Bildschirm des Displays erscheint hier, sobald noVNC vorhanden ist. Auf dem Display-Rechner ausführen:';
    const code = document.createElement('code'); code.textContent = 'bash scripts/install-remote-services.sh';
    const rest = document.createElement('p'); rest.textContent = 'Danach diese Seite neu laden. Übersicht, Dock und Einstellungen funktionieren auch ohne.';
    const box = document.createElement('div'); box.append(title, text, code, rest);
    hint.append(box);
    container.replaceChildren(hint);
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
