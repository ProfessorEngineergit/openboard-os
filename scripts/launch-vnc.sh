#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:0 XAUTHORITY="$HOME/.Xauthority"
root="$HOME/mega-display/vendor/vnc/root"
export LD_LIBRARY_PATH="$root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
# Only SSH-tunnel clients and local processes can access this socket.
vnc=$(command -v x11vnc || true)
if [ -z "$vnc" ]; then vnc="$root/usr/bin/x11vnc"; fi
exec "$vnc" -display :0 -auth "$XAUTHORITY" -localhost -rfbport 5900 -forever -shared -nopw -noxdamage -noxfixes -cursor none -wait 50 -defer 20 -quiet
