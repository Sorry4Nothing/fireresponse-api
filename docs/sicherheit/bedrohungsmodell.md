# Bedrohungsmodell

Dieses Modell beschreibt, was FireResponse schützt, wovor und wie. Es gilt für die API mit Admin-Panel in diesem Repo; die Apps haben eigene Repos und verweisen auf dieses Modell für die Server-Seite. Die Anforderungen (SR-xx) und das Vorgehen folgen den allgemeinen Sicherheitsvorgaben des Projekts; hier stehen nur die Verweise.

Methode: Assets und Vertrauensgrenzen benennen, pro Grenze die Bedrohungen nach STRIDE durchgehen, jede einer Massnahme zuordnen oder als Restrisiko festhalten. Massnahmen mit «(geplant)» setzt das genannte Epic um; bis dahin sind sie Vorgaben, keine Eigenschaft des Codes.

## Aufbau

- App (iOS, Android) ↔ Caddy ↔ API (Hono) ↔ PostgreSQL. Caddy ist der einzige Dienst mit öffentlichen Ports.
- Admin-Panel: statische Dateien unter `/admin`, Daten nur über `/api/v1/admin/*` mit Sitzung und zweitem Faktor.
- Ausgehend: FCM für Pushes, Pwned Passwords für den Passwortabgleich, der Lodur-Kalender (ICS) pro Einheit, alle 15 Minuten.
- Sicherungen: verschlüsselt auf einen S3-Speicher in der Schweiz.

## Werte (Assets)

| Wert                                                                | Warum schützenswert                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Namen von Teilnehmenden (oft Minderjährige) mit ihren Anmeldungen   | Kinderdaten, zeigen Tagesablauf und Abwesenheit                                |
| Konten, Sitzungen, Startpasswörter, zweite Faktoren                 | Zugang zu allem anderen                                                        |
| Telefonnummern des Kommandos, Profilbilder                          | Personendaten, freiwillig                                                      |
| Rollen und Rechte (Kantonsadmin, Kommando, Leitung, Eltern)         | Integrität der Zugriffsregeln                                                  |
| Lodur-Link einer Einheit                                            | Geheimnis: Wer ihn kennt, liest den Kalender                                   |
| Auswertung der Anmeldungen                                          | Zeigt Teilnahmeverhalten einzelner Personen                                    |
| Audit-Log                                                           | Spur der Verwaltungsaktionen; darf nicht veränderbar sein                      |
| Geheimnisse: `BETTER_AUTH_SECRET`, Schlüssel für FCM, DB-Passwörter | Wer sie hat, fälscht Sitzungen, sendet Pushes oder liest die Daten             |
| Sicherungen und Logs                                                | Enthalten dieselben Daten wie die Produktion                                   |
| Build-Weg (Repo, CI, Registry, Deploy)                              | Ein manipuliertes Image läuft mit allen Rechten der API                        |
| Verfügbarkeit                                                       | Einheiten planen Übungen über den Dienst; Ausfall ist lästig, nicht gefährlich |

## Vertrauensgrenzen

1. **App/Browser ↔ API.** Alles vom Client ist unvertrauenswürdig, auch die eigene App. Rolle, Person und Einheit kommen aus der Sitzung, nie aus dem Body (SR-13); die App schickt nie eine Einheit mit.
2. **API ↔ Datenbank.** Die API ist der einzige Weg zu den Daten. Ihre Rolle darf keine Tabellen ändern und am Audit-Log weder ändern noch löschen.
3. **API ↔ externe Dienste.** FCM, Pwned Passwords, Lodur: deren Antworten gelten als fremde Daten und werden geprüft (SR-20).
4. **Entwicklung ↔ Produktion.** Geheimnisse und Daten der Produktion bleiben dort; Tests nutzen erfundene Daten.
5. **Repo/CI ↔ Öffentlichkeit.** Das Repo ist öffentlich. Was in Git, Issues oder PRs steht, ist öffentlich.

## Angreiferbilder

- **Neugierige Person mit Konto:** probiert fremde IDs, Admin-Routen, Felder im Body; eine Mutter, die wissen will, wer sonst angemeldet ist.
- **Externer Angreifer:** Scanner, Passwort-Raten, bekannte Lücken in Bibliotheken, Typosquatting.
- **Gestohlenes oder verlorenes Gerät** mit offener Sitzung.
- **Versehen von innen:** ein Geheimnis im Commit, Personendaten im Log, ein Kommando, das zu viele Konten löscht.
- **Berechtigte Person mit Zweckentfremdung:** Das Kommando oder die Kantonsadministration nutzt die Auswertung gegen einzelne Kinder.

