# Domus – Architektur

## 1. Ziele und Randbedingungen

* Funktional an Discord angelehnt (Server, Kanäle, Rollen, Text, Sprache, Video, Bildschirm, DMs).
* **Selbst hostbar** ohne Cloud-Dienst, ohne externe Registrierung, ohne zentralen Anbieter.
* **Geringer Ressourcenverbrauch** auf Client und Server.
* Ein Windows-64-Bit-Installer; Client und Server aus **einer Codebasis**.
* Sichere Voreinstellungen: Server nach Installation **nicht** erreichbar, TLS an, Registrierung nur mit Einladung.

## 2. Technologieentscheidung

| Option | Bewertung |
|---|---|
| **Tauri 2 (Rust + System-WebView2)** | ✅ Gewählt. Kein mitgeliefertes Chromium (Installer ≈ wenige MB statt ≈ 80–100 MB), Rust-Backend für Netzwerk, TLS-Pinning, Server und Windows-Integration. WebView2 enthält eine vollständige WebRTC-Implementierung (Opus, VP8/VP9/H.264, AEC/NS/AGC, Staukontrolle, `getDisplayMedia`). |
| Electron | ❌ Bringt eigenes Chromium + Node mit; deutlich größerer Speicher- und Plattenbedarf. Für die Anforderungen gibt es keinen Funktionsvorteil gegenüber WebView2. |
| Nativ (Qt/egui + libwebrtc) | ❌ Eigene WebRTC-Integration (libwebrtc bauen, Bildschirmaufnahme, Encoder) wäre ein Vielfaches des Aufwands und fehleranfälliger. |
| Server in Go/Node | ❌ Rust erlaubt es, denselben Servercode in die Desktop-App einzubetten (Servermodus) und als Headless-Binary zu bauen – ohne zweite Laufzeitumgebung. |

**UI:** Preact + `@preact/signals` (≈ 56 KB gzip für die gesamte App). Signals aktualisieren nur betroffene Komponenten; keine CSS-/Komponenten-Frameworks, keine Webfonts, Icons als Inline-SVG.

**Server:** Rust, `tokio` (asynchron), `axum` (HTTP + WebSocket), `rustls` mit `ring` (TLS), `rusqlite` mit eingebautem SQLite (WAL, FTS5), `argon2` (Passwörter), `turn` (webrtc-rs, optionaler TURN-Relay).

## 3. Komponenten

