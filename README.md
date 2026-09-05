# Nexus Chat — Discord-Clone mit Owner-Konto

Ein vollwertiger Chat-Server: echte Konten, Datenbank, Echtzeit-Chat per WebSockets.

## Start
1. Node.js 20+ installieren.
2. `npm install`
3. `npm start`
4. Im Browser öffnen: http://localhost:3000

## Owner-Konto
**Der allererste Account, den du registrierst, wird automatisch dein Owner-Konto** 👑
– keine Konfiguration nötig. Er bekommt sofort eine eigene Community ("Meine Community")
mit Kanälen und die vollen Owner-Rechte:

- Nutzer verifizieren (Owner-Panel, oben links in der Kanalliste)
- Jede Nachricht auf dem Server bearbeiten oder löschen, unabhängig vom Autor
- Kanäle anlegen und löschen
- Mitglieder aus dem Server entfernen (Kick)

Jeder, der sich danach registriert, tritt automatisch deiner Community als normales
Mitglied bei.

Falls du stattdessen einen bestimmten, bereits existierenden Benutzernamen zwingend
zum Owner machen willst, kannst du beim Start `OWNER_USERNAME=deinname npm start` setzen.

## Enthaltene Features
- Registrierung/Login mit gehashten Passwörtern (bcrypt) + JWT-Sessions
- Mehrere Server, Text- und Sprachkanäle (Sprachkanäle sind aktuell nur sichtbar, ohne Audioübertragung)
- Echtzeit-Nachrichten über Socket.IO, Tippt-gerade-Anzeige
- Emoji-Reaktionen auf Nachrichten
- Nachrichten bearbeiten/löschen (eigene Nachrichten oder als Owner alle)
- Mitgliederliste mit Online-Status und Verifizierungs-Häkchen
- Owner-Panel zur Nutzerverwaltung
- SQLite-Datenbank (Datei `nexus-chat.db`), Daten bleiben über Neustarts erhalten

## Nachrichten trotz schlafendem Server (Free-Hosting)
Wenn der Server (z.B. bei Render) wegen Inaktivität eingeschlafen ist:
- Eine geschriebene Nachricht erscheint sofort als "wird gesendet…" im Chat.
- Im Hintergrund weckt ein normaler HTTP-Request den Server auf und versucht die
  Zustellung automatisch erneut, mit wachsender Wartezeit.
- Die Nachricht bleibt auch gespeichert, wenn du die Seite währenddessen neu lädst.
- Ein Banner oben zeigt an, wenn der Server gerade aufwacht.
- Sobald der Server antwortet, wird die Nachricht normal zugestellt.

## Mögliche nächste Ausbaustufen
Echte Sprach-/Video-Chats (WebRTC), Dateiupload, Direktnachrichten/Freundesliste,
feingranulare Rollen & Rechte, Moderationsprotokolle, Push-Benachrichtigungen,
Volltextsuche, Threads, OAuth-Login, Rate-Limiting, Deployment-Setup.
