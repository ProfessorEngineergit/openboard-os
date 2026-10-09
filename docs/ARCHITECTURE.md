# OpenBoard – Architektur und Schnittstellen

OpenBoard ist ein leichtgewichtiges Whiteboard-OS für große Touch-Displays (Referenz: Sharp LT60, Full HD, Intel HD 630, Ubuntu/XFCE/X11). Es besteht aus einem Node-Controller, einem Browser im Kiosk-Modus und einer unsichtbaren Shell, die in jede App eingeblendet wird.

Leitlinien:

- **Unsichtbar, bis man es braucht.** Die Shell zeigt im Ruhezustand nichts. Ein Wisch vom unteren Rand öffnet das Dock.
- **Leicht.** Es gibt keine Frameworks in der Shell. Metriken laufen nur, wenn jemand hinsieht. Ausgeblendete Apps verbrauchen nur so viel, wie die Lastlage erlaubt.
- **Koppelbar.** Alles ist per API, MQTT (Home Assistant), Webhooks und ASTRA steuerbar und beobachtbar.
- **Fernbedienbar.** Jede Einstellung und jede Dock-Anpassung ist in der Desktop-Konsole gespiegelt, ohne VNC.

## Prozesse

| Dienst (systemd --user) | Aufgabe |
|---|---|
| `openboard-control` | `kiosk/server.mjs`: Apps, Shell, API, Leistungsmanager, MQTT, ASTRA-Brücke (Port 4180, nur Loopback) |
| `openboard-browser` | Chrome bzw. Firefox im Kiosk-Modus mit Debug-Port 9222 (nur Loopback) |
| `openboard-remote` | `remote/server.mjs`: Konsole und VNC-Proxy (Port 6080, nur Loopback, Zugriff per SSH-Tunnel) |
| `openboard-update.timer` | `scripts/update.sh`, jede Minute: Git-Update mit Rollback |
| `openboard-gev` | God's Eye View (separater Upstream, Port 4173) |
| `openboard-display` | Display- und Touch-Wächter (`scripts/reconnect-display.py`) |

## Verzeichnisse

```
kiosk/
  server.mjs            Einstieg; verdrahtet die Module
  lib/                  Controller-Module (router, static, config, apps, lifecycle, metrics,
                        display, mqtt, astra, gemini, board-store, updates, shell-bundle)
  shell/                In jede App injizierte Shell (Dock, Widgets, Editor, Tastatur, Prompts)
  ui/                   tokens.css, kit.css, widgets.js, icons.js, fonts/ – gemeinsam für Shell, Apps, Konsole
  apps/settings/        Einstellungs-App (Touch) – dasselbe Modul läuft in der Konsole (Desktop)
  apps/astra/           ASTRA-Oberfläche
  apps/board/           Whiteboard (Excalidraw + Ink-Layer); src/ und gebautes dist/
  vendor/liquid-glass/  WebGL-Glas (Codex-Bereich)
remote/
  server.mjs            Konsole + VNC-Proxy + API-Proxy
  console/              Desktop-Konsole
scripts/                Installation, Update, Migrationen, Prüfungen
```

## Konfiguration (`kiosk/config.json`, Version 2)

Die Datei wird beim Start aus Version 1 migriert. Geheimnisse (`*.key`, `*.token`, `*.password`) werden nie an Clients ausgeliefert. Stattdessen steht dort `{"set": true}`.

