# Betrieb

Abläufe für den Betrieb von FireResponse; hier stehen Server, Konten, Deploy, Release, Release-Checkliste, Backups, Überwachung, Logs, der zweite Faktor und der Ablauf bei einer Datenpanne. Ausgerollt wird nur von `main`.

## Server

- Ein VPS. Die Domain ist `fireresponse.ch` (API unter `api.fireresponse.ch`); Anbieter und Region sind noch offen (#68). Im Gespräch ist Oracle Cloud «Always Free» (ARM, Ampere); ob die Region in der Schweiz liegt, ist ungeprüft, und die Home-Region lässt sich nach der Anmeldung nicht ändern.
- Das API-Image ist nur für arm64 gebaut (`image.yml` läuft auf `ubuntu-24.04-arm`). Die Images von postgres, caddy und restic gibt es auch für arm64. Auf einem amd64-Server startet das API-Image nicht.
- Auf dem Server laufen Linux mit systemd-journald, die Docker Engine mit dem Compose-Plugin und git.
- Der Dienst `api` hat in `deploy/docker-compose.prod.yml` höchstens 1 GB Arbeitsspeicher (`mem_limit`) und 256 Prozesse und Threads (`pids_limit`), damit viele gleichzeitige Bild-Uploads (bis 16 Mio. Pixel, beim Dekodieren rund 64 MB je Bild) nur die API treffen und nicht Postgres und Caddy; der Wert muss zum Server passen, und meldet `docker inspect` für den Container `OOMKilled`, ist er zu klein.
- Härtung (#68): SSH nur mit Schlüssel und nur für zwei Personen, Firewall, automatische Sicherheitsupdates. Nach der Einrichtung bestätigt ein Portscan von aussen, dass nur SSH, 80 und 443 offen sind.
- Das Repo liegt auf dem Server als Checkout des ausgerollten Tags. Befehle in dieser Doku laufen im Wurzelordner dieses Checkouts, jene im Abschnitt «Backups» im Ordner `deploy/`.
- Nur auf dem Server, nie im Repo: `deploy/.env` (Rechte 600, Vorlage `deploy/.env.example`) und der Schlüssel des Firebase-Dienstkontos unter `deploy/secrets/` (Ordner 700, Datei 400).

## Konten

Der Betrieb braucht diese Konten: Apple Developer Program, Google Play Console, das Google-Konto des Firebase-Projekts, Hoster, DNS, S3-Speicher, Uptime-Dienst und GitHub (Repo und GHCR). Hier stehen Rollen, keine Personen. Für jedes Konto gilt:

- Zwei-Faktor-Anmeldung.
- Wo der Dienst es erlaubt, hat eine zweite Person Zugriff.
- Die Wiederherstellungscodes liegen in einem Passwort-Tresor, den auch die Abteilungsleitung öffnen kann.

## Deploy

Erste Einrichtung auf dem Server:

1. Das Repo klonen und den Release-Tag auschecken: `git fetch --tags && git checkout vX.Y.Z`
2. `deploy/.env.example` nach `deploy/.env` kopieren und die Werte setzen (Passwörter hexadezimal, etwa aus `openssl rand -hex 32`; `BETTER_AUTH_SECRET` aus `openssl rand -base64 32`, `BETTER_AUTH_URL` ist die öffentliche Adresse der API mit `https://`; mit `http://` startet die API in Produktion nicht), dann `chmod 600 deploy/.env`. Die verantwortliche Stelle und ihre E-Mail-Adresse für die Seiten `/datenschutz`, `/konto-loeschen` und `/support` setzt man mit `VERANTWORTLICHE_STELLE` und `KONTAKT_EMAIL` in `deploy/.env` und in `docker-compose.prod.yml`; ohne Angabe nennen die Seiten weder Stelle noch Adresse.
3. Den Schlüssel des Firebase-Dienstkontos für die Pushes nach `deploy/secrets/fcm-service-account.json` legen: Ordner 700, Datei 400, Besitzer `1000:1000` (die UID der API im Container)
4. `deploy/Caddyfile.example` nach `deploy/Caddyfile` kopieren und die Domain eintragen (#68)
5. Nach dem ersten Tag das API-Image auf GHCR öffentlich schalten (#70), sonst findet der Server es nicht

Jedes Release rollt `deploy/deploy.sh vX.Y.Z` aus, nach `git fetch --tags && git checkout vX.Y.Z`. Das Skript aktualisiert die Images von postgres und caddy, sichert die Datenbank (siehe «Backups»), setzt die Passwörter der Datenbankrollen aus `deploy/.env`, führt die Migrationen mit der Besitzerrolle aus — nur vorwärts, nie zurück —, startet alle Dienste mit dem Tag neu und stoppt jeden Dienst ausser caddy, der einen Port veröffentlicht.

`deploy/Caddyfile` liegt nur auf dem Server und folgt der Vorlage nicht von selbst. Ändert sich `deploy/Caddyfile.example` in einem Release, die Änderung von Hand nach `deploy/Caddyfile` übernehmen (die Domain bleibt) und in `deploy/` Caddy neu starten: `docker compose -f docker-compose.prod.yml restart caddy`. Mit #220 kamen HSTS und die Sicherheits-Kopfzeilen dazu; ein Server, der vorher eingerichtet wurde, braucht diesen Schritt. Prüfen mit `curl -sI https://<Domain>/health`: Die Antwort zeigt `strict-transport-security`, aber keine Zeile `server`.

### Deploy aus GitHub

Statt von Hand rollt der Workflow «Deploy» ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) einen Tag aus, nachdem eine Person ihn in GitHub freigegeben hat (#252). Er prüft, dass der Tag `vX.Y.Z` heisst, auf `main` liegt und sein Image im GHCR existiert, und verbindet sich dann per SSH. Der Server führt für diesen Schlüssel nur [`deploy/ssh-deploy.sh`](../deploy/ssh-deploy.sh) aus: Es nimmt den Tag als einziges Argument, checkt ihn aus und startet `deploy/deploy.sh vX.Y.Z`. Der Ablauf auf dem Server bleibt derselbe wie von Hand.

Einrichtung, einmal:

1. Auf dem Server ein eigenes Schlüsselpaar nur für den Deploy erzeugen: `ssh-keygen -t ed25519 -N "" -C fireresponse-deploy -f fireresponse-deploy`. Den öffentlichen Teil in `~/.ssh/authorized_keys` des Deploy-Benutzers eintragen, in einer Zeile mit festem Befehl: `restrict,command="<Pfad des Checkouts>/deploy/ssh-deploy.sh" ssh-ed25519 AAAA… fireresponse-deploy`. `restrict` schaltet Terminal, Port- und Agent-Weiterleitung ab. Der private Teil kommt nur in das Secret und wird danach vom Server gelöscht.
2. Der Deploy-Benutzer muss `deploy/deploy.sh` ohne `sudo` ausführen können: Docker-Gruppe, Leserecht auf `deploy/secrets/` (siehe Schritt 3 oben) und ein Checkout, in dem er `git fetch` und `git checkout` ausführen darf.
3. In GitHub unter Settings → Environments die Umgebung `production` anlegen. «Required reviewers»: die Person, die freigibt; «Prevent self-review» ist nur sinnvoll, wenn eine zweite Person freigibt. «Deployment branches»: nur `main`, sonst könnte ein Branch den Workflow ändern.
4. In der Umgebung `production` vier Secrets setzen: `DEPLOY_HOST` (Name oder Adresse des Servers), `DEPLOY_USER`, `DEPLOY_SSH_KEY` (der private Schlüssel) und `DEPLOY_HOST_KEY` (eine Zeile für `known_hosts`, aus `ssh-keyscan -t ed25519 <Host>` auf dem Server selbst geholt, nicht aus dem Internet). Der Workflow verbindet sich nur mit diesem Hostschlüssel.
5. Die Firewall des Servers lässt SSH aus dem Internet zu, oder aus den Adressen der GitHub-Runner (die Liste steht unter `https://api.github.com/meta`, Feld `actions`, und ändert sich).

Ablauf: Der Workflow «Release» ruft «Deploy» nach dem Image selbst auf (#262); die Umgebung `production` wartet dann auf die Freigabe. Ohne den Haken «ausrollen» bleibt es beim Image. Einen vorhandenen Tag, etwa zum erneuten Ausrollen, rollt man unter Actions → Deploy → Run workflow aus: Tag eintragen und freigeben. Der Lauf zeigt die Ausgabe von `deploy.sh`; sie enthält keine Passwörter. Ein Schlüssel wird rotiert, indem man ein neues Paar erzeugt, die Zeile in `authorized_keys` ersetzt und das Secret setzt.

Das erste Admin-Konto legt die CLI im laufenden API-Container an, in `deploy/`: `docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/admin-anlegen.ts --benutzername <name> --name "<Vorname Nachname>" --neue-abteilung "<Name>"`. Sie zeigt das Startpasswort; es steht danach auch in der Personenliste, bis die Person es ersetzt hat. Immer `exec`, nie `run`: Die Ausgabe von `run` landet für 14 Tage im journald (siehe «Logs»), die von `exec` in keinem Log.

## Release

Ein Release der API ist ein Tag `vX.Y.Z` auf `main`; die Nummer steigt nur. Die iOS- und die Android-App liegen in eigenen Repos und haben dort ihren eigenen Release-Ablauf.

1. Release-PR von `develop` nach `main`, gemergt mit «Create a merge commit» ([GIT_WORKFLOW.md](GIT_WORKFLOW.md) sagt warum).
2. Der Merge nach `main` startet den Workflow «Release» von selbst mit Stufe `minor` und Ausrollen; von Hand geht es unter Actions → Release → Run workflow, Branch `main`, etwa für `major` oder eine Version. Er setzt den annotierten Tag auf den Commit, der den Lauf auslöst (beim Merge der Merge-Commit, von Hand der Kopf von `main`), baut das Image und rollt es nach der Freigabe der Umgebung `production` aus (Haken «ausrollen»). Die Stufe `minor` erhöht z (`v0.9.9` → `v0.9.10`), `major` erhöht y und setzt z auf 0 (`v0.9.9` → `v0.10.0`). x steigt nie von selbst: Nur das Feld «version» (z. B. `1.0.0`) erhöht es, und die Nummer muss grösser als der letzte Tag sein. Jede Stelle ist eine ganze Zahl ohne Obergrenze; die Rechnung steht in `deploy/naechste-version.sh`. Von Hand geht es weiter: `git fetch origin`, `git tag -a vX.Y.Z -m "Release X.Y.Z" origin/main`, `git push origin vX.Y.Z`.
3. Warten, bis der Workflow «Image» ([`.github/workflows/image.yml`](../.github/workflows/image.yml)) grün ist: Er prüft, dass der Tag `vX.Y.Z` heisst, baut das API-Image und legt es als `ghcr.io/sorry4nothing/fireresponse-api:vX.Y.Z` in GHCR ab. Ein falscher Tag baut kein Image.
4. Auf dem Server ausrollen: «Release» tut das nach dem Image, sobald die Umgebung `production` freigegeben ist (siehe «Deploy aus GitHub»); sonst Workflow «Deploy» von Hand starten, oder von Hand den Tag auschecken und `deploy/deploy.sh vX.Y.Z` ausführen (Backup, Migration, Neustart, Portprüfung).

Vor dem Store-Release einer App läuft die «Release-Checkliste» unten.

Ein Tag, dessen Lauf ein Image gebaut hat, wird nie verschoben, gelöscht oder neu vergeben. Hat der Lauf keines gebaut, weil die Tag-Prüfung oder der Build rot war: den Tag löschen (`git push origin --delete vX.Y.Z` und `git tag -d vX.Y.Z`), die Ursache per PR beheben und neu taggen.

`APP_MIN_VERSION` in `deploy/.env` auf dem Server steigt nur, um eine alte App auszusperren, und erst, wenn die neue Version in beiden Stores ist.

## Release-Checkliste

Sie läuft von Hand vor jedem Store-Release einer App: einmal auf Android und einmal auf einem iPhone, mit dem Release-Build aus dem Repo der jeweiligen App über TestFlight bzw. einen Testtrack der Play Console, nur in der Demo-Abteilung der Produktion (Screenshots nur von dort). Voraussetzung: Die Demo-Abteilung hat ein Demo-Kind in einer Stufe und ein Programm, das Eltern sehen (#76).

- [ ] Demo-Konten für das Review aktivieren (#76)
- [ ] Ein Admin der Demo-Abteilung meldet sich mit zweitem Faktor an und legt eine Person an: ein Elternteil eines Demo-Kindes, mit erfundenem Namen
- [ ] Mit der neuen Person: Login mit Startpasswort, Passwort setzen, App-Sperre
- [ ] Programm öffnen und Kind mit Ja/Nein melden
- [ ] Nach dem Review die Demo-Konten und die angelegten Personen wieder deaktivieren

Die Schritte vom Anmelden des Admins bis zur Anmeldung laufen auf jedem Gerät einmal, jedes Mal mit einer neu angelegten Person, denn das Startpasswort gilt nur für die erste Anmeldung. Aktivieren und Deaktivieren laufen einmal vor und einmal nach beiden Durchgängen.

## Backups

`deploy/backup.sh` sichert die Datenbank verschlüsselt mit [restic](https://restic.net) auf einen S3-Speicher in der Schweiz: täglich per Cron und vor jedem Deploy (`deploy.sh` ruft das Skript auf). restic behält 30 tägliche und 3 monatliche Stände; Älteres räumt das Skript bei jedem Lauf weg. Solange noch keine Migrationen gelaufen sind, beendet es sich ohne Backup.

### Nicht im Backup

- Sitzungen, offene Bestätigungscodes, die Schlüssel des Rate-Limits und Push-Tokens (Tabellen `session`, `verification`, `rate_limit`, `push_token`): Sitzungen enthalten Tokens, und Push-Tokens hängen an ihrer Sitzung. **Nach einer Wiederherstellung melden sich darum alle neu an.**
- Dateien auf dem Server: `deploy/.env` (Passwörter und restic-Schlüssel), `deploy/secrets/fcm-service-account.json` und die Zertifikate von Caddy. Caddy holt Zertifikate selbst neu; die Dateien ausser den Zertifikaten sind ohne eigene Kopie verloren.

Das Skript bricht ohne Backup ab, wenn eine andere Tabelle per Fremdschlüssel auf eine ausgeschlossene verweist, denn solche Zeilen machten die ganze Wiederherstellung ungültig. Dann die Ausschlussliste in `deploy/backup.sh` nachführen. Fehlt eine ausgeschlossene Tabelle dagegen noch (beim Deploy läuft das Backup vor der Migration, die sie anlegt), warnt das Skript nur und sichert ohne sie; die Prüfung meldet eine solche Tabelle im zurückgespielten Stand ebenfalls nur als Hinweis.

### Schlüssel

Das Archiv hat drei Schlüssel; jeder entschlüsselt alles:

| Wer               | Ablage                                          |
| ----------------- | ----------------------------------------------- |
| Server            | `RESTIC_PASSWORD` in `deploy/.env` (Rechte 600) |
| Betreuende Person | eigenes Passwort, selbst verwahrt               |
| Abteilungsleitung | versiegelt im Tresor der Abteilung              |

Wiederherstellen kann nur, wer zusätzlich Zugang zum S3-Speicher hat. Mit nur lesendem S3-Zugang braucht jeder restic-Befehl zusätzlich `--no-lock`.

Jeder Schlüssel kann das Archiv auch löschen. Der Schutz dagegen liegt beim Anbieter: Versionierung oder Object Lock für 30 Tage, eine Regel, die alte Versionen nach 30 Tagen entfernt, und ein Server-Zugangsschlüssel, der Versionen weder löschen noch den Schutz aufheben darf. Gelöschte Daten können so bis 30 Tage über die Aufbewahrung hinaus im Speicher liegen.

### Einrichtung

1. Beim Anbieter einen Bucket mit dem Schutz von oben anlegen.
2. In `deploy/.env` die restic-Werte aus `deploy/.env.example` füllen.
3. Archiv anlegen: `docker compose -f docker-compose.prod.yml run --rm backup init`
4. Die zwei weiteren Schlüssel anlegen; die Eingabe erfolgt an der Eingabeaufforderung und landet nie in Dateien oder im Verlauf:
   - `docker compose -f docker-compose.prod.yml run --rm backup key add --user betreuung`
   - `docker compose -f docker-compose.prod.yml run --rm backup key add --user abteilungsleitung`
5. Cron-Eintrag im Konto, das auch `deploy.sh` ausführt; 03:15 gibt es an beiden Tagen der Zeitumstellung genau einmal:
   `15 3 * * * <Pfad zum Repo>/deploy/backup.sh 2>&1 | logger -t fireresponse-backup`

### Prüfung einmal pro Quartal

Auf dem Server, nie auf einem persönlichen Rechner: `deploy/backup.sh pruefen` spielt den letzten Stand in einen Wegwerf-Container ohne Netz zurück, zählt die Zeilen je Tabelle neben dem Live-Stand (nur Zahlen) und öffnet psql für Stichproben. Danach löscht das Skript den Container samt Daten.

### Ernstfall: leere Datenbank

1. `docker compose -f docker-compose.prod.yml up -d --wait postgres`
2. Rollen anlegen: `docker compose -f docker-compose.prod.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d fireresponse < ../apps/api/src/db/rollen.sql`
3. Letzten Stand zurückspielen: `docker compose -f docker-compose.prod.yml run --rm -T backup dump --retry-lock 5m latest /fireresponse.dump | docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U postgres -d fireresponse --exit-on-error --single-transaction`
4. Release ausrollen: `./deploy.sh <Tag>`. Danach melden sich alle neu an.

Fehlt auch die alte `deploy/.env`: Das Passwort der betreuenden Person oder der Abteilungsleitung als `RESTIC_PASSWORD` in die neue `deploy/.env` eintragen, denn die Wiederherstellung läuft über `run -T` und kann kein Passwort versteckt abfragen. Danach einen neuen Server-Schlüssel anlegen (`key add`, Wert als `RESTIC_PASSWORD` in `deploy/.env`) und den verlorenen entfernen (`key list` zeigt die IDs, `key remove <ID>`). Die zweiten Faktoren lassen sich ohne die alte `.env` nicht mehr entschlüsseln; die Admins richten sie neu ein, nachdem die CLI sie zurückgesetzt hat (siehe «Zweiter Faktor»).

Bleibt nach einem Abbruch ein Lock im Archiv zurück: `docker compose -f docker-compose.prod.yml run --rm backup unlock`

## Überwachung

`/health` antwortet ohne Login mit `ok` (Status 200) oder `fehler` (Status 503). `fehler` heisst: Die Datenbank ist nicht erreichbar oder ihre Tabellen fehlen. Den Grund nennt nur das Log der API, nie die Antwort. Ist die Datenbank nicht erreichbar, dauert die Antwort rund 5 Sekunden.

Ein kostenloser Uptime-Dienst ruft `/health` auf; er sieht nur `ok` oder `fehler`. Anforderungen:

- Gratis-Plan; für das Konto gelten die Regeln aus «Konten».
- HTTPS-Check auf `https://<Domain>/health`, im kürzesten Intervall des Gratis-Plans. HEAD oder GET: Die API beantwortet HEAD wie GET, samt Status.
- Timeout über 5 Sekunden, damit der langsame 503 noch als Antwort zählt.
- Alarm bei jedem Status ausser 200 und wenn keine Antwort kommt.
- Alarm per E-Mail an die betreuende Person und, wo der Dienst es erlaubt, an eine zweite Person.

Kein Sentry in V1 (Datenschutz); später neu prüfen.

Bei Alarm:

1. Das API-Log der letzten Stunde lesen: `docker compose -f deploy/docker-compose.prod.yml logs --since 1h api`

## Logs

Alle Dienste aus `deploy/docker-compose.prod.yml` loggen über den journald-Treiber von Docker. journald löscht nach Alter statt nach Grösse: Server-Logs und Container-Logs, auch die von Caddy, bleiben so 14 Tage.

Lesen:

- `docker compose -f deploy/docker-compose.prod.yml logs <dienst>`
- `sudo journalctl CONTAINER_NAME=<Name>`; die Namen zeigt `docker compose -f deploy/docker-compose.prod.yml ps`. Für schon entfernte Container (etwa die Migration aus `docker compose run`) listet `sudo journalctl -F CONTAINER_NAME` alle Namen, die journald kennt.

Was in den Logs steht:

- API: eine JSON-Zeile pro Anfrage mit `requestId`, Routen-Muster und Status, ohne Namen, Inhalte oder IP-Adressen. Bei 401 und 403 einer angemeldeten Anfrage steht zusätzlich `nutzerId` darin, die ID des Kontos (siehe «Abgewiesene Anfragen prüfen»). Der Healthcheck des Containers ruft `/health` alle 30 Sekunden auf; erfolgreiche Aufrufe stehen weder im Log noch in den Zahlen der Übersicht, Fehler schon. Beim Start und danach alle 24 Stunden löscht die API abgelaufene Sitzungen samt ihren Push-Tokens und schreibt eine Zeile mit `"ereignis":"sitzungen"` und der Anzahl (`geloescht`), bei einem Fehler nur dessen Code. Das Löschen nach Alter begrenzt das Log.
- Caddy: IP-Adressen. Caddy schreibt auf stderr und damit nach journald; keine Log-Datei, kein Volume.
- PostgreSQL: Fehlerzeilen können Werte aus Abfragen zitieren, etwa `DETAIL: Key (…)=(…)` oder `STATEMENT: …`.

Die Ausgabe von `docker compose run` landet im Log des Dienstes und bleibt 14 Tage; die Ausgabe von `docker compose exec` landet in keinem Log.

Auf dem Server begrenzt ein Drop-in journald auf 14 Tage, als `/etc/systemd/journald.conf.d/60-fireresponse.conf`:

```ini
[Journal]
Storage=persistent
MaxRetentionSec=14day
MaxFileSec=1day
```

Danach `sudo systemctl restart systemd-journald`; prüfen mit `systemd-analyze cat-config systemd/journald.conf`. `MaxRetentionSec` löscht ganze Journal-Dateien; ohne `MaxFileSec=1day` wechselten die Dateien nur monatlich, und Einträge blieben Wochen über die 14 Tage hinaus. `Storage=persistent` legt die Logs auf die Platte; der Standardwert ist beim Kompilieren festgelegt, und `auto` hielte sie ohne `/var/log/journal` nur im RAM.

Andere Log-Dateien auf dem Server, etwa die eines Syslog-Dienstes mit den IP-Adressen von SSH-Clients: ebenfalls höchstens 14 Tage aufbewahren oder den Schreiber abschalten. Die Befehle dazu hängen vom System ab (#68).

### Abgewiesene Anfragen prüfen

Einen Alarm für gehäufte 401 (nicht angemeldet, Anmeldung fehlgeschlagen) und 403 (keine Berechtigung) gibt es nicht; geprüft wird von Hand im Log der API, in `deploy/`:

1. Nach Route zählen, hier für die letzten 24 Stunden: `docker compose -f docker-compose.prod.yml logs --since 24h --no-log-prefix api | grep -oE '"route":"[^"]*","status":40[13]' | sort | uniq -c | sort -rn`
2. Nach Konto zählen: `docker compose -f docker-compose.prod.yml logs --since 24h --no-log-prefix api | grep -oE '"nutzerId":"[^"]*"' | sort | uniq -c | sort -rn`. `nutzerId` steht nur bei 401 und 403 und nur, wenn die Anfrage eine gültige Sitzung hatte.

Worauf achten:

- Viele 401 auf `/api/auth/sign-in/username`: Jemand rät Passwörter. Wartezeit und Rate-Limit bremsen; die IP-Adressen dazu stehen nur im Log von Caddy.
- Viele 403 bei derselben `nutzerId`: Ein Konto versucht, was es nicht darf. Die ID ist die Spalte `id` der Tabelle `user`. Deutet es auf ein gekapertes Konto, gilt «Datenpanne».
- 403 ohne `nutzerId` auf einer ändernden Route unter `/api/v1`: Die Anfrage kam mit einem fremden `Origin`, etwa von einer anderen Webseite im Browser einer angemeldeten Person.

## Zweiter Faktor

Admins melden sich zusätzlich mit einem Code aus einer Authenticator-App oder einem Passwort-Manager an (TOTP, zehn Ersatzcodes, kein «Gerät vertrauen»). Ohne zweiten Faktor ist die Verwaltung gesperrt (`/api/v1/admin/*`); einrichten lässt er sich im Profil. Es handeln Rollen, keine bestimmten Personen.

- **Neues Gerät, das alte ist gelöscht:** Ein anderer Admin setzt den zweiten Faktor in der Verwaltung zurück («Zweiten Faktor zurücksetzen» auf der Seite der Person). Die Person meldet sich danach ohne Code an und richtet ihn neu ein.
- **Gerät verloren:** Derselbe Admin setzt zuerst ein «Neues Startpasswort» (das beendet jede Sitzung der Person; im Passwort-Manager des verlorenen Geräts kann das alte Passwort stehen) und setzt erst dann den zweiten Faktor zurück. Nie zurücksetzen, solange ein altes Passwort noch gilt, sonst richtet die fremde Person den neuen Faktor selbst ein (siehe «Datenpanne»).
- **Kein Admin besteht den zweiten Faktor mehr:** Wer den Server betreibt, setzt ihn mit der CLI zurück, in `deploy/`: `docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/zweiter-faktor-zuruecksetzen.ts --benutzername <name>`; immer `exec`, nie `run`. Lokal: `npm run zweiter-faktor:zuruecksetzen -w apps/api -- --benutzername <name>`. Die CLI braucht nur `DATABASE_URL` und läuft ohne Anmeldung, auch nach einem Wechsel des Auth-Geheimnisses.
- **Das Auth-Geheimnis ändert sich:** better-auth verschlüsselt die TOTP-Geheimnisse und die Ersatzcodes mit `BETTER_AUTH_SECRET`. Nach einem Wechsel lassen sie sich nicht mehr entschlüsseln: Wer den Server betreibt, setzt den Faktor jedes Admins mit der CLI zurück, danach meldet sich jeder an und richtet ihn neu ein.

Jede Zurücksetzung schreibt eine Zeile ins Audit-Log; bei der CLI steht «cli» als Akteur.

## Datenpanne

Der Ablauf gilt, sobald Daten in falsche Hände geraten sein könnten, etwa durch ein gekapertes Konto, ein geleaktes Geheimnis oder eine kopierte Datenbank. Es handeln Rollen, keine bestimmten Personen: Wer den Server betreibt, führt die Befehle aus; der Vorstand entscheidet und meldet.

1. **Alle Sitzungen beenden:** `npm run sitzungen:beenden -w apps/api`. Der Befehl liest `DATABASE_URL` aus der Umgebung oder aus `apps/api/.env` und meldet «Beendete Sitzungen: n». Alle müssen sich neu anmelden; Konten, Passwörter und zweite Faktoren bleiben.
2. **Den Vorstand informieren.** Bedeutet die Panne wahrscheinlich ein hohes Risiko für die betroffenen Personen, geht so rasch als möglich eine Meldung an den EDÖB über <https://databreach.edoeb.admin.ch/report> (Art. 24 Abs. 1 DSG), ohne auf die Schritte 3 und 4 zu warten; noch fehlende Angaben folgen so rasch als möglich (Art. 15 Abs. 2 DSV).
3. **Geheimnisse wechseln,** jedes einzeln:
   - Auth-Geheimnis: in `BETTER_AUTH_SECRET` einen neuen Zufallswert setzen und die API neu starten. Alte Cookies gelten dann nicht mehr, und die gespeicherten TOTP-Geheimnisse und Ersatzcodes lassen sich nicht mehr entschlüsseln: Kein Admin besteht den zweiten Faktor, bis er neu eingerichtet ist (Schritt 4). Den alten Wert vollständig entfernen, auch nicht als ältere Version in `BETTER_AUTH_SECRETS` behalten: Wer ihn kennt, könnte damit weiterhin Codes berechnen.
   - Passwörter der Datenbankrollen (#69).
   - Schlüssel des Firebase-Dienstkontos für FCM (#154): einen neuen Schlüssel erzeugen, ihn nach `deploy/secrets/fcm-service-account.json` legen, die API neu starten und erst dann den alten Schlüssel löschen.
   - restic- und S3-Schlüssel (#71).
4. **Gekapertes Konto sperren, dann zweite Faktoren neu einrichten.** Nach Schritt 3 besteht kein Admin den zweiten Faktor. Die CLI (`docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/zweiter-faktor-zuruecksetzen.ts --benutzername <name>`, in `deploy/`) setzt den Faktor genau eines vertrauenswürdigen Admins zurück; diese Person meldet sich an und richtet ihren Faktor neu ein. Dann deaktiviert sie das gekaperte Konto oder gibt ihm ein neues Startpasswort (#18); nie den Faktor eines Kontos zurücksetzen, solange sein altes Passwort noch gilt, sonst richtet die fremde Person den neuen Faktor selbst ein. Danach setzt sie die Faktoren der übrigen Admins zurück (#23), und diese richten ihre neu ein. Bleibt kein vertrauenswürdiger Admin übrig, legt die CLI (#20) einen neuen an, in `deploy/`: `docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/admin-anlegen.ts --benutzername <name> --name "<Vorname Nachname>" --abteilung "<Name>"`; immer `exec`, nie `run`, sonst steht das Startpasswort 14 Tage im journald (siehe «Logs»).
5. **Dokumentieren:** die Tatsachen rund um die Panne, ihre Auswirkungen und die getroffenen Massnahmen (Art. 15 Abs. 4 DSV), dazu ob gemeldet wurde und warum. Die Dokumentation bleibt mindestens zwei Jahre erhalten, nie im Repo, in Issues oder in PRs.
