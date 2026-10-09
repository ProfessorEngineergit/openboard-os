#!/usr/bin/env bash
set -euo pipefail
base="$HOME/mega-display"
mkdir -p "$HOME/.config/systemd/user" "$base/remote/novnc"
if [ ! -f "$base/remote/novnc/core/rfb.js" ]; then
  curl --fail --location https://github.com/novnc/noVNC/archive/a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820.tar.gz \
    | tar -xz --strip-components=1 -C "$base/remote/novnc"
fi
cat > "$HOME/.config/systemd/user/mega-display-vnc.service" <<UNIT
[Unit]
Description=Local X11 display mirror for SSH tunnel
[Service]
ExecStart=/usr/bin/bash $base/scripts/launch-vnc.sh
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
cat > "$HOME/.config/systemd/user/mega-display-remote.service" <<UNIT
[Unit]
Description=Browser remote control through SSH tunnel
After=mega-display-vnc.service
Wants=mega-display-vnc.service
[Service]
WorkingDirectory=$base/remote
ExecStart=$HOME/.local/opt/node/bin/node $base/remote/server.mjs
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now mega-display-vnc.service mega-display-remote.service
