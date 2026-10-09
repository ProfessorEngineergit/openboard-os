#!/usr/bin/env bash
# Installs the OpenBoard user services (idempotent). Replaces the old mega-* services.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
base="$OPENBOARD_BASE"
node="${OPENBOARD_NODE:?Node.js fehlt. Zuerst scripts/install-runtime.sh ausführen.}"
units="$HOME/.config/systemd/user"
mkdir -p "$units" "$HOME/.config/autostart" "$base/backups"
chmod +x "$base"/scripts/*.sh

# --- Migration from the old mega-* services -------------------------------------------
for old in mega-kiosk-browser mega-kiosk-control mega-gev mega-kiosk-cursor mega-kiosk-inhibit mega-kiosk-reconnect; do
  if [ -f "$units/$old.service" ]; then
    systemctl --user disable --now "$old.service" 2>/dev/null || true
    rm -rf "$units/$old.service" "$units/$old.service.d"
  fi
done
old_profile="$HOME/.local/share/mega-display/browser"
new_profile="$HOME/.local/share/openboard/browser"
if [ -d "$old_profile" ] && [ ! -d "$new_profile" ]; then mkdir -p "$(dirname "$new_profile")" && mv "$old_profile" "$new_profile"; fi

# --- Services --------------------------------------------------------------------------
cat > "$units/openboard-gev.service" <<UNIT
[Unit]
Description=God's Eye View local server
[Service]
WorkingDirectory=$base/gods-eye-view
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node $base/gods-eye-view/node_modules/vite/bin/vite.js --host localhost --port 4173 --strictPort
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT

cat > "$units/openboard-control.service" <<UNIT
[Unit]
Description=OpenBoard controller (apps, shell, performance, ASTRA, MQTT)
After=openboard-gev.service
[Service]
WorkingDirectory=$base/kiosk
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=$node $base/kiosk/server.mjs
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT

cat > "$units/openboard-browser.service" <<UNIT
[Unit]
Description=OpenBoard kiosk browser
After=openboard-gev.service openboard-control.service
Wants=openboard-gev.service openboard-control.service openboard-cursor.service openboard-inhibit.service openboard-display.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=$base/scripts/launch-browser.sh
Restart=always
RestartSec=2
TimeoutStopSec=10
KillMode=control-group
UNIT

cat > "$units/openboard-cursor.service" <<UNIT
[Unit]
Description=Hide the X11 pointer while the kiosk runs
PartOf=openboard-browser.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=/usr/bin/python3 $base/scripts/hide-cursor.py
Restart=on-failure
RestartSec=3
UNIT

cat > "$units/openboard-inhibit.service" <<UNIT
[Unit]
Description=Keep the display awake while the kiosk runs
PartOf=openboard-browser.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
ExecStart=/usr/bin/xfce4-screensaver-command --inhibit --application-name=OpenBoard --reason=Kiosk
Restart=on-failure
RestartSec=3
UNIT

# Display and touch watcher: resolution, rotation and touch mapping after hotplug.
cat > "$units/openboard-display.service" <<UNIT
[Unit]
Description=OpenBoard display and touch watcher
PartOf=openboard-browser.service
[Service]
Environment=DISPLAY=:0
Environment=XAUTHORITY=$HOME/.Xauthority
Environment=OPENBOARD_STATE_DIR=$OPENBOARD_STATE_DIR
ExecStart=/usr/bin/python3 $base/scripts/reconnect-display.py
Restart=on-failure
RestartSec=3
UNIT

# Auto update: checks every minute (the script honours config updates.intervalSeconds).
cat > "$units/openboard-update.service" <<UNIT
[Unit]
Description=OpenBoard update check
[Service]
Type=oneshot
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/bash $base/scripts/update.sh
UNIT
cat > "$units/openboard-update-now.service" <<UNIT
[Unit]
Description=OpenBoard update check (manual, ignores the interval)
[Service]
Type=oneshot
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/bash $base/scripts/update.sh --now
UNIT
cat > "$units/openboard-update.timer" <<UNIT
[Unit]
Description=OpenBoard update check timer
[Timer]
OnBootSec=90s
OnUnitInactiveSec=60s
AccuracySec=5s
[Install]
WantedBy=timers.target
UNIT

# --- Autostart and emergency shortcut ---------------------------------------------------
autostart="$HOME/.config/autostart/openboard.desktop"
rm -f "$HOME/.config/autostart/mega-display.desktop"
cat > "$autostart" <<DESKTOP
[Desktop Entry]
Type=Application
Name=OpenBoard
Exec=$base/scripts/start-kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=true
DESKTOP

export DISPLAY=:0 XAUTHORITY="$HOME/.Xauthority"
shortcut='/commands/custom/<Primary><Alt><Shift>k'
if xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut" >/dev/null 2>&1; then
  current=$(xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut")
  # Keep the previous binding once (never overwrite the backup of the original).
  [ -f "$base/backups/emergency-shortcut.previous" ] || printf '%s' "$current" > "$base/backups/emergency-shortcut.previous"
  xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut" -s "$base/scripts/stop-kiosk.sh"
else
  xfconf-query -c xfce4-keyboard-shortcuts -p "$shortcut" -n -t string -s "$base/scripts/stop-kiosk.sh" 2>/dev/null || true
fi

systemctl --user daemon-reload
systemctl --user enable openboard-gev.service openboard-control.service
systemctl --user enable --now openboard-update.timer
bash "$base/scripts/start-kiosk.sh"
echo "OpenBoard-Dienste installiert. Status: systemctl --user status openboard-control"
