# Funktionsstand (Version 1.0.2)

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

### macOS (neu in 1.0.2)
| Funktion | Stand |
|---|---|
| **macOS-Installer** (`.dmg`, universal für Apple Silicon + Intel, ab macOS 11) mit eigenem Installationsfenster (in „Programme“ ziehen); ad hoc signiert, **nicht notarisiert** (Gatekeeper fragt beim ersten Start) | 🟡 gebaut auf einem GitHub-Mac (siehe TESTING.md); **auf einem echten Mac nicht ausprobiert** |
| Native Fensterknöpfe (Ampel) über der eigenen Titelleiste, ⌘ statt Strg in der Tastenübersicht, Daten in `~/Library/Application Support/Domus`, Sitzungstoken mit Schlüsselbund-Schlüssel (AES-256-GCM) verschlüsselt, Hinweistexte für Mikrofon/Kamera/lokales Netzwerk | 🟡 kompiliert und Rust-Tests auf macOS im Build-Lauf; Oberfläche nicht auf einem Mac gesichtet |
| Server hosten, Chats, Anrufe, Kamera, Soundboard, Direktversand, E2E-DMs, QR-Übertragung | 🟡 derselbe Code wie unter Windows; auf macOS ungetestet |
| Sprachnachrichten: WebKit nimmt ggf. kein WebM auf → AAC/M4A als Ausweichformat (Server erkennt `.m4a`) | ✅ Server-Erkennung; 🟡 Aufnahme auf macOS ungetestet |
| Nicht auf macOS: Fernsteuerung dieses Rechners, Zeichnen-Overlay auf dem eigenen Desktop, Firewall-Hilfe; Ausgabegerät wählen und Bildschirm teilen hängen von der WebKit-Version ab | – |

### Server und Bildschirm am Handy, Chats verwalten (neu in 1.0.2)
| Funktion | Stand |
|---|---|
| **Server hosten in der Android-App:** dieselbe Hosting-Zentrale wie am PC (Server anlegen, starten, Einladungslink, Internet-Link über den Tunnel, mehrere Server, Autostart mit der App). Ein Vordergrund-Dienst mit Benachrichtigung „Domus-Server läuft“ hält die App samt Server im Hintergrund am Leben (Wake-Lock und WLAN-Lock) | 🟡 Rust-Teil identisch mit dem Desktop und dort getestet; der Android-Build kompiliert und enthält alles. **Auf einem Handy nicht ausprobiert.** Grenzen: Android-Energiesparmodi einzelner Hersteller können den Dienst trotzdem beenden; im Mobilfunknetz ist das Handy nur über den Tunnel erreichbar; die Windows-Firewall-Hilfe entfällt |
| **Bildschirm teilen in der Android-App:** Android-Freigabedialog (MediaProjection), das Bild geht als Videospur in den Anruf (bis 1600 px lange Seite, bis 15 FPS), beendbar in Domus oder über Android | 🟡 gebaut, **nicht auf einem Handy getestet**. Bewusst nicht: Ton des Handys, Fernsteuerung, Zeichnen-Overlay auf dem Handy. Dreht man das Handy während der Freigabe, bleibt das Format der Startausrichtung |
| **Anrufe laufen am Handy im Hintergrund weiter** (Vordergrund-Dienst vom Typ Mikrofon; ohne ihn schaltet Android das Mikrofon ab, sobald man die App verlässt – z. B. beim Bildschirmteilen) | 🟡 wie oben |
| **Chats archivieren, anheften, löschen** (Rechtsklick bzw. lange drücken auf eine Unterhaltung oder „⋯“ im Chat): Archiv als eigener, einklappbarer Bereich mit Ungelesen-Zähler; angeheftete Chats oben; „Chat löschen“ entfernt den Verlauf **nur für dich** – die andere Person behält ihn, eine neue Nachricht bringt den Chat ohne die alten Nachrichten zurück (gilt auch für die Suche). Alles serverseitig pro Konto gespeichert, also auf allen Geräten gleich | ✅ Rust-Integrationstest + `chats.mjs` |
| **Unterhaltungen filtern** (Suchfeld ab fünf Chats) | ✅ `chats.mjs` |
| **Lesebestätigungen** in Direktnachrichten („Zugestellt“ → „Gelesen“), nur wenn beide sie eingeschaltet haben (Standard: an; abschaltbar unter Einstellungen › Mein Konto) | ✅ Integrationstest + `chats.mjs` |
| **Ruhezeiten** (täglich, z. B. 22–7 Uhr, auch über Mitternacht) | ✅ `chats.mjs` |
| **Status mit Ablaufzeit** (30 Min., 1 Std., 4 Std., heute, 1 Woche) | ✅ `chats.mjs`; Hinweis: gelöscht wird er von einem laufenden Domus dieses Kontos – ist keins offen, verschwindet er beim nächsten Start |
| Behoben: Eingaben direkt nach dem Öffnen von „Mein Konto“ wurden kurz danach zurückgesetzt | ✅ |

