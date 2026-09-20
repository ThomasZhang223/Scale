#!/usr/bin/env bash
# Point the Worker at the laptop services behind cloudflared.
#
# A quick tunnel gets a NEW random hostname every time cloudflared restarts, so this runs every
# time the laptop side comes up. The values live in KV rather than in wrangler.toml so that
# rotating one is a write, not a redeploy.
#
#   bash set-upstreams.sh https://a.trycloudflare.com https://b.trycloudflare.com https://c.trycloudflare.com https://d.trycloudflare.com
#
# There is deliberately no default and no "reuse the last one". An unset key makes the Worker
# answer 503 naming the key, which is the correct outcome: guessing which service you meant is
# how a demo fails silently.

set -euo pipefail

if [ $# -ne 3 ] && [ $# -ne 4 ]; then
	echo "usage: set-upstreams.sh <solver-url> <search-url> <ingest-url> [embedding-url]" >&2
	echo "  pass the literal string SKIP for a service that is not running yet" >&2
	exit 2
fi

cd "$(dirname "$0")/../../workers"

set_one() {
	local name="$1" url="$2"
	if [ "${url}" = "SKIP" ]; then
		echo "    upstream:${name} left unset (will answer 503)"
		return
	fi
	case "${url}" in
	https://*) ;;
	*)
		echo "upstream:${name} must be an https URL, got '${url}'" >&2
		exit 1
		;;
	esac
	npx wrangler kv key put --binding CONFIG "upstream:${name}" "${url}" --remote >/dev/null
	echo "    upstream:${name} -> ${url}"
}

echo "==> Writing upstream origins to KV"
set_one solver "$1"
set_one search "$2"
set_one ingest "$3"
if [ $# -eq 4 ]; then set_one embedding "$4"; fi

echo
echo "Verify the whole wiring with:"
echo "  curl https://full-scale-workers.<subdomain>.workers.dev/v1/health"
echo "  curl https://full-scale-workers.<subdomain>.workers.dev/v1/health/upstream"