```
┌────────────────────────── NexUs Desktop (nexustalk.exe) ──────────────────────────┐
│  WebView2 (UI, Preact)                     │  Rust (Tauri)                            │
│  ─ Zustand pro Server (signals)            │  ─ net:   HTTP/WebSocket über rustls     │
│  ─ WebRTC-Mesh (Audio/Video/Bildschirm) ───┼──►        mit Zertifikats-Pinning (TOFU) │
│  ─ Dialoge, Einstellungen                  │  ─ host:  eingebetteter Server (optional)│
│                                            │  ─ store: Konfiguration, DPAPI-Tokens    │
│                                            │  ─ Tray, Autostart, Single-Instance      │
└────────────────────────────────────────────┴──────────────────────────────────────────┘
            │ WSS/HTTPS (Signalisierung, Text, Dateien)          ▲  SRTP/DTLS (Medien, P2P)
            ▼                                                     │
┌──────────── nexus-server (Bibliothek; Headless: domus-server.exe) ───────────────┐
│ http.rs   Registrierung/Anmeldung, Datei-Up/Download, Avatare, Icon, WS-Upgrade      │
│ ws.rs     Verbindungsschleife, Auth, Rate-Limits, Op-Dispatch → ops_*.rs             │
│ hub.rs    Live-Verbindungen, Event-Fan-out, Präsenz                                  │
│ perms.rs  Rollen/Overrides, In-Memory-Cache, serverseitige Prüfung                   │
│ store.rs  SQL-Abfragen · db.rs Migrationen · maintenance.rs Backups/Aufräumen        │
│ media.rs  STUN-Responder bzw. TURN-Relay (UDP)                                       │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Crates im Workspace:

| Crate | Zweck |
|---|---|
| `crates/nexus-server` | Serverbibliothek + Headless-Binary `domus-server` |
| `crates/nexus-net` | Client-Netzwerk (reqwest + tokio-tungstenite, rustls, Pinning) – genutzt von App und Integrationstests |
| `app/src-tauri` | Desktop-Shell `nexustalk` (bettet `nexus-server` und `nexus-net` ein) |
| `app/src` | Weboberfläche |

## 4. Trennung der Kommunikationsarten

| Art | Weg | Inhalt |
|---|---|---|
| Benutzerverwaltung | HTTPS `POST /api/v1/auth/*` | Registrierung, Anmeldung, Abmeldung |
| Echtzeit-Ereignisse & Signalisierung | WSS `/api/v1/ws` (JSON) | Nachrichten, Präsenz, Kanäle, SDP/ICE-Weiterleitung |
| Dateien | HTTPS `POST/GET /api/v1/files` | Streaming-Upload/-Download mit Größenlimit |
| Medien | WebRTC (DTLS-SRTP), **direkt zwischen Clients** | Audio, Webcam, Bildschirm, Systemton |
| NAT-Traversal | UDP: STUN (integriert), TURN (optional, integriert oder extern) | |
| Persistenz | SQLite (`nexus.db`) + Ordner `uploads/` | |

Der Anwendungsserver leitet **keine** Audio-/Videodaten weiter. Nur wenn keine direkte Verbindung möglich ist und TURN aktiviert ist, laufen Medien (weiterhin Ende-zu-Ende per DTLS-SRTP zwischen den Clients verschlüsselt) über den Relay.

## 5. Protokoll

WebSocket, JSON-Textframes:

```
→ {"id": 7, "op": "message.send", "d": {"channel_id": 1, "content": "Hallo"}}
← {"re": 7, "ok": true, "d": {...}}            ← {"re": 7, "ok": false, "err": {"code": "PERMISSION_DENIED", "msg": "…"}}
← {"ev": "message.created", "d": {"message": {...}, "nonce": "…"}}
```

* Erste Anfrage muss `auth` mit Sitzungstoken sein (Timeout 10 s); die Antwort enthält den kompletten Anfangszustand (`ready`).
* Heartbeat: Client sendet alle 30 s `ping`; der Server trennt nach 75 s Stille.
* Fehler sind strukturierte Codes (`crates/nexus-server/src/error.rs`), die der Client übersetzt (`app/src/i18n.ts`).
* Struktur-Änderungen (Kanäle, Rollen, Overrides) werden als `guild.sync` mit den **pro Benutzer** berechneten Rechten verteilt.

Wichtige Operationen: `message.send/edit/delete/history/search`, `channel.ack`, `typing`, `channel.*`, `category.*`, `role.*`, `member.*`, `invite.*`, `server.*`, `audit.list`, `backup.*`, `user.*`, `dm.open`, `relationship.*`, `voice.join/leave/update`, `rtc.signal` (vollständige Liste: `crates/nexus-server/src/ws.rs`, Funktion `dispatch`).

## 6. Sprach-/Videoarchitektur

* **Mesh**: Jeder Teilnehmer hält eine `RTCPeerConnection` zu jedem anderen (Standardlimit 10 pro Kanal, empfohlen ≤ 8 mit Video). Vorteil: kein Medienserver nötig, minimale Latenz. Nachteil: Upload wächst linear mit der Teilnehmerzahl (insbesondere bei Bildschirmübertragung). Eine SFU kann später ergänzt werden, ohne Protokoll oder UI grundlegend zu ändern (`voice.join` liefert bereits ICE-Konfiguration; Signalisierung ist abstrahiert).
* **Perfect Negotiation**: Beide Seiten dürfen jederzeit Tracks hinzufügen/entfernen (Bildschirm, Kamera); Kollisionen werden über „höfliche/unhöfliche“ Rollen aufgelöst.
* **Wiederverbindung**: ICE-Restart bei `failed` bzw. nach 4 s `disconnected`. Bricht die Signalisierung ab, behält der Server den Sprachplatz 20 s; der Client tritt nach dem WebSocket-Reconnect automatisch wieder bei, laufende Medienverbindungen bleiben bestehen (E2E-getestet mit Serverneustart).
* **Audio**: Opus; Echo-/Rauschunterdrückung und AGC der WebRTC-Engine (abschaltbar). Stummschalten deaktiviert den Track (keine Neuverhandlung). Push-to-Talk im aktiven Fenster.
* **Sprecheranzeige**: `getSynchronizationSources().audioLevel` der Empfänger (kein eigener Audio-Analysepfad pro Teilnehmer), lokal ein einzelner `AnalyserNode`; 5 Hz, nur während einer Sitzung.
* **Bildschirm**: `getDisplayMedia` (Systemdialog für Monitor/Fenster), Profile setzen Auflösung/FPS per Constraints und `maxBitrate`/`maxFramerate` per `RTCRtpSender.setParameters`; `contentHint` und `degradationPreference` je nach Profil. Systemton als eigener Audiotrack im Bildschirm-Stream, unabhängig vom Mikrofon.

## 7. Datenmodell (SQLite, Schema v1)

`users`, `sessions` (nur SHA-256 des Tokens), `roles`, `user_roles`, `categories`, `channels` (`text`/`voice`/`dm`), `channel_overrides`, `dm_members`, `messages` (+ FTS5-Index `messages_fts`), `mentions`, `attachments`, `invites`, `read_states`, `relationships`, `settings` (Community-Einstellungen als JSON, TURN-Secret), `audit_log`.

Migrationen: `PRAGMA user_version`, sequenziell in `db.rs`. Eine neuere Datenbank wird von einer älteren Version nicht geöffnet.

## 8. Konfiguration

* `server.toml` (Netzwerk, TLS, Medien, Limits, Logging) – Neustart nötig, validiert (`config.rs`).
* Community-Einstellungen (Name, Registrierung, Uploads, Aufbewahrung) – in der DB, zur Laufzeit über die App änderbar.
* Client: `%APPDATA%\NexusTalk\client.json` (Server-Liste, UI-Einstellungen, DPAPI-verschlüsselte Tokens).

## 9. Erweiterbarkeit

* Neue Operationen: Funktion in `ops_*.rs` + Zeile in `ws::dispatch`.
* Neue Rechte: Bit in `perms.rs` und `app/src/types.ts` + Beschriftung in `i18n.ts`.
* Neue Schemaänderungen: Eintrag in `MIGRATIONS`.
* Transport im Client ist austauschbar (`app/src/net/transport.ts`); dadurch läuft dieselbe UI auch im Browser (Tests, späterer Web-Client).
