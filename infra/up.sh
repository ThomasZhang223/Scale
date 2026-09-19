#!/usr/bin/env bash
# Bring up the laptop half of the stack: the four local services, then a quick tunnel to
# each, then publish the four tunnel origins to the Worker's CONFIG KV. See infra/README.md
# for the full picture — this script is the laptop side of one hop in it.
#
# Every phase fails loud. Nothing here guesses a URL or falls back to localhost — an unset
# value or a step that did not finish is an error message naming the fix, never a silent
# default. See infra/README.md for why that rule matters most in this file.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/infra/.env"
RUN_DIR="$REPO_ROOT/infra/.run"
SET_UPSTREAMS="$REPO_ROOT/infra/cloudflare/set-upstreams.sh"

HEALTH_TIMEOUT_TRIES=30    # 30 * 2s = 60s
TUNNEL_TIMEOUT_TRIES=30    # 30 * 1s = 30s

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Phase 1: preflight
# ---------------------------------------------------------------------------
preflight() {
  echo "== preflight =="

  command -v docker >/dev/null 2>&1 || die "docker CLI not found. Install Docker Desktop."
  docker info >/dev/null 2>&1 || die "Docker daemon is not running. Start Docker Desktop and re-run."

  command -v cloudflared >/dev/null 2>&1 || die "cloudflared not found. Install it: brew install cloudflared."

  if [ ! -f "$ENV_FILE" ]; then
    die "infra/.env not found. Copy infra/.env.example to infra/.env and fill in UPSTREAM_TOKEN."
  fi

  # Load infra/.env into this script's environment. set -a exports every variable sourced
  # below, so docker compose (which reads env_file: infra/.env itself) and this script agree
  # on the same values with no duplication.
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  if [ -z "${UPSTREAM_TOKEN:-}" ]; then die "UPSTREAM_TOKEN is unset in infra/.env."; fi
  if [ -z "${WORKER_BASE_URL:-}" ]; then die "WORKER_BASE_URL is unset in infra/.env."; fi
  if [ -z "${FIT_PORT:-}" ]; then die "FIT_PORT is unset in infra/.env."; fi
  if [ -z "${SEARCH_PORT:-}" ]; then die "SEARCH_PORT is unset in infra/.env."; fi
  if [ -z "${INGEST_PORT:-}" ]; then die "INGEST_PORT is unset in infra/.env."; fi

  # Explicit ports must agree with Compose, including existing local .env files.
  if [ "$SEARCH_PORT" != "8005" ]; then die "Set SEARCH_PORT=8005; embeddings now use 8004."; fi
  EMBEDDING_PORT=8004
  if [ -z "${EMBEDDING_API_KEY:-}" ]; then die "Set EMBEDDING_API_KEY in infra/.env (also a Worker secret)."; fi

  # `npx wrangler`, not bare `wrangler`. This project installs wrangler as a devDependency of
  # workers/, so it is never on PATH — the preflight rejected a perfectly working setup.
  # infra/cloudflare/set-upstreams.sh, which this script calls, already uses npx.
  if ! (cd "$REPO_ROOT/workers" && npx --no-install wrangler --version >/dev/null 2>&1); then
    die "wrangler not found. Run 'npm install' in workers/, then 'npx wrangler login'."
  fi
  if (cd "$REPO_ROOT/workers" && npx --no-install wrangler whoami 2>&1) | grep -qi "not authenticated"; then
    die "wrangler is not logged in. Run 'npx wrangler login' from workers/ first."
  fi

  # A tunnel left running from an earlier, un-stopped run would collide with a fresh set of
  # random trycloudflare.com hostnames and leak a process. A pidfile whose process already
  # died (laptop slept, cloudflared crashed) is stale, not a collision — remove it and move on.
  if [ -d "$RUN_DIR" ]; then
    for pidfile in "$RUN_DIR"/*.pid; do
      [ -e "$pidfile" ] || continue
      pid="$(cat "$pidfile")"
      if kill -0 "$pid" 2>/dev/null; then
        die "A tunnel from a previous run is still active (pid $pid, $pidfile). Run infra/down.sh first."
      fi
      rm -f "$pidfile"
    done
  fi

  echo "preflight OK"
}

# ---------------------------------------------------------------------------
# Phase 2: containers
# ---------------------------------------------------------------------------
wait_for_health() {
  local name="$1" port="$2" path="${3:-health}" max_tries="${4:-$HEALTH_TIMEOUT_TRIES}" tries=0
  echo "waiting for $name (:$port) /$path..."
  until curl -sf "http://localhost:$port/$path" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max_tries" ]; then
      die "$name never answered /$path on :$port. Check: docker compose logs $name"
    fi
    sleep 2
  done
  echo "$name is healthy"
}

containers() {
  echo "== containers =="
  # --build: without it, `up -d` reuses whatever image already exists and silently serves
  # stale code after an edit to services/*/app — exactly the kind of silent-wrong-default
  # this project's fail-loud rule forbids. Rebuilding is cheap; Docker's own layer cache
  # keeps a no-op re-run fast.
  ( cd "$REPO_ROOT" && docker compose --profile local up -d --build )

  wait_for_health embedding "$EMBEDDING_PORT" ready 90
  wait_for_health fit "$FIT_PORT"
  wait_for_health search "$SEARCH_PORT"
  wait_for_health ingest "$INGEST_PORT"
  echo "containers OK"
}

