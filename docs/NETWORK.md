# Netzwerk, Ports, Firewall und Router

## Ports (Standardwerte)

| Port | Protokoll | Zweck | Wann nötig |
|---|---|---|---|
| **7878** | TCP | HTTPS + WebSocket: Anmeldung, Text, Dateien, Signalisierung | immer |
| **3478** | UDP | STUN (integriert) bzw. STUN+TURN | für Sprache/Video über verschiedene Netze (empfohlen) |
| **49160–49200** | UDP | TURN-Relay-Ports | nur wenn TURN aktiviert ist |

Alle Ports sind in `server.toml` bzw. im Dialog „Eigenen Server betreiben“ änderbar.

## Erreichbarkeit verstehen

Zwei verschiedene Dinge:

1. **Server erreichbar** – der Client kann sich per TCP verbinden: Text, Präsenz, Dateien funktionieren.
2. **Medienverbindung zwischen zwei Clients** – Audio/Video gehen *direkt* von Client zu Client (WebRTC/ICE). Das kann auch dann scheitern, wenn der Server erreichbar ist (z. B. beide Clients hinter strikter NAT/Firewall).

NexusTalk zeigt beides getrennt an: Der Verbindungsstatus des Servers steht in der Seitenleiste/den Einstellungen, die Medienqualität (Latenz, Paketverlust, „über Relay“) im Sprachpanel und auf den Teilnehmerkacheln.

## Szenarien

### Nur dieser PC (Standard)
`bind = "127.0.0.1"`. Niemand sonst kann sich verbinden. Gut zum Ausprobieren.

### Lokales Netzwerk (LAN)
* Im Servermodus „Lokales Netzwerk / Internet“ wählen (setzt `bind = "0.0.0.0"`).
* Windows fragt beim ersten Start nach der Firewall-Freigabe: **„Private Netzwerke“ erlauben**.
* Andere verbinden sich mit `LAN-IP:7878`, z. B. `192.168.1.20`. Medien laufen im LAN direkt (Host-Kandidaten); STUN ist nicht zwingend.

Manuelle Firewall-Regeln (PowerShell als Administrator), falls die Abfrage nicht erschien:
```powershell
New-NetFirewallRule -DisplayName "NexusTalk TCP" -Direction Inbound -Protocol TCP -LocalPort 7878 -Action Allow -Profile Private
New-NetFirewallRule -DisplayName "NexusTalk STUN/TURN" -Direction Inbound -Protocol UDP -LocalPort 3478 -Action Allow -Profile Private
```

### Internet
1. Router: **Portweiterleitung** TCP 7878 und UDP 3478 (ggf. 49160–49200) auf die LAN-IP des Server-PCs.
2. In „Öffentliche Adresse“ die öffentliche IP oder einen (DynDNS-)Hostnamen eintragen – sie wird in Einladungslinks verwendet.
3. Empfohlen: eigenes Zertifikat (z. B. Let's Encrypt) für den Hostnamen eintragen; sonst prüfen Clients den Fingerabdruck aus dem Einladungslink.
4. Registrierung auf „Nur mit Einladung“ oder „Freischaltung“ lassen.
5. Mit TURN aktivieren, wenn Teilnehmer in restriktiven Netzen sind (Firmen, Mobilfunk-CGNAT). „Relay-IP“ = öffentliche IP des Servers.

**Realistische Grenzen:** Hat der Server-Anschluss selbst keine öffentliche IPv4 (DS-Lite/CGNAT), ist er aus dem Internet nur über IPv6, einen VPS/Reverse-Proxy oder ein VPN (z. B. WireGuard) erreichbar. Kein zentraler Dienst von NexusTalk wird benötigt, aber ohne erreichbare Adresse kann auch kein Peer verbinden.

### Hinter einem Reverse-Proxy
`tls.enabled = false` und `bind = "127.0.0.1"` setzen, der Proxy terminiert TLS und leitet `/` inkl. WebSocket-Upgrade (`/api/v1/ws`) weiter. Clients verbinden sich dann mit `https://chat.example.org:443` (öffentlich vertrauenswürdiges Zertifikat → keine Fingerabdruck-Abfrage).

### Externer TURN-Server (coturn)
In `server.toml`:
```toml
[[media.ice_servers]]
urls = ["turn:turn.example.org:3478?transport=udp", "turns:turn.example.org:5349"]
username = "nexus"
credential = "geheim"
```

## Fehlerdiagnose

| Symptom | Ursache / Lösung |
|---|---|
| „Server nicht erreichbar“ | Adresse/Port falsch, Server gestoppt, Firewall blockiert TCP 7878, Server bindet nur an 127.0.0.1. |
| „Unbekanntes Zertifikat“ | Erwartet bei selbst signierten Zertifikaten – Fingerabdruck mit dem Betreiber vergleichen. |
| „Zertifikat hat sich geändert“ | Zertifikat wurde neu erzeugt (Ordner `tls/` gelöscht?) oder Verbindung wird abgefangen. |
| Text geht, Sprache verbindet nicht („Verbinde …“) | Kein direkter Pfad: STUN-Port freigeben, ggf. TURN aktivieren. |
| Sprache „über Relay“, hohe Latenz | Direkter Pfad nicht möglich; Relay funktioniert, Server-Upload begrenzt die Qualität. |
| Verbindung bricht ab und kommt zurück | Automatische Wiederverbindung (Backoff bis 30 s); Sprachplatz wird 20 s gehalten. |

Die Serveradresse kann mit `curl -k https://HOST:7878/api/v1/info` geprüft werden (liefert Name und Version).
