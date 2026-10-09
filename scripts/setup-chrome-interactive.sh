#!/usr/bin/env bash
set -euo pipefail
printf 'Chromium-Kiosk einrichten. Ubuntu-Passwort hier eingeben.\n'
source_binary=$(find "$HOME/.cache/puppeteer/chrome" -type f -path '*/chrome-linux64/chrome' | sort -V | tail -n 1)
test -n "$source_binary"
sudo bash "$HOME/mega-display/scripts/install-browser-system.sh" "$(dirname "$source_binary")"
systemctl --user stop mega-kiosk-control.service
bash "$HOME/mega-display/scripts/start-kiosk.sh"
printf '\nChrome wurde gestartet. Dieses Fenster kann geschlossen werden.\n'
read -r -p 'Enter zum Schließen. '