```jsonc
{
  "version": 2,
  "apps": [
    { "id": "gev", "name": "God’s Eye View", "url": "http://localhost:4173/", "icon": "globe",
      "builtin": false, "enabled": true, "zoom": 1,
      "residency": "auto",          // "always" | "auto" | "eco"
      "weight": "heavy" },          // "heavy" | "standard" | "light" (Startwert, wird gemessen)
    { "id": "home", "name": "Home Assistant", "url": "http://homeassistant.local:8123/", "icon": "home", "zoom": 0.75, "residency": "always", "weight": "standard" },
    { "id": "astra", "name": "Astra", "url": "http://localhost:4180/apps/astra/", "icon": "astra", "builtin": true, "residency": "always", "weight": "light" },
    { "id": "board", "name": "Whiteboard", "url": "http://localhost:4180/apps/board/", "icon": "board", "builtin": true, "residency": "auto", "weight": "standard" },
    { "id": "settings", "name": "Einstellungen", "url": "http://localhost:4180/apps/settings/", "icon": "settings", "builtin": true, "residency": "eco", "weight": "light" }
  ],
  "startApp": "gev",
  "appearance": { "theme": "dark", "lightFrom": "07:00", "darkFrom": "19:30", "glass": "webgl", "accent": "#f4f5f8" },
  // theme: "dark" | "light" | "auto" (nach Uhrzeit); glass: "webgl" | "css" | "off"
  "dock": {
    "order": ["gev", "home", "astra", "board", "settings"],
    "autoHideSeconds": 6, "indicator": "touch",   // "always" | "touch" | "never"
    "tiles": [
      { "id": "t1", "items": [ { "id": "w1", "type": "metric.cpu", "options": { "style": "ring" } },
                               { "id": "w2", "type": "metric.gpu" },
                               { "id": "w3", "type": "action.sleep" },
                               { "id": "w4", "type": "action.theme" } ] },
      { "id": "t2", "items": [ { "id": "w5", "type": "info.clock" } ] }
    ]
  },
  "display": { "sleepMode": "black", "useDdc": false, "idleSleepMinutes": 0,
               "schedule": { "enabled": false, "sleepAt": "23:30", "wakeAt": "06:45" } },
  // sleepMode: "black" (schwarzes Overlay + Apps einfrieren) | "dpms" (Signal aus)
  "performance": {
    "mode": "balanced",                 // "eco" | "balanced" | "max"
    "elevatedCpu": 75, "criticalCpu": 92, "sustainSeconds": 20,
    "memoryFloorMB": 600,
    "terminate": "ask",                 // "ask" | "auto" | "never"
    "askTimeoutSeconds": 30, "askDefault": "keep",   // "keep" | "terminate"
    "terminateMinIdleMinutes": 20, "freezeMinIdleMinutes": 3,
    "prewarm": true, "thermalLimitC": 88,
    "gev": { "fps": 30, "resolutionScale": 0.8 }
  },
  "astra": { "url": "", "token": "", "voice": true, "briefingOnDisplay": true },
  "mqtt": { "url": "", "username": "", "password": "", "discoveryPrefix": "homeassistant", "nodeId": "openboard" },
  "gemini": { "key": "", "model": "gemini-3.8-live" },
  "board": { "paper": "auto", "lowLatency": true, "prediction": true },
  "updates": { "enabled": true, "branch": "main", "intervalSeconds": 60, "restartBrowser": "idle" }
}
```

## Lokale HTTP-API (Controller, `127.0.0.1:4180`)

Zugriffsstufen (siehe `kiosk/lib/router.mjs`): **public** (gültiger Host), **local** (zusätzlich Same-Origin, für eingebaute Apps und die Konsole über den Proxy), **token** (`Authorization: Bearer <kiosk/api-token>`).

