#!/usr/bin/env bash
# The user runs this one-time package installation with sudo on the display.
set -euo pipefail
test "$(id -u)" = 0
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y git curl ca-certificates xdotool unclutter-xfixes pulseaudio-utils python3-pil python3-websocket
snap install chromium
printf '\nSystem packages and Chromium are ready.\n'