## Bedrohungen nach STRIDE

| Bedrohung                                                                    | Massnahme                                                                                                                                                                                                                                                                                                           | SR                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **S** Passwörter raten, Credential Stuffing                                  | Wartezeit nach dem 5. Fehlversuch (1, 5, dann 15 Minuten), Rate-Limit pro Pfad und IP, mindestens 12 Zeichen, Abgleich mit bekannten Datenlecks, immer dieselbe Fehlermeldung bei der Anmeldung                                                                                                                     | SR-04, SR-05, SR-06 |
| **S** Startpasswort abgefangen                                               | Gilt 7 Tage, wird verschlüsselt gespeichert und nur im Dialog gezeigt; der Pflichtwechsel sperrt alles andere                                                                                                                                                                                                       | SR-01, SR-02        |
| **S** Gestohlene Sitzung                                                     | 90 Tage mit Verlängerung bei Nutzung, serverseitig widerrufbar (Abmelden, Passwortwechsel, «überall abmelden», Deaktivieren, Löschen), kein Cookie-Cache; die App hält das Token im Schlüsselspeicher                                                                                                               | SR-02, SR-43        |
| **S** Admin-Konto übernommen                                                 | Zweiter Faktor (TOTP) für jede Verwaltungsrolle; ohne ihn 403 auf `/api/v1/admin/*`                                                                                                                                                                                                                                 | SR-02, SR-10        |
| **T** Fremde IDs (BOLA)                                                      | Jede Abfrage filtert in SQL mit `einheitId IN (…)`; fremde Einheit und fremdes Konto sind 404, erst danach zählt das Recht (403)                                                                                                                                                                                    | SR-11               |
| **T** Rolle oder Einheit im Body                                             | `strictObject` mit zod an jeder Route; Person und Rolle nur aus der Sitzung                                                                                                                                                                                                                                         | SR-13, SR-20, SR-72 |
| **T** SQL-Injection                                                          | Drizzle und parametrisierte Abfragen                                                                                                                                                                                                                                                                                | SR-21               |
| **T** Fremde Webseite löst Aktionen im Browser einer angemeldeten Person aus | Ändernde Routen verlangen eine vertraute Herkunft (Origin), `frame-ancestors 'none'`                                                                                                                                                                                                                                | SR-34               |
| **T** Manipuliertes Paket oder Image                                         | Lockfile und `npm ci`, gepinnte Versionen, Dependabot, Image nur aus dem Release-Workflow, Deploy nach Freigabe                                                                                                                                                                                                     | SR-60 bis SR-63     |
| **T** Gefälschter oder umgeleiteter Lodur-Link                               | Nur https, nur erlaubte Hosts aus der Konfiguration, keine Weiterleitungen, Zeit- und Grössenlimit; Hosts, die auf interne Adressen zeigen, blockiert der Abruf; die Antwort wird als fremde Eingabe geprüft. Offen bleibt DNS-Rebinding (Restrisiko, solange die Liste nur Hosts enthält, die der Betreiber kennt) | SR-20, SR-26        |
| **T** Fehlerhafter oder leerer Kalender sagt alle Termine ab                 | Ein Kalender ohne jeden Termin neben künftigen Terminen endet mit dem Code `leer` und ändert nichts; ein Termin, den der Parser nicht lesen kann, gilt nicht als gestrichen; vergangene Termine fasst der Sync nie an                                                                                               | SR-20               |
| **R** Verwaltungsaktion ohne Spur                                            | Audit-Log mit Akteur, Aktion und Ziel, ohne Namen; die API-Rolle darf es nur ergänzen und lesen. Das Löschen eines Kontos steht darin (`konto_geloescht`)                                                                                                                                                           | SR-52               |
| **I** Fremde Daten in Antworten                                              | Explizite Auswahl der Felder, keine ganzen Zeilen; Kontakte und Profilbilder nur für Personen derselben Einheit                                                                                                                                                                                                     | SR-74               |
| **I** Kindernamen in Pushes                                                  | Pushes tragen nie einen Namen und nie Inhalte eines Termins (Absage und Änderung nennen nur Titel und Tag des Programms, die Anmeldung trägt einen festen Titel); die Daten des Push sind `typ` und `id`                                                                                                            | SR-41               |
| **I** Personendaten in Logs                                                  | Eine JSON-Zeile pro Anfrage mit Routenmuster, Status und Dauer; ohne Namen, Inhalte, Query und IP. Bei 401 und 403 steht die Konto-ID dabei. Aufbewahrung 14 Tage                                                                                                                                                   | SR-50, SR-52        |
| **I** Zu gesprächige Fehler                                                  | Ein festes Format mit Code und kurzer Meldung; Stacktraces nur im Log, ohne Meldungstext                                                                                                                                                                                                                            | SR-51               |
| **I** Daten in Sicherungen                                                   | Verschlüsselt (restic), Speicher in der Schweiz, Schlüssel getrennt; Sitzungen, Tokens und Rate-Limit sind nicht im Backup                                                                                                                                                                                          | SR-42               |
| **I** Lodur-Link, Startpasswort, zweiter Faktor in der Datenbank             | AES-GCM-verschlüsselt (der Lodur-Link hängt an `BETTER_AUTH_SECRET`); nie in Log oder Antwort                                                                                                                                                                                                                       | SR-30, SR-50        |
| **D** Anmeldungen und Uploads fluten                                         | Rate-Limit auf den Anmeldepfaden, Body-Limit 64 KB (Bilder 5 MB, höchstens 16 Mio. Pixel), `mem_limit` und `pids_limit` für die API                                                                                                                                                                                 | SR-04, SR-71        |
| **D** Lodur fällt aus oder liefert nichts mehr                               | Fehler pro Einheit mit einem Code, die nächste Einheit läuft weiter; `/health` meldet `sync-veraltet` nach 60 Minuten; Zeitlimit 15 s, Grössenlimit 5 MB, ein Lauf zur Zeit (Advisory Lock)                                                                                                                         | SR-71               |
| **E** Neue Route ohne Rechteprüfung                                          | Die Rechte-Matrix verlangt für jede Route eine Zeile mit dem Status jeder Persona; sonst scheitert der Test                                                                                                                                                                                                         | SR-10, SR-12        |
| **E** App-Sitzung ruft Verwaltung auf                                        | `/api/v1/admin/*` verlangt für Kantonsadmin, Kommando und Stellvertretungen den zweiten Faktor; App-Sitzungen haben keinen und bekommen 403                                                                                                                                                                         | SR-10               |
| **E** better-auth öffnet mehr Pfade als gewollt                              | Allowlist von acht Pfaden, jeder andere ist 404; ein Test prüft alle übrigen Pfade der Plugins                                                                                                                                                                                                                      | SR-12, SR-54        |
| **E** Rollen eigenmächtig erweitern                                          | Das Kommando wird nur übergeben (Tausch in einer Transaktion), nie entfernt; Stellvertretungen ordnet nur das Kommando; das Löschen eines Kommandanten-Kontos ist gesperrt                                                                                                                                          | SR-10, SR-13        |
| **E** Ein Kommando löscht Konten fremder Einheiten                           | Löschen nur, wenn alle Einheiten des Kontos zum Kommando gehören; sonst nur die Kantonsadministration                                                                                                                                                                                                               | SR-11               |