| Methode | Pfad | Stufe | Zweck |
|---|---|---|---|
| GET | `/health` | public | `{ok, browser, version}` |
| GET | `/ui/*`, `/apps/<id>/*` | public | Statische Dateien |
| GET | `/api/local/state` | local | Gesamtzustand (s. u.) |
| GET | `/api/local/events` | local | SSE: `state`, `metrics`, `prompt`, `toast`, `astra.*`, `board.*`, `update` |
| GET | `/api/local/config` | local | Konfiguration ohne Geheimnisse |
| PATCH | `/api/local/config` | local | Teil-Update (Deep Merge; Arrays ersetzen). Antwort: neue Konfiguration |
| POST | `/api/local/config/test/:target` | local | `astra` \| `mqtt` \| `gemini` → `{ok, detail}` |
| GET | `/api/local/widgets/catalog` | local | Widget-Katalog (Typen, Optionen) |
| GET | `/api/local/metrics` | local | Momentaufnahme; `?history=1` mit 10-min-Verlauf |
| POST | `/api/local/apps/:id/activate` | local | App öffnen |
| POST | `/api/local/apps/:id/:action` | local | `reload` \| `suspend` \| `resume` \| `terminate` |
| POST | `/api/local/apps` | local | Eigene Web-App anlegen `{name,url,icon}` |
| DELETE | `/api/local/apps/:id` | local | Eigene Web-App entfernen |
| POST | `/api/local/display/:action` | local | `sleep` \| `wake` |
| POST | `/api/local/prompt/:id` | local | Antwort auf eine Rückfrage `{choice}` |
| POST | `/api/local/system/:action` | local | `restart-browser` \| `restart-controller` \| `exit-kiosk` \| `update-check` \| `volume` `{value}` \| `brightness` `{value}` |
| GET | `/api/local/logs` | local | Letzte Controller-Logzeilen und Update-Protokoll |
| * | `/api/local/astra/*` | local | ASTRA-Brücke (s. u.) |
| * | `/api/local/board/*` | local | Whiteboard-Speicher (s. u.) |
| GET | `/api/v1/state` | token | wie `/api/local/state` |
| POST | `/api/v1/apps/:id/activate`, `/api/v1/display/:action` | token | Steuerung für Assistenten/Skripte |
| GET/POST | `/api/v1/gev/tools`, `/api/v1/gev/command` | token | GEV-Befehle (Allowlist) |
| POST | `/api/v1/board/insert` | token | Inhalte aufs Whiteboard (Format wie `board`-Event) |
| POST | `/api/v1/say` | token | `{text}` → Sprachausgabe über ASTRA-TTS |

Alte Pfade (`/api/state`, `/api/tabs/:id/activate`, `/api/gev/*`, `/whiteboard`, `/astra`, `/settings`) bleiben als Aliase bzw. Weiterleitungen erhalten.

### Zustand (`state`)

```jsonc
{
  "version": "a1b2c3d", "connected": true, "active": "gev",
  "theme": "dark",                       // effektiv (auto aufgelöst)
  "display": { "asleep": false, "since": 1760000000000 },
  "apps": [ { "id": "gev", "name": "…", "icon": "globe", "url": "…", "enabled": true,
              "residency": "auto", "lifecycle": "active",   // active | background | frozen | terminated | loading
              "lastActive": 1760000000000, "cpu": 12.5, "heapMB": 210 } ],
  "dock": { …wie config… }, "appearance": { … },
  "pressure": "normal",                  // normal | elevated | critical
  "astra": { "configured": true, "connected": true },
  "mqtt": { "configured": false, "connected": false },
  "update": { "current": "a1b2c3d", "available": false, "lastCheck": 0, "lastResult": "ok", "pendingBrowserRestart": false },
  "voice": { "gemini": true }
}
```

## Shell ↔ Controller

Der Controller injiziert `kiosk/shell/*` zusammen mit dem Glas-Runtime und den Tokens als ein Bundle in jede Top-Level-Seite. Die Version ist ein Hash des Bundles: Ändert sich der Code, wird die Shell ohne Neuladen der Seite ersetzt.

- Controller → Shell: `window.__openboard.update(state)`, `window.__openboard.event({type, …})` (`metrics`, `prompt`, `toast`, `voice`, `sleep`, `wake`).
- Shell → Controller: `window.openboardBridge(JSON.stringify({action, …}))`. Aktionen: `ready`, `activate {id}`, `activity` (gedrosselt, höchstens alle 5 s), `metrics-subscribe {on}`, `display {action}`, `config-patch {patch}` (Dock-Editor), `widget {id, action, value}`, `prompt {id, choice}`, `key {text|key}` (Bildschirmtastatur → echte Tastendrücke per Puppeteer), `voice-*` (Gemini).

## Widgets

Eine Kachel ist doppelt so breit wie ein App-Symbol und enthält 1–4 Elemente (1 = groß, 2 = nebeneinander, 3–4 = 2×2). Standard sind zwei Kacheln links vom Dock. Langes Drücken auf eine Kachel öffnet den Editor über dem Dock: Bibliothek, Ziehen und Ablegen, Kacheln hinzufügen und entfernen. Langes Drücken auf ein Element öffnet seinen Inspektor.

