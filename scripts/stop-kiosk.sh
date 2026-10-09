#!/usr/bin/env bash
set -euo pipefail
systemctl --user stop mega-kiosk-browser.service mega-kiosk-cursor.service
# The desktop session and its background remain available for maintenance.
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
xset s on
xset +dpms