## Auswertung der Anmeldungen (neu)

Ab V1 gibt es im Admin-Panel eine Auswertung (Epic E7). Sie ist neu und verändert das Datenschutzbild; deshalb steht sie hier ausdrücklich.

**Abgrenzung.** FireResponse betreibt kein Tracking und keine Analytics im üblichen Sinn: keine Drittanbieter-SDKs, keine Nutzungsdaten der App, kein Verfolgen über Geräte. Diesen engen Satz hält das Modell weiter. Die Auswertung widerspricht jedoch einer pauschalen Aussage «keine Auswertung von Personendaten»: Sie macht aus den Anmeldungen (Ja, Nein, offen) Kennzahlen zu einzelnen Personen. Das ist ein bewusster Zweck des Dienstes, kein Nebeneffekt, und gehört in die Datenschutzerklärung, die DSFA und den Elternbrief.

**Zweck.** Das Kommando plant Übungen und spricht mit Teilnehmenden und Eltern über die Teilnahme. Zahlen: Präsenzliste pro Termin, Teilnahmequote pro Person in einem Zeitraum, Jahresübersicht pro Einheit. Grundlage sind die Anmeldungen. Eine Anwesenheitskontrolle gibt es nicht; die Zahlen sagen, wer sich angemeldet hat, nicht wer gekommen ist.

**Wer sieht sie.**

| Rolle                          | Sieht                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Kommandantin, Kommandant       | die Auswertung der eigenen Einheit                                              |
| Stellvertretung                | wie das Kommando                                                                |
| Kantonsadmin                   | alle Bezirke und Einheiten                                                      |
| Leitende, Eltern, Teilnehmende | keine Auswertung; sie sehen nur die Anmeldungen, die ihnen schon heute zustehen |