Typen (`kiosk/ui/widgets.js` ist die Quelle, `GET /api/local/widgets/catalog` liefert sie aus):

| Typ | Art | Optionen |
|---|---|---|
| `metric.cpu` `metric.gpu` `metric.ram` `metric.temp` `metric.net` `metric.disk` | Anzeige | `style`: ring \| number \| spark; `warn`, `crit` |
| `metric.app` | Anzeige | stärkster Verbraucher oder `app` |
| `info.clock` `info.date` `info.weather` `info.next-event` `info.astra` `info.update` | Anzeige | `format` |
| `mqtt.value` | Anzeige | `topic`, `label`, `unit`, `jsonPath` |
| `action.sleep` `action.theme` `action.reload` `action.voice` `action.performance` | Knopf | – |
| `action.volume` `action.brightness` | Knopf/Regler | `step` |
| `action.app` | Knopf | `app` |
| `action.mqtt` | Knopf | `name`, `icon`, `payload` → erscheint in Home Assistant als Geräte-Auslöser |
| `action.webhook` | Knopf | `url`, `method`, `body` |
| `action.astra` | Knopf | `prompt` (fester Auftrag an ASTRA, z. B. „Briefing“) |

## Leistungsmanager (`kiosk/lib/lifecycle.mjs`)

Ziel: Solange Reserven da sind, wird nichts angefasst. Erst unter Last wird schrittweise und umkehrbar eingegriffen.

1. **Messung (alle 2 s):** System-CPU aus `/proc/stat`, RAM aus `/proc/meminfo`, Temperatur aus hwmon/thermal, GPU-Takt aus i915 sysfs bzw. `intel_gpu_top`. Pro App: CPU-Anteil aus CDP `Performance.getMetrics` (Delta `TaskDuration`) und JS-Heap. Geglättet wird per EWMA über 10 s.
2. **Druckstufe mit Hysterese:**
   - `normal`: unter `elevatedCpu` und RAM über der Untergrenze.
   - `elevated`: über `elevatedCpu` für `sustainSeconds`.
   - `critical`: über `criticalCpu` für `sustainSeconds` oder RAM unter `memoryFloorMB`.
   - Zurück in eine niedrigere Stufe erst 10 Prozentpunkte darunter und nach 30 s.
3. **Maßnahmen:**
   - `normal`: keine. Vorwärmen nach Nutzungsmuster ist erlaubt.
   - `elevated`: Hintergrund-Apps mit `residency=auto`, die länger als `freezeMinIdleMinutes` ungenutzt sind, werden eingefroren (`Page.setWebLifecycleState frozen`, sofort umkehrbar). `eco`-Apps werden immer sofort eingefroren, sobald sie in den Hintergrund gehen.
   - `critical`: Kandidat ist die Hintergrund-App mit dem höchsten Wert aus Kosten × Leerlaufzeit (Leerlauf ≥ `terminateMinIdleMinutes`). Bei `terminate=ask` erscheint eine Rückfrage (Shell und Konsole), z. B. „God’s Eye View verbraucht 40 % CPU und ist seit 22 min ungenutzt. Beenden?“ mit *Beenden* / *Behalten* / *Immer erlauben*. Ohne Antwort gilt `askDefault`. Bei `auto` wird direkt beendet, bei `never` nur eingefroren.
   - **Nie betroffen:** die aktive App, `residency=always` (z. B. Home Assistant, Astra), Apps mit laufender Sprachsitzung oder Audiowiedergabe.
