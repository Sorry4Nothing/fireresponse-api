# Architektur

FireResponse besteht aus einer App für iOS und Android und einem Server mit API und Datenbank. Die Pushes laufen über Firebase Cloud Messaging (FCM). Dieses Dokument beschreibt den Aufbau von Version 1.

## Teile

### App

- Die iOS- und die Android-App sind nativ und liegen in eigenen Repos, nicht in diesem.
- Ihre Daten holt die App nur von der API, über HTTPS.
- Daten vom Server hält sie nur im Arbeitsspeicher. Auf dem Gerät bleibt nur das Sitzungs-Token, im geschützten Speicher des Systems.

### API

- Hono auf Node 26; zod prüft jede Eingabe.
- REST mit JSON unter `/api/v1`.
- Login und Sitzungen mit better-auth unter `/api/auth`. Dort sind nur acht Pfade offen, jeder andere liefert 404.
- Die Rechte prüft die API bei jeder Anfrage, nie die App. Mandanten sind Kanton > Bezirk > Einheit (Jugend- oder Kinderfeuerwehr). Der Kanton ist fest, `bezirk` und `einheit` sind Tabellen. Jede Abfrage filtert mit `einheitId IN (…)` auf die Einheiten, die `einheitenFuer(person, zweck)` aus dem Konto ableitet; die App schickt nie eine Einheit mit. Eine fremde Einheit ist 404, erst danach prüft die Route das Recht (403).
- Rollen: Das Konto des Kantonsadmins (better-auth-Rolle `admin`) sieht alle Einheiten. Pro Einheit gibt es genau eine Kommandantin oder einen Kommandanten, beliebig viele Stellvertretungen (mit Reihenfolge) und Leitende (`einheit_rolle`). Eltern und Teilnehmende hängen über `teilnehmende_konto` an ihren Personen; pro Person antworten entweder die Eltern oder die Person selbst. Die Übergabe des Kommandos (`POST /api/v1/admin/einheiten/{einheitId}/kommando`) tauscht die Rollen in einer Transaktion.
- Verwaltungsrouten (`/api/v1/admin/*`) verlangen für jedes Konto mit Verwaltungsrolle (Kantonsadmin, Kommandant, Stellvertretung) einen zweiten Faktor; App-Sitzungen haben keinen und bekommen dort 403.
- Einwilligung: Ohne Zustimmung zur aktuellen Fassung (`user.einwilligung_version`) sperrt die API alle App-Routen ausser Profil (`GET /api/v1/ich`) und `/api/v1/einwilligung`; Passwortwechsel und Abmelden laufen über `/api/auth`.
- Konto löschen: Die Person löscht ihr Konto nicht selbst. Das Kommando (nur Konten, deren Einheiten es alle verwaltet) oder der Kantonsadmin löscht es in der Verwaltung (`DELETE /api/v1/admin/konten/{userId}`, vorher `GET /api/v1/admin/konten?benutzername=` für die Rückfrage). Eine Transaktion entfernt das Konto samt allem, was per CASCADE daran hängt; Teilnehmende bleiben Einträge der Einheit. Kommandantinnen und Kommandanten und das eigene Konto lassen sich nicht löschen (409). Das Audit-Log behält nur die IDs. Mehr in [datenschutz/README.md](datenschutz/README.md) und im [Bedrohungsmodell](sicherheit/bedrohungsmodell.md).
- Ohne Login liefert sie ausserdem die Seiten `/datenschutz`, `/nutzungsbedingungen`, `/konto-loeschen` und `/support`, die die App-Stores verlangen, sowie `/health`. `/health` antwortet nur «ok» oder mit einem Fehler, ohne Details.
- Die Web-Verwaltung unter `/admin` besteht aus statischen Dateien aus `apps/api/public/admin`, ohne Build-Schritt. Sie enthalten keine Daten: Die Seite meldet sich über `/api/auth` an und ruft `/api/v1/admin/*` auf, mit Sitzung und zweitem Faktor. Die Antworten tragen eine strenge Content-Security-Policy (kein Inline-Skript, kein Inline-Stil, `frame-ancestors 'none'`).
- «Übersicht» und «System» der Verwaltung zeigen Betriebszahlen der laufenden API über `GET /api/v1/admin/system` und `/api/v1/admin/system/requests`: Bestand, Prozess, Datenbank und Anfragen nach Routenmuster mit Dauer und Fehlern. Die Anfragezähler liegen nur im Arbeitsspeicher der API (24 Stunden in Minuten-Eimern, ohne Query, Body, Header, IP und Personen) und sind nach jedem Neustart leer.

