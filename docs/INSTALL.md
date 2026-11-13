# Installation, Betrieb und Aktualisierung

## Desktop-App (Windows 10/11, 64 Bit)

1. `Domus_<version>_x64-setup.exe` (NSIS, empfohlen) oder `Domus_<version>_x64_de-DE.msi` ausführen.
   * Der NSIS-Installer installiert **ohne Administratorrechte** für den aktuellen Benutzer nach `%LOCALAPPDATA%\Domus` und ersetzt dabei eine vorhandene NexUs-/NexusTalk-Installation.
   * Benötigt die Microsoft-Edge-WebView2-Runtime (unter Windows 11 vorinstalliert; fehlt sie, lädt der Installer sie von Microsoft).
2. Startmenüeintrag und Desktop-Verknüpfung „Domus“ werden angelegt.
3. Die Installation aktiviert **keinen** Server. Der Servermodus muss bewusst im Dialog „Eigenen Server betreiben“ (Server-Symbol in der linken Leiste) gestartet werden.

**Deinstallation:** Windows-Einstellungen › Apps › Domus › Deinstallieren. Benutzerdaten bleiben erhalten und können manuell gelöscht werden:

| Ordner | Inhalt |
|---|---|
| `%APPDATA%\NexusTalk\client.json` | Serverliste, Einstellungen, verschlüsselte Sitzungstoken |
| `%APPDATA%\NexusTalk\logs\` | Protokolle (7 Tage) |
| `%APPDATA%\NexusTalk\server\` | Daten des integrierten Servers (Datenbank, Uploads, Zertifikat, Backups, `server.toml`) |
| `%LOCALAPPDATA%\org.nexustalk.desktop\` | WebView2-Profil (Cache) |

## Android-App (ab 1.0.1, Android 8 oder neuer)

1. `Domus_<version>_android.apk` von der Projektseite auf das Handy laden und öffnen. Android fragt beim ersten Mal, ob der Browser bzw. Dateimanager Apps installieren darf („Unbekannte Apps installieren“) – für diese Installation erlauben.
2. Domus öffnen → **„Von anderem Gerät übertragen“**. Am PC: Rechtsklick auf den eigenen Namen unten links › **„Profil übertragen“** (oder Einstellungen › Geräte) → QR-Code mit dem Handy scannen. Alternativ „Server hinzufügen“ mit Adresse oder Einladungslink bzw. Einladungs-QR-Code.
3. Kamera und Mikrofon fragt Android erst, wenn sie gebraucht werden (QR-Scan, Anruf).

* Das Handy muss den Server erreichen können: im selben WLAN über die LAN-Adresse, von unterwegs über den Internet-Link (Tunnel) des Servers. Server, die nur auf dem PC selbst erreichbar sind („Nur dieser PC“), lassen sich nicht übertragen.
* Ab 1.0.2 kann die App auch **Server hosten** (Server-Symbol in der linken Leiste) und **den Bildschirm teilen**. Ein laufender Server hält Domus über eine dauerhafte Benachrichtigung im Hintergrund wach – das kostet Akku. Manche Hersteller beenden Hintergrund-Apps trotzdem; dann in den Android-Einstellungen für Domus „Akku-Optimierung: nicht optimieren“ wählen. **Wichtig:** Eine Deinstallation löscht auch den Server samt Nachrichten – vorher in den Server-Einstellungen ein Backup anlegen.
* Fernsteuerung und das Zeichnen-Overlay gibt es am Handy nicht.
* **Update:** neueres APK einfach darüber installieren (gleicher Signaturschlüssel); Server und Einstellungen bleiben erhalten. **Deinstallation** löscht alle Daten der App.

## Eigener Server in der App

1. Server-Symbol links → Konfiguration prüfen → **Server starten**.
2. Beim ersten Start: **Inhaberkonto anlegen** (Benutzername/Passwort). Der Server erscheint danach automatisch in der Liste.
3. Für andere erreichbar machen: „Lokales Netzwerk / Internet“ wählen, Warnung bestätigen, „Öffentliche Adresse“ eintragen, speichern, neu starten. Siehe [NETWORK.md](NETWORK.md).
4. Personen einladen: Rechtsklick auf den Server → „Personen einladen“ → Link kopieren.
5. Hintergrundbetrieb: Fenster schließen → Domus bleibt im Infobereich, der Server läuft weiter. Optional „Server beim Start automatisch starten“ + Einstellungen › App › „Mit Windows starten“.

## Headless-Server (ohne Oberfläche, Windows oder Linux)

Benötigt nur `domus-server(.exe)` – keine WebView2, keine weiteren Abhängigkeiten.

```bash
domus-server init --data /var/lib/domus     # schreibt server.toml
# server.toml anpassen: bind = "0.0.0.0", public_host = "chat.example.org"
domus-server --data /var/lib/domus
```

Beim ersten Start erscheint im Log ein **Einrichtungscode** (auch in `setup-code.txt`). Mit diesem Code registriert sich der Inhaber in der App (Server hinzufügen → Registrieren → Code eintragen).

Weitere Befehle:
```bash
domus-server backup  --data DIR            # Sicherung nach DIR/backups (auch im laufenden Betrieb)
domus-server restore DATEI --data DIR      # Wiederherstellung beim nächsten Start
```

### Linux (systemd)
```ini
# /etc/systemd/system/domus.service
[Unit]
Description=Domus Server
After=network-online.target

