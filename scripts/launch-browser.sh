#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
browser_path=/opt/google/chrome/chrome
if [ ! -x "$browser_path" ]; then
  printf 'System Chrome awaits installation; starting installed Firefox kiosk.\n'
  exec bash "$HOME/mega-display/scripts/launch-firefox.sh"
fi
python3 "$HOME/mega-display/scripts/wait-kiosk-ready.py"
xset s off
xset -dpms
# The system path selects Ubuntu's existing Chrome AppArmor profile.
exec "$browser_path" \
  --user-data-dir="$HOME/.local/share/mega-display/browser" \
  --kiosk --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --touch-events=enabled \
  --overscroll-history-navigation=0 \
  --disable-features=Translate,TouchpadOverscrollHistoryNavigation \
  --autoplay-policy=no-user-gesture-required \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  http://localhost:4173/
