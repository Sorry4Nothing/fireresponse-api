#!/usr/bin/env bash
# Berechnet die Nummer des nächsten Releases (siehe docs/GIT_WORKFLOW.md, «Release»)
# Aufruf: naechste-version.sh <minor|major> <X.Y.Z oder -> <letzter Tag vX.Y.Z oder leer>
# minor erhöht z, major erhöht y und setzt z auf 0; x steigt nur über die ausdrückliche Version.
# Ausgabe: X.Y.Z (ohne v)
set -euo pipefail

stufe=${1:-}
version=${2:--}
letzter=${3:-}
# Keine führenden Nullen (bash läse 08 als Oktalzahl) und höchstens 9 Stellen (kein Überlauf)
zahl='(0|[1-9][0-9]{0,8})'
muster="^${zahl}\.${zahl}\.${zahl}\$"

if [[ -z $letzter ]]; then
  alt=(0 0 0)
elif [[ $letzter =~ ^v${zahl}\.${zahl}\.${zahl}$ ]]; then
  alt=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
else
  echo "Letzter Tag ist keine Nummer vX.Y.Z: $letzter" >&2
  exit 1
fi

if [[ $version != - ]]; then
  if [[ ! $version =~ $muster ]]; then
    echo "Version ist keine Nummer X.Y.Z: $version" >&2
    exit 1
  fi
  neu=("${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}")
else
  case "$stufe" in
    minor) neu=("${alt[0]}" "${alt[1]}" "$((alt[2] + 1))") ;;
    major) neu=("${alt[0]}" "$((alt[1] + 1))" 0) ;;
    *) echo "Aufruf: naechste-version.sh <minor|major> <X.Y.Z oder -> <letzter Tag>" >&2; exit 1 ;;
  esac
fi

# Die Nummer muss steigen; Vergleich Stelle für Stelle als Zahl
for i in 0 1 2; do
  if ((neu[i] > alt[i])); then
    echo "${neu[0]}.${neu[1]}.${neu[2]}"
    exit 0
  elif ((neu[i] < alt[i])); then
    break
  fi
done
echo "Die Nummer ${neu[0]}.${neu[1]}.${neu[2]} ist nicht grösser als der letzte Tag $letzter" >&2
exit 1
