#!/usr/bin/env bash
set -euo pipefail
base="$HOME/mega-display"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/autostart" "$base/backups"
chmod +x "$base"/scripts/*.sh
cat > "$HOME/.config/systemd/user/mega-gev.service" <<EOF
[Unit]
Description=Gods Eye View local server
[Service]
WorkingDirectory=$base/gods-eye-view
Environment=PATH=$HOME/.local/opt/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$HOME/.local/opt/node/bin/node $base/gods-eye-view/node_modules/vite/bin/vite.js --host localhost --port 4173 --strictPort
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
cat > "$HOME/.config/systemd/user/mega-kiosk-control.service" <<EOF
[Unit]
Description=MEGA DISPLAY tabs and Gemini control
After=mega-gev.service
[Service]
WorkingDirectory=$base/kiosk
Environment=PATH=$HOME/.local/opt/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$HOME/.local/opt/node/bin/node $base/kiosk/server.mjs
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
cat > "$HOME/.config/systemd/user/mega-kiosk-browser.service" <<EOF
[Unit]
Description=MEGA DISPLAY touch kiosk browser
After=mega-gev.service mega-kiosk-control.service
Wants=mega-gev.service mega-kiosk-control.service mega-kiosk-cursor.service mega-kiosk-inhibit.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=$base/scripts/launch-browser.sh
Restart=always
RestartSec=2
TimeoutStopSec=10
KillMode=control-group
EOF
cat > "$HOME/.config/systemd/user/mega-kiosk-cursor.service" <<EOF
[Unit]
Description=Hide the X11 pointer while the kiosk runs
PartOf=mega-kiosk-browser.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=/usr/bin/python3 $base/scripts/hide-cursor.py
Restart=on-failure
RestartSec=3
EOF
cat > "$HOME/.config/systemd/user/mega-kiosk-inhibit.service" <<EOF
[Unit]
Description=Keep the touch kiosk display awake
PartOf=mega-kiosk-browser.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=/usr/bin/xfce4-screensaver-command --inhibit --application-name=MEGA-DISPLAY --reason=Touch-kiosk
Restart=on-failure
RestartSec=3
EOF
autostart="$HOME/.config/autostart/mega-display.desktop"
if [ -f "$autostart" ]; then cp -p "$autostart" "$base/backups/mega-display.desktop.$(date +%s)"; fi
cat > "$autostart" <<EOF
[Desktop Entry]
Type=Application
Name=MEGA DISPLAY Kiosk
Exec=$base/scripts/start-kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
export DISPLAY=:0 XAUTHORITY="$HOME/.Xauthority"
shortcut='/commands/custom/<Primary><Alt><Shift>k'
if xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut" >/dev/null 2>&1; then
  xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut" > "$base/backups/emergency-shortcut.previous"
  xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut" -s "$base/scripts/stop-kiosk.sh"
else
  xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut" -n -t string -s "$base/scripts/stop-kiosk.sh"
fi
systemctl --user daemon-reload
systemctl --user enable mega-gev.service mega-kiosk-control.service
bash "$base/scripts/start-kiosk.sh"
