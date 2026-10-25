# Funktionsstand (Version 0.7.0)

Legende: ✅ implementiert und getestet · 🟡 implementiert, nur teilweise/manuell oder nicht automatisiert getestet · ⬜ offen

## Definition von „fertig“ (Abschnitt 21 der Anforderungen)

| # | Kriterium | Stand |
|---|---|---|
| 1 | Windows-App lässt sich bauen und installieren | ✅ NSIS + MSI gebaut, NSIS installiert/deinstalliert (Entwicklungs-PC) |
| 2 | Benutzer kann eigenen Server starten | ✅ Servermodus in der App (E2E in WebView2) + Headless-Binary |
| 3 | Zweiter Client verbindet sich über das Netzwerk | 🟡 Mehrere Clients gleichzeitig getestet – aber alle auf einem PC (Loopback). Netzwerkpfad (Bind 0.0.0.0, TLS, Pinning) ist derselbe Code; zwei physische Rechner nicht getestet |
| 4 | Authentifizierung | ✅ |
| 5 | Textnachrichten in Kanälen | ✅ |
| 6 | Nachrichten bleiben nach Serverneustart erhalten | ✅ |
| 7 | Berechtigungen serverseitig geprüft | ✅ |
| 8 | Zwei Clients sprechen im Sprachkanal | ✅ (Browser-E2E mit virtuellem Mikrofon; echtes Mikrofon in der App erkannt und verbunden) |
| 9 | Bildschirmfreigabe für anderen Client | ✅ Browser-E2E (virtuelle Quelle); 🟡 in der Desktop-App öffnet sich der native Auswahldialog, die Übertragung einer echten Quelle wurde nicht durchgeklickt |
| 10 | Verbindung im Testnetz zuverlässig | 🟡 Loopback-Testnetz: zuverlässig inkl. Serverneustart. Echtes LAN/Internet offen |
| 11 | Netzwerkfehler nachvollziehbar behandelt | ✅ Reconnect mit Backoff, Zertifikatsfehler, strukturierte Fehlercodes, Statusanzeigen |
| 12 | Grundlegende Sicherheitsmaßnahmen | ✅ siehe SECURITY.md |
| 13 | Wichtigste Funktionen getestet | ✅ 62 Rust-Tests, 20 Medien-E2E (0.2.0); 10 Desktop-E2E und Installer-Tests zuletzt mit 0.1.0 |
| 14 | Funktionsstand dokumentiert | ✅ dieses Dokument |

## Funktionen im Detail

### Client- und Servermodus
| Funktion | Stand |
|---|---|
| Server per Adresse/Einladungslink hinzufügen, mehrere Server, Wechseln | ✅ |
| Zertifikats-TOFU mit Fingerabdruck, Warnung bei Änderung | ✅ |
| Verbindungsstatus & Latenz | ✅ |
| Servermodus: Name, Adresse, Port, Registrierungsmodus, Einladungen, Freischalten/Sperren, Rollen, Kanäle, Persistenz, Logs, Status, Backups/Restore, Neustart | ✅ |
| Server läuft ohne geöffnetes Fenster (Tray) | 🟡 implementiert, nicht automatisiert getestet |
| Autostart mit Windows / Server-Autostart | 🟡 Server-Autostart getestet; Windows-Autostart (Registry über Plugin) nicht getestet |
| Warnung vor externer Freigabe mit Port-/Firewall-Erklärung | ✅ |

### Text
| Funktion | Stand |
|---|---|
| Echtzeit, Verlauf, Zeitstempel, Name/Avatar, Bearbeiten, Löschen, Antworten, Erwähnungen, Online-Status, Zeilenumbrüche, Kopieren | ✅ |
| Dateianhänge mit Fortschritt, Bildvorschau, Download | ✅ (Server-Tests + UI im Browser); 🟡 Download-Dialog der App nicht automatisiert |
| Ungelesen-Markierungen, Erwähnungszähler, Tippanzeige | ✅ |
| Benachrichtigungen (DM, Erwähnung, Anruf, Verbindung), pro Server/Kanal stummschaltbar | 🟡 implementiert, Windows-Toast nicht automatisiert getestet |
| Volltextsuche mit Sprung zur Nachricht | ✅ |
| Reaktionen (Emoji-Auswahl, Schnellreaktionen), angeheftete Nachrichten | ✅ Server-Integrationstest; UI im Browser geprüft |
| Markdown (fett, kursiv, unterstrichen, durchgestrichen, Spoiler, Zitate, Listen, Code), Formatierungs-Tastenkürzel | ✅ UI im Browser geprüft |
| Rich-Embeds, Threads | ⬜ |

