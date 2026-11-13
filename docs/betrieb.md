# Betrieb

Abläufe für den Betrieb von FireResponse; hier stehen Server, Konten, Edge-Caddy, DNS, Deploy, Release, Release-Checkliste, Backups, Überwachung, Logs, der zweite Faktor und der Ablauf bei einer Datenpanne. Ausgerollt wird nur von `main`.

## Server

- Ein Server, den sich FireResponse mit einem weiteren, unabhängigen Compose-Stack teilt. Vorgesehen ist Oracle Cloud «Always Free» (ARM, Ampere); die Home-Region lässt sich nach der Anmeldung nicht ändern, und ob sie in der Schweiz liegt, ist zu prüfen, bevor der Server Daten hält (Unterauftragsbearbeiter, siehe Datenschutzerklärung).
- Die Domain ist `fireresponse.ch`, die API liegt unter `api.fireresponse.ch` (siehe «DNS»).
- Das API-Image ist nur für arm64 gebaut (`image.yml` läuft auf `ubuntu-24.04-arm`). Die Images von postgres, caddy und restic gibt es auch für arm64. Auf einem amd64-Server startet das API-Image nicht.
- Auf dem Server laufen Linux mit systemd-journald, die Docker Engine mit dem Compose-Plugin und git.
- Der Dienst `api` hat in `deploy/docker-compose.prod.yml` höchstens 1 GB Arbeitsspeicher (`mem_limit`) und 256 Prozesse und Threads (`pids_limit`), damit viele gleichzeitige Bild-Uploads (bis 16 Mio. Pixel, beim Dekodieren rund 64 MB je Bild) nur die API treffen und nicht Postgres und Caddy; der Wert muss zum Server passen, und meldet `docker inspect` für den Container `OOMKilled`, ist er zu klein.
- Härtung: SSH nur mit Schlüssel und nur für zwei Personen, Firewall, automatische Sicherheitsupdates. Nach der Einrichtung bestätigt ein Portscan von aussen, dass nur SSH, 80 und 443 offen sind. Bei Oracle müssen 80 und 443 zusätzlich in der Security List oder Network Security Group des Subnetzes offen sein. Docker öffnet veröffentlichte Ports an der Host-Firewall vorbei; darum veröffentlicht nur der Edge-Caddy Ports.
- Das Repo liegt auf dem Server als Checkout des ausgerollten Tags. Befehle in dieser Doku laufen im Wurzelordner dieses Checkouts, jene im Abschnitt «Backups» im Ordner `deploy/`.
- Nur auf dem Server, nie im Repo: `deploy/.env` (Rechte 600, Vorlage `deploy/.env.example`) und der Schlüssel des Firebase-Dienstkontos unter `deploy/secrets/` (Ordner 700, Datei 400).

### Platz auf dem Server

Beide Stacks müssen auf den Server passen; das ist nicht geprüft. Vor dem ersten Ausrollen und nach den ersten Wochen im Betrieb:

1. `nproc`, `free -h` und `df -h /var/lib/docker` zeigen, was der Server hat; `docker stats --no-stream` zeigt, was die Container brauchen.
2. Die Summe aller `mem_limit` und des Postgres-Bedarfs beider Stacks bleibt unter etwa 70 Prozent des Arbeitsspeichers, den Rest brauchen das Betriebssystem und der Cache. FireResponse rechnet mit höchstens 1 GB für die API, rund 0,5 GB für Postgres und wenigen Dutzend MB für den Edge-Caddy.
3. Passt es nicht, wird zuerst `mem_limit` der API gesenkt, nicht der Postgres begrenzt: Ein von OOM beendeter Postgres ist teurer als eine beendete API.

## Konten

Der Betrieb braucht diese Konten: Apple Developer Program, Google Play Console, das Google-Konto des Firebase-Projekts, Hoster, DNS und Domain, S3-Speicher, Uptime-Dienst und GitHub (Repo und GHCR). Hier stehen Rollen, keine Personen. Für jedes Konto gilt:

- Zwei-Faktor-Anmeldung.
- Wo der Dienst es erlaubt, hat eine zweite Person Zugriff.
- Die Wiederherstellungscodes liegen in einem Passwort-Tresor, den auch die Stellvertretung im Betrieb (die zweite Person) öffnen kann.

## Edge-Caddy

Die Ports 80 und 443 kann nur ein Prozess belegen, der Server hat aber zwei Stacks mit je einer Domain. Darum belegt sie ein eigener, kleiner Stack, der Edge-Caddy; die App-Stacks veröffentlichen keine Ports mehr.

Entscheid und verworfene Alternativen:

- **Eigener Edge-Stack (gewählt).** Der Edge-Caddy hängt an einem Docker-Netz je App-Stack (`edge-fireresponse`, für jeden weiteren Stack `edge-<name>`), die Stacks erreichen sich so untereinander nicht. Jeder Stack legt eine Seite als Datei im Ordner `sites/` des Edge-Caddys ab. Ein Deploy eines Stacks berührt die Domains der anderen nicht, und keine Konfiguration nennt eine fremde Domain.
- Der Caddy eines der beiden Stacks bedient beide: verworfen, denn jedes Deploy dieses Stacks unterbräche die Domain des anderen, und sein Caddyfile enthielte fremde Domains.
- Verschiedene Ports: nicht möglich, denn Browser und Zertifikatsprüfung (ACME) brauchen 80 und 443.

Die Dateien liegen als Vorlage in [`deploy/edge/`](../deploy/edge/): `docker-compose.yml`, `Caddyfile` (importiert nur `sites/*.caddy`) und `fireresponse.caddy` (die Seite der API). Der Alias `fireresponse-api` im Netz `edge-fireresponse` (`deploy/docker-compose.prod.yml`) ist eindeutig, weil der Edge-Caddy an mehreren Netzen hängt und der Dienstname `api` sonst bei mehreren Stacks gleich hiesse.

