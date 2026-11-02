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
- Konten entstehen von oben nach unten, es gibt keine Selbstregistrierung: Das erste Konto des Kantonsadmins legt die CLI `kantonsadmin:anlegen` auf dem Server an. Der Kantonsadmin legt Bezirke und Einheiten an; eine Einheit entsteht nur zusammen mit ihrer Kommandantin oder ihrem Kommandanten in einer Transaktion. Das Kommando legt Stellvertretungen (mit Reihenfolge; Stellvertretungen selbst dürfen das nicht), Leitende, Teilnehmende und Eltern an, einzeln oder per CSV-Import (Vorschau, dann Import). Jedes neue Konto bekommt ein Startpasswort, das nur in der Antwort der Anlage steht. Pro Teilnehmende/r antworten die Eltern oder die Person selbst; der Wechsel Eltern → Kind (`konto-wechsel`) legt das Konto der Person an und löst die Elternkonten in einer Transaktion.
- Der zweite Faktor (TOTP) gehört zum Konto, nicht zur Sitzung: Kantonsadmin, Kommando und Stellvertretungen richten ihn über `/api/auth/two-factor/enable` selbst ein und geben den Code danach bei jeder Anmeldung ein. Leitende, Eltern und Teilnehmende haben keinen; ihr App-Login ist ohne zweiten Faktor, und ihre Sitzungen bekommen unter `/api/v1/admin/*` 403.
- Einwilligung: Ohne Zustimmung zur aktuellen Fassung (`user.einwilligung_version`) sperrt die API alle App-Routen ausser Profil (`GET /api/v1/ich`) und `/api/v1/einwilligung`; Passwortwechsel und Abmelden laufen über `/api/auth`.
- Ohne Login liefert sie ausserdem die Seiten `/datenschutz`, `/konto-loeschen` und `/support`, die die App-Stores verlangen, sowie `/health`. `/health` antwortet nur «ok» oder mit einem Fehler, ohne Details.
- Die Web-Verwaltung unter `/admin` besteht aus statischen Dateien aus `apps/api/public/admin`, ohne Build-Schritt. Sie enthalten keine Daten: Die Seite meldet sich über `/api/auth` an und ruft `/api/v1/admin/*` auf, mit Sitzung und zweitem Faktor. Die Antworten tragen eine strenge Content-Security-Policy (kein Inline-Skript, kein Inline-Stil, `frame-ancestors 'none'`).
- Die Verwaltung zeigt immer genau eine Einheit; der Umschalter Bezirk/Einheit wählt sie (die Wahl steht nur in der Browser-Sitzung). Sie zeigt nur Aktionen, die die API erlaubt: Die Listen der Konten nennen je Konto in `aktionen`, was der Akteur darf, und die Routen prüfen dieselbe Regel (`src/konto-verwaltung.ts`). Konten, die auch zu einer anderen Einheit gehören (Eltern mit Kindern in zwei Einheiten, Leitende zugleich Eltern), ändert nur der Kantonsadmin: Sonst läse das Kommando über ein neues Startpasswort die Kinder einer fremden Einheit. Das Kommando ändert nur der Kantonsadmin, eine Stellvertretung nur das Kommando oder der Kantonsadmin; das eigene Konto nie (Startpasswort, Deaktivieren, zweiter Faktor).
- Ein Startpasswort steht in keiner Liste, nur im Dialog (neu erzeugt oder, solange es offen ist, wieder angezeigt) und wird beim Schliessen aus der Seite gelöscht. Alles, was die Verwaltung ändert, steht im Audit-Log ohne Passwörter, Namen und Nummern; «System → Änderungen» liest es (nur Kantonsadmin).
- Das Abzeichen eines Rangs ist ein SVG oder PNG (höchstens 500 KB, Hochformat 100:130) in der Datenbank. Der Server prüft und bereinigt es (SR-23): Ein SVG wird als Baum aus erlaubten Elementen und Attributen neu geschrieben (keine Skripte, kein `style`, keine Verweise nach aussen, kein DOCTYPE), ein PNG behält nur seine Bildblöcke. Ausgeliefert wird es mit eigener Content-Security-Policy (`sandbox`) und `nosniff`.
- «Übersicht» und «System» der Verwaltung zeigen Betriebszahlen der laufenden API über `GET /api/v1/admin/system` und `/api/v1/admin/system/requests`: Bestand, Prozess, Datenbank und Anfragen nach Routenmuster mit Dauer und Fehlern. Die Anfragezähler liegen nur im Arbeitsspeicher der API (24 Stunden in Minuten-Eimern, ohne Query, Body, Header, IP und Personen) und sind nach jedem Neustart leer.

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
- Pushes haben einen Titel und einen Text (`notification.body`). Sie enthalten nie Namen von Kindern. Der Text einer Erinnerung stammt von den Admins; sie schreiben keine Namen hinein.
- Deep Link: Jeder Push trägt als Daten genau `typ` und `id`. Bei `typ: "programm"` ist `id` die Programm-ID. Die App baut daraus das Ziel (Programm-Detail), auch beim Kaltstart; die API liefert keine URL. Android-Kanal: `programme`. Die App legt ihn an und kann ihn stummschalten. Bei einer Änderung oder Absage eines Programms geht kein Push hinaus.
- Schalter: Jede Person steuert `pushProgramme` selbst (`PATCH /api/v1/ich`, standardmässig an). Die API prüft ihn beim Senden: Wer den Schalter ausschaltet, bekommt diese Art Push nicht mehr, ohne dass das Token gelöscht wird.
- Anmelde-Push: Ändert sich die Teilnahme einer teilnehmenden Person an einem Programm (`PUT /api/v1/programme/{id}/teilnahmen/{teilnehmendeId}`, gleicher Wert zählt nicht), bekommen Kommando und Leitende der Einheit des Programms einen Push (Titel «Neue Anmeldung» bzw. «Neue Abmeldung», Text «Programm am Datum», nie die Person). Ausgenommen sind die handelnde Person und alle mit ausgeschaltetem `pushAnmeldungen` (Standard an, `GET /api/v1/ich` gibt ihn nur Personen mit einer Rolle in einer Einheit zurück). Typ `programm`, Kanal `programme`.