### Sprache / Video / Bildschirm
| Funktion | Stand |
|---|---|
| Beitreten/Verlassen, Mikrofon, Lautsprecher, Stumm, Ton aus, Sprecheranzeige | ✅ |
| Lautstärke pro Benutzer, Geräteauswahl Ein/Aus, Qualitätsanzeige | 🟡 implementiert; Lautstärke/Gerätewechsel nicht automatisiert getestet |
| Wiederverbindung nach Netzwerkproblemen (ICE-Restart, Grace-Period) | ✅ (Serverneustart-Szenario) |
| Push-to-Talk | ✅ im Fenster; 🟡 globale Taste im Hintergrund (tauri-plugin-global-shortcut) implementiert, nicht automatisiert getestet |
| Echo-/Rauschunterdrückung, AGC | ✅ über WebRTC-Engine, abschaltbar |
| Webcam | ✅ Browser-E2E (virtuelle Kamera); 🟡 echte Kamera nicht getestet |
| Bildschirm: Monitor/Fenster (Systemdialog), Beenden, Anzeige bei anderen, Profile, FPS/Auflösung/Bitrate, Anzeige wer überträgt, Vollbild | ✅ / 🟡 (siehe Kriterium 9) |
| Automatische Bandbreitenanpassung | ✅ WebRTC-Staukontrolle (Profile setzen Obergrenzen) |
| Systemton getrennt vom Mikrofon | 🟡 implementiert (`systemAudio`), Hinweis wenn nicht verfügbar; unter WebView2 nicht verifiziert |
| Mehr als ≈ 8 Teilnehmer mit Video (SFU) | ⬜ Mesh-Architektur, Limit konfigurierbar (Standard 10) |

### Benutzer, Rollen, Sicherheit
| Funktion | Stand |
|---|---|
| Registrierung (geschlossen/Einladung/Freischaltung/offen), Anmeldung, Abmeldung, Argon2id, Sitzungen | ✅ |
| Avatar, Statusmeldung, Online/Abwesend/Nicht stören/Unsichtbar | ✅ (Avatar-Upload über API getestet); 🟡 automatisch „Abwesend“ nach einstellbarer Inaktivität implementiert, nicht automatisiert getestet |
| DMs, Direktanrufe, Freunde, Blockieren | ✅ |
| Rollen Inhaber/Admin/Moderator/Mitglied/Gast, anpassbar, Kanal-Overrides | ✅ |
| Konto löschen, Aufbewahrungsfristen | ✅ |
| Ende-zu-Ende-Verschlüsselung für Text | ⬜ **nicht vorhanden** |

### Windows-Integration
| Funktion | Stand |
|---|---|
| Installer (NSIS/MSI), Deinstallation, Startmenü, Icon, Versionsinfo | ✅ |
| Konfigurationsspeicherung, beschädigte Konfiguration wird gesichert & zurückgesetzt | ✅ |
| Fehlerprotokolle (Client + Server, rotierend) | ✅ |
| Automatische Updates | ⬜ Konzept dokumentiert (INSTALL.md), nicht aktiviert |
| Code-Signatur des Installers | ⬜ (SmartScreen-Warnung beim ersten Start möglich) |

