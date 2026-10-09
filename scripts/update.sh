#!/usr/bin/env bash
# OpenBoard auto update. Run by openboard-update.timer every minute (and by the dock/console on demand with --now).
#
#   fetch origin/<branch> -> fast-forward -> npm ci if the lockfile changed -> syntax check -> migrations
#   -> restart controller + console -> wait for /health -> on any failure: roll back to the previous commit.
#
# Never touches a working tree with local changes. State for the controller: $OPENBOARD_STATE_DIR/update.json
# Options: --now (ignore the interval)   --check (only look for updates, do not apply)
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
cd "$OPENBOARD_BASE"
# Overridable for tests.
SYSTEMCTL="${OPENBOARD_SYSTEMCTL:-systemctl --user}"
HEALTH_URL="${OPENBOARD_HEALTH_URL:-http://127.0.0.1:4180/health}"
STATE="$OPENBOARD_STATE_DIR/update.json"
LOG="$OPENBOARD_STATE_DIR/update.log"
LOCK="$OPENBOARD_STATE_DIR/update.lock"
NOW=0; CHECK_ONLY=0
for arg in "$@"; do case "$arg" in --now) NOW=1;; --check) CHECK_ONLY=1;; esac; done

exec 9>"$LOCK"
flock -n 9 || exit 0

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }
# Keep the log small.
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt 600 ]; then tail -n 300 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi

# Reads a value from kiosk/config.json (python3 is always present on Ubuntu).
config() { python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    node = json.load(open('kiosk/config.json')).get('updates', {})
    value = node.get(sys.argv[1])
    print(sys.argv[2] if value is None else str(value).lower() if isinstance(value, bool) else value)
except Exception:
    print(sys.argv[2])
PY
}

# Merges key=value pairs into the state file (values are JSON).
state() { python3 - "$STATE" "$@" <<'PY'
import json, sys, time
path, pairs = sys.argv[1], sys.argv[2:]
try: data = json.load(open(path))
except Exception: data = {}
for pair in pairs:
    key, _, raw = pair.partition('=')
    try: data[key] = json.loads(raw)
    except Exception: data[key] = raw
tmp = path + '.tmp'
json.dump(data, open(tmp, 'w'), indent=2)
import os; os.replace(tmp, path)
PY
}

nowts() { date +%s000; }

ENABLED=$(config enabled true)
BRANCH=$(config branch main)
INTERVAL=$(config intervalSeconds 60)

# Honour the configured interval unless asked explicitly.
if [ "$NOW" = 0 ]; then
  last=$(python3 -c "import json;print(int(json.load(open('$STATE')).get('lastCheck',0)))" 2>/dev/null || echo 0)
  now=$(nowts)
  if [ $(( (now - last) / 1000 )) -lt "$INTERVAL" ]; then exit 0; fi
fi

git rev-parse --git-dir >/dev/null 2>&1 || { log "kein Git-Repository"; exit 0; }
if ! timeout 60 git fetch --quiet origin "$BRANCH" 2>>"$LOG"; then
  state "lastCheck=$(nowts)" 'lastResult="offline"' 'message="Fetch fehlgeschlagen (Netzwerk?)"'
  exit 0
fi

HEAD_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse "origin/$BRANCH")
if [ "$HEAD_SHA" = "$REMOTE_SHA" ] || git merge-base --is-ancestor "$REMOTE_SHA" "$HEAD_SHA"; then
  state "lastCheck=$(nowts)" 'available=false' 'lastResult="current"' 'message=null'
  exit 0
fi

# An update exists.
if [ "$ENABLED" != "true" ] || [ "$CHECK_ONLY" = 1 ]; then
  state "lastCheck=$(nowts)" 'available=true' 'lastResult="available"' 'message="Update verfügbar (automatisch aus)"'
  exit 0
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "Arbeitsverzeichnis hat lokale Änderungen, Update übersprungen"
  state "lastCheck=$(nowts)" 'available=true' 'lastResult="blocked"' 'message="Lokale Änderungen im Arbeitsverzeichnis"'
  exit 0
