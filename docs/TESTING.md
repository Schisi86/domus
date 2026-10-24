# Tests und Ergebnisse

Stand: 22.10.2026, Windows 11 Pro, Rust 1.98, Node 24, WebView2 155.

## Ausführen

```bash
cargo test -p nexus-server -p nexus-net -p nexustalk     # Unit- & Integrationstests (Rust)
npm --prefix app run typecheck                           # TypeScript
# WebRTC-E2E (UI-Devserver muss laufen: npm --prefix app run dev)
cargo build -p nexus-server && node tests/e2e/rtc.mjs
# Echte Desktop-App über WebView2-DevTools (siehe Kopf von tests/e2e/desktop.mjs)
node tests/e2e/desktop.mjs
# Bildschirm-Menü und Bildzuschnitt (UI-Devserver muss laufen)
node tests/e2e/features.mjs
# Hosting-Zentrale in der echten App (Testbuild mit eigener Kennung, siehe Kopf von tests/e2e/hosting.mjs)
node tests/e2e/hosting.mjs
# Titelleiste, Fußzeile, Einstellungen (Beispielserver: node tests/e2e/seed.mjs)
node tests/e2e/chrome.mjs <adresse> <token>
```

Einmalig für die Browsertests: `cd tests/e2e && npm install && npx playwright-core install chromium-headless-shell`.

## Ergebnisse

Stand 0.2.0 (23.10.2026): Rust-Tests und Medien-E2E erneut ausgeführt. Desktop-E2E und Installer-Test stammen noch von 0.1.0 – beim 0.2.0-Lauf lief auf dem Testrechner eine installierte NexusTalk-Instanz, die der Single-Instance-Schutz bevorzugt hätte.

### Rust – 69 Tests, alle bestanden

**Unit-Tests (42, `nexus-server`)**
* Authentifizierung: Argon2id-Hash/Verifikation, Salt, Token-Hashes.
* Berechtigungen: Owner/Admin, Mitgliederrechte, Kanal-Overrides (verbergen, schreibgeschützt), Overrides können keine Serverrechte vergeben, DM-Isolation (auch für Admins), Rollenhierarchie/Rechteausweitung.
* Nachrichtenverarbeitung & Datenbank: Lebenszyklus, Verlauf/Paging, Antworten, Erwähnungen, Lesestatus, FTS-Suche (inkl. Injection-Versuche), Einladungen (Ablauf, Nutzungen, Einmal-Code), Anhänge (nur Uploader, nur einmal), DMs, Konto-Löschung (Tombstone), Aufbewahrung, Migration/Idempotenz, FTS5 verfügbar.
* Konfiguration: sichere Standards, ungültige Werte, ICE-URLs/Portbereiche, Roundtrip, beschädigte Datei.
* Sonstiges: Eingabevalidierung (Benutzernamen, Passwörter, Steuerzeichen, Dateinamen/Pfadmanipulation), Bildsignaturen, Rate-Limiter, Hub/Präsenz, Trennen langsamer Clients, Erwähnungs-Parser, Emoji-Validierung für Reaktionen, STUN-Antwort (inkl. UDP-Roundtrip), Backup-Namen, Datumsformat, Upload-Limit beim Streamen.

**Integrationstests (16, echter Server + echter Client über HTTP/WebSocket)**

| Test | Prüft |
|---|---|
| `owner_setup_registration_and_login` | Einrichtungscode, Einladungspflicht, Login, gleiche Fehlermeldung für unbekannte Benutzer, kein Klartextpasswort in der DB |
| `invalid_session_is_rejected_on_websocket` | gefälschte Tokens, Operationen ohne Anmeldung |
| `text_chat_between_two_clients_survives_restart` | Echtzeitnachrichten, Erwähnung, Antwort, Bearbeiten, Tippen, **Serverneustart → Reconnect mit derselben Sitzung, Verlauf und Lesestatus persistent**, Suche, Löschen |
| `permissions_are_enforced_by_the_server` | 6 Admin-Operationen verweigert, keine Selbstbeförderung, versteckter Kanal (Verlauf, Senden, Suche, Events), schreibgeschützter Kanal, Moderation, Audit-Eintrag |
| `ban_disconnects_and_blocks_login` | Socket getrennt, Login gesperrt, Sitzungen widerrufen, Entsperren |
| `approval_mode_requires_moderator` | Freischaltungsmodus |
| `manipulated_and_oversized_input_is_rejected` | ungültiges JSON, unbekannte Ops, falsche Typen, Übergröße, Steuerzeichen, fremde Anhang-IDs, SQL-/FTS-Injection, Pfad im Benutzernamen, Übergroßer Frame trennt nur diese Verbindung |
| `excessive_requests_are_rate_limited` | Login-Limit pro IP, Nachrichtenflut |
| `file_upload_download_and_limits` | Upload/Download, Dateinamen-Bereinigung, private Uploads, Downloads nur angemeldet, Pfadmanipulation, HTML wird als Download ausgeliefert, Größenlimit (keine Restdatei), Uploads abschaltbar |
| `voice_channel_signaling_between_clients` | Beitritt, Zustände, Signalisierung nur im selben Kanal, Textkanal nicht betretbar, Verlassen |
| `guests_cannot_share_screen` | Gast: Bildschirm/Uploads verweigert |
| `direct_messages_and_blocking` | DMs, Dritte ausgeschlossen, Freundschaftsanfragen, Blockieren in beide Richtungen |
| `backup_and_restore` | Sicherung, Wiederherstellung per Neustart, Ungültige Namen |
| `tls_certificate_pinning` | Unbekanntes Zertifikat → Fingerabdruck, falscher Pin → Abbruch, richtiger Pin → HTTP + WebSocket, Zertifikat bleibt nach Neustart |
| `server_stats_and_logs_for_admins` | Status, Einstellungen, Logs |
| `reactions_and_pins` | Reaktionen hinzufügen/entfernen (Ereignis an andere Clients, ungültige Emojis abgelehnt, Limit), Anheften nur mit Moderationsrecht, Liste angehefteter Nachrichten |