### Premium-Ausbau (neu in 0.7.0)
| Funktion | Stand |
|---|---|
| **Soundboard mit echten Aufnahmen:** 16 Sounds von Pixabay (Pixabay Content License, Quellen in `app/public/sounds/CREDITS.md`), pro Sound im Pegel angeglichen, lange Sounds blenden aus; Rechtsklick hört nur für dich vor | ✅ Browser-E2E (Auslösen); Auswahl nach Länge, Pegel, Stille am Anfang und Beliebtheit – den Klang muss ein Mensch beurteilen |
| **Lebendiger Hintergrund:** langsam wanderndes Licht in den Farben des Designs, feine Körnung, Sterne bei Galaxie/Mitternacht; pausiert bei verborgenem Fenster, respektiert „Bewegung reduzieren“, abschaltbar | ✅ Screenshots |
| **Vier neue Designs** (Cyberpunk, Tiefsee, Galaxie, Royal Gold – jetzt 14) und **eigene Akzentfarbe** für jedes Design | ✅ Screenshots |
| **Profil:** Banner mit Farbverlauf (Vorlagen oder eigene Farben), „Über mich“ (190 Zeichen), Live-Vorschau beim Bearbeiten | ✅ Rust-Integrationstest + Browser-E2E |
| **Sprachnachrichten:** Aufnahme im Eingabefeld (Pegelanzeige, Timer, verwerfen/senden, max. 5 Minuten, Opus), Player mit Wellenform, Springen, 1×/1,5×/2×; normale Audiodateien (MP3, OGG, WAV) bekommen denselben Player | ✅ Browser-E2E (aufnehmen, senden, Wellenform, Dauer); Server erkennt `.weba` als Audio |
| **Anruf-Reaktionen** (schwebende Emojis über der Kachel), **Hand heben** mit Reihenfolge (Kachel, Kanalliste, Zähler), **Bild-in-Bild** für Bildschirmübertragungen | ✅ Rust + Browser-E2E; 🟡 Bild-in-Bild nur, wenn WebView2 es anbietet (Knopf erscheint sonst nicht) |
| **Eingabeempfindlichkeit (Noise-Gate)** im Audio-Thread (AudioWorklet) – automatisch (folgt dem Grundrauschen), manuell mit Schwelle, aus; Live-Pegel mit Schwellen-Marke in den Einstellungen; funktioniert auch im Hintergrund | ✅ Browser-E2E (Mikrofon läuft über das Gate, Audio kommt an, rtc.mjs 20/20); 🟡 Feinabstimmung mit echten Mikrofonen/Räumen nicht getestet |
| **Posteingang:** Erwähnungen des Servers und „Für später“ (gespeicherte Nachrichten mit Erinnerung nach 20 min / 1 h / 3 h / morgen 9 Uhr – Toast, Systembenachrichtigung, Ton) | ✅ Rust + Browser-E2E; Erinnerungen werden nur auf diesem Gerät und nur bei laufender App ausgelöst |
| Freie Ports werden für neue Server auf allen Netzwerkadressen geprüft (vorher nur 127.0.0.1 – ein anderes Programm auf 0.0.0.0 führte beim Freigeben zu „Port belegt“) | ✅ Unit-Test |