Nur im Admin-Panel, also nur mit zweitem Faktor. Die App zeigt keine Auswertung. Es gibt keinen Export (kein CSV, kein Excel).

**Wie lange.** Die API speichert die Auswertung nicht. Sie rechnet bei jeder Abfrage aus den Anmeldungen. Die Zahlen leben deshalb so lange wie die Anmeldungen: bis das Kommando die Anmeldung, die teilnehmende Person oder den Termin löscht. Eine automatische Frist gibt es heute nicht. Die Aufbewahrungsdauer legt der Verantwortliche fest (Vorschlag: Anmeldungen und Termine nach 3 Jahren löschen); bis dahin gilt «bis zur Löschung durch das Kommando».

**Risiken und Massnahmen.**

| Risiko                                                                    | Massnahme                                                                                                                |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Leistungsdruck oder Ausschluss eines Kindes wegen einer niedrigen Quote   | Zweckbindung in den Nutzungsbedingungen (Planung und Gespräch, keine Sanktionen); Hinweis im Elternbrief                 |
| Eine Quote misst das Anmelden, nicht das Erscheinen, und kann falsch sein | Die Auswertung sagt es und heisst «Anmeldungen»; keine Anwesenheitskontrolle                                             |
| Das Kommando sieht eine fremde Einheit                                    | Jede Aggregat-Route filtert wie alle anderen mit `einheitId IN (…)`; Zeile in der Rechte-Matrix, Mandantentest           |
| Daten wandern aus dem Panel                                               | Kein Export; die Panel-CSP verbietet fremde Ziele; Zahlen stehen nirgends im Log                                         |
| Aus kleinen Gruppen lassen sich Einzelne erkennen                         | Hingenommen: Das Kommando kennt seine Teilnehmenden; die Auswertung zeigt nichts, was die Anmeldungen nicht schon zeigen |
| Die Kantonsadministration sieht alle Bezirke                              | Steht in den Nutzungsbedingungen; zweiter Faktor; Audit-Log der Verwaltungsaktionen                                      |

## Konto löschen

Die Person löscht ihr Konto nicht selbst: Konten entstehen durch das Kommando, und die App enthält keine Verwaltungsfunktionen. Mit einer gestohlenen Sitzung liessen sich so auch keine Daten vernichten. Das Kommando oder die Kantonsadministration löscht in der Verwaltung (`DELETE /api/v1/admin/konten/{userId}`). Dagegen stehen die Bedrohungen «Fremdes Konto gelöscht» (Rechte-Matrix, 404 und 403 wie bei jeder Route) und «Einheit ohne Kommando» (409, zuerst übergeben). Das Löschen entfernt alles, was am Konto hängt; das Audit-Log behält nur die IDs. Die Sicherungen behalten das Konto bis zum Ablauf ihrer Aufbewahrung.

## Restrisiken (akzeptiert)

| Risiko                                                                 | Begründung                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Push-Anbieter (Google, Apple) sehen Token und Zeitpunkt der Mitteilung | Ohne Push wäre der Dienst für Eltern wenig nützlich; Inhalt und Namen gehen nicht hinaus                      |
| Jemand mit Zugriff auf den Server liest die Datenbank                  | Der Betrieb ist klein; Zugriff nur für zwei Personen mit Schlüssel; Hoster und Region sind noch zu prüfen     |
| Konten ohne zweiten Faktor in der App                                  | Nur die Verwaltung braucht ihn; die App enthält keine Verwaltungsfunktionen                                   |
| Der Audit-Eintrag nennt die ID eines gelöschten Kontos weiter          | Eine ID allein identifiziert niemanden; sie ist nötig, um die Spur zu halten                                  |
| Sicherungen enthalten gelöschte Konten bis zu rund vier Monate         | Sicherungen sind nur für den Ausfall da; nach einer Wiederherstellung sind gelöschte Konten erneut zu löschen |

## Offene Punkte

- Aufbewahrungsfrist für Termine und Anmeldungen festlegen (siehe Auswertung).
- Hoster, Standort und Auftragsverhältnis mit dem Hoster klären.
- Nach einer Wiederherstellung aus der Sicherung gelöschte Konten erneut löschen: Verfahren in `docs/betrieb.md` ergänzen (E9).
- Dieses Modell mitführen: bei jeder neuen Route, jedem neuen Datenfeld und jeder neuen Auswertung die Tabelle durchgehen.