### Android-App, Profil per QR-Code, kleine Verbesserungen (neu in 1.0.1)
| Funktion | Stand |
|---|---|
| **Android-App** (APK, Android 8+, ARM64 und x86_64): derselbe Client wie unter Windows – Text, Sprache, Video, DMs inkl. Verschlüsselung, Soundboard, Umfragen, Dateien, Einladungen. Eigene Handy-Oberfläche: eine Spalte (Server/Kanäle ↔ Chat), Zurück-Taste schließt Dialoge und kehrt zur Kanalliste zurück, Mitgliederliste als Sheet, Menüs als Bottom-Sheet (lange drücken), Dialoge im Vollbild, große Touch-Flächen, Wischen zum Antworten, Bildschirm bleibt im Anruf an, App-Icon als adaptives Android-Icon | 🟡 APK gebaut und signiert; Oberfläche im Handy-Format automatisiert getestet (`mobile.mjs`, Chromium mit Android-Kennung und Touch). **Auf einem echten Handy oder im Emulator wurde die App nicht gestartet** – der Emulator braucht Hardware-Virtualisierung, die auf dem Entwicklungs-PC im BIOS/UEFI ausgeschaltet ist |
| Android – in 1.0.1 nicht enthalten: Server hosten und eigenen Bildschirm teilen (beides seit 1.0.2 möglich); weiterhin nicht: Fernsteuerung, Zeichnen-Overlay auf dem Desktop, globale Tasten, Tray/Autostart mit dem System | – |
| **Profil übertragen per QR-Code** (PC → Handy und Handy → PC): Einmal-Codes je Server (3 Minuten, einmalig), Adressen, Fingerabdruck und auf Wunsch Design/Sprache/Schriftgröße/Benachrichtigungen; Empfang per Kamera-Scan oder eingefügtem Text, eigene Sitzung je Gerät, Hinweis „Neues Gerät angemeldet“. Server, die nur auf diesem PC erreichbar sind (localhost), werden mit Begründung ausgelassen | ✅ Rust-Integrationstest (Einmaligkeit, Ablauf, Liste, Abmelden) + `mobile.mjs`: QR aus der App → simulierte Kamera des anderen Geräts → Anmeldung, in beide Richtungen |
| **Angemeldete Geräte** (Einstellungen › Geräte): Liste mit „Dieses Gerät“, andere Geräte abmelden (nur dieses wird getrennt) | ✅ Integrationstest + `mobile.mjs` |
| **Entwürfe pro Kanal** (bleiben auch nach Neustart, Stift-Symbol in der Kanalliste) | ✅ `mobile.mjs` |
| **Benachrichtigungen pausieren** (1 Std., 8 Std., bis morgen 8 Uhr; Rechtsklick auf den eigenen Namen oder Einstellungen › Benachrichtigungen; Glocken-Symbol zum Fortsetzen) | ✅ `mobile.mjs` (Windows-Toast selbst nicht automatisiert) |
| **Antworten per Doppelklick** (Desktop) bzw. **Wischen nach links** (Touch), abschaltbar | ✅ Wischen in `mobile.mjs`; Doppelklick im Browser geprüft |
| **Schriftgröße der Nachrichten** getrennt vom UI-Zoom; **„Enter sendet“** abschaltbar (am Handy standardmäßig aus) | ✅ `mobile.mjs` |
| **Globale Stummschalt-Taste** (Desktop, Standard aus, z. B. F6) | 🟡 implementiert wie die globale Push-to-Talk-Taste, nicht automatisiert getestet |
| **Einladung als QR-Code** (im Einladungsdialog, wenn die Adresse von außen erreichbar ist) und **QR-Scan beim Server-Hinzufügen** | 🟡 im Browser geprüft, Scan derselbe Code wie bei der Profilübertragung |