**Drosselung.** Die API zählt Anfragen je Absender-Adresse (erster Eintrag von `X-Forwarded-For`, den der Edge-Caddy setzt): 600 je Minute über `/api/v1/*` und `/admin/*`, 30 je Minute für die öffentlichen Seiten und `GET /api/v1/datenschutz`, danach 429 `ZU_VIELE_ANFRAGEN`. Die Zähler liegen im Speicher der einen Instanz und sind nach einem Neustart leer; bei mehr als einer Instanz müssten sie in die Datenbank. Das Limit der Anmeldung (`/api/auth`) und diese Drosselung vertrauen dem Header: Die Adresse ist nur echt, wenn die API ausschliesslich über den Edge-Caddy erreichbar ist. Darum veröffentlicht `deploy/docker-compose.prod.yml` keinen Port (ein Test prüft das) und `deploy.sh` stoppt jeden Dienst, der einen veröffentlicht. Der Edge-Caddy selbst begrenzt nicht (das Standard-Image hat kein Rate-Limit-Modul).

Einrichtung, einmal, in einem eigenen Ordner ausserhalb des Checkouts, denn der Checkout wechselt mit jedem Release den Stand:

1. `mkdir -p <Edge-Ordner>/sites`, dorthin `deploy/edge/docker-compose.yml` und `deploy/edge/Caddyfile` kopieren, nach `<Edge-Ordner>/sites/` die Datei `deploy/edge/fireresponse.caddy`. Die Seiten weiterer Stacks kommen als weitere `*.caddy`-Dateien dazu, ihre Netze `edge-<name>` in `docker-compose.yml` unter `networks` und im Dienst `caddy`.
2. Solange noch ein anderer Caddy die Ports 80 und 443 belegt, ist Schritt 3 der Umzug (siehe unten). Sonst: im Edge-Ordner `docker compose up -d`.
3. Prüfen: `docker compose ps` zeigt `caddy` als `Up`, `docker network ls` das Netz `edge-fireresponse`.

Eine Seite ändern oder hinzufügen, ohne Unterbruch: Datei nach `<Edge-Ordner>/sites/` kopieren, dann im Edge-Ordner `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile` und `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`. Ist die neue Datei fehlerhaft, melden beide Befehle den Fehler und der Caddy läuft mit der alten Konfiguration weiter. Ändert sich `deploy/edge/fireresponse.caddy` in einem Release, gilt das auch hier: Die Änderung von Hand übernehmen. Prüfen mit `curl -sI https://api.fireresponse.ch/health`: Die Antwort zeigt `strict-transport-security`, aber keine Zeile `server`.

Umzug von einem Caddy, der heute die Ports belegt: Die Domain des anderen Stacks ist dabei für einige Minuten nicht erreichbar, am besten in einer ruhigen Stunde.

1. Den Edge-Ordner wie oben anlegen, mit der Seiten-Datei des anderen Stacks in `sites/` und dessen Netz `edge-<name>` in `docker-compose.yml`. Vorher `docker compose config` im Edge-Ordner.
2. Den anderen Stack so ändern, dass sein API-Dienst am externen Netz `edge-<name>` hängt (mit eindeutigem Alias), sein eigener Caddy entfällt und er keine Ports veröffentlicht; seine Deploy-Prüfung «nur caddy darf Ports veröffentlichen» wird zu «kein Dienst darf Ports veröffentlichen». Das ist eine Änderung im Repo dieses Stacks.
3. Den alten Caddy stoppen (`docker compose stop caddy` im anderen Stack), im Edge-Ordner `docker compose up -d` und den anderen Stack mit der geänderten Compose-Datei neu starten. Der Edge-Caddy holt die Zertifikate neu bei Let's Encrypt; die Abfragen sind im Gratis-Rahmen.
4. Prüfen: beide Domains über HTTPS, `docker compose ps` in beiden Stacks, Portscan von aussen.

Bis dieser Umzug gemacht ist, kann der Stack `fireresponse` nicht online gehen, weil die Ports 80 und 443 belegt sind.

## DNS

Die Zone von `fireresponse.ch` liegt beim DNS-Anbieter der Domain (Rolle «DNS und Domain» in «Konten»). Nötig sind:

| Name                  | Typ | Wert                                 |
| --------------------- | --- | ------------------------------------ |
| `api.fireresponse.ch` | A   | öffentliche IPv4-Adresse des Servers |

Kein AAAA-Eintrag, solange nicht geprüft ist, dass Docker über IPv6 die echte Adresse des Absenders weitergibt: Sonst zählte das Rate-Limit der Anmeldung alle IPv6-Clients als eine Adresse.

Einrichtung und Prüfung:

1. Einige Stunden vor dem Umzug die TTL des Eintrags auf 300 Sekunden senken, damit ein Fehler schnell korrigiert ist.
2. Eintrag setzen. Prüfen: `dig +short api.fireresponse.ch` liefert die Adresse des Servers.
3. Erst wenn der Eintrag stimmt, den Edge-Caddy starten oder neu laden: Caddy holt das Zertifikat selbst per HTTP-Abfrage auf Port 80 und scheitert, solange der Name noch woandershin zeigt.
4. Prüfen: `curl -sI https://api.fireresponse.ch/health` antwortet mit Status 200 und `strict-transport-security`.

Beim Anbieter: Zwei-Faktor-Anmeldung, automatische Verlängerung der Domain und eine Erinnerung an die zweite Person, DNSSEC einschalten, wo der Anbieter es kann. Läuft die Domain ab, steht die API still und die Apps erreichen den Server nicht mehr.

## Deploy

