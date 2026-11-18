# Domus

*Vormals NexUs (0.8–0.10) und NexusTalk (bis 0.7).* Einstellungen, Server und Chats liegen weiterhin in `%APPDATA%\NexusTalk`; ein Update übernimmt alles.

Schlanke, selbst hostbare Kommunikationssoftware für Text, Sprache, Video und Bildschirmübertragung – Desktop-App für Windows und macOS mit integriertem Servermodus, Android-App und eigenständigem Headless-Server. Keine Cloud, keine externe Registrierung, kein zentraler Anbieter.

© 2026 Christian Schiessl · [cjs86.netlify.app](https://cjs86.netlify.app) · Projektseite & Download: [domus-talk.netlify.app](https://domus-talk.netlify.app) · [Spenden per PayPal](https://www.paypal.com/donate/?business=r4pi%40gmx.de&item_name=Domus&currency_code=EUR) (r4pi@gmx.de)

## Funktionsumfang (Kurzfassung)

* **Server hosten:** eigene Schaltfläche unten links, Windows-Firewall-Freigabe per Klick, Internet-Link per verschlüsseltem Tunnel – auch ohne öffentliche IP (Starlink, DS-Lite) und ohne Router-Einstellungen –, zusätzlich Router-Weiterleitung per UPnP und Verbindungs-Check, mehrere Server gleichzeitig auf eigenen Ports (automatisch gewählt), alles voreingestellt (TLS, Einladungspflicht, Autostart), dauerhafter Einladungslink je Server, Erreichbarkeit „Nur dieser PC“ / „Freunde einladen“ per Klick.
* **Server & Kanäle:** Kategorien, Text- und Sprachkanäle, Rollen (Inhaber, Administrator, Moderator, Mitglied, Gast – anpassbar) mit Kanal-Overrides, Einladungen, Freischaltung, Sperren, Audit-Protokoll, Serverprotokoll, Ressourcenanzeige, Backups/Wiederherstellung, Slow-Mode je Textkanal, Personenlimit je Sprachkanal.
* **1.0.2:** Neu: **macOS-Installer** (universal, Apple Silicon + Intel). Die Android-App kann jetzt **eigene Server hosten** (läuft im Hintergrund weiter) und **den Bildschirm teilen**; Anrufe laufen am Handy im Hintergrund weiter. **Chats archivieren, anheften und für dich löschen**, Unterhaltungen filtern, **Lesebestätigungen**, **Ruhezeiten** und Statusmeldungen mit Ablaufzeit.
* **1.0.1:** **Android-App** mit eigener Handy-Oberfläche (eine Spalte, Zurück-Taste, Wischen zum Antworten, Menüs als Bottom-Sheet). **Profil per QR-Code übertragen** – PC → Handy und zurück, mit Einmal-Codes statt Passwort. Angemeldete Geräte verwalten, Entwürfe pro Kanal, Benachrichtigungen pausieren, Antworten per Doppelklick, eigene Schriftgröße für Nachrichten, „Enter sendet“ abschaltbar, globale Stummschalt-Taste, Einladungen als QR-Code.
* **1.0.0:** Neuer Name **Domus** (lateinisch „Zuhause“) und neues Logo – ein Haus mit Kopfhörern – in App, Installer, Verknüpfung und Websites. Der Installer ersetzt NexUs bzw. NexusTalk automatisch und übernimmt Daten und Autostart. Einladungslinks beginnen mit `domus://`, alte `nexustalk://`-Links funktionieren weiter. Headless-Server heißt jetzt `domus-server`.
* **0.10.0:** Eigene Server starten automatisch mit der App (abschaltbar, sonst Ein-Klick-Start). Fernsteuerung mit Umschalt-Taste F8, optionalem verdecktem Passwort und richtiger Tasten-/Monitor-Zuordnung. Auf den Stream zeichnen und Laserpointer, Direktversand von Dateien ohne Größenlimit, Sofort-Clip (F9), Gemeinsam schauen, Ende-zu-Ende-verschlüsselte Direktnachrichten. 6 neue ruhige Designs, 5 grelle entfernt (20 gesamt).
* **0.9.1:** Soundboard-Sounds Applaus/Grillen/Gong repariert (sauber neu kodiert), Soundboard ohne Scrollbalken, Fernsteuerung nur bei Vollbild-Freigabe, Vollbild vorausgewählt mit Systemton an.
* **0.9.0:** 36 Soundboard-Sounds (überlappend, Mute, Lautstärke), Bildschirm + Kamera gleichzeitig (Kamera als Overlay), Fernsteuerung mit Passwort (Maus/Tastatur/Controller, Desktop), „Für später“ als Selbst-DM „Notizen“, 5 neue animierte Designs (Matrix, Synthwave, Lava, Hologramm, Prisma).
* **Premium (0.7.0):** Soundboard mit 16 echten Aufnahmen, Sprachnachrichten mit Wellenform und 2×-Wiedergabe, Anruf-Reaktionen, Hand heben, Bild-in-Bild, Eingabeempfindlichkeit (Noise-Gate), Posteingang mit Erwähnungen und „Für später“ samt Erinnerungen, Profil-Banner und „Über mich“, lebendiger Hintergrund, 14 Designs, eigene Akzentfarbe.
* **Moderation & Interaktion:** Personen-Menü per Rechtsklick überall (Profil, Nachricht, Anrufen, Erwähnen, private Notiz, Lautstärke bis 200 %, für mich stummschalten), Auszeit, Kicken, serverseitig stummschalten/taub schalten, in andere Sprachkanäle verschieben oder trennen, Umfragen, Weiterleiten, Als ungelesen markieren, Soundboard.
* **Text:** Echtzeit, Verlauf mit Nachladen, Antworten, Erwähnungen, Reaktionen, angeheftete Nachrichten, Markdown inkl. Spoiler, Emoji-Auswahl, Bearbeiten/Löschen, Mehrzeiler, Code, Links, Dateianhänge mit Fortschritt und Bildvorschau, Ungelesen-/Erwähnungszähler, Tippanzeige, Volltextsuche, Benachrichtigungen.
* **Sprache/Video:** WebRTC-Mesh mit Opus, TURN-Relay auch über den Internet-Tunnel (TCP), Echo-/Rauschunterdrückung, Stumm/Ton aus, Push-to-Talk (auch global im Hintergrund), Sprecheranzeige, Lautstärke pro Benutzer, Geräteauswahl, Qualitätsanzeige (RTT, Verlust, Relay), automatische Wiederverbindung, Webcam.
* **Bildschirm:** Monitor oder Fenster (Systemdialog); vor dem Start ein Menü mit Schnellwahl, Auflösung (720p–4K/Original), Bildrate (5–60 FPS), „Optimiert für“ (Text/Bewegung) und Bitrate – auch während der Übertragung änderbar; Systemton getrennt vom Mikrofon, Anzeige wer überträgt, Vollbild.
* **Benutzer:** Registrierung nach Serverrichtlinie, Argon2id-Passwörter, Avatare und Serverbilder mit quadratischem Zuschnitt, Status (Online/Abwesend/Nicht stören/Unsichtbar), Statusmeldung, DMs und Direktanrufe, Freunde, Blockieren, Konto löschen.
* **Oberfläche:** eigene Titelleiste in den Farben des Designs, 20 Designs (ruhige und kräftige, zwei mit dezenter Animation) und halbtransparenten Flächen, dezente Interface-Sounds (Beitreten, Verlassen, Kanalwechsel, Stummschalten, Bildschirm), 15 Sprachen (Landesflagge in der Fußzeile, Arabisch von rechts nach links), mechanisches N-Logo, Schnellwechsler (Strg+K), Tastenkürzel, automatisch „Abwesend“, Benachrichtigungston.
* **Windows:** NSIS-/MSI-Installer, Startmenü, Tray-Betrieb, Autostart, Single-Instance, DPAPI-geschützte Sitzungstoken, Fehlerprotokolle.

Den genauen, geprüften Stand (inkl. offener Punkte) beschreibt **[docs/STATUS.md](docs/STATUS.md)**.

## Schnellstart

* **Benutzer:** Installer ausführen → „Server hinzufügen“ → Adresse oder Einladungslink eingeben.
* **Handy:** APK installieren → „Von anderem Gerät übertragen“ → am PC Rechtsklick auf den eigenen Namen › „Profil übertragen“ → QR-Code scannen.
* **Eigener Server:** grüne Server-Schaltfläche unten links → Namen vergeben → „Erstellen & starten“ → Passwort für das Inhaberkonto → Einladungslink kopieren. Weitere Server über „Neuer Server“.
* **Dedizierter Server:** `domus-server --data <ordner>` (Windows/Linux), siehe [docs/INSTALL.md](docs/INSTALL.md).

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
app/src-tauri         Desktop- und Android-Shell (Tauri 2, Rust); Android-Projekt in gen/android
app/src               Oberfläche (Preact + Signals, TypeScript)
tests/e2e             WebRTC-Ende-zu-Ende-Tests, Desktop-Test, Screenshots (Playwright, echte UI)
website               Projektseite (domus-talk.netlify.app)
tests/bench           Ressourcen-Benchmarks (Server, Medien)
scripts               Desktop-Benchmark (PowerShell)
docs                  Dokumentation
```

## Lizenz

MIT – siehe [LICENSE](LICENSE). © 2026 Christian Schiessl