### Domus 1.0 – neuer Name, neues Logo (neu in 1.0.0)
| Funktion | Stand |
|---|---|
| **Umbenennung in Domus** in Oberfläche (alle 15 Sprachen), Titelleiste, Fenster- und Infobereich-Titel, Installer (Name, Grafiken, Kurzbeschreibung), Programmdatei `Domus.exe`, Desktop-Verknüpfung, Firewall-Regel „Domus Server“, Headless-Server `domus-server`, Projektseite und cjs86 | ✅ Typprüfung, alle Testreihen mit den neuen Namen |
| **Logo:** Haus mit Kopfhörern auf warmem Verlauf (Amber → Koralle → Violett); als Icon 16–256 px (.ico), Installer-Seitenbild und -Kopfgrafik, Favicon | ✅ in allen Größen gesichtet |
| **Update von NexUs/NexusTalk:** Installer beendet die alte App, entfernt die alte Installation still und übernimmt „Mit Windows starten“. Daten bleiben in `%APPDATA%\NexusTalk`, App-Kennung unverändert (`org.nexustalk.desktop`), damit nichts verloren geht | 🟡 Logik geprüft und Installer gebaut; **das Update über eine echte NexUs-Installation wurde nicht ausprobiert**, um die laufende Installation auf dem Entwicklungs-PC nicht anzufassen |
| **Einladungslinks** `domus://…`; `nexustalk://…` wird weiter angenommen | ✅ Rust- und Browser-Tests. Hinweis: NexUs 0.10 und älter kann `domus://`-Links nicht öffnen – dort hilft das Update |
| **Neue Programmdatei:** Windows-Firewall-Freigabe gilt pro Programm; nach dem Update meldet Domus deshalb ggf. „Firewall blockiert“ und gibt sich mit einem Klick (Administrator-Bestätigung) wieder frei. Internet-Links über den Tunnel sind davon nicht betroffen | 🟡 erwartetes Verhalten, nicht auf einem zweiten PC geprüft |
| Unverändert intern: Crate-Namen (`nexus-server`, `nexus-net`), Datenordner, Speicher-Schlüssel im Browser-Build, TURN-Realm | – |

