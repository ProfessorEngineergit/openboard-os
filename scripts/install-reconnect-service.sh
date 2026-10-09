#!/usr/bin/env bash
set -euo pipefail
base="$HOME/mega-display"
mkdir -p "$HOME/.config/systemd/user/mega-kiosk-browser.service.d"
cat > "$HOME/.config/systemd/user/mega-kiosk-reconnect.service" <<EOF
[Unit]
Description=Reconnect Sharp display and touch input
PartOf=mega-kiosk-browser.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=/usr/bin/python3 $base/scripts/reconnect-display.py
Restart=on-failure
RestartSec=3
EOF
cat > "$HOME/.config/systemd/user/mega-kiosk-browser.service.d/reconnect.conf" <<EOF
[Unit]
Wants=mega-kiosk-reconnect.service
EOF
systemctl --user daemon-reload
systemctl --user start mega-kiosk-reconnect.service
