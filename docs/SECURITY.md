# Sicherheit und Datenschutz

## Was ist implementiert

| Bereich | Umsetzung |
|---|---|
| Transportverschlüsselung | TLS 1.2/1.3 (rustls) für HTTP und WebSocket. Ohne eigenes Zertifikat erzeugt der Server beim ersten Start ein selbst signiertes und behält es. |
| Zertifikatsprüfung im Client | Pinning des SHA-256-Fingerabdrucks („Trust on first use“). Unbekannte Zertifikate werden mit Fingerabdruck angezeigt und müssen bestätigt werden; ein **geändertes** Zertifikat blockiert die Verbindung mit deutlicher Warnung. Öffentlich vertrauenswürdige Zertifikate (z. B. Let's Encrypt) werden ohne Rückfrage akzeptiert. Einladungslinks enthalten den Fingerabdruck. |
| Medien | WebRTC mit DTLS-SRTP zwischen den Clients (auch über TURN verschlüsselt). |
| Passwörter | Argon2id (Standardparameter der `argon2`-Crate), individuelles Salt, nie im Klartext gespeichert oder protokolliert. Konstante Fehlermeldung und Dummy-Hash bei unbekannten Benutzern (kein Benutzer-Enumeration über Antwortzeiten/Text). |
| Sitzungen | 256-Bit-Zufallstoken; in der DB nur SHA-256-Hash. Ablauf nach 30 Tagen Inaktivität (konfigurierbar). Passwortänderung beendet alle anderen Sitzungen, Sperre beendet alle. |
| Token-Speicherung im Client | Windows DPAPI (an das Windows-Benutzerkonto gebunden). Passwörter werden im Client nicht gespeichert. |
| Berechtigungen | Ausschließlich serverseitig geprüft (`perms.rs`, jede Operation). UI blendet nur aus. Rollenhierarchie verhindert Rechteausweitung (man kann nur Rollen unterhalb der eigenen verwalten und keine Rechte vergeben, die man selbst nicht hat). Fremde DMs sind auch für Administratoren unsichtbar. |
| Eingabevalidierung | Längenlimits, Steuerzeichen-Filter, Namensregeln, typisierte JSON-Deserialisierung; FTS-Suchbegriffe werden quotiert (keine Such-Injection); SQL nur parametrisiert. |
| Dateien | Gespeichert unter Zufalls-IDs (kein Pfad aus Benutzereingaben), Dateinamen nur zur Anzeige und bereinigt. Größenlimit wird beim Streamen erzwungen, Speicherkontingent, Abbruch löscht Teildateien. Auslieferung mit `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Content-Disposition: attachment` (Bilder: inline, nur bei erkannter Signatur PNG/JPEG/GIF/WebP). Dateien werden nie ausgeführt. Uploads sind abschaltbar. Download nur mit Leserecht auf den Kanal. |
| Rate-Limits | Anmeldung/Registrierung pro IP (6/min, Burst 10), WebSocket-Operationen pro Verbindung (10/s, Burst 40), Nachrichten (2/s, Burst 10), Verbindungen gesamt/pro IP, maximale Framegröße 128 KB, begrenzte Ausgangswarteschlange (langsame Clients werden getrennt). |
| Stabilität | Jede Verbindung läuft in einem eigenen Task; Fehler/Panics betreffen nur diese Verbindung (Release-Build ohne `panic=abort`). Ungültiges JSON, Übergrößen oder Flooding trennen nur den Verursacher. |
| Sichere Standardkonfiguration | Bind an `127.0.0.1`, TLS an, Registrierung „nur mit Einladung“, Owner-Einrichtung über Einmalcode, TURN aus. Freigabe ins Netzwerk erfordert eine bestätigte Warnung mit Port-Erklärung. |
| Protokollierung | Sicherheitsrelevante Ereignisse (Fehlanmeldungen mit IP, Anmeldungen, Registrierungen, Sperren, Rollen-/Kanaländerungen, Löschungen durch Moderatoren, Backups) im Serverlog bzw. Audit-Protokoll. Keine Nachrichteninhalte, keine Passwörter/Token. Logrotation (7 Tage Standard). |
| Datenlöschung | Benutzer können ihr Konto löschen (optional inkl. aller Nachrichten). Aufbewahrungsfrist für Nachrichten konfigurierbar. Nicht verwendete Uploads werden nach 1 h gelöscht. |
| Medienzugriff | Mikrofon nur während einer Sprachsitzung, Kamera und Bildschirm nur nach ausdrücklicher Aktion; Bildschirmübertragung wird permanent angezeigt und ist jederzeit beendbar; Systemdialog für die Quellenauswahl. |

## Was NICHT implementiert ist (ehrliche Einschränkungen)

* **Keine Ende-zu-Ende-Verschlüsselung für Textnachrichten und Dateien.** Der Serverbetreiber kann Nachrichten und Dateien in der Datenbank bzw. im Upload-Ordner lesen. (Audio/Video/Bildschirm sind zwischen den Clients per DTLS-SRTP verschlüsselt; der Server sieht sie nicht.)
* **Kein Verschlüsseln der Datenbank im Ruhezustand.** Schutz über Dateisystemrechte/Festplattenverschlüsselung des Server-PCs.
* **Durchsetzung von Sprech-/Video-/Bildschirmrechten in P2P-Sitzungen**: Der Server verweigert die entsprechenden Zustände (`voice.update`) und markiert stumme Benutzer; ehrliche Clients rendern nur vom Server freigegebene Streams. Ein manipulierter Client könnte dennoch Medien an andere Teilnehmer senden, weil diese nicht über den Server laufen. Vollständige Durchsetzung erfordert eine SFU (geplant).
* Keine Zwei-Faktor-Anmeldung, keine Passwort-Zurücksetzung per E-Mail (bewusst keine externen Dienste; Admin kann Konto löschen, Benutzer neu registrieren).
* Kein Virenscan hochgeladener Dateien.
* **Internet-Tunnel (ab 0.5.0):** Für Einladungen über das Internet läuft der Verkehr über das öffentliche Relay `bore.pub` (Dritter). Inhalte bleiben TLS-verschlüsselt und per Fingerabdruck geprüft; das Relay sieht IP-Adressen, Zeitpunkte und Datenmengen. Der Relay-Port ist öffentlich erreichbar, Schutz bietet die Einladungspflicht. Hinter dem Tunnel sieht der Server alle Teilnehmer als `127.0.0.1`: das Verbindungslimit pro IP entfällt dort, die Login-Bremse gilt gemeinsam. Der Tunnel ist im Verbindungs-Check abschaltbar.
* **TURN über den Tunnel (ab 0.6.0):** Freigegebene Server in der Desktop-App schalten den TURN-Relay ein (UDP lokal, TCP auch über bore.pub). Zugangsdaten sind zeitlich begrenzt (12 h, HMAC mit Server-Geheimnis) und gehen nur an angemeldete Benutzer. Medien bleiben DTLS-SRTP-verschlüsselt; der Relay leitet nur weiter.
* **Moderation (ab 0.6.0):** Auszeit, Kicken, serverseitiges Stummschalten und Verschieben werden ausschließlich serverseitig durchgesetzt (Rechte + Rangfolge, Inhaber unantastbar) und im Audit-Protokoll vermerkt. Eine Auszeit entzieht Schreib-, Datei-, Sprech-, Kamera- und Bildschirmrechte in Serverkanälen; DMs bleiben nutzbar. Serverseitiges Stummschalten ist wie die übrigen Sprechrechte „honest client“: Der Server markiert und verweigert, ein manipulierter Client könnte trotzdem Medien direkt an andere senden (siehe SFU-Hinweis oben).
* **Profile (ab 0.7.0):** Banner-Farben werden serverseitig streng geprüft (nur `#rrggbb`, höchstens zwei), „Über mich“ ist auf 190 Zeichen begrenzt und wird als Text, nicht als HTML angezeigt.
* **Sprachnachrichten (ab 0.7.0):** werden wie andere Dateien gespeichert (Größenlimit, Leserecht nötig). Als Audio gilt eine Datei nur bei passender Signatur; WebM nur mit Endung `.weba`/`.opus`.
* **„Für später“ und Notizen** liegen nur lokal auf dem Gerät, nicht auf dem Server.
* **Fernsteuerung (ab 0.9.0):** Nur in der Desktop-App und nur, wenn der **gesamte Bildschirm** geteilt wird (nicht ein einzelnes Fenster), damit der Steuernde sieht, was er bedient. Eingaben werden lokal per Windows `SendInput` eingespielt und nur, solange eine ausdrücklich freigegebene Sitzung läuft (Host hat die Funktion eingeschaltet, ein Passwort gesetzt, und das Passwort des Betrachters stimmte). Der Host sieht ein deutliches Banner und kann sofort widerrufen; das Beenden der Bildschirmübertragung schaltet die Steuerung ab. Steuerbefehle laufen Ende-zu-Ende über den WebRTC-Datenkanal (nicht über den Server). Risiko bleibt: Wer die Steuerung übernimmt, kann den geteilten Rechner bedienen – nur an vertraute Personen vergeben und ein starkes Passwort wählen.
* **Selbst-DM „Notizen“ (ab 0.9.0):** gespeicherte Nachrichten liegen als normale Direktnachricht an dich selbst auf dem Server (keine Ende-zu-Ende-Verschlüsselung, wie bei allen Texten).
* **Öffentliche STUN-Server:** Für Sprache/Video fragen Clients zusätzlich `stun.cloudflare.com` und `stun.l.google.com` nach ihrer öffentlichen Adresse. Diese Dienste sehen dabei die IP-Adresse, aber keine Medien.

## Welche Daten speichert der Server?

| Daten | Zweck | Sichtbar für |
|---|---|---|
| Benutzername, Anzeigename, Avatar, Statusmeldung | Profil | alle Mitglieder |
| Passwort-Hash (Argon2id) | Anmeldung | niemand (nur Server) |
| Sitzungen: Token-Hash, Zeitpunkte, Gerätename | Anmeldung | nur Server |
| Rollen, Online-Status (bzw. „offline“ bei unsichtbar) | Rechte/Präsenz | alle Mitglieder |
| Nachrichten, Antworten, Erwähnungen, Bearbeitungszeit | Chat | Benutzer mit Leserecht auf den Kanal; DMs nur die beiden Teilnehmer |
| Dateien (Name, Größe, Typ, Inhalt) | Anhänge | Benutzer mit Leserecht auf den Kanal |
| Lesestatus pro Kanal | Ungelesen-Markierungen | nur der Benutzer selbst |
| Freundes-/Blockierliste | Kontakte | nur die beteiligten Benutzer (Blockierungen sind für die blockierte Person nicht direkt sichtbar) |
| Sprachkanal-Teilnahme, Stumm/Ton aus/Kamera/Bildschirm | Anzeige | Benutzer mit Leserecht auf den Kanal |
| Audit-Protokoll (Aktion, Akteur, Ziel) | Moderation | Rolle mit „Audit-Protokoll“ |
| Serverlog: Zeit, Ereignis, bei Fehlanmeldung IP + Benutzername | Sicherheit | Serverbetreiber |

**IP-Adressen**: werden nicht in der Datenbank gespeichert, nur im rotierenden Serverlog bei Anmeldungen/Fehlversuchen. In P2P-Sprachsitzungen sehen die Teilnehmer gegenseitig ihre (öffentlichen bzw. lokalen) IP-Adressen – das ist bei direkten WebRTC-Verbindungen technisch unvermeidbar. Wer das nicht möchte, kann über einen TURN-Relay gehen (zukünftige Option „nur Relay“).

## Meldung von Sicherheitsproblemen

Bitte nicht öffentlich als Issue melden, sondern direkt an die Projektbetreuer.