### Zusammenarbeit, Verschlüsselung, Autostart, Designs (neu in 0.10.0)
| Funktion | Stand |
|---|---|
| **Server-Autostart:** alle eigenen Server starten mit der App (letzte Einstellungen, ohne Rückfrage; bei Fehlstart bis zu drei Wiederholungen). Globaler Schalter unter Einstellungen › App; pro Server weiter abschaltbar. Gestoppte Server starten mit einem Klick: Banner in der Kanalliste, Startseite des Servers, Rechtsklick in der Leiste, Liste der Hosting-Zentrale. Beim Update wird der Server-Schalter einmalig eingeschaltet (vorher war er bei übernommenen Servern aus – deshalb „passierte nichts“) | ✅ Desktop-E2E `native.mjs` (Start nach Update, globaler Schalter, Ein-Klick-Start) |
| **Fernsteuerung überarbeitet:** Umschalt-Taste (Standard **F8**, wählbar) wechselt zwischen eigenem PC und Stream, in der Desktop-App systemweit; beim Gesteuerten beendet dieselbe Taste die Steuerung sofort. Passwort **optional** und verdeckt (Auge zum Anzeigen); ohne Passwort bestätigt der Host jede Anfrage. Fünf Fehlversuche sperren fünf Minuten. Tasten gehen als Hardware-Scancodes (richtige Belegung auch bei QWERTZ, Pfeil-/Navigationstasten als „extended“), Maus auf den geteilten Monitor statt auf den gesamten virtuellen Desktop, Spielmodus mit relativer Mausbewegung, horizontales Scrollen, Menü für Tastenkombinationen (Win, Alt+Tab, Task-Manager …), gehaltene Tasten werden beim Pausieren/Beenden losgelassen, Vollbild mit Tastatursperre | ✅ Browser-E2E `collab.mjs` (Anfrage, Bestätigung, Passwort, F8, Scancodes, Maus, Loslassen, Widerruf); ✅ Rust-Tests inkl. echter Zeigerbewegung auf diesem PC (≤ 2 px); 🟡 **zwischen zwei echten Rechnern nicht getestet**; Erkennung des geteilten Monitors bei mehreren Bildschirmen nur per Unit-Test (dieser PC hat einen) |
| **Auf den Stream zeichnen + Laserpointer:** jeder im Anruf kann auf jedem Stream markieren und zeigen; Striche verblassen nach einigen Sekunden. Beim Teilenden erscheinen die Markierungen zusätzlich in einem durchsichtigen, durchklickbaren Overlay direkt auf dem Desktop (von der Aufnahme ausgenommen). Abschaltbar | ✅ Browser-E2E (Strich, Pointer, Abschalten); ✅ Desktop-E2E (Overlay-Fenster öffnet, zeichnet, schließt); 🟡 Overlay während einer echten Übertragung nur einzeln, nicht im Zusammenspiel getestet |
| **Direktversand ohne Größenlimit:** Dateien gehen per WebRTC-Datenkanal direkt von Rechner zu Rechner; der Server vermittelt nur den Verbindungsaufbau und speichert nichts. In DMs automatisch angeboten, wenn eine Datei das Upload-Limit übersteigt | ✅ Browser-E2E (6 MB, SHA-256 identisch, Ablehnen); ✅ Desktop-E2E für das stückweise Schreiben auf die Platte; 🟡 sehr große Dateien (GB) und Übertragung über das Internet-Relay nicht gemessen |
| **Sofort-Clip:** die letzten Sekunden (15–120 s wählbar, Clip bis zum Doppelten) des angesehenen oder eigenen Streams als MP4/WebM, mit Stream-Ton und optional den Stimmen; Taste **F9** (systemweit in der Desktop-App), Speichern oder im Chat teilen; die anderen sehen einen Hinweis | ✅ Browser-E2E (Puffer, Clip, Dialog, Hinweis); 🟡 Rechenlast des Puffers nicht gemessen |
| **Gemeinsam schauen:** YouTube-Link oder direkte Video-Adresse – jeder spielt selbst ab, Start/Pause/Spulen gelten für alle, Nachzügler steigen an der richtigen Stelle ein. Lokale Videodatei wird als Stream für alle abgespielt | ✅ Browser-E2E (Synchronisation, Nachzügler, Datei als Stream); 🟡 YouTube-Bild in der Desktop-App nicht automatisiert geprüft (im Test lädt der Player und liefert Titel/Position) |
| **Ende-zu-Ende-verschlüsselte Direktnachrichten:** pro Unterhaltung einschaltbar (Schloss im Kopf), ECDH P-256 + AES-256-GCM, privater Schlüssel nur auf dem Gerät (Windows-DPAPI), Sicherheitsnummer zum Vergleichen, Warnung bei Schlüsselwechsel, Schlüsselsicherung mit Kennwort. Grenzen siehe SECURITY.md | ✅ Browser-E2E (Server speichert nur Chiffrat, Gegenseite liest, Bearbeiten, Sicherung/Wiederherstellung); ✅ Rust-Integrationstest (Schlüsselverzeichnis) |
| **Designs:** 5 entfernt (Neon, Matrix, Lava, Hologramm, Prisma – zu grell bzw. schlecht lesbar; Einstellungen wechseln automatisch auf das nächstliegende), 6 neue ruhige: Graphit, Fjord, Papier (hell), Mokka, Bordeaux, Mono – jetzt 20. Oberfläche insgesamt ruhiger: weniger Glanz und Leuchten, Farbe markiert nur noch Aktives; Meldungen oben rechts statt über den Anruf-Knöpfen | ✅ Screenshots geprüft |