4. **Wiederherstellen:** Eingefrorene Apps laufen beim Öffnen sofort weiter. Beendete Apps laden die zuletzt besuchte URL neu.
5. **Vorwärmen:** Ein Stunden-Histogramm der Nutzung (Halbwertszeit 7 Tage) sagt die nächste App voraus. Bei `normal` wird sie 5 min vorher aufgetaut bzw. geladen, ebenso Astra vor einem Wecker.
6. **Thermik:** Über `thermalLimitC` senkt der Manager GEV auf 20 FPS und Skalierung 0,6; unter Grenze − 5 °C wird zurückgestellt.
7. **Schlafmodus:** Alle Apps außer `always` werden eingefroren und GEV pausiert. Beim Aufwachen taut zuerst die aktive App auf.

`performance.mode` verschiebt die Schwellen: eco = −15, balanced = 0, max = +8 und `terminate=never`.

## ASTRA-Display-Protokoll v1

Der Controller spricht serverseitig mit ASTRA (`astra.url`, z. B. `http://192.168.178.189:8088`) und verwendet `Authorization: Bearer <astra.token>`. In ASTRA ist das `ASTRA_DISPLAY_TOKEN` bzw. der Token aus dem Admin-Bereich. Der Browser sieht den Token nie.

| Methode | ASTRA-Pfad | Kiosk-Proxy |
|---|---|---|
| GET | `/display/v1/hello` → `{name, version, capabilities:[…]}` | `/api/local/astra/hello` |
| POST | `/display/v1/message` | `/api/local/astra/message` |
| GET | `/display/v1/glance` | `/api/local/astra/glance` |
| POST | `/display/v1/tts` `{text}` → `{mime, b64}` | `/api/local/astra/tts` |
| GET | `/display/v1/events` (SSE) | wird als `astra.<type>` über `/api/local/events` weitergereicht |

`POST /display/v1/message`:

```jsonc
// Anfrage
{ "session_id": "display-main", "text": "Was steht heute an?",            // oder:
  "audio": { "mime": "audio/wav", "b64": "…" },                            // 16 kHz Mono
  "speak": true, "context": { "active_app": "astra", "locale": "de-DE", "theme": "dark" } }
// Antwort
{ "session_id": "display-main", "transcript": "Was steht heute an?", "reply": "Heute hast du …",
  "cards": [Card], "speech": { "mime": "audio/mpeg", "b64": "…" } | null,
  "actions": [ { "type": "open_app", "app": "board" } ] }
```

`GET /display/v1/glance` → `{generated_at, greeting, weather: WeatherData|null, calendar: {events:[Event]}|null, briefing: {text}|null, alarms: [{id, at, label}]}`

SSE-Ereignisse (`event: <typ>`, `data: <json>`):

| Typ | Daten |
|---|---|
| `hello` | `{version}` |
| `card` / `cards` | `{card}` / `{cards, replace}` |
| `say` | `{text, speech?: {mime, b64}}` |
| `reply` | wie die Antwort von `message` (asynchrone Folgeantworten) |
| `alarm` | `{id, label, sound: "gentle"\|"classic"\|"none", speak?: text, speech?, cards?: [Card]}` |
| `command` | `{action: "sleep"\|"wake"\|"open_app", app?}` |
| `board` | `{op: "add_text"\|"add_mermaid"\|"add_image"\|"add_svg"\|"add_elements", …}` |
| `ping` | `{}` |

**Card**: `{id, type, title?, subtitle?, data, ttl_seconds?}`

| type | data |
|---|---|
| `weather` | `WeatherData = {location, updated, now:{temp, feels_like, condition, is_day, description, humidity, wind_kmh, high, low}, hourly:[{time, temp, condition, is_day, pop}], daily:[{date, min, max, condition, pop}]}`; `condition` ∈ clear, partly, cloudy, fog, drizzle, rain, snow, sleet, thunder, wind |
| `calendar` | `{events: [{title, start, end, all_day, location?, calendar?, color?}]}` (ISO 8601) |
| `list` | `{items: [{title, detail?, meta?, icon?}]}` |
| `markdown` | `{text}` (Teilmenge: Überschriften, Listen, fett/kursiv, Code, Links ohne Navigation) |
| `image` | `{src: "data:…"\|"https://…", alt, caption?}` |
| `sketch` | `{svg}` (wird als Bild gerendert und nie als DOM eingefügt) |
| `facts` | `{rows: [{label, value}]}` |
| `home` | `{entities: [{name, state, unit?, domain}]}` |
| `alarm` | `{at, label}` |