[Service]
User=nexustalk
ExecStart=/usr/local/bin/domus-server --data /var/lib/domus
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/domus

[Install]
WantedBy=multi-user.target
```
`systemctl enable --now nexustalk`. SIGTERM fährt den Server sauber herunter.

### Windows-Dienst / Autostart
Am einfachsten über die Aufgabenplanung: Trigger „Beim Systemstart“, Aktion `domus-server.exe --data C:\DomusData`, „Unabhängig von der Benutzeranmeldung ausführen“.

## Welche Komponenten werden benötigt?

| Szenario | Komponenten |
|---|---|
| Nur Client | Desktop-App (enthält den Server, startet ihn aber nicht) + WebView2-Runtime |
| Server auf dem eigenen PC mit Oberfläche | Desktop-App (Servermodus) |
| Dedizierter Server | `domus-server` (≈ 7 MB, keine Abhängigkeiten) |
| Restriktive Netze | zusätzlich TURN (integriert aktivierbar oder externer coturn) |

## Aktualisierungskonzept

* **Versionierung:** SemVer; Serverprotokoll-Version (`protocol`) in `/api/v1/info` und im `ready`-Paket. Clients zeigen inkompatible Server an, sobald sich die Protokollversion ändert.
* **Datenbank:** Migrationen laufen beim Start automatisch und vorwärts (`PRAGMA user_version`). Vor einem Update wird eine Sicherung empfohlen (`backup.create` / `domus-server backup`). Eine neuere Datenbank wird von einer älteren Programmversion nicht geöffnet (klare Fehlermeldung statt Datenverlust).
* **Desktop-App:** Neue Installer-Version einfach über die alte installieren; Daten in `%APPDATA%` bleiben erhalten. Ein automatischer Updater (Tauri-Updater mit signierten Paketen und selbst gehosteter Update-URL, kein zwingender zentraler Dienst) ist vorbereitet, aber **noch nicht aktiviert** – dafür sind ein Signaturschlüssel und ein Veröffentlichungsort nötig.
* **Headless-Server:** Binary ersetzen, neu starten.

## Selbst bauen

Voraussetzungen: Rust (stable, MSVC), Node.js ≥ 20, Visual Studio Build Tools (C++).

```bash
cd app
npm install
npx tauri build                        # → target/release/bundle/{nsis,msi}/
cargo build --release -p nexus-server  # → target/release/domus-server.exe
```

**Android-APK** (zusätzlich: JDK 17, Android SDK mit Plattform 36, Build-Tools 36 und NDK 27; Umgebungsvariablen `JAVA_HOME`, `ANDROID_HOME`, `NDK_HOME`; Rust-Ziele `aarch64-linux-android` und `x86_64-linux-android`):

```bash
cd app/src-tauri/gen/android
./gradlew assembleUniversalRelease -PabiList=arm64-v8a,x86_64 -ParchList=arm64,x86_64 -PtargetList=aarch64,x86_64
# → app/build/outputs/apk/universal/release/app-universal-release.apk
```

`npx tauri android build --apk` funktioniert ebenso, braucht unter Windows aber den Entwicklermodus (die Tauri-CLI verlinkt die Bibliothek per Symlink); der Gradle-Aufruf oben kopiert sie stattdessen. Signiert wird mit dem Schlüssel aus `%USERPROFILE%\.domus-keys\keystore.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) – der Schlüssel liegt bewusst nicht im Repository; ohne ihn entsteht ein unsigniertes APK. **Den Schlüssel sichern:** Updates müssen mit demselben Schlüssel signiert sein.

Entwicklung: `npx tauri dev` (App) bzw. `npm run dev` + `cargo run -p nexus-server -- --data dev-data` (Browser-UI gegen Testserver ohne TLS).
