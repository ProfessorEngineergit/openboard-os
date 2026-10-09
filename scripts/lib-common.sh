#!/usr/bin/env bash
# Shared helpers, sourced by the other scripts. Resolves the install directory from
# the script location, so the repository can live anywhere.
OPENBOARD_BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export OPENBOARD_BASE
OPENBOARD_STATE_DIR="${OPENBOARD_STATE_DIR:-$HOME/.local/state/openboard}"
export OPENBOARD_STATE_DIR
mkdir -p "$OPENBOARD_STATE_DIR"

# Node: prefer the runtime installed by install-runtime.sh, else whatever is on PATH.
if [ -z "${OPENBOARD_NODE:-}" ]; then
  if [ -x "$HOME/.local/opt/node/bin/node" ]; then OPENBOARD_NODE="$HOME/.local/opt/node/bin/node"; else OPENBOARD_NODE="$(command -v node || true)"; fi
fi
export OPENBOARD_NODE
OPENBOARD_NPM="${OPENBOARD_NPM:-$(dirname "${OPENBOARD_NODE:-/usr/bin/node}")/npm}"
export OPENBOARD_NPM

openboard_units=(openboard-gev openboard-control openboard-browser openboard-cursor openboard-inhibit openboard-display openboard-remote openboard-vnc)
