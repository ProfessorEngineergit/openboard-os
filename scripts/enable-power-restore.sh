#!/usr/bin/env bash
# Authorized BIOS change: start this HP automatically when AC power returns.
set -euo pipefail
attribute='/sys/class/firmware-attributes/hp-bioscfg/attributes/After Power Loss'
if [ "$(id -u)" != 0 ]; then
  printf 'This change requires administrator authentication.\n' >&2
  exit 1
fi
[ -f "$attribute/current_value" ]
case ";$(cat "$attribute/possible_values");" in
  *';Power On;'*) ;;
  *) printf 'Firmware does not advertise Power On. No change made.\n' >&2; exit 1 ;;
esac
printf 'Previous value: '; cat "$attribute/current_value"
printf '%s\n' 'Power On' > "$attribute/current_value"
value=$(cat "$attribute/current_value")
[ "$value" = 'Power On' ]
printf 'Verified BIOS setting: After Power Loss = %s\n' "$value"
