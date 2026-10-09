#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
mkdir -p "$HOME/.local/opt"
cd "$HOME/.local/opt"
wget -q https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -O node-shasums.txt
node_archive=$(awk '/ node-v.*-linux-x64.tar.xz$/ {print $2}' node-shasums.txt)
test -n "$node_archive"
wget -q "https://nodejs.org/dist/latest-v24.x/$node_archive" -O "$node_archive"
awk -v file="$node_archive" '$2 == file' node-shasums.txt | sha256sum -c -
tar -xf "$node_archive"
ln -sfn "${node_archive%.tar.xz}" node
export PATH="$HOME/.local/opt/node/bin:$PATH"
node --version
npm --version
cd "$OPENBOARD_BASE/gods-eye-view"
PUPPETEER_SKIP_DOWNLOAD=true npm ci --no-audit --no-fund
npm run doctor