### Interaktion, Moderation und Sprache übers Internet (neu in 0.6.0)
| Funktion | Stand |
|---|---|
| **Sprache/Video über den Internet-Tunnel:** Der eingebaute TURN-Relay nimmt jetzt auch TCP an (RFC 5766, gleiche Portnummer wie UDP). Freigegebene Server in der Desktop-App schalten TURN automatisch ein und bekommen einen zweiten Tunnel (`bore.pub:PORT`) nur für den Medien-Relay; Clients erhalten diese Adresse mit den TURN-Zugangsdaten | ✅ Rust: TURN-Allokation über TCP (lokal) und **über das echte Relay im Internet** (zwei Clients tauschen Daten über ihre Relay-Adressen); Browser-E2E `turn.mjs` 5/5: Chromium nutzt nur TURN/TCP, Audio und Datenkanal kommen an; Desktop-E2E: eigener Tunnel für TURN; 🟡 kein Test mit einem zweiten Gerät in einem fremden Netz |
| Systemton beim Bildschirmteilen ohne die eigene Wiedergabe (`restrictOwnAudio`), damit niemand sich selbst als Echo hört | 🟡 Hinweis an WebView2; ob die installierte WebView2-Version ihn unterstützt, wurde nicht geprüft |
| WebView2-Leiste „… teilt Ihren Bildschirm · Freigabe beenden · Ausblenden“ wird während einer Übertragung ausgeblendet (Stopp bleibt in der App) | ✅ in der echten WebView2 geprüft: Leiste erscheint ohne, verschwindet mit der neuen Funktion |
| **Personen-Menü** (Rechtsklick überall: Mitgliederliste, Chat, Sprachkanal) mit Untermenüs: Profil, Nachricht, Anrufen, Erwähnen, private Notiz, Lautstärke bis 200 %, „Für mich stummschalten“, Freundschaft, Blockieren, Moderation, Sprachkanal, IDs kopieren | ✅ Browser-E2E `interact.mjs` |
| **Moderation:** Auszeit (60 s bis 1 Woche; kein Schreiben, Reagieren, Sprechen – DMs bleiben), Kicken (abmelden, Konto muss neu freigeschaltet werden), serverseitig stummschalten/taub schalten, in anderen Sprachkanal verschieben, trennen; vier neue Rechte (Kicken, Auszeit, Stummschalten, Verschieben), Rangfolge wird geprüft, Audit-Protokoll | ✅ Rust-Integrationstest + Browser-E2E |
| **Umfragen** (2–10 Antworten, Einfach-/Mehrfachauswahl, Laufzeit 1 h bis 1 Woche oder offen, Live-Ergebnis, Stimme ändern/zurückziehen, vorzeitig beenden) | ✅ Rust-Integrationstest + Browser-E2E |
| **Weiterleiten** von Nachrichten samt Dateien in Kanäle oder DMs („Weitergeleitet · ursprünglich von …“) | ✅ Rust-Integrationstest (Datei wird kopiert) + Browser-E2E |
| **Als ungelesen markieren** | ✅ Rust + Browser-E2E |
| **Slow-Mode** je Textkanal (5 s bis 6 h, Moderatoren ausgenommen, Countdown im Eingabefeld) und **Personenlimit** je Sprachkanal (Anzeige 2/5) | ✅ Rust + Browser-E2E |
| **Soundboard** im Sprachkanal (8 synthetische Sounds, alle im Kanal hören sie, 3 s Abklingzeit, abschaltbar und Lautstärke in den Einstellungen) | ✅ Rust (Zustellung, Rate-Limit, gesperrt bei Stummschaltung) + Browser-E2E (Auslösen); Klang manuell zu beurteilen |

### Internet-Einladungen ohne Router-Einstellungen (neu in 0.5.0)
| Funktion | Stand |
|---|---|
| Internet-Tunnel: Ein Server im Modus „Freunde einladen“ baut automatisch eine **ausgehende** Verbindung zum öffentlichen Relay `bore.pub` auf (bore-Protokoll) und bekommt eine öffentliche Adresse `bore.pub:PORT`. Das funktioniert auch ohne eigene öffentliche IPv4 (Starlink, DS-Lite/CGNAT), ohne UPnP und ohne Portweiterleitung | ✅ Rust-Test über das echte Relay: eingebetteter Server → bore.pub → Client mit Zertifikats-Pinning, HTTP und WebSocket; falscher Fingerabdruck wird abgelehnt. Desktop-E2E: öffentliche Adresse erscheint |
| Einladungskarte: Internet-Link zuerst und hervorgehoben („funktioniert für alle, egal wo“), Heimnetz-Link darunter; Verbindungs-Check mit Tunnel-Status; Tunnel ein- und ausschaltbar | ✅ Desktop-E2E `hosting.mjs` |
| Relay-Port wird gemerkt (`relay.json` im Serverordner) und beim nächsten Start wieder angefragt, damit verschickte Links gültig bleiben; automatische Wiederverbindung mit Backoff | ✅ Rust-Test; 🟡 Ist der Port beim Relay inzwischen vergeben, gibt es einen neuen Link |
| Server lauscht zusätzlich auf IPv6 (Dual-Stack) | 🟡 kompiliert und läuft, nicht aus einem fremden IPv6-Netz getestet |
| Öffentliche STUN-Server (Cloudflare, Google) als Rückfallebene für Sprache/Video | 🟡 nicht über echte NAT-Kombinationen getestet |

