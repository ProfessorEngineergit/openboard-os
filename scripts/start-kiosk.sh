#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
systemctl --user import-environment DISPLAY XAUTHORITY
systemctl --user start mega-gev.service mega-kiosk-control.service mega-kiosk-browser.service