**Weitere:** `nexus-net` (3: Adressparser, Fingerabdrücke, WS-URLs), Desktop-Crate (4: DPAPI-verschlüsselte Tokens/beschädigte Konfiguration; Übernahme des bisherigen Serverordners; getrennte Ports, Ordner und Relay-Bereiche für neue Server inkl. Konfliktprüfung; zwei eingebettete Server gleichzeitig starten und entfernen; Erreichbarkeit: CGNAT-Erkennung, sichere Pfad-Quotierung, PowerShell-Syntax der Firewall-Skripte, Firewall-Status ohne Adminrechte).

### Echtzeit-Medien – `tests/e2e/rtc.mjs`: 20/20 bestanden (0.1.0: 3 Läufe in Folge; 0.2.0: erneut 20/20)

Echte Weboberfläche, echter Server, 3–4 Clients in Chromium mit virtuellem Mikrofon/Bildschirm:

| Prüfung | Ergebnis |
|---|---|
| Audioverbindung zwischen zwei Clients aufgebaut | ✅ |
| Audiodaten A→B und B→A | ✅ (≈ 7 KB in 2,5 s je Richtung) |
| Sprecheranzeige | ✅ |
| RTT-Messung | ✅ |
| Stummschaltung wird übertragen | ✅ |
| Bildschirmübertragung gestartet, bei B empfangen, Frames dekodiert, in der UI gerendert | ✅ (46 Frames in 2,5 s) |
| Übertragung beendet → bei B entfernt | ✅ |
| Webcam bei B empfangen, Ausschalten entfernt sie | ✅ |
| 3 Teilnehmer vollständig vermascht | ✅ (je 2/2 Verbindungen) |
| Serverneustart während des Gesprächs: Signalisierung zurück, Sprachplatz erhalten, **Medien liefen weiter** | ✅ |
| Verlassen/erneuter Beitritt baut Medien neu auf | ✅ |
| Gast ohne Bildschirmrecht wird serverseitig abgelehnt (mit Meldung) | ✅ |

### Hosting-Zentrale (Desktop-App) – `tests/e2e/hosting.mjs`: 14/14 bestanden

Echte Desktop-App (Testbuild mit eigener App-Kennung, Datenordner per `APPDATA` in ein Temp-Verzeichnis umgeleitet – eine installierte NexusTalk bleibt unberührt), gesteuert über WebView2-DevTools: Schaltfläche unten links, Erstformular mit vorausgefülltem Namen, zwei Server nacheinander erstellt (Ports 7878/7879), Inhaber jeweils mit vorausgefülltem Benutzernamen angelegt, dauerhafte Einladungslinks angezeigt und beim erneuten Öffnen unverändert, beide Server gleichzeitig aktiv, Zähler in der Leiste, Registry `hosts.json`, Entfernen inkl. Datenordner und Client-Eintrag.

### Bildschirm-Menü, Bildzuschnitt, Sounds – `tests/e2e/features.mjs`: 16/16 bestanden

Browser-UI mit virtueller Bildschirmquelle: Menü öffnet sich statt sofort zu übertragen, 6 Schnellwahlen / 5 Auflösungen / 4 Bildraten / 3 Inhaltsarten, Markierung der Auswahl, gewählte Grenzen am Track (`getConstraints`: 1280×720, 15 FPS, `contentHint` detail), Änderung während der Übertragung (1080p60, motion), Anzeige im Kopfbereich, Stoppen. Ein 900×400-Bild wird im Zuschneide-Dialog über den geöffneten Servereinstellungen bearbeitet und als 512×512-WebP gespeichert (vom Server zurückgeladen und vermessen).

### Fensterrahmen und Verbindungshilfen – `tests/e2e/chrome.mjs`: 11/11 bestanden