Erste Einrichtung auf dem Server:

1. Das Repo klonen und den Release-Tag auschecken: `git fetch --tags && git checkout vX.Y.Z`
2. `deploy/.env.example` nach `deploy/.env` kopieren und die Werte setzen (Passwörter hexadezimal, etwa aus `openssl rand -hex 32`; `BETTER_AUTH_SECRET` aus `openssl rand -base64 32`, `BETTER_AUTH_URL` ist die öffentliche Adresse der API mit `https://`; mit `http://` startet die API in Produktion nicht), dann `chmod 600 deploy/.env`. Die verantwortliche Stelle und ihre E-Mail-Adresse für die Seiten `/datenschutz`, `/konto-loeschen` und `/support` stehen in `VERANTWORTLICHE_STELLE` und `KONTAKT_EMAIL`; beide sind Pflicht, `docker-compose.prod.yml` startet ohne sie nicht.
3. Den Schlüssel des Firebase-Dienstkontos für die Pushes nach `deploy/secrets/fcm-service-account.json` legen: Ordner 700, Datei 400, Besitzer `1000:1000` (die UID der API im Container)
4. Den Edge-Caddy einrichten (siehe «Edge-Caddy»); `deploy.sh` bricht ab, solange das Netz `edge-fireresponse` fehlt.
5. Nach dem ersten Tag das API-Image auf GHCR öffentlich schalten (Package Settings → Change visibility), sonst findet der Server es nicht und der Workflow «Deploy» kann es nicht prüfen. Im Image steckt kein Geheimnis.

Jedes Release rollt `deploy/deploy.sh vX.Y.Z` aus, nach `git fetch --tags && git checkout vX.Y.Z`. Das Skript prüft, dass das Netz des Edge-Caddys da ist, aktualisiert das Image von postgres, sichert die Datenbank (siehe «Backups»), setzt die Passwörter der Datenbankrollen aus `deploy/.env`, führt die Migrationen mit der Besitzerrolle aus — nur vorwärts, nie zurück —, startet alle Dienste mit dem Tag neu und stoppt jeden Dienst, der einen Port veröffentlicht.

Das Image des Edge-Caddys und seine Seiten-Dateien gehören nicht zu diesem Skript (siehe «Edge-Caddy»).

### Firebase-Projekt für die Pushes

Die Pushes laufen über ein eigenes Firebase-Projekt, das nur FireResponse nutzt. Einmal einrichten:

1. In der Firebase-Konsole ein Projekt anlegen und Cloud Messaging aktivieren. Für iOS den APNs-Authentifizierungsschlüssel (`.p8`) des Apple Developer Programs hochladen. Die Apps registrieren je ihre Bundle-ID bzw. Paketnamen im Projekt; die Konfigurationsdateien (`google-services.json`, `GoogleService-Info.plist`) gehören zu den Apps, nicht in dieses Repo.
2. Unter «Projekteinstellungen», «Dienstkonten» einen neuen privaten Schlüssel für das Firebase-Admin-SDK erzeugen. Die JSON-Datei liegt nur auf dem Server unter `deploy/secrets/fcm-service-account.json` (Ordner 700, Datei 400, Besitzer `1000:1000`), nie im Repo, nie im Chat, nie in einer E-Mail. Geht die Datei verloren, erzeugt man in der Konsole einen neuen Schlüssel.
3. `docker-compose.prod.yml` setzt `FCM_SCHLUESSEL_DATEI` auf den Pfad im Container. Nach dem Ablegen der Datei die API neu starten; im Log steht beim Start nicht mehr `ohne-schluessel`.
4. Die Apps legen die Android-Kanäle `termine` und `anmeldungen` an. Die Kanal-IDs stehen in der Android-Konfiguration des Pushes (`android.notification.channelId`).
5. Test: Mit dem Konto des Kommandos auf einem Gerät anmelden (das Gerät registriert sein Push-Token), dann mit einem Elternkonto der Einheit ein künftiges Programm im Anmeldefenster beantworten. Das Gerät des Kommandos zeigt «Neue Anmeldung» mit Titel und Tag des Programms als Text.

Push-Texte tragen nie Namen und nie den Titel eines Termins (ausser den freien Mitteilungen aus dem Panel-Bereich «Push senden», vor denen das Formular warnt): Sie stehen je nach Handy auf dem gesperrten Bildschirm und laufen über Apple und Google. Schlüssel tauschen: siehe «Datenpanne».

### Deploy aus GitHub

Statt von Hand rollt der Workflow «Deploy» ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) einen Tag aus, nachdem eine Person ihn in GitHub freigegeben hat. Er prüft, dass der Tag `vX.Y.Z` heisst, auf `main` liegt und sein Image im GHCR existiert, und verbindet sich dann per SSH. Der Server führt für diesen Schlüssel nur [`deploy/ssh-deploy.sh`](../deploy/ssh-deploy.sh) aus: Es nimmt den Tag als einziges Argument, checkt ihn aus und startet `deploy/deploy.sh vX.Y.Z`. Der Ablauf auf dem Server bleibt derselbe wie von Hand.

Einrichtung, einmal:

1. Auf dem Server ein eigenes Schlüsselpaar nur für den Deploy erzeugen: `ssh-keygen -t ed25519 -N "" -C fireresponse-deploy -f fireresponse-deploy`. Den öffentlichen Teil in `~/.ssh/authorized_keys` des Deploy-Benutzers eintragen, in einer Zeile mit festem Befehl: `restrict,command="<Pfad des Checkouts>/deploy/ssh-deploy.sh" ssh-ed25519 AAAA… fireresponse-deploy`. `restrict` schaltet Terminal, Port- und Agent-Weiterleitung ab. Der private Teil kommt nur in das Secret und wird danach vom Server gelöscht.
2. Der Deploy-Benutzer muss `deploy/deploy.sh` ohne `sudo` ausführen können: Docker-Gruppe, Leserecht auf `deploy/secrets/` (siehe Schritt 3 oben) und ein Checkout, in dem er `git fetch` und `git checkout` ausführen darf.
3. In GitHub unter Settings → Environments die eigene Umgebung `production` dieses Repos anlegen (Umgebungen und Secrets gelten je Repo, sie teilen sich nicht mit anderen Repos). «Required reviewers»: die Person, die freigibt; «Prevent self-review» ist nur sinnvoll, wenn eine zweite Person freigibt. «Deployment branches»: «Selected branches» mit der Regel `main`, sonst könnte ein Branch den Workflow ändern.
4. In der Umgebung `production` vier Secrets setzen: `DEPLOY_HOST` (Name oder Adresse des Servers), `DEPLOY_USER`, `DEPLOY_SSH_KEY` (der private Schlüssel) und `DEPLOY_HOST_KEY` (eine Zeile für `known_hosts`, aus `ssh-keyscan -t ed25519 <Host>` auf dem Server selbst geholt, nicht aus dem Internet). Der Workflow verbindet sich nur mit diesem Hostschlüssel.
5. Die Firewall des Servers lässt SSH aus dem Internet zu, oder aus den Adressen der GitHub-Runner (die Liste steht unter `https://api.github.com/meta`, Feld `actions`, und ändert sich).

Ablauf: Der Workflow «Release» ruft «Deploy» nach dem Image selbst auf; die Umgebung `production` wartet dann auf die Freigabe. Fehlen die Secrets oder ist der Server noch nicht eingerichtet, schlägt dieser Lauf fehl und lässt sich ablehnen oder später wiederholen; der Tag und das Image bleiben bestehen. Ohne den Haken «ausrollen» bleibt es beim Image. Einen vorhandenen Tag, etwa zum erneuten Ausrollen, rollt man unter Actions → Deploy → Run workflow aus: Tag eintragen und freigeben. Der Lauf zeigt die Ausgabe von `deploy.sh`; sie enthält keine Passwörter. Ein Schlüssel wird rotiert, indem man ein neues Paar erzeugt, die Zeile in `authorized_keys` ersetzt und das Secret setzt.

Das erste Konto des Kantonsadmins legt die CLI im laufenden API-Container an, in `deploy/`: `docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/kantonsadmin-anlegen.ts --benutzername <name> --name "<Vorname Nachname>"`. Sie zeigt das Startpasswort. Immer `exec`, nie `run`: Die Ausgabe von `run` landet für 14 Tage im journald (siehe «Logs»), die von `exec` in keinem Log.

Erste Einrichtung nach dem ersten Konto: Der Kantonsadmin meldet sich mit dem Startpasswort an, wechselt es und richtet den zweiten Faktor ein (`POST /api/auth/two-factor/enable`, danach `verify-totp` mit dem ersten Code); ohne ihn sind alle Routen unter `/api/v1/admin` zu. Dann legt er Bezirke und Einheiten mit Kommandant/in an (`POST /api/v1/admin/bezirke`, `POST /api/v1/admin/einheiten`) und gibt dem Kommando das Startpasswort aus der Antwort weiter. Das Kommando wechselt es, richtet ebenfalls den zweiten Faktor ein und legt Stellvertretungen, Leitende, Teilnehmende und Eltern an. Der Ablauf ist in `apps/api/test/einrichtung.test.ts` durchgespielt; Startpasswörter stehen nur in den Antworten der Anlage und nirgends im Log.

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

Sie läuft von Hand vor jedem Store-Release einer App: einmal auf Android und einmal auf einem iPhone, mit dem Release-Build aus dem Repo der jeweiligen App über TestFlight bzw. einen Testtrack der Play Console, nur im Demo-Bezirk der Produktion (Screenshots nur von dort). Voraussetzung: Der Demo-Bezirk hat eine Demo-Einheit mit Kommando, erfundene Teilnehmende und eine Übung (Termin), die Eltern sehen.

- [ ] Demo-Konten für das Review aktivieren
- [ ] Das Kommando der Demo-Einheit meldet sich mit zweitem Faktor an und legt eine Person an: ein Elternteil eines erfundenen Teilnehmenden, mit erfundenem Namen
- [ ] Mit der neuen Person: Login mit Startpasswort, Passwort setzen, Einwilligung beim ersten Start, App-Sperre
- [ ] Übung öffnen und Teilnehmende mit Ja/Nein melden
- [ ] Nach dem Review die Demo-Konten und die angelegten Personen wieder deaktivieren

Die Schritte vom Anmelden des Kommandos bis zur Anmeldung laufen auf jedem Gerät einmal, jedes Mal mit einer neu angelegten Person, denn das Startpasswort gilt nur für die erste Anmeldung. Aktivieren und Deaktivieren laufen einmal vor und einmal nach beiden Durchgängen.

## Backups

