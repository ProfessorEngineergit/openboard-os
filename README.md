# MEGA DISPLAY Kiosk

Touch-Kiosk für Ubuntu mit X11: God’s Eye View, Home Assistant, eine eigene Assistenten-Weboberfläche und ein lokales Whiteboard. Eine private Fernansicht zeigt den echten Bildschirm über einen SSH-Tunnel.

## Oberfläche

- Kleiner, verschiebbarer App-Knopf (48 × 48 Pixel, Symbol 18 Pixel).
- Transparenter Liquid-Glass-Look mit dem originalen WebGL-Backend von `@tomagranate/liquid-glass`.
- Das aufgeklappte App-Panel bleibt oben links und lässt sich nicht verschieben.
- Vier vorgeladene App-Tabs im selben Vollbildfenster. Ein Wechsel aktiviert den vorhandenen Tab.
- Zusätzliche Home-Assistant-Fenster erhalten ebenfalls den Switcher; eingebettete Frames bekommen kein zweites Overlay.
- Home Assistant wird auf 75 % skaliert; der App-Switcher behält seine Touch-Größe.
- Der Cursor wird auf X11 und in den App-Seiten ausgeblendet.
- Whiteboard mit Stift, Radierer, Farben, Undo/Redo, PNG-Export und lokaler Speicherung.

Über GEV und Whiteboard verzerrt der Glass-Renderer die Canvas-Pixel direkt unter dem Knopf beziehungsweise Panel. Über gewöhnlichen HTML-Seiten greift der CSS-Backdrop-Effekt. Ein einfarbiger Hintergrund liefert entsprechend wenig sichtbare Lichtbrechung. Die WebGL-Aktualisierung ist auf ungefähr sieben Bilder pro Sekunde begrenzt, um Ressourcen für die Karte zu lassen.

## Installation

Voraussetzungen: Ubuntu mit Xorg/XFCE, eine funktionierende Touch-Verbindung, Firefox sowie Node.js 24. Die Skripte erwarten dieses Projekt unter `$HOME/mega-display`. GEV wird separat installiert und ist nicht Teil dieses Repositorys.

```bash
# Dieses Repository als ~/mega-display klonen, dann:
cd ~/mega-display
git clone https://github.com/bilawalsidhu/gods-eye-view.git
git -C gods-eye-view checkout 6be25595b16491ce01ffd8d81e66921f321ee200
bash scripts/install-runtime.sh
cd kiosk
PUPPETEER_SKIP_DOWNLOAD=true npm ci
cp config.example.json config.json
cd ..
bash scripts/install-services.sh
bash scripts/install-reconnect-service.sh
```

Pakete für die X11-Steuerung und den optionalen Fernzugriff:

```bash
sudo apt-get install xdotool python3 x11-xserver-utils xinput xfce4-terminal xfce4-screensaver x11vnc curl
bash scripts/install-remote-services.sh
```

Eine automatische Desktop-Anmeldung muss im Display-Manager separat eingerichtet werden. Die Installationsskripte richten XFCE-Autostart und Dienste ein, ändern aber keine Login-Zugangsdaten. Der Browser-Launcher verwendet vorhandenes System-Chrome unter `/opt/google/chrome/chrome` oder den installierten Firefox. Browser-Sandbox und AppArmor bleiben aktiv.

## Einrichtung und Bedienung

`http://localhost:4180/settings` auf dem Display-Rechner konfiguriert den optionalen Gemini-Key sowie Home-Assistant- und Assistenten-URLs. Ohne echte Assistenten-URL zeigt Astra einen lokalen Platzhalter. Native GEV-Sprachsteuerung wird in GEV selbst eingerichtet; der Gemini-Adapter ist eine separate Kiosk-Funktion. Sprachsteuerung setzt ein Mikrofon und einen passenden Provider-Key voraus.

Den kleinen App-Knopf antippen, um das Panel zu öffnen; nur diesen Knopf zum Verschieben ziehen. Seine Position wird zwischen den Apps synchronisiert und lokal gespeichert. Das Panel schließt nach zwölf Sekunden. Eine Drei-Finger-Bewegung vom Bildschirmrand öffnet es ebenfalls, sofern der Touch-Controller mehrere Kontakte unterstützt.

**Ctrl+Alt+Shift+K** beendet den Kiosk für Wartungsarbeiten. Erneut starten:

```bash
bash ~/mega-display/scripts/start-kiosk.sh
```

Die Karte verwendet einen Zielwert von 30 FPS und eine Render-Skalierung von 0,8. Die tatsächliche Bildrate hängt von Grafikchip, Browser und Szene ab.

## Fernzugriff

Die Fernansicht und VNC hören ausschließlich auf Loopback (6080 beziehungsweise 5900). Sie dürfen nicht direkt ins LAN oder Internet veröffentlicht werden. Der SSH-Tunnel übernimmt die Zugriffskontrolle; VNC hat innerhalb dieses lokalen Tunnels kein separates Passwort.

