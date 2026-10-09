#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
systemctl --user stop openboard-browser.service openboard-cursor.service
# The desktop session and its background remain available for maintenance.
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
xset s on
xset +dpms
if [ -f "$OPENBOARD_STATE_DIR/compositing.previous" ] && command -v xfconf-query >/dev/null 2>&1; then
  xfconf-query -c xfwm4 -p /general/use_compositing -s "$(cat "$OPENBOARD_STATE_DIR/compositing.previous")" 2>/dev/null || true
  rm -f "$OPENBOARD_STATE_DIR/compositing.previous"
fi
