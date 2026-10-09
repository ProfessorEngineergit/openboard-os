#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib-common.sh"
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
export MOZ_USE_XINPUT2=1
python3 "$OPENBOARD_BASE/scripts/wait-kiosk-ready.py"
profile="$HOME/snap/firefox/common/openboard-kiosk"
mkdir -p "$profile"
cat > "$profile/user.js" <<'EOF'
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.max_resumed_crashes", 0);
user_pref("browser.startup.page", 1);
user_pref("browser.tabs.warnOnClose", false);
user_pref("dom.w3c_touch_events.enabled", 1);
user_pref("ui.context_menus.after_mouseup", false);
user_pref("apz.allow_zooming", false);
user_pref("apz.allow_double_tap_zooming", false);
user_pref("browser.gesture.pinch.latched", false);
user_pref("dom.ipc.processCount", 4);
EOF
xset s off
xset -dpms
exec /usr/bin/firefox --no-remote --profile "$profile" --remote-debugging-port=9222 --kiosk http://localhost:4173/
