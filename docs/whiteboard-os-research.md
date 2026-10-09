# Ähnliche Projekte und Bausteine

Recherche vom 9. Oktober 2026. Die Einordnung bezieht sich auf die offiziellen
Projektseiten und Dokumentationen, nicht auf eigene Installationstests.

Gesucht ist eine Touch-Arbeitsumgebung für große Displays: eigene Apps,
Zeichnungen und Projektmaterial zusammenbringen, zwischen Anwendungen wechseln
und ihre Darstellung sowie CPU-, GPU- und RAM-Nutzung koordinieren. Ein
Zeichenprogramm allein erfüllt dieses Ziel nur teilweise.

| Projekt | Nähe zur Vision | Bestehende Funktion | Grenze / Lizenz |
| --- | --- | --- | --- |
| [SAGE3](https://github.com/SAGE-3/next) | Sehr hoch: gemeinsame Fläche mit Apps | Unendliche Boards, veränderbare App-Fenster, eigene Web-App-Plugins, Bildschirm-/Fensterfreigaben; für große Display-Wände ausgelegt | Eigene Lizenz mit eingeschränkter Nutzung; kein uneingeschränkt frei verwendbarer Unterbau |
| [OpenBoard](https://github.com/OpenBoard-org/OpenBoard) | Hoch beim Whiteboard und bei Touch-Präsentationen | Zeichnen, Unterrichtsmaterial, Desktop-Annotation und Bildschirmbereiche ins Board übernehmen; Windows, macOS, Linux | Schwerpunkt Unterricht und Whiteboard; kein allgemeiner App-Lifecycle-Manager. GPLv3 |
| [SQLBI Whiteboard](https://github.com/sql-bi/SQLBI-Whiteboard) | Hoch beim Nebeneinander von Zeichnungen und laufenden Apps | Native Windows-11-App mit unendlichem Canvas und LiveView-Containern für App-Fenster oder Displays; Ansichten einfrieren und annotieren | Windows-Anwendung, keine Ubuntu-Kiosk-Shell und kein universeller App-Host. MIT |
| [Apache Guacamole](https://guacamole.apache.org/) | Wichtiger Baustein für entfernte Windows-/Linux-Apps | Browserbasierte Fernbedienung über RDP, VNC und SSH | Kein Whiteboard und keine räumliche Projektoberfläche. Apache 2.0 |
| [KioskOS](https://kioskos.io/) | Nähe bei Gerätebetrieb und Fernverwaltung | Vollbild-Chromium, Start beim Booten, zentrale Konfiguration und Geräteüberwachung | Digital-Signage-/Kiosk-Infrastruktur; keine gemeinsame Arbeitsfläche mit Apps. Laut Projekt MIT |

## Der engste Vergleich: SAGE3

SAGE3 platziert Anwendungen als Fenster auf einer gemeinsamen Arbeitsfläche.
Externe Plugins können mit beliebigen Web-Frameworks erstellt werden und laufen
in isolierten iFrames. Eine Drawing-App, Webviews und Bildschirmfreigaben ergänzen
die Oberfläche. Damit ähnelt es dem gewünschten Zusammenspiel von Projekten
und eigenen Apps besonders stark. Quellen:
[Anwendungen](https://sage-3.github.io/docs/Applications),
[Plugin-Entwicklung](https://sage-3.github.io/docs/Application-Development),
[Architektur](https://sage-3.github.io/docs/Architecture).

Die Lizenz verlangt jedoch eingeschränkte Nutzung und behandelt kommerzielle
Verwendung separat. Abgeleitete Arbeiten unterliegen ebenfalls Bedingungen.
Für ein frei weiterverwendbares eigenes Projekt ist SAGE3 deshalb eine
funktionale Referenz; eine direkte Übernahme muss gesondert auf Lizenzkompatibilität
geprüft werden. Quelle: [SAGE3-Lizenz](https://github.com/SAGE-3/next/blob/main/LICENSE).

## Zeichnen über Apps und Apps bedienen

OpenBoard hat einen Desktop-Modus zum Annotieren und Übernehmen von
Bildschirmbereichen ins Board. Das ist ein gutes Vorbild für den Wechsel zwischen
Zeichnen, Präsentieren und Anwendungen. Quelle:
[OpenBoard-Handbuch, Desktop-Modus](https://openboard.ch/download/Tutoriel_OpenBoard_1.6EN.pdf).

SQLBI Whiteboard zeigt laufende Windows-Fenster in LiveView-Containern und kann
die Ansicht einfrieren. Die Dokumentation beschreibt dabei Fensteraufnahme und
Annotation; daraus folgt keine generelle Fernbedienung der aufgenommenen App.
Quelle: [Funktionen im Repository](https://github.com/sql-bi/SQLBI-Whiteboard).

Für tatsächliche Eingaben in eine entfernte Windows-App wäre ein Remote-Adapter
wie Guacamole ein eigener Baustein. Windows und die Anwendung laufen dabei auf
einem Windows-Rechner oder einer VM; der Touch-Client zeigt und bedient die
Sitzung im Browser. Das wäre keine native Windows-Laufzeit in dieser Linux-Shell.
Quelle: [Apache Guacamole](https://guacamole.apache.org/).

## Konsequenz für dieses Projekt

Meine Einordnung: Die Idee hat bereits sehr nahe Verwandte, besonders SAGE3.
Ein allgemeines, frei nutzbares Whiteboard-OS mit beliebigen nativen und Web-Apps,
Touch-Kiosk-Betrieb und überprüfter Ressourcenverteilung habe ich in dieser
Recherche nicht als fertige Gesamtlösung bestätigt. Das ist eine begrenzte
Rechercheaussage, keine Behauptung, dass es weltweit keines gibt.

Der eigene Schwerpunkt kann eine schlanke, lokal betreibbare Touch-Shell sein:
App-Adapter, Projekt-Arbeitsflächen, gute Wiederherstellung und messbare
Reaktionszeiten. Vor einer großen Neuentwicklung sollte ein kleiner Vergleich
mit SAGE3 und OpenBoard zeigen, welche Interaktionen übernommen werden sollen.
Der aktuelle Prototyp demonstriert bislang den Switcher und das Whiteboard;
Windows-Integration, freie App-Anordnung, Caching und globale Ressourcenbudgets
sind Entwicklungsziele.

OpenBoard ist außerdem bereits ein etablierter Projektname. Eine neue Shell
sollte sich sichtbar von diesem Projekt unterscheiden und keine Zugehörigkeit
oder Ableitung suggerieren.
