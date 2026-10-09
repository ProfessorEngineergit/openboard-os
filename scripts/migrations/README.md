# Migrationen

Einmalige Schritte nach einem Update, z. B. Datenformate umstellen. Dateien heißen `NNN-name.sh`
und laufen in dieser Reihenfolge genau einmal (Marker unter `~/.local/state/openboard/migrations`).
Schlägt eine Migration fehl, rollt `update.sh` auf den vorherigen Stand zurück.