fi
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then git checkout --quiet "$BRANCH" 2>>"$LOG" || { state "lastCheck=$(nowts)" 'lastResult="blocked"' 'message="Branch-Wechsel fehlgeschlagen"'; exit 0; }; fi

PREVIOUS="$HEAD_SHA"
log "Update $PREVIOUS -> $REMOTE_SHA"
state "lastCheck=$(nowts)" 'available=true' 'lastResult="updating"' "previous=\"$PREVIOUS\"" 'message="Update läuft …"'
CHANGED=$(git diff --name-only "$PREVIOUS" "$REMOTE_SHA")

rollback() {
  log "FEHLER: $1 – Rollback auf $PREVIOUS"
  git reset --hard --quiet "$PREVIOUS" 2>>"$LOG"
  if echo "$CHANGED" | grep -q '^kiosk/package-lock.json$'; then (cd kiosk && PUPPETEER_SKIP_DOWNLOAD=true "$OPENBOARD_NPM" ci --no-audit --no-fund >>"$LOG" 2>&1); fi
  $SYSTEMCTL restart openboard-control.service >>"$LOG" 2>&1
  $SYSTEMCTL try-restart openboard-remote.service >>"$LOG" 2>&1
  state "lastCheck=$(nowts)" 'available=true' 'lastResult="rolled-back"' "message=\"$1\""
  exit 1
}

git merge --ff-only --quiet "origin/$BRANCH" 2>>"$LOG" || rollback "Fast-Forward nicht möglich"

if echo "$CHANGED" | grep -q '^kiosk/package-lock.json$'; then
  log "npm ci"
  (cd kiosk && PUPPETEER_SKIP_DOWNLOAD=true "$OPENBOARD_NPM" ci --no-audit --no-fund >>"$LOG" 2>&1) || rollback "npm ci fehlgeschlagen"
fi

# Syntax check of everything the controller and console load.
while IFS= read -r file; do
  "$OPENBOARD_NODE" --check "$file" >>"$LOG" 2>&1 || rollback "Syntaxfehler in $file"
done < <(git ls-files 'kiosk/*.mjs' 'kiosk/lib/*.mjs' 'remote/*.mjs')

# One-time migrations: scripts/migrations/NNN-name.sh (run once, recorded in the state dir).
mkdir -p "$OPENBOARD_STATE_DIR/migrations"
for migration in $(ls scripts/migrations/*.sh 2>/dev/null | sort); do
  mark="$OPENBOARD_STATE_DIR/migrations/$(basename "$migration")"
  [ -f "$mark" ] && continue
  log "Migration $(basename "$migration")"
  bash "$migration" >>"$LOG" 2>&1 || rollback "Migration $(basename "$migration") fehlgeschlagen"
  touch "$mark"
done

$SYSTEMCTL restart openboard-control.service >>"$LOG" 2>&1 || rollback "Controller-Neustart fehlgeschlagen"
$SYSTEMCTL try-restart openboard-remote.service >>"$LOG" 2>&1

# The controller must answer /health within a minute.
ok=0
for _ in $(seq 1 30); do
  sleep 2
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then ok=1; break; fi
done
[ "$ok" = 1 ] || rollback "Controller antwortet nach dem Update nicht"

# A changed browser launcher only takes effect after a browser restart; the controller does that when idle.
RESTART=false
if echo "$CHANGED" | grep -qE '^scripts/(launch-browser|launch-firefox|wait-kiosk-ready)'; then RESTART=true; fi
REINSTALL=""
if echo "$CHANGED" | grep -qE '^scripts/install-(services|remote-services)\.sh$'; then REINSTALL=" Dienste neu einrichten: scripts/install-services.sh"; fi
NEW=$(git rev-parse --short=10 HEAD)
log "Update auf $NEW abgeschlossen"
state "lastCheck=$(nowts)" 'available=false' 'lastResult="updated"' "lastUpdate=$(nowts)" "pendingBrowserRestart=$RESTART" "message=\"Aktualisiert auf $NEW.$REINSTALL\""