**Grenzen (ehrlich):**
* `bore.pub` ist ein kostenloser, öffentlicher Dienst eines Dritten ohne Verfügbarkeitsgarantie. Fällt er aus, versucht NexusTalk es automatisch weiter; der Heimnetz-Link funktioniert unabhängig davon.
* Inhalte bleiben TLS-verschlüsselt zwischen App und Server (Fingerabdruck im Link). Der Relay-Betreiber sieht IP-Adressen und Datenmengen, aber keine Inhalte.
* Der Relay-Port ist öffentlich erreichbar. Wer ihn errät, landet beim Server; die Standard-Registrierung „Nur mit Einladung“ schützt davor.
* Über den Tunnel kommen für den Server alle Teilnehmer von `127.0.0.1`. Das Verbindungslimit pro IP gilt dort deshalb nicht (nur das Gesamtlimit), und die Login-Bremse (6/min, 10 auf einmal) teilen sich alle Tunnel-Nutzer.
* Sprache und Video laufen per WebRTC möglichst direkt zwischen den Teilnehmern. Seit 0.6.0 gibt es als Rückfallebene den TURN-Relay über einen eigenen Tunnel; dann laufen die (DTLS-SRTP-verschlüsselten) Medien über bore.pub und den Host-PC – mit etwas mehr Verzögerung und Upload-Last beim Host.
* Getestet wurde der Weg durch das echte Relay im Internet, der Test-Client lief aber auf demselben PC. Ein zweites Gerät in einem fremden Netz stand nicht zur Verfügung.

### Erreichbarkeit für andere (neu in 0.4.1)
| Funktion | Stand |
|---|---|
| Windows-Firewall: Status-Prüfung (ohne Adminrechte) und Freigabe per Klick mit einer UAC-Bestätigung; automatisch beim Wechsel auf „Freunde einladen“; entfernt auch Sperr-Regeln aus einem weggeklickten Firewall-Dialog | ✅ Status-Abfrage und Skript-Syntax getestet; 🟡 die Freigabe selbst (Admin-Aktion) und der Zugriff von einem zweiten PC wurden nicht automatisiert getestet |
| Verbindungs-Check im Hosting: Server läuft, Firewall, Heimnetz-Adresse, Internet (UPnP) | ✅ visuell geprüft |
| Router-Weiterleitung per UPnP (TCP + UDP, stündlich erneuert, beim Stoppen entfernt), öffentliche IP, Erkennung von DS-Lite/CGNAT, zweiter Einladungslink „Über das Internet“ | 🟡 implementiert; der Router des Entwicklungs-PCs antwortet nicht auf UPnP, daher nicht mit echtem Router getestet |
| Hinweise beim Verbinden: „keine Antwort“ (Firewall/Servermodus) vs. „PC erreichbar, aber kein Server auf dem Port“ | ✅ Desktop-E2E |
| Hinweis-Symbol am Hosting-Knopf, wenn ein freigegebener Server läuft, die Firewall aber blockiert | ✅ |

### Fensterrahmen, Designs, Sounds (neu in 0.4.0)
| Funktion | Stand |
|---|---|
| Eigene Titelleiste statt Windows-Leiste (Farben des Designs, Ort in der Mitte, Minimieren/Maximieren/Schließen, Ziehen, Doppelklick) | ✅ Desktop-E2E `chrome.mjs`; 🟡 Einrasten per Windows-Snap-Layout-Menü am Maximieren-Knopf entfällt (Win+Pfeiltasten und Ziehen an den Rand funktionieren) |
| 10 Designs mit Farbverlauf hinter der ganzen Oberfläche, halbtransparente Flächen, Glas-Effekt für Fenster/Menüs | ✅ Screenshots aller Designs (Browser + Desktop) |
| Interface-Sounds (synthetisch, ohne Audiodateien), abschaltbar, Lautstärke, Vorhören | ✅ Auslösung per Browser-E2E nachgewiesen; Klang manuell zu beurteilen |
| Fußzeile mit „Spenden“, Copyright-Link und Sprachflagge; Herz-Knopf entfernt | ✅ Desktop-E2E |
| Schließen-Knopf der Einstellungen bleibt beim Scrollen sichtbar | ✅ Desktop-E2E |
| Neues Logo (mechanisches N) inkl. aller Icon-Größen | ✅ |