```bash
ssh -N -L 16080:127.0.0.1:6080 USER@DISPLAY_HOST
```

Danach `http://localhost:16080/` öffnen. Die Fernansicht bietet App-Wechsel, Desktop, Terminal, Kiosk-Start und lokale API-Einrichtung. Nach einer unterbrochenen VNC-Verbindung versucht sie automatisch eine neue Verbindung. Ein dauerhafter SSH-Tunnel muss auf dem zugreifenden Rechner separat eingerichtet werden.

## Speicherung und Neustart

Das Whiteboard speichert im Browser und unter `kiosk/data/whiteboard/current.json`. Dateispeicherung erfolgt mit atomarem Austausch und Festplatten-Synchronisierung; vorherige Versionen liegen unter `snapshots/`. Nach fehlgeschlagenen Speicherungen wird erneut versucht. Eine externe Sicherung ist bewusst installationsabhängig und muss separat konfiguriert werden.

Die Browser-Launcher warten auf X11 und die lokalen App-Server. Dienste starten nach Fehlern erneut. Fehlgeschlagene Browser-Netzwerkseiten werden nach einer Wiederverbindung erneut geladen; bereits geladene Apps bleiben erhalten. Der Sharp-Touch-Wächter erkennt Geräte anhand ihres Namens, ordnet aktuelle Eingabe-IDs dem Full-HD-Bildausgang zu und deaktiviert Bildschirm-Blanking.

Bei unterstützten HP-Systemen kann `scripts/setup-power-restore-interactive.sh` nach lokaler Administrator-Authentifizierung ausschließlich die BIOS-Option **After Power Loss → Power On** setzen und zurücklesen. Der Rechner muss diese Option unterstützen. Physischer Kaltstart, Audio und Touch-Gesten müssen auf der konkreten Hardware getestet werden.

## API für Assistenten

Die Steuerung läuft unter `http://127.0.0.1:4180`. Authentifizierung: `Authorization: Bearer TOKEN`; der automatisch erzeugte Token steht ausschließlich lokal in `kiosk/api-token`.

- `GET /api/state`: aktive App und Verbindungszustand.
- `POST /api/tabs/gev/activate`: GEV aktivieren; auch `home`, `astra`, `board` sind möglich.
- `GET /api/gev/tools`: erlaubte GEV-Befehle und ihre Schemas.
- `POST /api/gev/command`: beispielsweise `{"name":"get_current_view_state","args":{}}`.

Beliebiger JavaScript-Code wird nicht als Befehl ausgeführt. Schlüssel gehören nicht in Frontend-Quelltext oder Commits.

## Prüfen

Die Browser-Prüfer laufen innerhalb des Controllers, weil Firefox nur eine WebDriver-BiDi-Sitzung erlaubt. Während der Prüfung den normalen Controller-Dienst stoppen und anschließend wieder starten.

- `node kiosk/server.mjs --verify-startup`: App-Bereitschaft, bestehendes Kiosk-Fenster und Netzwerkwiederherstellung.
- `node kiosk/server.mjs --verify-updates`: vorhandene Tabs, Vollbild, Skalierung und Glass-Renderer.
- `node kiosk/server.mjs --verify-dock`: kleiner Knopf, Verschieben und festes Panel.
- `node kiosk/server.mjs --verify-overlays`: vorhandene zusätzliche Home-Assistant-Fenster und ihre App-Knöpfe prüfen, ohne die Seiten neu zu laden.
- `node kiosk/server.mjs --verify`: vollständiger Funktionstest, der auch einen Whiteboard-Teststrich zeichnet.

Die vollständige Prüfung nur mit entbehrlichen Testzeichnungen ausführen. Prüfberichte und Bildschirmfotos bleiben unter `logs/` und werden nicht versioniert.

## Datenschutz im Repository

Dieses Repository enthält ausschließlich Quellcode, generische Beispielkonfiguration und Abhängigkeiten-Metadaten. Lokale Konfiguration, API-Token, Provider-Schlüssel, Browserprofile, Zeichnungen, Sicherungen, Geräteinventar, Screenshots und Logs werden nicht hochgeladen. Reale Hosts und Kontodaten müssen lokal konfiguriert werden.

## Drittanbieter

- [God’s Eye View](https://github.com/bilawalsidhu/gods-eye-view), separat installierter Upstream, auf den oben genannten Commit abgestimmt.
- [Liquid Glass](https://github.com/TomaGranate/liquid-glass), MIT; unveränderte Originalquellen und Lizenz liegen unter `kiosk/vendor/liquid-glass`.
- [noVNC](https://github.com/novnc/noVNC), separat heruntergeladen, Commit `a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820`; die Original-Lizenz bleibt im Download erhalten.
- Puppeteer und ws werden mit dem Lockfile installiert.

Eine mögliche professionelle Whiteboard-Erweiterung ist [Nextcloud Whiteboard](https://github.com/nextcloud/whiteboard). Dieses Repository installiert oder ersetzt keine vorhandene Nextcloud-Instanz.
