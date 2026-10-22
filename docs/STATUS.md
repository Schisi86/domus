# Funktionsstand (Version 0.1.0)

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
| 13 | Wichtigste Funktionen getestet | ✅ 60 Rust-Tests, 20 Medien-E2E, 10 Desktop-E2E, Installer-Tests |
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
| Rich-Embeds, Markdown über Code/Links hinaus, Reaktionen, Threads, angeheftete Nachrichten | ⬜ |

### Sprache / Video / Bildschirm
| Funktion | Stand |
|---|---|
| Beitreten/Verlassen, Mikrofon, Lautsprecher, Stumm, Ton aus, Sprecheranzeige | ✅ |
| Lautstärke pro Benutzer, Geräteauswahl Ein/Aus, Qualitätsanzeige | 🟡 implementiert; Lautstärke/Gerätewechsel nicht automatisiert getestet |
| Wiederverbindung nach Netzwerkproblemen (ICE-Restart, Grace-Period) | ✅ (Serverneustart-Szenario) |
| Push-to-Talk | 🟡 nur bei aktivem Fenster (keine globale Tastenkombination) |
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
| Avatar, Statusmeldung, Online/Abwesend/Nicht stören/Unsichtbar | ✅ (Avatar-Upload über API getestet; Abwesend wird nicht automatisch bei Inaktivität gesetzt) |
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

## Bekannte Einschränkungen

1. **Mesh-Topologie**: Upload-Bedarf wächst mit der Teilnehmerzahl, besonders bei Bildschirmübertragung (jeder Empfänger bekommt einen eigenen Encoder-Stream).
2. **P2P-Rechte**: Sprech-/Video-/Bildschirmrechte sind serverseitig für den Zustand erzwungen, ein manipulierter Client könnte aber Medien direkt an Peers senden (siehe SECURITY.md).
3. **IP-Sichtbarkeit** zwischen Teilnehmern bei direkten Medienverbindungen.
4. **Push-to-Talk** nur bei fokussiertem Fenster.
5. Server sind voneinander unabhängig (keine Föderation): Konten und DMs gelten pro Server.
6. Dateien werden nicht in Backups der Datenbank aufgenommen (Ordner `uploads/` separat sichern).
7. Medien-Leistungswerte wurden in Headless-Chromium gemessen, nicht in der WebView2-App.

## Nächste Schritte (priorisiert)

1. Test mit zwei physischen PCs im LAN und über Internet inkl. TURN; Ergebnisse in TESTING.md ergänzen.
2. Manueller Durchlauf der Bildschirmübertragung (Monitor, Fenster, Systemton) in der Desktop-App.
3. Globales Push-to-Talk (tauri-plugin-global-shortcut, Pressed/Released).
4. Automatischer Status „Abwesend“ bei Inaktivität.
5. Signierter Auto-Updater mit selbst gehosteter Update-Quelle; Code-Signatur.
6. Optionale SFU für größere Sprachkanäle und vollständige Rechte-Durchsetzung.
7. Option „Nur über Relay verbinden“ (IP-Schutz).
8. Reaktionen, angeheftete Nachrichten, erweitertes Markdown.
9. Linux-Build des Headless-Servers in CI.
