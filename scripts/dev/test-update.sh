#!/usr/bin/env bash
# Tests scripts/update.sh against a throw-away Git remote (no systemd, no real controller).
set -uo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
work="$(mktemp -d)"; trap 'kill $HEALTH_PID 2>/dev/null; rm -rf "$work"' EXIT
fail=0
check() { if [ "$2" = "$3" ]; then echo "✓ $1"; else echo "✗ $1: erwartet '$3', war '$2'"; fail=1; fi; }
result() { python3 -c "import json;print(json.load(open('$work/state/update.json')).get('lastResult'))"; }

# origin + deployed clone containing the real scripts
git init -q --bare "$work/origin.git"
git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
mkdir -p "$work/seed/scripts" "$work/seed/kiosk/lib" "$work/seed/remote"
cp "$repo/scripts/update.sh" "$repo/scripts/lib-common.sh" "$work/seed/scripts/"
echo 'export const a = 1;' > "$work/seed/kiosk/server.mjs"
echo '{}' > "$work/seed/kiosk/package-lock.json"
( cd "$work/seed" && git add -A && git -c user.name=t -c user.email=t@t commit -qm v1 && git branch -M main && git push -q origin main )
git clone -q "$work/origin.git" "$work/deploy" 2>/dev/null
( cd "$work/deploy" && git checkout -q main 2>/dev/null )

# fake systemctl and a health endpoint whose answer the test can switch
cat > "$work/systemctl" <<'SH'
#!/usr/bin/env bash
echo "$@" >> "$(dirname "$0")/systemctl.log"
SH
chmod +x "$work/systemctl"
cat > "$work/health.py" <<'PY'
import http.server, os, sys
flag = sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = not os.path.exists(flag)
        self.send_response(200 if ok else 503); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
PY
python3 "$work/health.py" 18999 "$work/unhealthy" & HEALTH_PID=$!
sleep 0.5
export OPENBOARD_STATE_DIR="$work/state" OPENBOARD_SYSTEMCTL="$work/systemctl" OPENBOARD_HEALTH_URL=http://127.0.0.1:18999/health OPENBOARD_NPM=true
run() { ( cd "$work/deploy" && bash scripts/update.sh --now ); }
push() { ( cd "$work/seed" && git add -A && git -c user.name=t -c user.email=t@t commit -qm "$1" && git push -q origin main ); }
sha() { git -C "$work/deploy" rev-parse --short HEAD; }

run; check "nothing new -> current" "$(result)" "current"

echo 'export const a = 2;' > "$work/seed/kiosk/server.mjs"; push v2
v1=$(sha); run
check "good update -> updated" "$(result)" "updated"
check "head moved" "$([ "$(sha)" != "$v1" ] && echo yes)" "yes"
check "controller restarted" "$(grep -c 'restart openboard-control' "$work/systemctl.log" | tr -d ' ')" "1"

echo 'export const a = ;' > "$work/seed/kiosk/server.mjs"; push broken
v2=$(sha); run
check "syntax error -> rolled-back" "$(result)" "rolled-back"
check "head restored" "$(sha)" "$v2"

echo 'export const a = 3;' > "$work/seed/kiosk/server.mjs"; push v3
touch "$work/unhealthy"; run
check "controller unhealthy -> rolled-back" "$(result)" "rolled-back"
check "head restored after failed health" "$(sha)" "$v2"
rm "$work/unhealthy"

echo dirty >> "$work/deploy/kiosk/server.mjs"; run
check "local changes -> blocked" "$(result)" "blocked"
( cd "$work/deploy" && git checkout -q -- . )

mkdir -p "$work/seed/scripts/migrations"; echo 'touch "$OPENBOARD_STATE_DIR/migrated"' > "$work/seed/scripts/migrations/001-test.sh"; push migration
run
check "migration ran once" "$([ -f "$work/state/migrated" ] && echo yes)" "yes"
check "migration update -> updated" "$(result)" "updated"

( cd "$work/deploy" && git remote set-url origin /nonexistent ); run
check "no network -> offline" "$(result)" "offline"

[ "$fail" = 0 ] && echo "update.sh: alle Tests bestanden" || { echo "update.sh: Fehler"; cat "$work/state/update.log" | tail -20; exit 1; }