`deploy/backup.sh` sichert die Datenbank verschlüsselt mit [restic](https://restic.net) auf einen S3-Speicher in der Schweiz: täglich per Cron und vor jedem Deploy (`deploy.sh` ruft das Skript auf). restic behält 30 tägliche und 3 monatliche Stände; Älteres räumt das Skript bei jedem Lauf weg. Solange noch keine Migrationen gelaufen sind, beendet es sich ohne Backup.

### Nicht im Backup

- Sitzungen, offene Bestätigungscodes, die Schlüssel des Rate-Limits und Push-Tokens (Tabellen `session`, `verification`, `rate_limit`, `push_token`): Sitzungen enthalten Tokens, und Push-Tokens hängen an ihrer Sitzung. **Nach einer Wiederherstellung melden sich darum alle neu an.**
- Dateien auf dem Server: `deploy/.env` (Passwörter und restic-Schlüssel), `deploy/secrets/fcm-service-account.json` und die Zertifikate des Edge-Caddys. Der Edge-Caddy holt Zertifikate selbst neu; die Dateien ausser den Zertifikaten sind ohne eigene Kopie verloren. Die Dateien des Edge-Ordners (`docker-compose.yml`, `Caddyfile`, `sites/`) stehen im Repo.

Gelöschte Mitteilungen des Infokanals (Tabelle `infokanal_mitteilung`) tragen ihren Text nur bis zur Löschung; ein älteres Backup enthält ihn noch. **Nach einer Wiederherstellung sind sie darum erneut zu löschen** (wie gelöschte Konten): `update infokanal_mitteilung set text = null, autor_id = null, geloescht_am = now()` für die Zeilen, die der Verantwortliche meldet, oder die Mitteilungen der betroffenen Einheit ganz entfernen.

Das Skript bricht ohne Backup ab, wenn eine andere Tabelle per Fremdschlüssel auf eine ausgeschlossene verweist, denn solche Zeilen machten die ganze Wiederherstellung ungültig. Dann die Ausschlussliste in `deploy/backup.sh` nachführen. Fehlt eine ausgeschlossene Tabelle dagegen noch (beim Deploy läuft das Backup vor der Migration, die sie anlegt), warnt das Skript nur und sichert ohne sie; die Prüfung meldet eine solche Tabelle im zurückgespielten Stand ebenfalls nur als Hinweis.

### Schlüssel

Das Archiv hat drei Schlüssel; jeder entschlüsselt alles:

| Wer                        | Ablage                                           |
| -------------------------- | ------------------------------------------------ |
| Server                     | `RESTIC_PASSWORD` in `deploy/.env` (Rechte 600)  |
| Betreuende Person          | eigenes Passwort, selbst verwahrt                |
| Stellvertretung im Betrieb | versiegelt im Passwort-Tresor der zweiten Person |

Das Archiv, der Bucket (oder Präfix) und die Schlüssel gehören nur FireResponse: Kein anderer Stack auf dem Server nutzt dasselbe Archiv, dieselben Passwörter oder denselben S3-Zugang. So reicht der Verlust eines Schlüssels nie für beide Stacks.

Wiederherstellen kann nur, wer zusätzlich Zugang zum S3-Speicher hat. Mit nur lesendem S3-Zugang braucht jeder restic-Befehl zusätzlich `--no-lock`.

Jeder Schlüssel kann das Archiv auch löschen. Der Schutz dagegen liegt beim Anbieter: Versionierung oder Object Lock für 30 Tage, eine Regel, die alte Versionen nach 30 Tagen entfernt, und ein Server-Zugangsschlüssel, der Versionen weder löschen noch den Schutz aufheben darf. Gelöschte Daten können so bis 30 Tage über die Aufbewahrung hinaus im Speicher liegen.

### Einrichtung

1. Beim Anbieter einen eigenen Bucket mit dem Schutz von oben anlegen, mit eigenem Zugangsschlüssel nur für diesen Bucket.
2. In `deploy/.env` die restic-Werte aus `deploy/.env.example` füllen, mit einem frischen `RESTIC_PASSWORD` (etwa `openssl rand -hex 32`).
3. Archiv anlegen: `docker compose -f docker-compose.prod.yml run --rm backup init`
4. Die zwei weiteren Schlüssel anlegen; die Eingabe erfolgt an der Eingabeaufforderung und landet nie in Dateien oder im Verlauf:
   - `docker compose -f docker-compose.prod.yml run --rm backup key add --user betreuung`
   - `docker compose -f docker-compose.prod.yml run --rm backup key add --user stellvertretung`
5. Cron-Eintrag im Konto, das auch `deploy.sh` ausführt; 03:15 gibt es an beiden Tagen der Zeitumstellung genau einmal:
   `15 3 * * * <Pfad zum Repo>/deploy/backup.sh 2>&1 | logger -t fireresponse-backup`

### Prüfung einmal pro Quartal

Der Workflow [`quartal-ruecksicherung.yml`](../.github/workflows/quartal-ruecksicherung.yml) legt am 1. Januar, April, Juli und Oktober ein Issue «Rücksicherungstest» an; es erinnert und hat die Schritte als Liste. Der Test selbst läuft von Hand. Das Ergebnis (nur Zahlen, keine Daten) steht im Issue, bevor man es schliesst.

Auf dem Server, nie auf einem persönlichen Rechner: `deploy/backup.sh pruefen` spielt den letzten Stand in einen Wegwerf-Container ohne Netz zurück, zählt die Zeilen je Tabelle neben dem Live-Stand (nur Zahlen) und öffnet psql für Stichproben. Danach löscht das Skript den Container samt Daten.

### Ernstfall: leere Datenbank

1. `docker compose -f docker-compose.prod.yml up -d --wait postgres`
2. Rollen anlegen: `docker compose -f docker-compose.prod.yml exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d fireresponse < ../apps/api/src/db/rollen.sql`
3. Letzten Stand zurückspielen: `docker compose -f docker-compose.prod.yml run --rm -T backup dump --retry-lock 5m latest /fireresponse.dump | docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U postgres -d fireresponse --exit-on-error --single-transaction`
4. Release ausrollen: `./deploy.sh <Tag>`. Danach melden sich alle neu an.

Fehlt auch die alte `deploy/.env`: Das Passwort der betreuenden Person oder der Stellvertretung als `RESTIC_PASSWORD` in die neue `deploy/.env` eintragen, denn die Wiederherstellung läuft über `run -T` und kann kein Passwort versteckt abfragen. Danach einen neuen Server-Schlüssel anlegen (`key add`, Wert als `RESTIC_PASSWORD` in `deploy/.env`) und den verlorenen entfernen (`key list` zeigt die IDs, `key remove <ID>`). Die zweiten Faktoren lassen sich ohne die alte `.env` nicht mehr entschlüsseln; die Konten mit Verwaltungsrolle richten sie neu ein, nachdem die CLI sie zurückgesetzt hat (siehe «Zweiter Faktor»).

Bleibt nach einem Abbruch ein Lock im Archiv zurück: `docker compose -f docker-compose.prod.yml run --rm backup unlock`

## Überwachung

`/health` antwortet ohne Login mit `ok` (Status 200), `fehler` oder `sync-veraltet` (Status 503). `fehler` heisst: Die Datenbank ist nicht erreichbar oder ihre Tabellen fehlen. `sync-veraltet` heisst: Der Lodur-Sync einer Einheit mit Link ist seit über 60 Minuten nicht gelungen; welche Einheit und warum, zeigt die Verwaltung (`GET /api/v1/admin/einheiten/{einheitId}/lodur`, Feld `syncFehler`) und das Log (`"ereignis":"lodur-sync"`, nur ein Code). Den Grund nennt nur das Log der API, nie die Antwort. Ist die Datenbank nicht erreichbar, dauert die Antwort rund 5 Sekunden.

Ein kostenloser Uptime-Dienst ruft `/health` auf; er sieht nur `ok` oder `fehler`. Gewählt ist UptimeRobot. Bei einem Wechsel zuerst die aktuellen Bedingungen des Gratis-Plans lesen (Intervall, Zahl der Monitore, erlaubte Nutzung, Standort der Server). Der Dienst sieht nur die öffentliche Adresse und die Antwort `ok` oder `fehler`, keine Personendaten. Anforderungen:

- Gratis-Plan; für das Konto gelten die Regeln aus «Konten».
- HTTPS-Check auf `https://api.fireresponse.ch/health`, im kürzesten Intervall des Gratis-Plans. HEAD oder GET: Die API beantwortet HEAD wie GET, samt Status.
- Timeout über 5 Sekunden, damit der langsame 503 noch als Antwort zählt.
- Alarm bei jedem Status ausser 200 und wenn keine Antwort kommt.
- Alarm per E-Mail an die betreuende Person und, wo der Dienst es erlaubt, an eine zweite Person.
- Falls der Dienst es anbietet: Alarm vor dem Ablauf des Zertifikats (Caddy erneuert es selbst; der Alarm zeigt, wenn das scheitert).

Einrichtung, einmal, nach dem ersten erfolgreichen Deploy und dem DNS-Eintrag:

1. Konto beim Dienst anlegen (Zwei-Faktor, zweite Person; siehe «Konten»).
2. Einen HTTPS-Monitor mit den Werten von oben anlegen und die Empfänger eintragen.
3. Abnahme: im Ordner `deploy/` `docker compose -f docker-compose.prod.yml stop api` ausführen. Nach dem Intervall des Dienstes kommt der Alarm. Dann `docker compose -f docker-compose.prod.yml start api` ausführen; der Monitor meldet die Entwarnung. Zeit und Ergebnis kurz in einem Issue notieren.

Kein Sentry in V1 (Datenschutz); später neu prüfen.

Die Überwachung deckt DNS, Edge-Caddy, Zertifikat, API und Datenbank ab (`/health` fragt die Datenbank). Sie deckt nicht ab, ob das tägliche Backup läuft; das zeigt der Rücksicherungstest und `restic snapshots` (siehe «Backups»).

Bei Alarm:

1. Das API-Log der letzten Stunde lesen: `docker compose -f deploy/docker-compose.prod.yml logs --since 1h api`
2. `docker compose -f deploy/docker-compose.prod.yml ps`: Läuft `api` und `postgres`, beide `healthy`? Läuft der Edge-Caddy (im Edge-Ordner `docker compose ps` und `docker compose logs --since 1h caddy`)? Antwortet `curl -s http://127.0.0.1:3000/health` im Container der API (`docker compose -f deploy/docker-compose.prod.yml exec api node -e "fetch('http://127.0.0.1:3000/health').then(r => r.text()).then(console.log)"`)?
3. Platz und Speicher: `df -h`, `free -h`, `docker inspect` des Containers auf `OOMKilled` (siehe «Server»).
4. Ist die Datenbank beschädigt oder leer: «Ernstfall: leere Datenbank» unter «Backups».

## Wartung

Das Konto des Kantonsadmins schaltet die Wartung in der Verwaltung (Übersicht, Kachel «Wartung») mit einem Text von höchstens 280 Zeichen und einem Ende, beides optional. Solange sie läuft, antworten alle App-Routen unter `/api/v1/` mit 503 `WARTUNG`, auch ohne Sitzung; die Apps zeigen den Wartungsbildschirm. Offen bleiben die Verwaltung (`/api/v1/admin/*`), `GET /api/v1/wartung`, `GET /api/v1/datenschutz`, `/health` und die Seiten. Die Anmeldung der Apps (mit `X-App-Version`) ist gesperrt, die der Verwaltung im Browser nicht. Das Ende ist nur eine Anzeige: Die Wartung läuft, bis jemand sie ausschaltet. Jedes Ein- und Ausschalten steht im Protokoll der Änderungen.

Kommt niemand mehr in die Verwaltung (zweiter Faktor verloren), schaltet, wer den Server betreibt, mit SQL aus. Alle drei Felder müssen leer werden, sonst weist die Datenbank die Änderung ab: `update wartung set aktiv = false, text = null, ende = null, seit = null;` (in `deploy/`: `docker compose -f docker-compose.prod.yml exec postgres psql -U postgres -d fireresponse`). Den zweiten Faktor setzt die CLI aus «Zweiter Faktor» zurück; das ist der bessere Weg, weil er im Protokoll steht.

## Logs

Alle Dienste aus `deploy/docker-compose.prod.yml` und der Edge-Caddy loggen über den journald-Treiber von Docker. journald löscht nach Alter statt nach Grösse: Server-Logs und Container-Logs, auch die des Edge-Caddys, bleiben so 14 Tage.

Lesen:

- `docker compose -f deploy/docker-compose.prod.yml logs <dienst>`; der Edge-Caddy: `docker compose logs caddy` im Edge-Ordner
- `sudo journalctl CONTAINER_NAME=<Name>`; die Namen zeigt `docker compose -f deploy/docker-compose.prod.yml ps`, für den Edge-Caddy `docker compose ps` im Edge-Ordner. Für schon entfernte Container (etwa die Migration aus `docker compose run`) listet `sudo journalctl -F CONTAINER_NAME` alle Namen, die journald kennt.

Was in den Logs steht:

- API: eine JSON-Zeile pro Anfrage mit `requestId`, Routen-Muster und Status, ohne Namen, Inhalte oder IP-Adressen. Bei 401 und 403 einer angemeldeten Anfrage steht zusätzlich `nutzerId` darin, die ID des Kontos (siehe «Abgewiesene Anfragen prüfen»). Der Healthcheck des Containers ruft `/health` alle 30 Sekunden auf; erfolgreiche Aufrufe stehen weder im Log noch in den Zahlen der Übersicht, Fehler schon. Beim Start und danach alle 24 Stunden löscht die API abgelaufene Sitzungen samt ihren Push-Tokens und schreibt eine Zeile mit `"ereignis":"sitzungen"` und der Anzahl (`geloescht`), bei einem Fehler nur dessen Code. Ebenso löscht die API Mitteilungen im Infokanal nach 6 Monaten (`"ereignis":"infokanal"`, `geloescht`); Mitteilungstexte stehen nie im Log. Im selben Takt löscht die API Nachrichten der Glocke 6 Monate nach ihrem Ablauf (ohne Ablauf 6 Monate nach dem Erstellen) und schreibt eine Zeile mit `"ereignis":"nachrichten"` und der Anzahl (`geloescht`), bei einem Fehler nur dessen Code. Das Löschen nach Alter begrenzt das Log.
- Edge-Caddy: IP-Adressen, auch die der anderen Stacks. Caddy schreibt auf stderr und damit nach journald; keine Log-Datei, kein Volume.
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

Andere Log-Dateien auf dem Server, etwa die eines Syslog-Dienstes mit den IP-Adressen von SSH-Clients: ebenfalls höchstens 14 Tage aufbewahren oder den Schreiber abschalten. Die Befehle dazu hängen vom System ab.

### Abgewiesene Anfragen prüfen

Einen Alarm für gehäufte 401 (nicht angemeldet, Anmeldung fehlgeschlagen) und 403 (keine Berechtigung) gibt es nicht; geprüft wird von Hand im Log der API, in `deploy/`:

1. Nach Route zählen, hier für die letzten 24 Stunden: `docker compose -f docker-compose.prod.yml logs --since 24h --no-log-prefix api | grep -oE '"route":"[^"]*","status":40[13]' | sort | uniq -c | sort -rn`
2. Nach Konto zählen: `docker compose -f docker-compose.prod.yml logs --since 24h --no-log-prefix api | grep -oE '"nutzerId":"[^"]*"' | sort | uniq -c | sort -rn`. `nutzerId` steht nur bei 401 und 403 und nur, wenn die Anfrage eine gültige Sitzung hatte.

Worauf achten:

- Viele 401 auf `/api/auth/sign-in/username`: Jemand rät Passwörter. Wartezeit und Rate-Limit bremsen; die IP-Adressen dazu stehen nur im Log des Edge-Caddys.
- Viele 429 in den Logs der API (Feld `status`): Eine Adresse überschreitet die Drosselung. Im Log steht die Route, die Adresse nur im Log des Edge-Caddys.
- Viele 403 bei derselben `nutzerId`: Ein Konto versucht, was es nicht darf. Die ID ist die Spalte `id` der Tabelle `user`. Deutet es auf ein gekapertes Konto, gilt «Datenpanne».
- 403 ohne `nutzerId` auf einer ändernden Route unter `/api/v1`: Die Anfrage kam mit einem fremden `Origin`, etwa von einer anderen Webseite im Browser einer angemeldeten Person.

## Zweiter Faktor

Konten mit Verwaltungsrolle (Kantonsadmin, Kommandant, Stellvertretung) melden sich zusätzlich mit einem Code aus einer Authenticator-App oder einem Passwort-Manager an (TOTP, zehn Ersatzcodes, kein «Gerät vertrauen»). Ohne zweiten Faktor ist die Verwaltung gesperrt (`/api/v1/admin/*`); einrichten lässt er sich im Profil. Es handeln Rollen, keine bestimmten Personen.

- **Neues Gerät, das alte ist gelöscht:** Ein Kantonsadmin setzt den zweiten Faktor in der Verwaltung zurück («Zweiten Faktor zurücksetzen» auf der Seite der Person). Die Person meldet sich danach ohne Code an und richtet ihn neu ein. Ist die Person selbst Kantonsadmin, tut es ein anderer Kantonsadmin.
- **Gerät verloren:** Derselbe Kantonsadmin setzt zuerst ein «Neues Startpasswort» (das beendet jede Sitzung der Person; im Passwort-Manager des verlorenen Geräts kann das alte Passwort stehen) und setzt erst dann den zweiten Faktor zurück. Nie zurücksetzen, solange ein altes Passwort noch gilt, sonst richtet die fremde Person den neuen Faktor selbst ein (siehe «Datenpanne»).
- **Kein Kantonsadmin besteht den zweiten Faktor mehr:** Wer den Server betreibt, setzt ihn mit der CLI zurück, in `deploy/`: `docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/zweiter-faktor-zuruecksetzen.ts --benutzername <name>`; immer `exec`, nie `run`. Lokal in der Entwicklung: `npm run zweiter-faktor:zuruecksetzen -w apps/api -- --benutzername <name>`. Die CLI braucht nur `DATABASE_URL` und läuft ohne Anmeldung, auch nach einem Wechsel des Auth-Geheimnisses.
- **Das Auth-Geheimnis ändert sich:** better-auth verschlüsselt die TOTP-Geheimnisse und die Ersatzcodes mit `BETTER_AUTH_SECRET`. Nach einem Wechsel lassen sie sich nicht mehr entschlüsseln: Wer den Server betreibt, setzt den Faktor jedes Kontos mit Verwaltungsrolle mit der CLI zurück, danach meldet sich jedes an und richtet ihn neu ein.

Jede Zurücksetzung schreibt eine Zeile ins Audit-Log; bei der CLI steht «cli» als Akteur.

## Datenpanne

Der Ablauf gilt, sobald Daten in falsche Hände geraten sein könnten, etwa durch ein gekapertes Konto, ein geleaktes Geheimnis oder eine kopierte Datenbank. Es handeln Rollen, keine bestimmten Personen: Wer den Server betreibt, führt die Befehle aus; die verantwortliche Stelle (`VERANTWORTLICHE_STELLE`) entscheidet und meldet.

1. **Alle Sitzungen beenden,** in `deploy/`: `docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/sitzungen-beenden.ts`. Der Befehl meldet «Beendete Sitzungen: n». Alle müssen sich neu anmelden; Konten, Passwörter und zweite Faktoren bleiben. In der Entwicklung: `npm run sitzungen:beenden -w apps/api`.
2. **Die verantwortliche Stelle informieren,** und mit ihr die Bezirke, deren Einheiten betroffen sein können. Bedeutet die Panne wahrscheinlich ein hohes Risiko für die betroffenen Personen, geht so rasch als möglich eine Meldung an den EDÖB über <https://databreach.edoeb.admin.ch/report> (Art. 24 Abs. 1 DSG), ohne auf die Schritte 3 und 4 zu warten; noch fehlende Angaben folgen so rasch als möglich (Art. 15 Abs. 2 DSV).
3. **Geheimnisse wechseln,** jedes einzeln:
   - Auth-Geheimnis: in `BETTER_AUTH_SECRET` einen neuen Zufallswert setzen und die API neu starten. Alte Cookies gelten dann nicht mehr, und die gespeicherten TOTP-Geheimnisse und Ersatzcodes lassen sich nicht mehr entschlüsseln: Kein Konto mit Verwaltungsrolle besteht den zweiten Faktor, bis er neu eingerichtet ist (Schritt 4), und die gespeicherten Lodur-Links lassen sich nicht mehr lesen (Sync-Fehler `entschluesselung`): Das Kommando trägt sie neu ein. Den alten Wert vollständig entfernen, auch nicht als ältere Version in `BETTER_AUTH_SECRETS` behalten: Wer ihn kennt, könnte damit weiterhin Codes berechnen.
   - Passwörter der Datenbankrollen: in `deploy/.env` neue Werte für `API_DB_PASSWORD` und `MIGRATION_DB_PASSWORD` setzen und `deploy/deploy.sh <Tag>` des laufenden Tags ausführen; es setzt die Rollenpasswörter und startet neu.
   - Schlüssel des Firebase-Dienstkontos für FCM: einen neuen Schlüssel erzeugen, ihn nach `deploy/secrets/fcm-service-account.json` legen, die API neu starten und erst dann den alten Schlüssel löschen.
   - restic- und S3-Schlüssel: einen neuen S3-Zugangsschlüssel beim Anbieter anlegen und in `deploy/.env` eintragen, den alten löschen; einen neuen restic-Schlüssel anlegen (`key add`) und den alten entfernen (`key remove`).
4. **Gekapertes Konto sperren, dann zweite Faktoren neu einrichten.** Nach Schritt 3 besteht kein Konto mit Verwaltungsrolle den zweiten Faktor. Die CLI (`docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/zweiter-faktor-zuruecksetzen.ts --benutzername <name>`, in `deploy/`) setzt den Faktor genau eines vertrauenswürdigen Kantonsadmins zurück; diese Person meldet sich an und richtet ihren Faktor neu ein. Dann deaktiviert sie das gekaperte Konto oder gibt ihm ein neues Startpasswort; nie den Faktor eines Kontos zurücksetzen, solange sein altes Passwort noch gilt, sonst richtet die fremde Person den neuen Faktor selbst ein. Danach setzt sie die Faktoren der übrigen Konten mit Verwaltungsrolle zurück, und diese richten ihre neu ein. Bleibt kein vertrauenswürdiger Kantonsadmin übrig, legt die CLI einen neuen an, in `deploy/`: `docker compose -f docker-compose.prod.yml exec api node --import tsx src/cli/kantonsadmin-anlegen.ts --benutzername <name> --name "<Vorname Nachname>"`; immer `exec`, nie `run`, sonst steht das Startpasswort 14 Tage im journald (siehe «Logs»).
5. **Dokumentieren:** die Tatsachen rund um die Panne, ihre Auswirkungen und die getroffenen Massnahmen (Art. 15 Abs. 4 DSV), dazu ob gemeldet wurde und warum. Die Dokumentation bleibt mindestens zwei Jahre erhalten, nie im Repo, in Issues oder in PRs.