### Hosting, Bildschirm, Bilder (neu in 0.3.0)
| Funktion | Stand |
|---|---|
| Hosting-Zentrale über eigene Schaltfläche unten links, Statusanzeige (Anzahl laufender Server) | ✅ Desktop-E2E |
| Mehrere Server gleichzeitig, Ports/Ordner automatisch (TCP 7878+n, UDP 3478+n, Relay-Bereiche getrennt), Konfliktprüfung | ✅ Rust-Unit-Tests + Desktop-E2E (2 Server parallel) |
| Inhaberkonto mit vorausgefülltem Namen, dauerhafter Einladungslink je Server, neuer Link per Klick | ✅ Desktop-E2E |
| Erreichbarkeit per Klick umschalten (mit Neustart), Server umbenennen, entfernen (inkl. Daten) | ✅ Entfernen per Desktop-E2E; Umschalten auf „Freunde einladen“ nicht automatisiert (Windows-Firewall-Abfrage) |
| Übernahme des bisherigen einzelnen Servers (Ordner `server`) | ✅ Unit-Test |
| Bildschirm-Menü vor dem Start: Schnellwahl, Auflösung, Bildrate, Inhalt, Bitrate, Systemton, Upload-Schätzung je Zuschauerzahl | ✅ Browser-E2E (Werte am aufgenommenen Track geprüft) |
| Qualität während der Übertragung ändern | ✅ Browser-E2E |
| Server- und Profilbilder quadratisch zuschneiden (Ziehen, Zoom, Vorschau), Ergebnis 512×512 WebP | ✅ Browser-E2E |

### Oberfläche (neu in 0.2.0)
| Funktion | Stand |
|---|---|
| 15 Sprachen (de, en, es, fr, it, pt, nl, pl, tr, ru, ar mit RTL, hi, zh, ja, ko), Umschaltung über die Landesflagge, Systemsprache | ✅ alle 692 Schlüssel vollständig (automatisch geprüft); Übersetzungen maschinell erstellt, nicht muttersprachlich lektoriert |
| 10 Designs (Smaragd als Standard), optional hell/dunkel nach Windows | ✅ Screenshots aller Hauptansichten |
| Neues 3D-Logo, Über-Dialog mit Copyright, Homepage und Spenden-Button | ✅ |
| Schnellwechsler (Strg+K), Tastenkürzel-Übersicht (Strg+/), Kanalwechsel (Alt+↑/↓), Benachrichtigungston | ✅ UI im Browser geprüft |
| Tray-Menü in der gewählten Sprache | 🟡 implementiert, nicht automatisiert getestet |

## Bekannte Einschränkungen

1. **Mesh-Topologie**: Upload-Bedarf wächst mit der Teilnehmerzahl, besonders bei Bildschirmübertragung (jeder Empfänger bekommt einen eigenen Encoder-Stream).
2. **P2P-Rechte**: Sprech-/Video-/Bildschirmrechte sind serverseitig für den Zustand erzwungen, ein manipulierter Client könnte aber Medien direkt an Peers senden (siehe SECURITY.md).
3. **IP-Sichtbarkeit** zwischen Teilnehmern bei direkten Medienverbindungen.
4. **Globales Push-to-Talk** belegt die Taste systemweit, solange es aktiv ist.
5. Server sind voneinander unabhängig (keine Föderation): Konten und DMs gelten pro Server.
6. Dateien werden nicht in Backups der Datenbank aufgenommen (Ordner `uploads/` separat sichern).
7. Medien-Leistungswerte wurden in Headless-Chromium gemessen, nicht in der WebView2-App.

## Nächste Schritte (priorisiert)

1. Test mit zwei physischen PCs im LAN und über Internet inkl. TURN; Ergebnisse in TESTING.md ergänzen.
2. Manueller Durchlauf der Bildschirmübertragung (Monitor, Fenster, Systemton) in der Desktop-App.
3. Muttersprachliche Durchsicht der Übersetzungen.
4. Desktop-E2E und Installer-Test mit 0.2.0 wiederholen.
5. Signierter Auto-Updater mit selbst gehosteter Update-Quelle; Code-Signatur.
6. Optionale SFU für größere Sprachkanäle und vollständige Rechte-Durchsetzung.
7. Option „Nur über Relay verbinden“ (IP-Schutz).
8. Threads und Link-Vorschauen.
9. Linux-Build des Headless-Servers in CI.