# ---------------------------------------------------------------------------
# Phase 3: tunnels
# ---------------------------------------------------------------------------
cleanup_partial_tunnels() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "tunnels phase failed — stopping anything it started so nothing is left running" >&2
    for name in fit search ingest embedding; do
      if [ -f "$RUN_DIR/$name.pid" ]; then
        kill "$(cat "$RUN_DIR/$name.pid")" 2>/dev/null || true
        rm -f "$RUN_DIR/$name.pid" "$RUN_DIR/$name.url"
      fi
    done
  fi
}

start_tunnel() {
  local name="$1" port="$2"
  local log="$RUN_DIR/cloudflared-$name.log"

  cloudflared tunnel --url "http://localhost:$port" >"$log" 2>&1 &
  local pid=$!
  echo "$pid" >"$RUN_DIR/$name.pid"

  local tries=0 url=""
  while [ -z "$url" ]; do
    url="$(grep -Eo 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$log" 2>/dev/null | head -1 || true)"
    if [ -n "$url" ]; then
      break
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge "$TUNNEL_TIMEOUT_TRIES" ]; then
      die "cloudflared for $name never printed a trycloudflare.com URL within ${TUNNEL_TIMEOUT_TRIES}s. Log: $log"
    fi
    sleep 1
  done

  echo "$url" >"$RUN_DIR/$name.url"
  echo "$name tunnel: $url"
}

tunnels() {
  echo "== tunnels =="
  mkdir -p "$RUN_DIR"

  # Scoped to this phase only: if fit's tunnel comes up but search's times out, both should
  # be torn down rather than left as a half-published set. Cleared once all four are up, so
  # a later phase failing (publish, below) does not tear down tunnels that are working fine —
  # they stay live and testable even if the Worker side isn't ready yet.
  trap cleanup_partial_tunnels EXIT
  start_tunnel embedding "$EMBEDDING_PORT"
  start_tunnel fit "$FIT_PORT"
  start_tunnel search "$SEARCH_PORT"
  start_tunnel ingest "$INGEST_PORT"
  trap - EXIT

  echo "tunnels OK"
}

# ---------------------------------------------------------------------------
# Phase 4: publish
# ---------------------------------------------------------------------------
publish() {
  echo "== publish =="

  if [ ! -f "$SET_UPSTREAMS" ]; then
    die "infra/cloudflare/set-upstreams.sh not found. The Cloudflare panel ships this on
branch thomas/cloudflare-infra — pull it in, then re-run. This script does not reimplement
it. The four tunnels above are still running; infra/down.sh stops them when you're done."
  fi
  if [ ! -x "$SET_UPSTREAMS" ]; then
    die "infra/cloudflare/set-upstreams.sh exists but is not executable. chmod +x it and re-run."
  fi

  local fit_url search_url ingest_url
  fit_url="$(cat "$RUN_DIR/fit.url")"
  search_url="$(cat "$RUN_DIR/search.url")"
  ingest_url="$(cat "$RUN_DIR/ingest.url")"

  # Optional fourth argument publishes upstream:embedding.
  "$SET_UPSTREAMS" "$fit_url" "$search_url" "$ingest_url" "$(cat "$RUN_DIR/embedding.url")"

  echo "publish OK"
}

# ---------------------------------------------------------------------------
# Phase 5: print
# ---------------------------------------------------------------------------
print_summary() {
  echo "== summary =="
  echo "fit    (upstream:solver)  -> $(cat "$RUN_DIR/fit.url")"
  echo "search (upstream:search)  -> $(cat "$RUN_DIR/search.url")"
  echo "ingest (upstream:ingest)  -> $(cat "$RUN_DIR/ingest.url")"
  echo "embedding (upstream:embedding) -> $(cat "$RUN_DIR/embedding.url")"
  echo "Worker: $WORKER_BASE_URL"
  echo
  echo "One-line health check, no token needed, through the tunnel:"
  echo "  curl -s $(cat "$RUN_DIR/fit.url")/health"
  echo
  echo "infra/down.sh stops the tunnels and the containers."
}

preflight
containers
tunnels
publish
print_summary
