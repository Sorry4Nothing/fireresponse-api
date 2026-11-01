#!/usr/bin/env bash
# Rollt ein Release aus, nachdem der Tag ausgecheckt ist: deploy/deploy.sh vX.Y.Z
# Backup, Rollen und Passwörter, Migration mit der Besitzerrolle, Neustart, Prüfung der veröffentlichten Ports
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Aufruf: deploy/deploy.sh vX.Y.Z" >&2
  exit 1
fi
cd "$(dirname "$0")"
# Fehlt die Schlüsseldatei, legt Docker an ihrer Stelle ein leeres Verzeichnis an
for datei in .env Caddyfile secrets/fcm-service-account.json; do
  if [[ ! -f $datei ]]; then
    echo "Fehlt oder ist keine Datei: deploy/$datei" >&2
    exit 1
  fi
done
export TAG=$1

compose() {
  docker compose -f docker-compose.prod.yml "$@"
}

echo "Images von postgres und caddy aktualisieren" >&2
# Die Korrekturen hinter den Tags postgres:18 und caddy:2 kommen nur so
compose pull postgres caddy
compose up -d --wait --wait-timeout 120 postgres

./backup.sh

echo "Rollen und Passwörter setzen" >&2
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d fireresponse <../apps/api/src/db/rollen.sql
# \getenv liest die Passwörter aus der Umgebung des Containers, so stehen sie auf keiner Befehlszeile
compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d fireresponse <<'SQL'
\getenv api_passwort API_DB_PASSWORD
\getenv migration_passwort MIGRATION_DB_PASSWORD
ALTER ROLE fireresponse_api PASSWORD :'api_passwort';
ALTER ROLE fireresponse_besitzer PASSWORD :'migration_passwort';
SQL

echo "Migration mit der Besitzerrolle" >&2
compose run --rm -T migration

echo "Neustart mit $TAG" >&2
neustart=0
# Die Portprüfung läuft auch nach einem gescheiterten Neustart, sonst bliebe ein veröffentlichter Port offen
compose up -d --wait --wait-timeout 120 || neustart=$?

# Nur exponierte, nicht veröffentlichte Ports erscheinen als 0
belegt=$(compose ps --format '{{.Service}}{{range .Publishers}}{{if .PublishedPort}} {{.PublishedPort}}{{end}}{{end}}' | awk '$1 != "caddy" && NF > 1')
if [[ -n $belegt ]]; then
  echo "Nur caddy darf Ports veröffentlichen. Diese Dienste werden gestoppt (Dienst und Ports):" >&2
  echo "$belegt" >&2
  mapfile -t dienste < <(cut -d ' ' -f 1 <<<"$belegt")
  compose stop "${dienste[@]}"
  exit 1
fi
if ((neustart != 0)); then
  echo "Neustart mit $TAG gescheitert" >&2
  exit "$neustart"
fi
echo "Deploy von $TAG fertig" >&2