**Board-Operationen** (ASTRA-Event `board` und `POST /api/v1/board/insert`):

- `add_text {text, x?, y?}`
- `add_mermaid {definition}`
- `add_image {src, caption?}`
- `add_svg {svg}`
- `add_elements {elements: ExcalidrawElementSkeleton[]}`

Ohne Koordinaten platziert das Board den Inhalt rechts neben dem sichtbaren Bereich und scrollt dorthin.

## Whiteboard-Speicher

Ablage unter `kiosk/data/boards/<id>/`: `scene.json` (letzter kompakter Stand), `ops.ndjson` (Append-Log), `files/` (Bilder) und `snapshots/` (stündlich, 14 Tage). Eine Kompaktierung erfolgt nach 500 Ops oder 2 MB.

| Methode | Pfad | Zweck |
|---|---|---|
| GET | `/api/local/board/boards` | Liste `{id, name, updated, thumbnail?}` |
| POST | `/api/local/board/boards` | Anlegen `{name}` |
| PATCH/DELETE | `/api/local/board/boards/:id` | Umbenennen/Löschen (in den Papierkorb) |
| GET | `/api/local/board/boards/:id` | `{scene: {elements, appState, files: {id: meta}}, seq}` |
| POST | `/api/local/board/boards/:id/ops` | `{base_seq, ops: [{type: "upsert", elements} \| {type: "delete", ids} \| {type: "app", appState}]}` → `{seq}` |
| PUT/GET | `/api/local/board/boards/:id/files/:fileId` | Bilddaten |
| GET | `/api/local/board/boards/:id/snapshots` | Liste |
| POST | `/api/local/board/boards/:id/snapshots/:snap/restore` | Wiederherstellen |

Die Board-Seite stellt für den Controller `window.__openboardBoard = {apply(op), exportPNG(), diagnostics()}` bereit.

## MQTT / Home Assistant

Discovery unter `<discoveryPrefix>/<component>/<nodeId>/<object>/config`; ein Gerät „OpenBoard“, Verfügbarkeit per Last Will.

| Entität | Typ | Funktion |
|---|---|---|
| Bildschirm | `switch` | an = wach, aus = Schlafmodus |
| App | `select` | aktive App |
| Leistungsmodus | `select` | eco / balanced / max |
| Design | `select` | dark / light / auto |
| Sagen | `text` | Text → ASTRA-TTS auf dem Display |
| Neu laden, Browser neu starten | `button` | – |
| CPU, GPU, RAM, Temperatur, aktive App, letzte Berührung, Version | `sensor` | – |
| ASTRA verbunden, Update verfügbar | `binary_sensor` | – |
| Widget-Knöpfe `action.mqtt` | `device_automation` (Trigger) | erscheinen als Auslöser in HA-Automationen |

## Updates (`scripts/update.sh`)

1. `git fetch origin <branch>` und Vergleich mit `HEAD`.
2. Bei Abweichung: Abbruch, wenn das Arbeitsverzeichnis lokale Änderungen hat. Sonst wird `HEAD` in `~/.local/state/openboard/update.json` gesichert, dann folgt `git merge --ff-only`.
3. `npm ci`, wenn sich `kiosk/package-lock.json` geändert hat.
4. `node --check` auf alle `.mjs`. Neue Migrationen aus `scripts/migrations/NNN-*.sh` laufen einmalig.
5. Neustart von `openboard-control` und `openboard-remote`, danach 60 s lang `/health`-Prüfung.
6. Schlägt etwas fehl: `git reset --hard <vorher>`, erneute Installation, Neustart, Status „rolled back“.
7. Hat sich ein Browser-Startskript geändert, wird der Browser neu gestartet, sobald das Display schläft oder 2 min ungenutzt ist.
8. Nach dem Neustart ersetzt der Controller die Shell in allen Apps (Hash-Vergleich) und lädt die eingebauten Apps neu, deren Dateien sich geändert haben.
