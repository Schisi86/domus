# Funktionsstand (Version 0.3.0)

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
