#!/usr/bin/env bash
# Optional extras for monitoring and display control. Needs sudo.
#   intel_gpu_top  - real GPU load for the GPU widget (otherwise the GPU clock is shown)
#   ddcutil        - display brightness over the video cable (DDC/CI)
set -euo pipefail
sudo apt-get install -y intel-gpu-tools ddcutil
# intel_gpu_top needs the perf capability; this avoids running anything as root.
sudo setcap cap_perfmon=ep "$(command -v intel_gpu_top)" || true
# ddcutil talks to /dev/i2c-*; the user must be in the i2c group (log in again afterwards).
sudo groupadd -f i2c
sudo usermod -aG i2c "$USER"
echo "Fertig. Neu anmelden, damit die Gruppe i2c gilt."