### Lodur-Kalender

- Die Termine jeder Einheit kommen aus ihrem Lodur-Kalender (ICS). Das Kommando oder der Kantonsadmin trägt den ganzen Link der Einheit ein (`PUT /api/v1/admin/einheiten/{einheitId}/lodur`). Die API speichert ihn mit AES-GCM verschlüsselt (Schlüssel aus `BETTER_AUTH_SECRET`, eigener Zweck), zeigt danach nur den Host und schreibt ihn nie ins Log. Ein Wechsel des Geheimnisses macht gespeicherte Links unlesbar; der Sync meldet dann `entschluesselung`, und das Kommando trägt den Link neu ein.
- SSRF-Schutz (SR-26): erlaubt sind nur `https`, nur ein Host aus `LODUR_ERLAUBTE_HOSTS`, kein Port, keine Zugangsdaten im Link. Der Abruf folgt keiner Weiterleitung, bricht nach 15 Sekunden ab und liest höchstens 5 MB. Die Allowlist gilt bei jedem Abruf, nicht nur beim Speichern.
- Ein Job in der API läuft beim Start und danach alle 15 Minuten, ohne manuellen Auslöser. Ein Advisory Lock verhindert zwei gleichzeitige Läufe. Jede Einheit läuft für sich; scheitert eine, steht in `einheit.sync_fehler` genau ein Code (`http-fehler`, `weiterleitung`, `zu-gross`, …), nie eine Meldung, und die nächste Einheit läuft trotzdem.
- Lodur setzt `CREATED`, `DTSTAMP` und `LAST-MODIFIED` bei jedem Abruf neu. Änderungen erkennt darum nur `programm.inhalt_hash` (SHA-256 über Titel, Zeiten, Thema/Dienst, Info und Aufgebot). `Verantwortlich` wird nie gespeichert.
- Künftige Termine übernehmen jede Änderung. Hat noch niemand geantwortet, bleibt es still; gibt es Antworten, bleiben sie, und alle, die geantwortet haben, bekommen einen Push («Termin geändert»). Vergangene Termine ändert der Sync nie. Fehlt die UID eines künftigen Termins, wird er `abgesagt`; die Anmeldungen bleiben, und alle Konten der Einheit bekommen einen Push («Termin abgesagt»). Ein Kalender ohne jeden Termin sagt nichts ab, sondern endet mit dem Code `leer`. Beide kommen aus `sendeAenderungsPush` und `sendeAbsagePush` (Kanal `termine`) und tragen weder Datum noch Titel, Inhalte oder Namen.
- `/health` antwortet mit 503 und `sync-veraltet`, wenn der Sync einer Einheit mit Link seit über 60 Minuten nicht gelungen ist.

### PostgreSQL

- PostgreSQL 18 hält die Daten von FireResponse.
- In Produktion hat die Datenbank keinen veröffentlichten Port. Sie hängt nur im internen Netz des Servers.
- Die API verbindet sich mit einer eigenen Rolle ohne DDL-Rechte: Tabellen anlegen, umbauen oder entfernen darf sie nicht. Migrationen laufen mit der Besitzerrolle der Datenbank.

### Caddy

- Webserver vor der API, der einzige Dienst mit veröffentlichten Ports (80 und 443).
- HTTPS mit automatisch erneuerten Zertifikaten und HSTS.
- Leitet die Anfragen an die API weiter.

### Push über FCM

