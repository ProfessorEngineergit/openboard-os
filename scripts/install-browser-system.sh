#!/usr/bin/env bash
# Install the official, already downloaded Chrome build at Ubuntu's trusted
# browser path. The existing AppArmor profile enables Chromium's sandbox.
set -euo pipefail
test "$(id -u)" = 0
source_dir=${1:?Pass the directory containing the downloaded official chrome-linux64 build}
destination=/opt/google/chrome
test -x "$source_dir/chrome"
if [ -e "$destination/chrome" ]; then
  printf 'A system Chrome installation already exists; leaving it intact.\n'
  exit 0
fi
install -d -m 0755 "$destination"
cp -a "$source_dir/." "$destination/"
chown -R root:root "$destination"
chmod 0755 "$destination/chrome"
printf 'Official browser installed. AppArmor and Chromium sandbox remain enabled.\n'
