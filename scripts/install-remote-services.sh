#!/usr/bin/env bash
# Installs the remote console and the local VNC mirror (loopback only; reach it through an SSH tunnel).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
base="$OPENBOARD_BASE"
node="${OPENBOARD_NODE:?Node.js fehlt. Zuerst scripts/install-runtime.sh ausführen.}"
units="$HOME/.config/systemd/user"
mkdir -p "$units" "$base/remote/novnc"
for old in mega-display-vnc mega-display-remote; do
  if [ -f "$units/$old.service" ]; then systemctl --user disable --now "$old.service" 2>/dev/null || true; rm -f "$units/$old.service"; fi
done
if [ ! -f "$base/remote/novnc/core/rfb.js" ]; then
  curl --fail --location https://github.com/novnc/noVNC/archive/a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820.tar.gz \
    | tar -xz --strip-components=1 -C "$base/remote/novnc"
fi
cat > "$units/openboard-vnc.service" <<UNIT
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
cat > "$units/openboard-remote.service" <<UNIT
[Unit]
Description=OpenBoard remote console (SSH tunnel only)
After=openboard-vnc.service
Wants=openboard-vnc.service
[Service]
WorkingDirectory=$base/remote
ExecStart=$node $base/remote/server.mjs
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now openboard-vnc.service openboard-remote.service
echo "Konsole: ssh -N -L 16080:127.0.0.1:6080 USER@HOST, dann http://localhost:16080/"
