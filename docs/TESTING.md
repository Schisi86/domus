# Tests und Ergebnisse

Stand: 11.11.2026, Windows 11 Pro, Rust 1.98, Node 24, WebView2 155.

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
# 0.10: Fernsteuerung, Zeichnen, Clips, Gemeinsam schauen, Direktversand, E2E-DMs (UI-Devserver muss laufen)
node tests/e2e/collab.mjs
# 0.10: Server-Autostart und native Helfer in der echten App (Testbuild wie bei hosting.mjs)
node tests/e2e/native.mjs
# Übersetzungen: alle 15 Sprachen vollständig, gleiche Platzhalter
python tests/i18n-check.py
# Echte Zeigerbewegung der Fernsteuerung (bewegt kurz die Maus, daher nur auf Wunsch)
cargo test -p nexustalk real_cursor -- --ignored
```

Einmalig für die Browsertests: `cd tests/e2e && npm install && npx playwright-core install chromium-headless-shell`.

## Ergebnisse

Stand 0.2.0 (23.10.2026): Rust-Tests und Medien-E2E erneut ausgeführt. Desktop-E2E und Installer-Test stammen noch von 0.1.0 – beim 0.2.0-Lauf lief auf dem Testrechner eine installierte NexusTalk-Instanz, die der Single-Instance-Schutz bevorzugt hätte.

### Rust – 89 Tests, alle bestanden (0.10.0; weitere 5 nur auf Wunsch: Internet-Relay, echte Zeigerbewegung)

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

**Weitere:** `nexus-net` (3: Adressparser, Fingerabdrücke, WS-URLs), Desktop-Crate (4: DPAPI-verschlüsselte Tokens/beschädigte Konfiguration; Übernahme des bisherigen Serverordners; getrennte Ports, Ordner und Relay-Bereiche für neue Server inkl. Konfliktprüfung; zwei eingebettete Server gleichzeitig starten und entfernen; Erreichbarkeit: CGNAT-Erkennung, sichere Pfad-Quotierung, PowerShell-Syntax der Firewall-Skripte, Firewall-Status ohne Adminrechte; Relay-Einstellungen speichern/laden). Zusätzlich zwei Live-Tests gegen das öffentliche Relay (mit `--ignored`): `relay_roundtrip` (Echo durch bore.pub) und `server_through_relay` (eingebetteter Server über bore.pub, HTTP + WebSocket mit Pinning, falscher Pin wird abgelehnt) – beide bestanden (0.5.0):

```bash
cargo test -p nexustalk server_through_relay -- --ignored --nocapture
```

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

### Zusammenarbeit und Verschlüsselung – `tests/e2e/collab.mjs`: 46/46 bestanden (0.10.0)

Zwei bis drei Browser-Clients gegen einen frischen Server: Fernsteuerung (Angebot, Bestätigung durch den Host, Passwort richtig/falsch, F8 pausiert und übernimmt, Tasten als Scancodes, Maus zentriert, gehaltene Tasten werden losgelassen, Widerruf, verdecktes Passwortfeld), Zeichnen und Laserpointer (inkl. Abschalten durch den Teilenden), Sofort-Clip (Puffer, Video, Dialog, Hinweis an andere), Gemeinsam schauen (Start, Pause, Spulen, Nachzügler, Ende; Datei als Stream), Direktversand (6 MB, SHA-256 identisch, Ablehnen) und E2E-DMs (Server speichert nur Chiffrat, Gegenseite liest und antwortet verschlüsselt, gleiche Sicherheitsnummer, Bearbeiten, Schlüsselsicherung, unlesbare Nachricht wird gekennzeichnet). Die Eingabe-Injektion selbst ist nicht Teil dieses Tests (Browser), siehe Rust-Tests.

### Server-Autostart und native Helfer – `tests/e2e/native.mjs`: 17/17 bestanden (0.10.0)

Echte Desktop-App (WebView2, eigene Kennung, eigenes Datenverzeichnis): Server startet nach einem Update von selbst (alte `hosts.json` ohne Schalter), globaler Schalter hält Server gestoppt, Banner „läuft gerade nicht“ startet ihn mit einem Klick; Geräte-Geheimnisse (DPAPI) lesen/schreiben/löschen, Datei stückweise schreiben (5 MB, SHA-256) und Abbruch ohne Rest, Ziel-Monitor der Fernsteuerung, Overlay-Fenster öffnet durchsichtig, zeichnet einen weitergeleiteten Strich und schließt wieder.

### Interaktion – `tests/e2e/interact.mjs`: 34/34 bestanden (0.10.0)

Zwei Browser-Clients (Inhaber + Mitglied) gegen einen frischen Server: Breiten per Ziehen und Zurücksetzen, kompakter Chat, Emoji-Vorschläge, Bildschirm-Startknöpfe, Posteingang in der linken Leiste, Sprachnachricht aufnehmen/senden/abspielbar mit Wellenform, Profil-Banner und „Über mich“, Posteingang (Erwähnung, „Für später“ mit Erinnerung), Anruf-Reaktion und Hand heben, Noise-Gate im Mikrofonweg, Umfrage erstellen/abstimmen/live zählen, Weiterleiten, Als ungelesen markieren, Auszeit über das Personen-Menü (Eingabe gesperrt, Uhr-Symbol, aufheben), Slow-Mode (Hinweis, Countdown), Soundboard, serverseitig stummschalten (Mitglied kann nicht selbst aufheben), Verschieben in anderen Sprachkanal, Kicken (abgemeldet, wartet auf Freischaltung).

### Sprach-Relay über TCP – `tests/e2e/turn.mjs`: 5/5 bestanden (0.6.0)

Zwei Chromium-Verbindungen, die nur TURN über TCP benutzen dürfen: Datenkanal und Audio kommen an, gewählter Pfad ist „relay/tcp“. Dazu Rust: `turn_allocates_over_tcp` (lokal) und das Live-Test `turn_through_relay` (zwei TURN-Clients über bore.pub, Daten über beide Relay-Adressen):

```bash
cargo test -p nexustalk turn_through_relay -- --ignored --nocapture
```

Rust-Integrationstests neu in 0.6.0: `timeout_kick_and_voice_moderation`, `polls_forwarding_slowmode_and_mark_unread`; 0.7.0: `profiles_call_reactions_inbox_and_voice_messages`; 0.9.0: `self_dm_notes_to_self`, Unit-Tests `remotectl` (Freigabe-Gate, Eingabe-Parsen). 0.10.0: `e2e_key_directory_and_direct_signaling` (Schlüsselverzeichnis, ungekürzte verschlüsselte Antwort-Vorschau, Vermittlung für den Direktversand samt Größenlimit, Blockieren, Offline); Unit-Tests `remotectl` (Zuordnung auf den geteilten Monitor bei mehreren Bildschirmen, Scancode-/Relativ-Befehle), `local` (Geheimnisse, Datei-Schreiber); auf Wunsch `real_cursor_lands_where_the_controller_points` (echte Zeigerbewegung, auf diesem PC ≤ 2 px Abweichung). Soundboard-Dateien per Skript geprüft (36/36 dekodieren); 0.9.1: Applaus/Grillen/Gong neu kodiert und in der Browser-Engine (decodeAudioData) gegengeprüft.

### Hosting-Zentrale (Desktop-App) – `tests/e2e/hosting.mjs`: 19/19 bestanden (0.6.0, inkl. Internet-Link und eigenem TURN-Tunnel; ohne Internet: `E2E_NO_INTERNET=1`)

Echte Desktop-App (Testbuild mit eigener App-Kennung, Datenordner per `APPDATA` in ein Temp-Verzeichnis umgeleitet – eine installierte NexUs bleibt unberührt), gesteuert über WebView2-DevTools: Schaltfläche unten links, Erstformular mit vorausgefülltem Namen, zwei Server nacheinander erstellt (Ports 7878/7879), Inhaber jeweils mit vorausgefülltem Benutzernamen angelegt, dauerhafte Einladungslinks angezeigt und beim erneuten Öffnen unverändert, beide Server gleichzeitig aktiv, Zähler in der Leiste, Registry `hosts.json`, Entfernen inkl. Datenordner und Client-Eintrag.

### Bildschirm-Menü, Bildzuschnitt, Sounds – `tests/e2e/features.mjs`: 16/16 bestanden

Browser-UI mit virtueller Bildschirmquelle: Menü öffnet sich statt sofort zu übertragen, 6 Schnellwahlen / 5 Auflösungen / 4 Bildraten / 3 Inhaltsarten, Markierung der Auswahl, gewählte Grenzen am Track (`getConstraints`: 1280×720, 15 FPS, `contentHint` detail), Änderung während der Übertragung (1080p60, motion), Anzeige im Kopfbereich, Stoppen. Ein 900×400-Bild wird im Zuschneide-Dialog über den geöffneten Servereinstellungen bearbeitet und als 512×512-WebP gespeichert (vom Server zurückgeladen und vermessen).

### Fensterrahmen und Verbindungshilfen – `tests/e2e/chrome.mjs`: 17/17 bestanden (0.10.0)

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

* **Freigabe-Leiste der WebView2 (0.6.0):** Das Ausblenden wurde einmal manuell-skriptgesteuert in der echten WebView2 geprüft (Quelle per `--auto-select-desktop-capture-source`), ist aber nicht Teil der automatischen Testreihen, weil dafür der echte Bildschirm aufgenommen wird.
* **Internet-Tunnel mit einem zweiten Gerät (0.5.0):** Der Weg durch das echte Relay ist getestet, der Client lief aber auf demselben PC. Sprache/Video zwischen zwei Geräten in fremden Netzen (WebRTC über öffentliches STUN, ohne TURN) ist **nicht** getestet.
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
