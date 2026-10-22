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
```

Einmalig für die Browsertests: `cd tests/e2e && npm install && npx playwright-core install chromium-headless-shell`.

## Ergebnisse

### Rust – 60 Tests, alle bestanden

**Unit-Tests (41, `nexus-server`)**
* Authentifizierung: Argon2id-Hash/Verifikation, Salt, Token-Hashes.
* Berechtigungen: Owner/Admin, Mitgliederrechte, Kanal-Overrides (verbergen, schreibgeschützt), Overrides können keine Serverrechte vergeben, DM-Isolation (auch für Admins), Rollenhierarchie/Rechteausweitung.
* Nachrichtenverarbeitung & Datenbank: Lebenszyklus, Verlauf/Paging, Antworten, Erwähnungen, Lesestatus, FTS-Suche (inkl. Injection-Versuche), Einladungen (Ablauf, Nutzungen, Einmal-Code), Anhänge (nur Uploader, nur einmal), DMs, Konto-Löschung (Tombstone), Aufbewahrung, Migration/Idempotenz, FTS5 verfügbar.
* Konfiguration: sichere Standards, ungültige Werte, ICE-URLs/Portbereiche, Roundtrip, beschädigte Datei.
* Sonstiges: Eingabevalidierung (Benutzernamen, Passwörter, Steuerzeichen, Dateinamen/Pfadmanipulation), Bildsignaturen, Rate-Limiter, Hub/Präsenz, Trennen langsamer Clients, Erwähnungs-Parser, STUN-Antwort (inkl. UDP-Roundtrip), Backup-Namen, Datumsformat, Upload-Limit beim Streamen.

**Integrationstests (15, echter Server + echter Client über HTTP/WebSocket)**

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

**Weitere:** `nexus-net` (3: Adressparser, Fingerabdrücke, WS-URLs), Desktop-Crate (1: DPAPI-verschlüsselte Tokens, beschädigte Konfiguration).

### Echtzeit-Medien – `tests/e2e/rtc.mjs`: 20/20 bestanden (3 Läufe in Folge)

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

### Desktop-App (WebView2) – `tests/e2e/desktop.mjs`: 10/10 bestanden

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

* **Installation auf einem frisch aufgesetzten Windows-System** (ohne Entwicklungswerkzeuge) – nur auf dem Entwicklungs-PC getestet.
* **MSI-Paket**: gebaut, aber nicht installiert (Standard-MSI installiert systemweit und benötigt Administratorrechte).
* **Zwei getrennte PCs über LAN/Internet**: Alle Mehrclient-Tests liefen auf einem Rechner (Loopback). Echte NAT-Szenarien, STUN über Router, TURN-Relay mit realen restriktiven Netzen sind **nicht** getestet. Der integrierte TURN-Server startet (Code-Pfad vorhanden), wurde aber nicht mit echten Relay-Verbindungen verifiziert.
* **Bildschirmübertragung mit echter Quelle in der Desktop-App** (Monitor-/Fensterauswahl im nativen Dialog, Systemton): Der Dialog öffnet sich nachweislich; die Auswahl selbst lässt sich nicht automatisieren und wurde nicht manuell durchgeklickt. Systemton-Erfassung unter WebView2 ist daher **ungeprüft**.
* **Webcam mit echter Kamera** (nur mit virtuellem Gerät im Browser geprüft).

Ein bei den Tests gefundener und behobener Fehler: Nach einem *Server*-Neustart hat der zuerst zurückkehrende Client die Medienverbindungen zu noch nicht zurückgekehrten Teilnehmern geschlossen (leere Sprachbelegung nach Neustart). Bestehende Verbindungen erhalten jetzt beim Wiederbeitritt 25 s Schonfrist.
* Push-to-Talk, Ausgabegerätewechsel (`setSinkId`), Benachrichtigungen (Windows-Toast), Autostart mit Windows, Tray-Verhalten: implementiert, **nicht automatisiert getestet**.
* Linux-Headless-Server: Code ist plattformneutral, aber auf Linux nicht gebaut/getestet.
* Lasttests über 100 Clients, Langzeitbetrieb (Tage), Speicherplatz-voll-Szenarien (Fehlerpfad implementiert, nicht provoziert).
