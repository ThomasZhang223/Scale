#!/usr/bin/env bash
# Bring up ONLY the B06 generation adapter (services/gen/app/generate_server.py) and its own
# quick tunnel, then print the two wrangler commands that point the Worker at it.
#
# Why this is not part of infra/up.sh: up.sh rotates all four live tunnel URLs and republishes
# them to KV, and re-creates ingest without its vendor keys. During a demo weekend that is a
# destructive act. This script adds a fifth service and a fifth tunnel and touches nothing else.
#
# The adapter's URL is a Worker SECRET (BASETEN_URL), not a KV upstream, so there is nothing
# for infra/cloudflare/set-upstreams.sh to publish. That is the whole reason it is separate.
#
# Every phase fails loud. Nothing here guesses a URL, a port or a credential.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/infra/.env"
SECRETS_FILE="${FULL_SCALE_SECRETS:-$HOME/.config/full-scale/secrets.env}"
RUN_DIR="$REPO_ROOT/infra/.run"

die() { echo "ERROR: $*" >&2; exit 1; }

# --- preflight -------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker CLI not found. Install Docker Desktop."
docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start Docker Desktop and re-run."
command -v cloudflared >/dev/null 2>&1 || die "cloudflared not found. Install it: brew install cloudflared."

[ -f "$ENV_FILE" ] || die "infra/.env not found."
set -a; . "$ENV_FILE"; set +a
[ -n "${GEN_PORT:-}" ] || die "GEN_PORT is unset in infra/.env."

# Vendor credentials live outside git. Never echo them; only report which one is missing.
[ -f "$SECRETS_FILE" ] || die "$SECRETS_FILE not found. It holds BASETEN_PREDICT_URL, BASETEN_API_KEY and GENERATION_API_KEY (mode 600)."
set -a; . "$SECRETS_FILE"; set +a
for name in BASETEN_PREDICT_URL BASETEN_API_KEY GENERATION_API_KEY; do
  [ -n "${!name:-}" ] || die "$name is unset in $SECRETS_FILE. Mint GENERATION_API_KEY with: openssl rand -hex 32"
done

if [ -f "$RUN_DIR/gen.pid" ] && kill -0 "$(cat "$RUN_DIR/gen.pid")" 2>/dev/null; then
  die "A gen tunnel is already running (pid $(cat "$RUN_DIR/gen.pid"), URL $(cat "$RUN_DIR/gen.url" 2>/dev/null)). Kill it first if you want a new URL — and remember that a new URL means re-putting the BASETEN_URL Worker secret."
fi
rm -f "$RUN_DIR/gen.pid" "$RUN_DIR/gen.url"

# --- container -------------------------------------------------------------------------
echo "== container =="
# Only the gen service, only its profile. The other four are never named, so `up` cannot
# recreate them and cannot rotate their tunnels.
( cd "$REPO_ROOT" && docker compose --profile gen up -d --build gen )

echo "waiting for gen (:$GEN_PORT) /health..."
tries=0
until curl -sf "http://localhost:$GEN_PORT/health" >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 30 ] || die "gen never answered /health on :$GEN_PORT. Check: docker compose --profile gen logs gen"
  sleep 2
done
health="$(curl -s "http://localhost:$GEN_PORT/health")"
echo "$health"
case "$health" in
  *'"provider":true'*) ;;
  *) die "gen answered /health with provider:false — SF3D_PREDICT_URL or BASETEN_API_KEY did not reach the container." ;;
esac
case "$health" in
  *'"auth":true'*) ;;
  *) die "gen answered /health with auth:false — GENERATION_API_KEY did not reach the container." ;;
esac

# --- tunnel ----------------------------------------------------------------------------
echo "== tunnel =="
mkdir -p "$RUN_DIR"
log="$RUN_DIR/cloudflared-gen.log"
cloudflared tunnel --url "http://localhost:$GEN_PORT" >"$log" 2>&1 &
echo "$!" >"$RUN_DIR/gen.pid"

tries=0; url=""
while [ -z "$url" ]; do
  url="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null | head -1 || true)"
  [ -z "$url" ] || break
  tries=$((tries + 1))
  if [ "$tries" -ge 30 ]; then
    kill "$(cat "$RUN_DIR/gen.pid")" 2>/dev/null || true
    rm -f "$RUN_DIR/gen.pid"
    die "cloudflared for gen never printed a trycloudflare.com URL within 30s. Log: $log"
  fi
  sleep 1
done
echo "$url" >"$RUN_DIR/gen.url"

# --- summary ---------------------------------------------------------------------------
cat <<EOF

== summary ==
gen tunnel -> $url
health     -> curl -s $url/health

Point the Worker at it (from workers/), answering each prompt with the value, never echoing it:
  npx wrangler secret put BASETEN_URL        # paste: $url/generate
  npx wrangler secret put BASETEN_API_KEY    # paste: the GENERATION_API_KEY value from $SECRETS_FILE

BASETEN_API_KEY on the WORKER is the adapter's GENERATION_API_KEY, not a Baseten credential.
A quick-tunnel URL dies when cloudflared restarts, so re-put BASETEN_URL after every restart.
infra/up.sh refuses to run while this tunnel is alive; kill \$(cat infra/.run/gen.pid) first.
infra/down.sh stops this tunnel and this container along with the other four.
EOF
