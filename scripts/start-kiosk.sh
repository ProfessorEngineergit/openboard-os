#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
# Compositing adds about a frame of pen latency to fullscreen windows. Switch it off while the
# kiosk runs and remember the old value for stop-kiosk.sh.
if command -v xfconf-query >/dev/null 2>&1; then
  prev=$(xfconf-query -c xfwm4 -p /general/use_compositing 2>/dev/null || true)
  if [ -n "$prev" ] && [ ! -f "$OPENBOARD_STATE_DIR/compositing.previous" ]; then printf '%s' "$prev" > "$OPENBOARD_STATE_DIR/compositing.previous"; fi
  xfconf-query -c xfwm4 -p /general/use_compositing -s false 2>/dev/null || true
fi
systemctl --user import-environment DISPLAY XAUTHORITY
systemctl --user start openboard-gev.service openboard-control.service openboard-browser.service