Isolierter Desktop-Testbuild: Firewall-Status lesbar ohne Adminrechte, Hilfetext bei „kein Server auf dem Port“ (abgelehnte Verbindung) und bei „keine Antwort“ (Firewall/Servermodus); eigene Titelleiste mit Ziehbereich und drei Fensterknöpfen, native Windows-Leiste aus (`is_decorated = false`), Maximieren/Wiederherstellen über die Knöpfe, Fußzeile mit „Spenden“, Copyright und Flagge unten rechts, kein Herz/keine Flagge mehr in der Leiste, Schließen-Knopf der Einstellungen bleibt nach dem Scrollen im sichtbaren Bereich und schließt. Dazu Screenshots in mehreren Designs. `features.mjs` prüft zusätzlich, dass beim Betreten des Sprachkanals, beim Teilen und beim Kanalwechsel Sounds ausgelöst werden (16/16).

### Übersetzungen

Alle 15 Sprachdateien enthalten exakt die 761 Schlüssel der deutschen Quelle (Skriptprüfung); TypeScript prüft die Schlüssel zusätzlich typsicher. Darstellung von Arabisch (RTL), Japanisch, Hindi und Russisch per Screenshot geprüft.

### Desktop-App (WebView2) – `tests/e2e/desktop.mjs`: 10/10 bestanden (Version 0.1.0)

Release-Build, gesteuert über das DevTools-Protokoll von WebView2:

| Prüfung | Ergebnis |
|---|---|
| UI lädt in WebView2 | ✅ |
| Servermodus: Standard „Nur dieser PC“ | ✅ |
| Eingebetteter Server startet mit TLS (selbst signiert) | ✅ |
| Inhaberkonto über die Rust-Netzwerkschicht (TLS + Pinning) angelegt, verbunden | ✅ |
| Nachricht senden/anzeigen | ✅ |
| Einstellungen und Serververwaltung öffnen | ✅ |
| WebRTC + `getDisplayMedia` verfügbar (VP8, VP9, H.264, AV1) | ✅ |
| Mikrofonzugriff durch App-Berechtigungshandler (ohne Rückfrage) mit echtem Headset | ✅ |
| Sprachkanal beitreten | ✅ |
| `getDisplayMedia` öffnet die native Quellenauswahl | ✅ |

### Installer (NSIS, dieser PC) – manuell/skriptgesteuert

| Prüfung | Ergebnis |
|---|---|
| Stille Installation ohne Adminrechte (`/S`) nach `%LOCALAPPDATA%\NexusTalk` | ✅ (15,6 MB) |
| Startmenüeintrag, Deinstallationseintrag (HKCU) | ✅ |
| Start nach Installation (UI bereit, eingebetteter Server startet per Autostart) | ✅ |
| Deinstallation entfernt Programm, Verknüpfung, Registry; Benutzerdaten bleiben | ✅ |
| Neuinstallation + Start mit vorhandener Konfiguration (gleiches Zertifikat, Server startet) | ✅ |

## Nicht oder nur teilweise getestet

* **Firewall-Freigabe und Zugriff von einem zweiten PC (0.4.1):** Die Freigabe ist eine Admin-Aktion und wurde nicht automatisiert ausgeführt; ein zweites Gerät stand nicht zur Verfügung. Geprüft sind Status-Abfrage, Skript-Syntax und die Hinweise im Client. **UPnP** konnte mangels UPnP-fähigem Router nicht gegen ein echtes Gerät getestet werden.

* **Installation auf einem frisch aufgesetzten Windows-System** (ohne Entwicklungswerkzeuge) – nur auf dem Entwicklungs-PC getestet.
* **MSI-Paket**: gebaut, aber nicht installiert (Standard-MSI installiert systemweit und benötigt Administratorrechte).
* **Zwei getrennte PCs über LAN/Internet**: Alle Mehrclient-Tests liefen auf einem Rechner (Loopback). Echte NAT-Szenarien, STUN über Router, TURN-Relay mit realen restriktiven Netzen sind **nicht** getestet. Der integrierte TURN-Server startet (Code-Pfad vorhanden), wurde aber nicht mit echten Relay-Verbindungen verifiziert.
* **Bildschirmübertragung mit echter Quelle in der Desktop-App** (Monitor-/Fensterauswahl im nativen Dialog, Systemton): Der Dialog öffnet sich nachweislich; die Auswahl selbst lässt sich nicht automatisieren und wurde nicht manuell durchgeklickt. Systemton-Erfassung unter WebView2 ist daher **ungeprüft**.
* **Webcam mit echter Kamera** (nur mit virtuellem Gerät im Browser geprüft).

Ein bei den Tests gefundener und behobener Fehler: Nach einem *Server*-Neustart hat der zuerst zurückkehrende Client die Medienverbindungen zu noch nicht zurückgekehrten Teilnehmern geschlossen (leere Sprachbelegung nach Neustart). Bestehende Verbindungen erhalten jetzt beim Wiederbeitritt 25 s Schonfrist.
* Globales Push-to-Talk, automatisch „Abwesend“, Tray-Menü-Sprache, Ausgabegerätewechsel (`setSinkId`), Benachrichtigungen (Windows-Toast), Autostart mit Windows, Tray-Verhalten: implementiert, **nicht automatisiert getestet**.
* Linux-Headless-Server: Code ist plattformneutral, aber auf Linux nicht gebaut/getestet.
* Lasttests über 100 Clients, Langzeitbetrieb (Tage), Speicherplatz-voll-Szenarien (Fehlerpfad implementiert, nicht provoziert).
