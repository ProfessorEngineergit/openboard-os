#!/usr/bin/env bash
# Read-only inventory. Run as the display's desktop user over SSH.
set -u
section() { printf '\n### %s\n' "$1"; }
run() { if command -v "$1" >/dev/null 2>&1; then "$@" 2>&1 || true; fi; }
section 'System'
id
hostname
cat /etc/os-release
uname -r
for field in sys_vendor product_name product_version board_name; do
  file="/sys/class/dmi/id/$field"
  if [ -r "$file" ]; then printf '%s: ' "$field"; cat "$file"; fi
done
section 'CPU and memory'
run lscpu
run free -h
section 'Storage'
run lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL
run df -h / "$HOME"
section 'Graphics, network and audio controllers'
if command -v lspci >/dev/null 2>&1; then
  lspci -nnk | sed -n '/VGA\|Display\|3D controller\|Audio\|Network controller/,+3p'
fi
section 'USB and input devices'
run lsusb
if [ -r /proc/bus/input/devices ]; then cat /proc/bus/input/devices; fi
section 'Display connectors'
for connector in /sys/class/drm/card*-*; do
  [ -d "$connector" ] || continue
  printf '\n%s\n' "$connector"
  for field in status enabled modes; do
    if [ -r "$connector/$field" ]; then printf '%s: ' "$field"; cat "$connector/$field"; fi
  done
  if [ -s "$connector/edid" ] && command -v edid-decode >/dev/null 2>&1; then
    edid-decode "$connector/edid" || true
  fi
done
section 'Desktop sessions'
run loginctl list-sessions --no-legend
run pgrep -a -f 'Xorg|Xwayland|gnome-shell|xfce4-session|openbox|chromium|chrome|firefox'
printf 'SSH DISPLAY=%s XAUTHORITY=%s\n' "${DISPLAY:-unset}" "${XAUTHORITY:-unset}"
section 'Audio outputs and inputs'
run wpctl status
run pactl info
run pactl list short sinks
run pactl list short sources
run aplay -l
run arecord -l
section 'Installed tools'
for tool in chromium chromium-browser google-chrome firefox node npm git python3 xinput xrandr unclutter curl; do
  command -v "$tool" || true
done
run systemctl is-active ssh display-manager NetworkManager
section 'Privilege availability'
if sudo -n true 2>/dev/null; then
  printf 'Noninteractive sudo is available.\n'
else
  printf 'Sudo needs interactive authentication or is unavailable.\n'
fi
