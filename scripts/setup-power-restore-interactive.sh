#!/usr/bin/env bash
set -uo pipefail
printf 'HP: Automatisch einschalten, sobald der Strom wieder da ist.\n'
printf 'Die einzige BIOS-Änderung ist: After Power Loss → Power On.\n'
printf 'Bitte Ubuntu-Passwort hier eingeben (Eingabe bleibt unsichtbar).\n\n'
if sudo /usr/bin/bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/enable-power-restore.sh"; then
  printf '\nFertig. Der Kiosk bleibt eingerichtet.\n'
else
  printf '\nNoch nicht eingerichtet. Die obige Fehlermeldung zeigt den Grund.\n'
fi
read -r -p 'Enter schließt dieses Fenster. ' _answer
