# Öffentliche Demo-Screenshots

Diese Bilder zeigen die tatsächliche Oberfläche aus `kiosk/overlay.js` und
`kiosk/whiteboard.html`, ausgeführt in einem frischen Browserprofil gegen einen
temporären lokalen Demo-Server. Der Server liest ausschließlich öffentliche
Quelltexte. Alle Projekt-Namen, Hintergründe und Zeichenstriche sind künstliche
Beispieldaten; Home Assistant, GEV, Konten und das installierte Display werden
nicht kontaktiert. Externe Browser-Anfragen werden blockiert.

- `glass-panel.png`: fester App-Switcher mit generischen Projekt-Namen.
- `launcher.png`: derselbe Demo-Hintergrund mit verschobenem 48px-App-Knopf.
- `whiteboard.png`: reales Whiteboard-UI mit generierter Beispielzeichnung.

Das sind Screenshots des heutigen Prototyps, keine Darstellung einer bereits
fertigen Whiteboard-OS-Arbeitsfläche oder einer Windows-App-Integration.

Neu erzeugen, nach `PUPPETEER_SKIP_DOWNLOAD=true npm ci --prefix kiosk`:

```bash
DOCS_BROWSER=/PATH/TO/CHROME node scripts/capture-docs.mjs
```

Die PNG-Dateien enthalten keine Text-/EXIF-Metadaten. Nach jeder Neuerzeugung
müssen alle drei Bilder vor einer Veröffentlichung visuell geprüft werden.