### Korrekturen (0.9.1)
| Funktion | Stand |
|---|---|
| **Soundboard-Sounds repariert:** Applaus, Grillen und Gong (die drei längsten) wurden sauber neu kodiert (44,1 kHz, einheitlich) und kurz getrimmt, damit sie in der WebView2-Engine zuverlässig dekodieren und abspielen | ✅ in der echten Browser-Engine geprüft (alle dekodieren) |
| **Soundboard ohne Scrollbalken:** das Raster passt jetzt vollständig in den Rahmen (kein seitliches Scrollen) | ✅ Browser-E2E |
| **Fernsteuerung nur bei Vollbild:** die Freigabe lässt sich nur einschalten, wenn der gesamte Bildschirm geteilt wird (nicht ein einzelnes Fenster), damit der Steuernde den ganzen Desktop sieht | ✅ per displaySurface erkannt, Knopf andernfalls gesperrt |
| **Bildschirm teilen:** Vollbild ist vorausgewählt (displaySurface „monitor"), Systemton standardmäßig an; „Gesamter Bildschirm" steht im App-Menü links, „Anderer Inhalt" rechts | ✅ App-Menü per E2E; die native Auswahl von Windows/WebView2 selbst ist nicht gestaltbar |
| **Soundboard-Lautstärke** weiterhin standardmäßig 50 % | ✅ |

### Soundboard, gleichzeitiges Teilen, Fernsteuerung, neue Designs (neu in 0.9.0)
| Funktion | Stand |
|---|---|
| **Soundboard:** 20 neue Meme-/Gaming-Sounds (jetzt 36), alle von Pixabay geprüft und im Pegel angeglichen; feineres, minimalistisches Emoji-Raster; Sounds überlappen beim Klicken ohne Verzögerung und ohne Abbruch; Stummschalt-Knopf und Lautstärke (Standard 50 %) im Menü | ✅ Browser-E2E (schnelle Klicks ohne Sperre, Mute, 50 %); alle 36 Dateien dekodieren (Prüfskript) |
| **Bildschirm + Kamera gleichzeitig:** beide als getrennte Kacheln oder – Standard – die Kamera als kleines Overlay über der Bildschirmübertragung; umschaltbar in den Einstellungen | ✅ Browser-E2E (Overlay-Kachel); Logik für zwei Streams vorhanden |
| **Fernsteuerung (Desktop):** Wer den Bildschirm teilt, erlaubt die Steuerung mit einem selbst gesetzten Passwort; ein Betrachter übernimmt Maus, Tastatur oder Controller über den verschlüsselten Datenkanal. Injektion nur bei aktiver, freigegebener Sitzung; Host sieht ein Banner und kann jederzeit beenden | 🟡 Rust-Unit-Tests (Freigabe-Gate, Parsen) + kompiliert; **echte Übertragung zwischen zwei Rechnern nicht getestet** (Eingabe wird per Windows SendInput injiziert); Controller wird auf Maus/Tasten abgebildet (kein virtueller Controller-Treiber nötig) |
| **Posteingang-Knopf entfernt:** „Für später speichern“ leitet die Nachricht jetzt in eine private Direktnachricht an dich selbst („Notizen“) weiter | ✅ Rust-Integrationstest (Selbst-DM) + Browser-E2E |
| **Brief-Symbol** schon in 0.8 für DMs/Freunde; Hover-Fehler am „+“ der Textkanäle behoben | ✅ visuell geprüft |
| **5 neue Designs mit Effekten/Animationen:** Matrix (Grün, Scanlines, Code-Regen), Synthwave (Neon-Gitter + Sonne), Lava (warme, langsam wandernde Blobs), Hologramm (schimmernder Farbverlauf, animierte Namen), Prisma (treibende Aurora) – jetzt 19 Designs; pausieren bei verborgenem Fenster und respektieren „Bewegung reduzieren“ | ✅ Screenshots aller fünf |

### NexUs (neu in 0.8.0)
| Funktion | Stand |
|---|---|
| **Neuer Name „NexUs“ und neues Logo** (ein durchgehender Strich bildet das N, der Verbindungspunkt leuchtet; Smaragd → Cyan → Indigo) – App, Fenster, Taskleiste, Tray, Desktop-/Startmenü-Verknüpfung, Installer (eigene Kopf- und Seitengrafik), Projektseite | ✅ Desktop-E2E (Titelleiste), Installer gebaut; Daten bleiben in `%APPDATA%\NexusTalk` |
| Installer entfernt die alte „NexUs“-Installation automatisch (stilles Deinstallieren, alte Verknüpfungen und Autostart-Eintrag), Einstellungen/Server/Chats bleiben | 🟡 Hook gebaut; das Upgrade von einer installierten 0.7.0 wurde nicht automatisiert getestet |
| **Fehler behoben: Soundboard-Sounds** spielten in der Desktop-App nicht (Sicherheitsrichtlinie `connect-src` blockierte das Laden; betraf auch die Wellenform von Sprachnachrichten) | ✅ Desktop-E2E: Datei lädt und dekodiert, Worklet lädt, `blob:` lesbar |
| **Fehler behoben: Spenden-Link** (und Homepage) öffneten sich nicht – der Opener hatte keinen erlaubten URL-Bereich | ✅ einmal echt geöffnet; Desktop-E2E prüft den Bereich und dass andere Schemata gesperrt bleiben |
| **Breiten per Ziehen:** Seitenleiste (200–440 px) und Mitgliederliste (180–420 px), Chat nimmt den Rest; Doppelklick setzt zurück, Pfeiltasten am Griff, wird gespeichert | ✅ Browser-E2E |
| Mitgliederliste standardmäßig eingeblendet (einmalig auch für bestehende Einstellungen) | ✅ |
| Posteingang aus der Chat-Kopfzeile in die linke Leiste verlegt (öffnet als Fenster) | ✅ Browser-E2E |
| Brief-Symbol für Direktnachrichten/Freunde | ✅ |
| **Bildschirm teilen:** Systemton standardmäßig an; Start-Knöpfe „Gesamter Bildschirm“ (wählt im Windows-Dialog den Bildschirm-Reiter vor) und daneben „Anderer Inhalt“ (Fenster) | ✅ Browser-E2E (Knöpfe, Platz); 🟡 Vorauswahl im WebView2-Dialog nicht automatisiert geprüft |
| **Webcam:** neues Symbol, Systemton standardmäßig mitübertragen (abschaltbar in den Einstellungen) – Windows fragt dafür beim Start der Kamera einmal nach der Tonquelle | 🟡 implementiert; mit echter Kamera nicht getestet |
| **Kompakter Chat** (eine Zeile pro Nachricht), **Emoji-Vorschläge** mit „:“ und automatische Umwandlung von `:name:`, Knopf **„Zu den neuesten Nachrichten“** beim Hochscrollen | ✅ Browser-E2E |

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
* `bore.pub` ist ein kostenloser, öffentlicher Dienst eines Dritten ohne Verfügbarkeitsgarantie. Fällt er aus, versucht NexUs es automatisch weiter; der Heimnetz-Link funktioniert unabhängig davon.
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
