# Ressourcenverbrauch – Messverfahren und Ergebnisse

Alle Werte wurden am 22.10.2026 auf **einem** Entwicklungs-PC gemessen (AMD Ryzen 7 5800X, 8 Kerne/16 Threads, Windows 11 Pro, WebView2 155). Sie sind reproduzierbar, aber nicht auf andere Hardware übertragbar. Rohdaten: `tests/bench/*.json`.

## Verfahren

| Skript | Misst |
|---|---|
| `scripts/bench-desktop.ps1` | Startzeit (Prozessstart → Frontend meldet „ui ready“ im Log), Arbeitsspeicher und CPU **des gesamten Prozessbaums** (`nexustalk.exe` + alle `msedgewebview2.exe`-Kindprozesse) nach 10 s, CPU über 30 s Leerlauf, Installationsgröße. 3 Durchläufe. |
| `tests/bench/bench.mjs` | Release-Headless-Server: Leerlauf, 100 verbundene Clients, 100 Clients × 1 Nachricht/s (jede Nachricht wird an alle 101 Verbindungen verteilt = 10.100 Zustellungen/s). Medien: zwei Clients in Headless-Chromium mit virtuellen Geräten – Leerlauf, Sprachanruf, Bildschirmübertragung 720p/10 FPS und 1080p/30 FPS. |

CPU-Angaben: „% eines Kerns“ (100 % = ein voll ausgelasteter Kern) bzw. „% des Systems“ (alle 16 Threads).

## Ergebnisse

### Installation

| Artefakt | Größe |
|---|---|
| NSIS-Installer `NexusTalk_0.1.0_x64-setup.exe` | **4,5 MB** |
| MSI `NexusTalk_0.1.0_x64_de-DE.msi` | 6,2 MB |
| Installationsordner (App inkl. eingebettetem Server) | **15,6 MB** |
| Headless-Server `nexustalk-server.exe` | 7,0 MB |
| Weboberfläche (JS gzip / CSS gzip) | 56 KB / 6 KB |

WebView2 ist Bestandteil von Windows 10/11 und wird nicht mitgeliefert.

### Desktop-App (installiert, Release)

| Szenario | Startzeit bis UI | Prozesse | Arbeitsspeicher (Working Set) | Privater Speicher | CPU Leerlauf |
|---|---|---|---|---|---|
| Client, gespeicherter Server nicht erreichbar (Wiederverbindungsversuche) | 0,68–0,71 s | 7 | 350–355 MB | 165–173 MB | 0,05–0,16 % des Systems |
| Client **mit laufendem eingebettetem Server**, verbunden, Textkanal geöffnet | 0,75–1,03 s | 7 | 364–374 MB | 173–185 MB | 0,02–0,03 % des Systems |

Einordnung: Der größte Teil entfällt auf die WebView2-Prozesse (Browser-, GPU-, Renderer-, Netzwerk-, Hilfsprozesse); das Working Set enthält gemeinsam genutzte Seiten, die auch andere WebView2-Anwendungen verwenden. Der eingebettete Server selbst benötigt nur ≈ 10–15 MB (siehe unten).

### Server (Release, Headless)

| Szenario | Arbeitsspeicher | CPU |
|---|---|---|
| Leerlauf | **13,6 MB** | 0 % |
| 100 verbundene, inaktive Clients | 29,8 MB | 0 % |
| 100 Clients × 1 Nachricht/s (10.100 Zustellungen/s, persistiert in SQLite) | 32,5 MB | 15,7 % eines Kerns (1,0 % des Systems) |

### Medien (zwei Clients zusammen, Headless-Chromium, virtuelle Geräte)

| Szenario | CPU beider Clients zusammen | Speicher beider Clients + Browser |
|---|---|---|
| Nur Text (Leerlauf) | 1,1 % eines Kerns | 394 MB |
| Sprachanruf (beide Richtungen, Opus) | 25,4 % eines Kerns (≈ 13 % pro Client) | 538 MB |
| + Bildschirm 720p / 10 FPS | 33,7 % eines Kerns | 616 MB |
| + Bildschirm 1080p / 30 FPS | 43,3 % eines Kerns | 686 MB |

Wichtig: Diese Medienwerte stammen aus Headless-Chromium mit synthetischen Geräten und **Software-Kodierung**, nicht aus der WebView2-App mit echtem Bildschirm. Sie zeigen die relative Größenordnung der Profile. In der Desktop-App nutzt WebView2 – wo verfügbar – Hardware-Encoder; dort wurde die Medienlast **noch nicht automatisiert gemessen** (siehe STATUS.md).

### Verhalten bei Netzwerkunterbrechungen (gemessen im E2E-Test)

* Server-Neustart während eines Gesprächs mit 3 Teilnehmern: Signalisierung nach ≈ 1–3 s wieder verbunden, Sprachplatz durch Grace-Period erhalten, **Audio lief ohne Neuaufbau weiter** (Bytes stiegen über den Neustart hinweg).
* Client-Wiederverbindung: Backoff 1 s, 2 s, 4 s, 8 s, 15 s, 30 s (+ Jitter); sofortiger Versuch beim Windows-Ereignis „online“.

## Zielwerte (abgeleitet aus der ersten Version)

| Kennzahl | Ziel | Stand |
|---|---|---|
| Installer | < 10 MB | ✅ 4,5 MB |
| Start bis bedienbar | < 1,5 s | ✅ ≈ 0,7–1,0 s |
| Privater Speicher im Leerlauf (inkl. WebView2) | < 200 MB | ✅ ≈ 165–185 MB |
| CPU im Leerlauf | < 0,5 % | ✅ ≤ 0,16 % |
| Server Leerlauf | < 30 MB | ✅ 13,6 MB |
| Server, 100 aktive Clients | < 100 MB, < 50 % eines Kerns | ✅ 32,5 MB, 15,7 % |
| Sprachanruf pro Client | < 15 % eines Kerns | ✅ ≈ 13 % (Headless-Messung) |
