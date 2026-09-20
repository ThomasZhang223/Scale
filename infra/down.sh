#!/usr/bin/env bash
# Stop the three quick tunnels, then the containers. Mirror of infra/up.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_DIR="$REPO_ROOT/infra/.run"

echo "== stopping tunnels =="
if [ -d "$RUN_DIR" ]; then
  for pidfile in "$RUN_DIR"/*.pid; do
    [ -e "$pidfile" ] || continue
    name="$(basename "$pidfile" .pid)"
    pid="$(cat "$pidfile")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid"
      echo "stopped $name tunnel (pid $pid)"
    else
      echo "$name tunnel (pid $pid) was already stopped"
    fi
  done
  rm -rf "$RUN_DIR"
else
  echo "infra/.run not found — no tunnels to stop"
fi

echo "== stopping containers =="
# --profile gen as well as local: the B06 generation adapter sits in its own profile
# (see docker-compose.yml), and `down` only stops services in the profiles it is given.
( cd "$REPO_ROOT" && docker compose --profile local --profile gen down )

echo "done"
