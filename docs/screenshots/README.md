# Öffentliche Demo-Screenshots

Diese Bilder zeigen die tatsächliche Oberfläche (Shell, Astra, Whiteboard, Einstellungen), ausgeführt in
einem frischen Browserprofil gegen Attrappen: eine Platzhalter-Karte statt God's Eye View, eine
Platzhalter-Seite statt Home Assistant und ein Mock für ASTRA (`scripts/dev/fixtures.mjs`,
`scripts/dev/mock-astra.mjs`). Alle Namen, Termine, Wetterwerte und Zeichnungen sind künstliche
Beispieldaten; echte Konten, Dienste und das installierte Display werden nicht kontaktiert.

- `dock.png`: Dock mit Widget-Kacheln und App-Kacheln über der Platzhalter-Karte.
- `astra.png`: Astra-Ruhebild mit Uhr, Briefing, Terminen und Wetter.
- `board.png`: Whiteboard mit einem generierten Beispiel-Diagramm.
- `settings.png`: Einstellungen-App.

Neu erzeugen (Headless-Chromium, nach `PUPPETEER_SKIP_DOWNLOAD=true npm ci --prefix kiosk`):

```bash
node scripts/dev/e2e.mjs --docs docs/screenshots
```

Die PNG-Dateien enthalten keine Text-/EXIF-Metadaten. Nach jeder Neuerzeugung müssen alle Bilder vor einer
Veröffentlichung visuell geprüft werden; der Datenschutz-Prüfer erlaubt nur genau diese vier Dateinamen.
