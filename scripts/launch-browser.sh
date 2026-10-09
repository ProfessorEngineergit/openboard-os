#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
browser_path=/opt/google/chrome/chrome
if [ ! -x "$browser_path" ]; then
  printf 'System Chrome awaits installation; starting installed Firefox kiosk.\n'
  exec bash "$OPENBOARD_BASE/scripts/launch-firefox.sh"
fi
python3 "$OPENBOARD_BASE/scripts/wait-kiosk-ready.py"
xset s off
xset -dpms
# The system path selects Ubuntu's existing Chrome AppArmor profile.
# --disable-pinch: no page zoom; --enable-features=...: touch and pen events arrive unthrottled.
exec "$browser_path" \
  --user-data-dir="$HOME/.local/share/openboard/browser" \
  --kiosk --no-first-run --no-default-browser-check \
  --disable-session-crashed-bubble --touch-events=enabled --disable-pinch \
  --overscroll-history-navigation=0 \
  --disable-features=Translate,TouchpadOverscrollHistoryNavigation \
  --autoplay-policy=no-user-gesture-required \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  http://localhost:4173/
