# NexusTalk

Schlanke, selbst hostbare Kommunikationssoftware für Text, Sprache, Video und Bildschirmübertragung – Windows-Desktop-App mit integriertem Servermodus und eigenständigem Headless-Server. Keine Cloud, keine externe Registrierung, kein zentraler Anbieter.

© 2026 Christian Schiessl · [cjs86.netlify.app](https://cjs86.netlify.app) · Projektseite & Download: [nexustalk-app.netlify.app](https://nexustalk-app.netlify.app) · [Spenden per PayPal](https://www.paypal.com/donate/?business=r4pi%40gmx.de&item_name=NexusTalk&currency_code=EUR) (r4pi@gmx.de)

## Funktionsumfang (Kurzfassung)

* **Server hosten:** eigene Schaltfläche unten links, Windows-Firewall-Freigabe per Klick, Internet-Link per verschlüsseltem Tunnel – auch ohne öffentliche IP (Starlink, DS-Lite) und ohne Router-Einstellungen –, zusätzlich Router-Weiterleitung per UPnP und Verbindungs-Check, mehrere Server gleichzeitig auf eigenen Ports (automatisch gewählt), alles voreingestellt (TLS, Einladungspflicht, Autostart), dauerhafter Einladungslink je Server, Erreichbarkeit „Nur dieser PC“ / „Freunde einladen“ per Klick.
* **Server & Kanäle:** Kategorien, Text- und Sprachkanäle, Rollen (Inhaber, Administrator, Moderator, Mitglied, Gast – anpassbar) mit Kanal-Overrides, Einladungen, Freischaltung, Sperren, Audit-Protokoll, Serverprotokoll, Ressourcenanzeige, Backups/Wiederherstellung, Slow-Mode je Textkanal, Personenlimit je Sprachkanal.
* **Premium (0.7.0):** Soundboard mit 16 echten Aufnahmen, Sprachnachrichten mit Wellenform und 2×-Wiedergabe, Anruf-Reaktionen, Hand heben, Bild-in-Bild, Eingabeempfindlichkeit (Noise-Gate), Posteingang mit Erwähnungen und „Für später“ samt Erinnerungen, Profil-Banner und „Über mich“, lebendiger Hintergrund, 14 Designs, eigene Akzentfarbe.
* **Moderation & Interaktion:** Personen-Menü per Rechtsklick überall (Profil, Nachricht, Anrufen, Erwähnen, private Notiz, Lautstärke bis 200 %, für mich stummschalten), Auszeit, Kicken, serverseitig stummschalten/taub schalten, in andere Sprachkanäle verschieben oder trennen, Umfragen, Weiterleiten, Als ungelesen markieren, Soundboard.
* **Text:** Echtzeit, Verlauf mit Nachladen, Antworten, Erwähnungen, Reaktionen, angeheftete Nachrichten, Markdown inkl. Spoiler, Emoji-Auswahl, Bearbeiten/Löschen, Mehrzeiler, Code, Links, Dateianhänge mit Fortschritt und Bildvorschau, Ungelesen-/Erwähnungszähler, Tippanzeige, Volltextsuche, Benachrichtigungen.
* **Sprache/Video:** WebRTC-Mesh mit Opus, TURN-Relay auch über den Internet-Tunnel (TCP), Echo-/Rauschunterdrückung, Stumm/Ton aus, Push-to-Talk (auch global im Hintergrund), Sprecheranzeige, Lautstärke pro Benutzer, Geräteauswahl, Qualitätsanzeige (RTT, Verlust, Relay), automatische Wiederverbindung, Webcam.
* **Bildschirm:** Monitor oder Fenster (Systemdialog); vor dem Start ein Menü mit Schnellwahl, Auflösung (720p–4K/Original), Bildrate (5–60 FPS), „Optimiert für“ (Text/Bewegung) und Bitrate – auch während der Übertragung änderbar; Systemton getrennt vom Mikrofon, Anzeige wer überträgt, Vollbild.
* **Benutzer:** Registrierung nach Serverrichtlinie, Argon2id-Passwörter, Avatare und Serverbilder mit quadratischem Zuschnitt, Status (Online/Abwesend/Nicht stören/Unsichtbar), Statusmeldung, DMs und Direktanrufe, Freunde, Blockieren, Konto löschen.
* **Oberfläche:** eigene Titelleiste in den Farben des Designs, 14 Designs mit durchgehendem Farbverlauf und halbtransparenten Flächen, dezente Interface-Sounds (Beitreten, Verlassen, Kanalwechsel, Stummschalten, Bildschirm), 15 Sprachen (Landesflagge in der Fußzeile, Arabisch von rechts nach links), mechanisches N-Logo, Schnellwechsler (Strg+K), Tastenkürzel, automatisch „Abwesend“, Benachrichtigungston.
* **Windows:** NSIS-/MSI-Installer, Startmenü, Tray-Betrieb, Autostart, Single-Instance, DPAPI-geschützte Sitzungstoken, Fehlerprotokolle.

Den genauen, geprüften Stand (inkl. offener Punkte) beschreibt **[docs/STATUS.md](docs/STATUS.md)**.

## Schnellstart

* **Benutzer:** Installer ausführen → „Server hinzufügen“ → Adresse oder Einladungslink eingeben.
* **Eigener Server:** grüne Server-Schaltfläche unten links → Namen vergeben → „Erstellen & starten“ → Passwort für das Inhaberkonto → Einladungslink kopieren. Weitere Server über „Neuer Server“.
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
tests/e2e             WebRTC-Ende-zu-Ende-Tests, Desktop-Test, Screenshots (Playwright, echte UI)
website               Projektseite (nexustalk-app.netlify.app)
tests/bench           Ressourcen-Benchmarks (Server, Medien)
scripts               Desktop-Benchmark (PowerShell)
docs                  Dokumentation
```

## Lizenz

MIT – siehe [LICENSE](LICENSE). © 2026 Christian Schiessl