- Die App holt ihr FCM-Registrierungstoken bei Firebase und registriert es bei der API.
- Die API schickt Pushes mit firebase-admin direkt an FCM (HTTP v1). FCM stellt sie über APNs (Apple) und an Android-Geräte zu.
- Meldet FCM ein Token als nicht mehr registriert, löscht die API es. Ohne Schlüsseldatei des Dienstkontos (`FCM_SCHLUESSEL_DATEI`) startet die API und sendet keine Pushes.
- Pushes haben einen Titel und einen Text (`notification.body`). Sie enthalten nie Namen von Kindern und nie Inhalte eines Termins: Absage, Änderung und Anmeldung tragen nur einen festen Titel und den Text «In Fire-Response». Der Text einer Erinnerung stammt von den Admins (mit den Platzhaltern `{Programm}` und `{Datum}`); sie schreiben keine Namen hinein.
- Deep Link: Jeder Push trägt als Daten genau `typ` und `id`. Bei `typ: "programm"` ist `id` die Programm-ID. Die App baut daraus das Ziel (Programm-Detail), auch beim Kaltstart; die API liefert keine URL.
- Android-Kanäle: `termine` (Erinnerung, Absage, Änderung) und `anmeldungen` (Anmelde-Push an Kommando und Leitende). Die App legt beide an; Personen können sie stummschalten. Die Kanal-ID steht in der Android-Konfiguration des Pushes, nicht in den Daten.
- Schalter: Jede Person steuert `pushProgramme` selbst (`PATCH /api/v1/ich`, standardmässig an). Die API prüft ihn beim Senden: Wer den Schalter ausschaltet, bekommt diese Art Push nicht mehr, ohne dass das Token gelöscht wird.
- Anmelde-Push: Ändert sich die Teilnahme einer teilnehmenden Person an einem Programm (`PUT /api/v1/programme/{id}/teilnahmen/{teilnehmendeId}`, gleicher Wert zählt nicht), bekommen Kommando und Leitende der Einheit des Programms einen Push (Titel «Neue Anmeldung» bzw. «Neue Abmeldung», Text «In Fire-Response», weder Programm noch Person). Ausgenommen sind die handelnde Person und alle mit ausgeschaltetem `pushAnmeldungen` (Standard an, `GET /api/v1/ich` gibt ihn nur Personen mit einer Rolle in einer Einheit zurück). Typ `programm`, Kanal `anmeldungen`.
- Absage- und Änderungs-Push: Die Funktionen `sendeAbsagePush` und `sendeAenderungsPush` (`apps/api/src/termin-push.ts`) rufen der Lodur-Sync und alle anderen Stellen auf, nachdem sie ein künftiges Programm abgesagt oder geändert haben; sie hängen an keinem Sync-Code. Die Absage (Titel «Termin abgesagt») geht an alle Aktiven der Einheit: Eltern und teilnehmende Personen aktiver Teilnehmender, Kommando und Leitende. Die Änderung (Titel «Termin geändert») geht nur an die, die für das Programm schon geantwortet haben (ja oder nein); hat noch niemand geantwortet, geht nichts hinaus. Beide beachten `pushProgramme` und aktive Konten, schicken einem Konto nur einen Push, tun bei einem begonnenen Programm nichts und werfen nie. Typ `programm`, Kanal `termine`.
- Erinnerungen (Zeitregeln): Eine Regel gehört zu einer Einheit (`einheit_id`); das Kommando verwaltet sie für die eigene Einheit. Der Prüfer läuft jede Minute und schickt die Erinnerung an Konten mit offener Antwort, nur für Programme im Anmeldefenster (`ANMELDEFENSTER_TAGE`). Typ `programm`, Kanal `termine`.

## Wer spricht mit wem

| Von             | Zu                                  | Weg                          | Wozu                                                                                                          |
| --------------- | ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| App             | Caddy                               | HTTPS                        | Login, Programme, Anmeldungen, Push-Token registrieren                                                        |
| Browser         | Caddy                               | HTTPS                        | Seiten `/datenschutz`, `/nutzungsbedingungen`, `/konto-loeschen`, `/support`, Verwaltung `/admin`             |
| Uptime-Dienst   | Caddy                               | HTTPS                        | `/health` abfragen, Alarm bei Fehler                                                                          |
| Caddy           | API                                 | internes Netz des Servers    | Anfragen weiterleiten                                                                                         |
| Caddy           | Zertifizierungsstelle               | HTTPS (ACME)                 | Zertifikate holen und erneuern                                                                                |
| API             | PostgreSQL                          | internes Netz, eigene Rolle  | Daten lesen und schreiben                                                                                     |
| Migrationen     | PostgreSQL                          | Besitzerrolle der Datenbank  | Tabellen anlegen und umbauen                                                                                  |
| Backup (restic) | S3-Speicher in der Schweiz          | HTTPS                        | Verschlüsselte Backups ablegen, täglich und vor jedem Deploy                                                  |
| API             | Pwned Passwords (Have I Been Pwned) | HTTPS                        | Neue Passwörter mit bekannten Datenlecks abgleichen; gesendet werden nur die ersten 5 Zeichen des SHA-1-Hashs |
| App             | Firebase (FCM)                      | HTTPS                        | Push-Token holen                                                                                              |
| API             | FCM                                 | HTTPS, firebase-admin        | Pushes senden                                                                                                 |
| API             | Lodur (Host aus der Allowlist)      | HTTPS, ohne Weiterleitung    | Kalender der Einheit alle 15 Minuten abrufen                                                                  |
| FCM             | Gerät                               | über APNs (Apple) und Google | Pushes zustellen                                                                                              |