## Wer spricht mit wem

| Von             | Zu                                  | Weg                          | Wozu                                                                                                          |
| --------------- | ----------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| App             | Caddy                               | HTTPS                        | Login, Programme, Anmeldungen, Push-Token registrieren                                                        |
| Browser         | Caddy                               | HTTPS                        | Seiten `/datenschutz`, `/konto-loeschen`, `/support` und die Verwaltung `/admin`                              |
| Uptime-Dienst   | Caddy                               | HTTPS                        | `/health` abfragen, Alarm bei Fehler                                                                          |
| Caddy           | API                                 | internes Netz des Servers    | Anfragen weiterleiten                                                                                         |
| Caddy           | Zertifizierungsstelle               | HTTPS (ACME)                 | Zertifikate holen und erneuern                                                                                |
| API             | PostgreSQL                          | internes Netz, eigene Rolle  | Daten lesen und schreiben                                                                                     |
| Migrationen     | PostgreSQL                          | Besitzerrolle der Datenbank  | Tabellen anlegen und umbauen                                                                                  |
| Backup (restic) | S3-Speicher in der Schweiz          | HTTPS                        | Verschlüsselte Backups ablegen, täglich und vor jedem Deploy                                                  |
| API             | Pwned Passwords (Have I Been Pwned) | HTTPS                        | Neue Passwörter mit bekannten Datenlecks abgleichen; gesendet werden nur die ersten 5 Zeichen des SHA-1-Hashs |
| App             | Firebase (FCM)                      | HTTPS                        | Push-Token holen                                                                                              |
| API             | FCM                                 | HTTPS, firebase-admin        | Pushes senden                                                                                                 |
| FCM             | Gerät                               | über APNs (Apple) und Google | Pushes zustellen                                                                                              |
