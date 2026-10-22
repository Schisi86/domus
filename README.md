# NexusTalk

Schlanke, selbst hostbare Kommunikationssoftware für Text, Sprache, Video und Bildschirmübertragung – Windows-Desktop-App mit integriertem Servermodus und eigenständigem Headless-Server. Keine Cloud, keine externe Registrierung, kein zentraler Anbieter.

> Projektname „NexusTalk“ ist ein Platzhalter.

## Funktionsumfang (Kurzfassung)

* **Server & Kanäle:** Kategorien, Text- und Sprachkanäle, Rollen (Inhaber, Administrator, Moderator, Mitglied, Gast – anpassbar) mit Kanal-Overrides, Einladungen, Freischaltung, Sperren, Audit-Protokoll, Serverprotokoll, Ressourcenanzeige, Backups/Wiederherstellung.
* **Text:** Echtzeit, Verlauf mit Nachladen, Antworten, Erwähnungen, Bearbeiten/Löschen, Mehrzeiler, Code, Links, Dateianhänge mit Fortschritt und Bildvorschau, Ungelesen-/Erwähnungszähler, Tippanzeige, Volltextsuche, Benachrichtigungen.
* **Sprache/Video:** WebRTC-Mesh mit Opus, Echo-/Rauschunterdrückung, Stumm/Ton aus, Push-to-Talk, Sprecheranzeige, Lautstärke pro Benutzer, Geräteauswahl, Qualitätsanzeige (RTT, Verlust, Relay), automatische Wiederverbindung, Webcam.
* **Bildschirm:** Monitor oder Fenster (Systemdialog), Profile Energiesparend/Ausgewogen/Hohe Qualität/Manuell, Systemton getrennt vom Mikrofon, Anzeige wer überträgt, Vollbild.
* **Benutzer:** Registrierung nach Serverrichtlinie, Argon2id-Passwörter, Avatare, Status (Online/Abwesend/Nicht stören/Unsichtbar), Statusmeldung, DMs und Direktanrufe, Freunde, Blockieren, Konto löschen.
* **Windows:** NSIS-/MSI-Installer, Startmenü, Tray-Betrieb, Autostart, Single-Instance, DPAPI-geschützte Sitzungstoken, Fehlerprotokolle.

Den genauen, geprüften Stand (inkl. offener Punkte) beschreibt **[docs/STATUS.md](docs/STATUS.md)**.

## Schnellstart

* **Benutzer:** Installer ausführen → „Server hinzufügen“ → Adresse oder Einladungslink eingeben.
* **Eigener Server:** Server-Symbol in der linken Leiste → „Server starten“ → Inhaberkonto anlegen → einladen.
* **Dedizierter Server:** `nexustalk-server --data <ordner>` (Windows/Linux), siehe [docs/INSTALL.md](docs/INSTALL.md).

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Technologieentscheidung, Komponenten, Protokoll, Datenmodell |
| [docs/INSTALL.md](docs/INSTALL.md) | Installation, Headless-Betrieb, Aktualisierung, Selbst bauen |
| [docs/NETWORK.md](docs/NETWORK.md) | Ports, Firewall, Router, TURN, Fehlerdiagnose |
| [docs/SECURITY.md](docs/SECURITY.md) | Sicherheitsmaßnahmen, gespeicherte Daten, Einschränkungen |
| [docs/TESTING.md](docs/TESTING.md) | Testverfahren und Ergebnisse |
| [docs/BENCHMARK.md](docs/BENCHMARK.md) | Messverfahren und gemessene Ressourcenwerte |
| [docs/STATUS.md](docs/STATUS.md) | Funktionsstand, bekannte Einschränkungen, nächste Schritte |

## Projektstruktur

```
crates/nexus-server   Server (Bibliothek + Headless-Binary), Unit- & Integrationstests
crates/nexus-net      Client-Netzwerk mit TLS-Pinning
app/src-tauri         Desktop-Shell (Tauri 2, Rust)
app/src               Oberfläche (Preact + Signals, TypeScript)
tests/e2e             WebRTC-Ende-zu-Ende-Tests (Playwright, echte UI)
tests/bench           Ressourcen-Benchmarks (Server, Medien)
scripts               Desktop-Benchmark (PowerShell)
docs                  Dokumentation
```

## Lizenz

MIT
