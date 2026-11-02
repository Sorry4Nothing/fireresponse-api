#!/usr/bin/env bash
# Sichert die Datenbank verschlüsselt mit restic auf den S3-Speicher; Ablauf und Schlüssel: docs/betrieb.md
# Ohne Argument ein Backup (Cron und deploy.sh); «pruefen» spielt den letzten Stand in einen Wegwerf-Container zurück
set -euo pipefail

modus=${1-}
if [[ $# -gt 1 || ($# -eq 1 && $modus != pruefen) ]]; then
  echo "Aufruf: deploy/backup.sh [pruefen]" >&2
  exit 2
fi
cd "$(dirname "$0")"

compose() {
  docker compose -f docker-compose.prod.yml "$@"
}

# Ohne Daten im Backup: Sitzungen enthalten Tokens. Eine neue Tabelle, die auf eine dieser verweist, gehört auch hierhin
ausschluss=(session verification rate_limit push_token)

# Zeilen je Tabelle als «schema.tabelle|anzahl», ohne Inhalte
zaehl_sql="SELECT table_schema || '.' || table_name || '|' || (xpath('/table/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, false, '')))[1]::text FROM information_schema.tables WHERE table_schema IN ('public', 'drizzle') AND table_type = 'BASE TABLE' ORDER BY 1"

if [[ $modus == pruefen ]]; then
  if [[ ! -f ../apps/api/src/db/rollen.sql ]]; then
    echo "Fehlt: apps/api/src/db/rollen.sql, in derselben Ablage wie im Repo" >&2
    exit 1
  fi
  docker rm -f fireresponse_pruefung >/dev/null 2>&1 || true
  bild=$(compose config --images postgres)
  echo "Wegwerf-Container fireresponse_pruefung ohne Netz starten ($bild)" >&2
  docker run -d --rm --name fireresponse_pruefung --network none -e POSTGRES_DB=fireresponse -e POSTGRES_HOST_AUTH_METHOD=trust "$bild" >/dev/null
  trap 'docker stop fireresponse_pruefung >/dev/null 2>&1 || true' EXIT

  bereit=
  for ((i = 0; i < 60; i++)); do
    # Über TCP: Der Server, der das leere Volume einrichtet, hört nur auf dem Socket
    if docker exec fireresponse_pruefung pg_isready -h 127.0.0.1 -U postgres -d fireresponse >/dev/null 2>&1; then
      bereit=1
      break
    fi
    sleep 1
  done
  if [[ -z $bereit ]]; then
    echo "Der Wegwerf-Container wurde nicht bereit" >&2
    exit 1
  fi

  # Der Dump trägt Besitzer und Rechte; ohne die Rollen bricht die Wiederherstellung ab
  docker exec -i fireresponse_pruefung psql -v ON_ERROR_STOP=1 -U postgres -d fireresponse <../apps/api/src/db/rollen.sql >/dev/null
  echo "Letzter Stand aus dem Archiv in den Wegwerf-Container" >&2
  compose run --rm -T backup dump --retry-lock 5m latest /fireresponse.dump | docker exec -i fireresponse_pruefung pg_restore -U postgres -d fireresponse --exit-on-error --single-transaction
  compose run --rm -T backup snapshots --retry-lock 5m --latest 1

  wieder=$(docker exec fireresponse_pruefung psql -tA -v ON_ERROR_STOP=1 -U postgres -d fireresponse -c "$zaehl_sql")
  live=$(compose exec -T postgres psql -tA -v ON_ERROR_STOP=1 -U postgres -d fireresponse -c "$zaehl_sql")

  for tabelle in "${ausschluss[@]}"; do
    zeilen=$(grep "^public\.$tabelle|" <<<"$wieder" | cut -d '|' -f 2 || true)
    if [[ -z $zeilen ]]; then
      # Stand von vor der Migration dieser Tabelle; eine fehlende Tabelle hat keine Daten
      echo "Hinweis: Ausgeschlossene Tabelle public.$tabelle fehlt im zurückgespielten Stand" >&2
    elif [[ $zeilen != 0 ]]; then
      echo "Ausgeschlossene Tabelle public.$tabelle ist nicht leer (Zeilen: $zeilen)" >&2
      exit 1
    fi
  done

  echo "Zeilen je Tabelle:"
  {
    echo "Tabelle|wiederhergestellt|live"
    join -t '|' -a 1 -a 2 -e '?' -o 0,1.2,2.2 <(sort <<<"$wieder") <(sort <<<"$live")
  } | awk -F'|' '{printf "%-30s %18s %10s\n", $1, $2, $3}'

  if [[ -t 0 ]]; then
    echo 'Stichproben von Hand: psql im Wegwerf-Container, beenden mit \q' >&2
    docker exec -it fireresponse_pruefung psql -U postgres -d fireresponse
  else
    echo "Keine Eingabekonsole, Stichproben übersprungen" >&2
  fi
  echo "Prüfung fertig, der Wegwerf-Container samt Daten wird gelöscht" >&2
  exit 0
fi

# Vor den ersten Migrationen gibt es nichts zu sichern; eine gestoppte Datenbank bleibt dagegen ein Fehler
leer=$(compose exec -T postgres psql -tA -v ON_ERROR_STOP=1 -U postgres -d fireresponse -c "SELECT to_regclass('drizzle.__drizzle_migrations') IS NULL")
if [[ $leer == t ]]; then
  echo "Noch keine Migrationen, darum kein Backup" >&2
  exit 0
fi

sql_liste=$(printf ", ('%s')" "${ausschluss[@]}")
sql_liste=${sql_liste:2}
# Eine fehlende ausgeschlossene Tabelle hat keine Daten: warnen und ohne sie sichern (deploy.sh sichert vor der Migration, die sie anlegt)
fehlend=$(compose exec -T postgres psql -tA -v ON_ERROR_STOP=1 -U postgres -d fireresponse -c "WITH ausschluss(name) AS (VALUES $sql_liste) SELECT name FROM ausschluss WHERE to_regclass('public.' || name) IS NULL")
vorhanden=()
for tabelle in "${ausschluss[@]}"; do
  if grep -qx "$tabelle" <<<"$fehlend"; then
    echo "Warnung: Ausgeschlossene Tabelle public.$tabelle gibt es noch nicht, Backup ohne sie" >&2
  else
    vorhanden+=("$tabelle")
  fi
done

# Daten einer Tabelle, die auf eine ausgeschlossene verweist, machten die ganze Wiederherstellung ungültig
probleme=$(compose exec -T postgres psql -tA -v ON_ERROR_STOP=1 -U postgres -d fireresponse <<SQL
WITH ausschluss(name) AS (VALUES $sql_liste)
SELECT c.conrelid::regclass::text || ' verweist auf ' || c.confrelid::regclass::text
FROM pg_constraint c
JOIN ausschluss a ON c.confrelid = to_regclass('public.' || a.name)
WHERE c.contype = 'f'
  AND c.conrelid NOT IN (SELECT to_regclass('public.' || name) FROM ausschluss WHERE to_regclass('public.' || name) IS NOT NULL);
SQL
)
if [[ -n $probleme ]]; then
  echo "Kein Backup: Die Ausschlussliste in deploy/backup.sh passt nicht zur Datenbank:" >&2
  echo "$probleme" >&2
  exit 1
fi

umask 077
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

echo "Backup der Datenbank mit restic" >&2
dump_args=()
for tabelle in "${vorhanden[@]}"; do
  dump_args+=("--exclude-table-data=$tabelle")
done
# Erst in eine Datei: Ein Rohr direkt in restic ergäbe bei einem Fehler von pg_dump einen angeschnittenen Stand
compose exec -T postgres pg_dump -U postgres -d fireresponse --format=custom --compress=0 "${dump_args[@]}" >"$tmp"
# Unkomprimiert oben, denn restic komprimiert selbst
compose run --rm -T backup backup --retry-lock 5m --stdin --stdin-filename fireresponse.dump <"$tmp"
# --max-unused 0: Mit dem Standardwert blieben gelöschte Zeilen unbegrenzt in halb genutzten Paketen liegen
compose run --rm -T backup forget --retry-lock 5m --keep-daily 30 --keep-monthly 3 --prune --max-unused 0
echo "Backup fertig" >&2
