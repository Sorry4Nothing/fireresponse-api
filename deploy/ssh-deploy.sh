#!/usr/bin/env bash
# Befehl des Deploy-Schlüssels in ~/.ssh/authorized_keys (siehe docs/betrieb.md, «Deploy aus GitHub»): Der Schlüssel kann nur einen Tag ausrollen
set -euo pipefail

# Der ganze Block steht in geschweiften Klammern: bash liest ihn ein, bevor git checkout dieses Skript ersetzt
{
  tag=${SSH_ORIGINAL_COMMAND:-}
  if [[ ! $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Aufruf: ssh <Server> vX.Y.Z" >&2
    exit 1
  fi
  cd "$(dirname "$0")/.."
  git fetch --tags
  git checkout "$tag"
  exec deploy/deploy.sh "$tag"
}
