#!/usr/bin/env bash
# Smoke test for the Full Scale Cloudflare backend. Proves a running deployment actually works,
# against any base origin -- a local `wrangler dev` or the real workers.dev deployment.
#
# Usage:
#   bash smoke.sh http://127.0.0.1:8799
#   bash smoke.sh https://full-scale-workers.thomaszhangdev.workers.dev
#
# Standing rule 4 (fail loud): the base URL is required and never defaulted to localhost. A
# smoke test that silently tests the wrong server is worse than no smoke test.
#
# Pure bash, curl, and python3 for JSON. No npm install, no jq.
#
# ceiling: deliberately no `set -e`. This script tests both success paths (expect 200) and
# rejection paths (expect 422/400/401/404) on purpose -- it must keep running every remaining
# check after one fails or one curl call returns a non-2xx status, and only report the final
# tally at the end. `set -u` still catches unbound-variable typos.
set -u

if [ "${1-}" = "" ]; then
  echo "usage: bash smoke.sh <base-url>" >&2
  echo "  example: bash smoke.sh http://127.0.0.1:8799" >&2
  echo "  example: bash smoke.sh https://full-scale-workers.thomaszhangdev.workers.dev" >&2
  exit 2
fi

BASE="${1%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FIXTURE="$REPO_ROOT/fixtures/room-demo.json"

if [ ! -f "$FIXTURE" ]; then
  echo "fixtures/room-demo.json not found at $FIXTURE -- run this from a full checkout." >&2
  exit 2
fi

TMPDIR="$(mktemp -d)"
SSE_PID=""
cleanup() {
  if [ -n "$SSE_PID" ]; then
    kill "$SSE_PID" >/dev/null 2>&1 || true
    wait "$SSE_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

# --- small helpers -----------------------------------------------------------------------

# jget.py: read one JSON file, eval a Python expression against it as `obj`, print the result.
# Stands in for jq, which is not guaranteed to be installed.
cat > "$TMPDIR/jget.py" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
with open(path) as f:
    obj = json.load(f)
result = eval(expr, {"obj": obj, "len": len})
if isinstance(result, (dict, list)):
    print(json.dumps(result))
elif result is None:
    print("null")
elif isinstance(result, bool):
    print("true" if result else "false")
else:
    print(result)
PY
jget() { python3 "$TMPDIR/jget.py" "$1" "$2" 2>/dev/null; }
uuid4() { python3 -c "import uuid; print(uuid.uuid4())"; }

url_for() {
  case "$1" in
    http*) echo "$1" ;;
    *) echo "$BASE$1" ;;
  esac
}

REQ_N=0
# req METHOD PATH JSON_BODY_OR_EMPTY [EXTRA_HEADER...]
# Sets STATUS, BODY_OUT (file), HDR_OUT (file) as globals.
req() {
  local method="$1" path="$2" body="$3"
  shift 3
  local hdrs=()
  for h in "$@"; do hdrs+=(-H "$h"); done
  REQ_N=$((REQ_N + 1))
  BODY_OUT="$TMPDIR/body_$REQ_N"
  HDR_OUT="$TMPDIR/hdr_$REQ_N"
  local url
  url="$(url_for "$path")"
  # ceiling: macOS ships bash 3.2, where "${hdrs[@]}" on a zero-element array is a hard error
  # under `set -u`. The `${hdrs[@]+"${hdrs[@]}"}` form is the portable workaround.
  if [ -n "$body" ]; then
    STATUS=$(curl -sS -o "$BODY_OUT" -D "$HDR_OUT" -w '%{http_code}' -X "$method" "$url" \
      -H "content-type: application/json" ${hdrs[@]+"${hdrs[@]}"} --data "$body")
  else
    STATUS=$(curl -sS -o "$BODY_OUT" -D "$HDR_OUT" -w '%{http_code}' -X "$method" "$url" ${hdrs[@]+"${hdrs[@]}"})
  fi
}

# req_binary METHOD URL CONTENT_TYPE DATA -- for the raw upload PUT, which is not JSON.
req_binary() {
  local method="$1" url="$2" ctype="$3" data="$4"
  REQ_N=$((REQ_N + 1))
  BODY_OUT="$TMPDIR/body_$REQ_N"
  HDR_OUT="$TMPDIR/hdr_$REQ_N"
  STATUS=$(curl -sS -o "$BODY_OUT" -D "$HDR_OUT" -w '%{http_code}' -X "$method" "$url" \
    -H "content-type: $ctype" --data-binary "$data")
}

header_value() {
  # header_value HDR_FILE NAME -- case-insensitive, trims CRLF.
  grep -i "^$2:" "$1" 2>/dev/null | head -1 | sed -E 's/^[^:]+:[[:space:]]*//' | tr -d '\r\n'
}

wait_for_string() {
  # wait_for_string FILE NEEDLE MAX_HALF_SECONDS
  local file="$1" needle="$2" max="$3" i=0
  while [ "$i" -lt "$max" ]; do
    if grep -q "$needle" "$file" 2>/dev/null; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  grep -q "$needle" "$file" 2>/dev/null
}

PASS_N=0
FAIL_N=0
SKIP_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
skip() { SKIP_N=$((SKIP_N + 1)); echo "SKIP: $1"; }

CREATED_IDS=()
remember() { CREATED_IDS+=("$1"); }

echo "== Smoke test against $BASE =="
echo

# --- 1. GET /v1/health ---------------------------------------------------------------------

req GET "/v1/health" ""
if [ "$STATUS" = "200" ] && [ "$(jget "$BODY_OUT" "obj.get('ok')")" = "true" ] \
   && [ "$(jget "$BODY_OUT" "obj.get('d1')")" = "ok" ]; then
  pass "GET /v1/health -> 200, ok=true, d1=ok"
else
  fail "GET /v1/health -> expected 200/ok/d1=ok, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
fi

# Detect whether this is the local offline dev server (offline-config.sh strips Vectorize,
# Workers AI and Browser Run): every upstream KV key unset, and no BASETEN_URL secret. Any
# check that would need one of those to actually reach the internet skips rather than fails
# when this is true, per the task brief. Given the checks below, none currently need internet
# to pass -- they were chosen to mirror workers/DEPLOY.md's own offline-verified list -- so
# this flag is printed for visibility and is available to gate future checks, not exercised now.
IS_OFFLINE="false"
if [ "$(jget "$BODY_OUT" "obj.get('upstreams',{}).get('solver')")" = "null" ] \
   && [ "$(jget "$BODY_OUT" "obj.get('upstreams',{}).get('search')")" = "null" ] \
   && [ "$(jget "$BODY_OUT" "obj.get('upstreams',{}).get('ingest')")" = "null" ] \
   && [ "$(jget "$BODY_OUT" "obj.get('secrets',{}).get('BASETEN_URL')")" = "false" ]; then
  IS_OFFLINE="true"
fi
echo "info: offline-server mode: $IS_OFFLINE (upstreams unset and no BASETEN_URL)"
echo

# --- 2. Stub layer still answers X-Stub: 1 ---------------------------------------------------

req GET "/v1/rooms/anything" "" "X-Stub: 1"
if [ "$STATUS" = "200" ] && [ "$(jget "$BODY_OUT" "len(obj.get('walls', []))")" = "4" ]; then
  pass "GET /v1/rooms/anything with X-Stub: 1 -> 4 walls from the fixture"
else
  fail "X-Stub stub layer -> expected 200 with 4 walls, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
fi

# --- 3. OPTIONS preflight ---------------------------------------------------------------------

req OPTIONS "/v1/rooms" ""
ALLOW_METHODS="$(header_value "$HDR_OUT" "access-control-allow-methods")"
if [ "$STATUS" = "204" ] && echo "$ALLOW_METHODS" | grep -qi "PUT"; then
  pass "OPTIONS /v1/rooms -> 204, allow-methods includes PUT ($ALLOW_METHODS)"
else
  fail "OPTIONS preflight -> expected 204 with PUT allowed, got status=$STATUS allow-methods=$ALLOW_METHODS"
fi

# --- 4. POST /v1/rooms with the real fixture --------------------------------------------------

FIXTURE_ROOM_ID="$(jget "$FIXTURE" "obj['roomId']")"
ROOM_BODY="$(cat "$FIXTURE")"
req POST "/v1/rooms" "$ROOM_BODY"
ROOM_ID="$(jget "$BODY_OUT" "obj.get('roomId')")"
if [ "$STATUS" = "200" ] && [ "$ROOM_ID" = "$FIXTURE_ROOM_ID" ]; then
  pass "POST /v1/rooms with room-demo.json -> roomId $ROOM_ID"
  remember "room: $ROOM_ID"
else
  fail "POST /v1/rooms -> expected 200 with roomId $FIXTURE_ROOM_ID, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
  ROOM_ID="$FIXTURE_ROOM_ID"
fi

# --- 5. POST /v1/rooms with worldAlignment: gravity -> 422 -------------------------------------

GRAVITY_BODY_FILE="$TMPDIR/gravity_room.json"
python3 -c "
import json
doc = json.load(open('$FIXTURE'))
doc['worldAlignment'] = 'gravity'
doc['roomId'] = '$(uuid4)'
json.dump(doc, open('$GRAVITY_BODY_FILE', 'w'))
"
req POST "/v1/rooms" "$(cat "$GRAVITY_BODY_FILE")"
ERR_CODE="$(jget "$BODY_OUT" "obj.get('error')")"
if [ "$STATUS" = "422" ] && [ "$ERR_CODE" = "bad_world_alignment" ]; then
  pass "POST /v1/rooms with worldAlignment=gravity -> 422 bad_world_alignment"
else
  fail "worldAlignment=gravity -> expected 422 bad_world_alignment, got status=$STATUS error=$ERR_CODE"
fi

# --- 6. GET /v1/rooms/{id} round-trips the walls ------------------------------------------------

req GET "/v1/rooms/$ROOM_ID" ""
if [ "$STATUS" = "200" ] && [ "$(jget "$BODY_OUT" "len(obj.get('walls', []))")" = "4" ]; then
  pass "GET /v1/rooms/$ROOM_ID -> 4 walls round-tripped"
else
  fail "GET /v1/rooms/{id} -> expected 200 with 4 walls, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
fi

# --- 7. POST /v1/objects -> state measured, glbUrl null -----------------------------------------

OBJECT_BODY_FILE="$TMPDIR/object_ok.json"
cat > "$OBJECT_BODY_FILE" <<'EOF'
{
  "source": "catalog",
  "name": "Smoke Test Accent Chair",
  "category": "chair",
  "bboxMeters": { "w": 0.55, "h": 0.85, "d": 0.6 },
  "measure": { "method": "declared", "confidence": 0.4 },
  "price": { "cents": 12900, "currency": "USD" },
  "productUrl": "https://example.com/smoke-test-chair",
  "merchant": "Smoke Test Co"
}
EOF
req POST "/v1/objects" "$(cat "$OBJECT_BODY_FILE")"
OBJECT_ID="$(jget "$BODY_OUT" "obj.get('objectId')")"
if [ "$STATUS" = "200" ] && [ "$(jget "$BODY_OUT" "obj.get('state')")" = "measured" ] \
   && [ "$(jget "$BODY_OUT" "obj.get('glbUrl')")" = "null" ]; then
  pass "POST /v1/objects -> state=measured, glbUrl=null, objectId=$OBJECT_ID"
  remember "object: $OBJECT_ID"
else
  fail "POST /v1/objects -> expected state=measured/glbUrl=null, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
fi

# --- 8. POST /v1/objects with bboxMeters.w=90 -> 422 ---------------------------------------------

BAD_BBOX_BODY_FILE="$TMPDIR/object_bad_bbox.json"
cat > "$BAD_BBOX_BODY_FILE" <<'EOF'
{
  "source": "catalog",
  "name": "Smoke Test Giant Sofa",
  "category": "sofa",
  "bboxMeters": { "w": 90, "h": 1, "d": 1 },
  "measure": { "method": "declared", "confidence": 0.3 }
}
EOF
req POST "/v1/objects" "$(cat "$BAD_BBOX_BODY_FILE")"
ERR_CODE="$(jget "$BODY_OUT" "obj.get('error')")"
if [ "$STATUS" = "422" ] && [ "$ERR_CODE" = "bad_bbox" ]; then
  pass "POST /v1/objects with bboxMeters.w=90 -> 422 bad_bbox"
else
  fail "bboxMeters.w=90 -> expected 422 bad_bbox, got status=$STATUS error=$ERR_CODE"
fi

# --- 9. POST /v1/rooms/{id}/versions with placement.scale=1.4 -> 422 -----------------------------

VER_BAD_BODY_FILE="$TMPDIR/version_bad_scale.json"
python3 -c "
import json
body = {
    'label': 'smoke test bad scale',
    'placements': [{
        'placementId': '$(uuid4)',
        'objectId': '$OBJECT_ID',
        'p': [0.5, 0.0, 0.5],
        'yawDeg': 0.0,
        'scale': 1.4,
        'lockedToWallId': None,
        'flags': [],
    }],
}
json.dump(body, open('$VER_BAD_BODY_FILE', 'w'))
"
req POST "/v1/rooms/$ROOM_ID/versions" "$(cat "$VER_BAD_BODY_FILE")"
ERR_CODE="$(jget "$BODY_OUT" "obj.get('error')")"
if [ "$STATUS" = "422" ] && [ "$ERR_CODE" = "non_unit_scale" ]; then
  pass "POST /v1/rooms/{id}/versions with scale=1.4 -> 422 non_unit_scale"
else
  fail "placement scale=1.4 -> expected 422 non_unit_scale, got status=$STATUS error=$ERR_CODE"
fi

# Setup, not one of the named checks but required plumbing for #13/#14 below: a real, accepted
# version so push/SSE have a versionId that actually exists in D1.
VER_OK_BODY='{"label":"smoke test real version","placements":[]}'
req POST "/v1/rooms/$ROOM_ID/versions" "$VER_OK_BODY"
REAL_VERSION_ID="$(jget "$BODY_OUT" "obj.get('versionId')")"
if [ "$STATUS" = "200" ] && [ -n "$REAL_VERSION_ID" ] && [ "$REAL_VERSION_ID" != "null" ]; then
  pass "POST /v1/rooms/{id}/versions with empty placements -> versionId $REAL_VERSION_ID"
  remember "version: $REAL_VERSION_ID"
else
  fail "setup: could not create a real version, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
fi

# --- 10. Upload mint -> PUT -> GET asset, with CORS -----------------------------------------------

UPLOAD_REQ_BODY="$(python3 -c "import json; print(json.dumps({'kind':'objectFrame','objectId':'$OBJECT_ID','n':0}))")"
req POST "/v1/uploads" "$UPLOAD_REQ_BODY"
UPLOAD_KEY="$(jget "$BODY_OUT" "obj.get('key')")"
PUT_URL="$(jget "$BODY_OUT" "obj.get('putUrl')")"
if [ "$STATUS" != "200" ] || [ -z "$PUT_URL" ] || [ "$PUT_URL" = "null" ]; then
  fail "POST /v1/uploads -> expected 200 with putUrl, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
else
  PAYLOAD="smoke-test-bytes-$(date +%s)-$$"
  req_binary PUT "$PUT_URL" "text/plain" "$PAYLOAD"
  if [ "$STATUS" != "200" ]; then
    fail "PUT to putUrl -> expected 200, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
  else
    req GET "/v1/assets/$UPLOAD_KEY" ""
    ASSET_BODY="$(cat "$BODY_OUT" 2>/dev/null)"
    ACAO="$(header_value "$HDR_OUT" "access-control-allow-origin")"
    if [ "$STATUS" = "200" ] && [ "$ASSET_BODY" = "$PAYLOAD" ] && [ -n "$ACAO" ]; then
      pass "uploads -> PUT -> GET /v1/assets/$UPLOAD_KEY round-trips bytes with CORS ($ACAO)"
      remember "upload key: $UPLOAD_KEY"
    else
      fail "GET /v1/assets/{key} -> expected 200 with matching bytes and CORS, got status=$STATUS acao=$ACAO body=$ASSET_BODY"
    fi
  fi

  # --- 11. Replaying the same upload token -> 401 -------------------------------------------------
  req_binary PUT "$PUT_URL" "text/plain" "replay-attempt"
  ERR_CODE="$(jget "$BODY_OUT" "obj.get('error')")"
  if [ "$STATUS" = "401" ] && [ "$ERR_CODE" = "expired_upload_token" ]; then
    pass "Replaying the upload token -> 401 expired_upload_token"
  else
    fail "Replayed upload token -> expected 401 expired_upload_token, got status=$STATUS error=$ERR_CODE"
  fi
fi

# --- 12. POST /v1/uploads with kind=whatever -> 400 -----------------------------------------------

req POST "/v1/uploads" '{"kind":"whatever"}'
ERR_CODE="$(jget "$BODY_OUT" "obj.get('error')")"
if [ "$STATUS" = "400" ] && [ "$ERR_CODE" = "unknown_upload_kind" ]; then
  pass "POST /v1/uploads with kind=whatever -> 400 unknown_upload_kind"
else
  fail "unknown upload kind -> expected 400 unknown_upload_kind, got status=$STATUS error=$ERR_CODE"
fi

# --- 13. SSE end to end: subscribe, push, see event: version --------------------------------------

if [ -n "$REAL_VERSION_ID" ] && [ "$REAL_VERSION_ID" != "null" ]; then
  SSE_FILE="$TMPDIR/sse_stream.txt"
  : > "$SSE_FILE"
  curl -sN --max-time 15 "$(url_for "/v1/sync/$ROOM_ID")" > "$SSE_FILE" 2>/dev/null &
  SSE_PID=$!

  if wait_for_string "$SSE_FILE" ": connected" 10; then
    PUSH_BODY="$(python3 -c "import json; print(json.dumps({'versionId':'$REAL_VERSION_ID'}))")"
    req POST "/v1/push/$ROOM_ID" "$PUSH_BODY"
    if [ "$STATUS" = "204" ]; then
      if wait_for_string "$SSE_FILE" "event: version" 20; then
        pass "SSE: subscribed to /v1/sync/$ROOM_ID, POST /v1/push delivered event: version within 10s"
      else
        fail "SSE: event: version did not arrive within 10s of the push"
      fi
    else
      fail "SSE setup: POST /v1/push/{roomId} -> expected 204, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
    fi
  else
    fail "SSE: GET /v1/sync/{roomId} never opened (no ': connected' within 5s)"
  fi

  kill "$SSE_PID" >/dev/null 2>&1 || true
  wait "$SSE_PID" 2>/dev/null || true
  SSE_PID=""
else
  fail "SSE end to end -> skipped, no real versionId from the setup step above"
fi

# --- 14. POST /v1/push with a versionId that does not exist -> 404 --------------------------------

MISSING_PUSH_BODY='{"versionId":"00000000-0000-4000-8000-000000000000"}'
req POST "/v1/push/$ROOM_ID" "$MISSING_PUSH_BODY"
ERR_CODE="$(jget "$BODY_OUT" "obj.get('error')")"
if [ "$STATUS" = "404" ] && [ "$ERR_CODE" = "version_not_found" ]; then
  pass "POST /v1/push with an unknown versionId -> 404 version_not_found"
else
  fail "push unknown version -> expected 404 version_not_found, got status=$STATUS error=$ERR_CODE"
fi

# --- 15. POST /v1/search returns an array and an X-Ranker header ----------------------------------

req POST "/v1/search" '{"text":"chair","limit":5}'
RANKER="$(header_value "$HDR_OUT" "x-ranker")"
IS_LIST="$(jget "$BODY_OUT" "isinstance(obj, list)")"
case "$RANKER" in
  vectorize|upstream|vectorize-ranker-unreachable|d1-fallback|relaxed) RANKER_OK=1 ;;
  *) RANKER_OK=0 ;;
esac
if [ "$STATUS" = "200" ] && [ "$IS_LIST" = "true" ] && [ "$RANKER_OK" = "1" ]; then
  pass "POST /v1/search -> array, X-Ranker: $RANKER"
else
  fail "POST /v1/search -> expected 200/array/X-Ranker in {vectorize,upstream,vectorize-ranker-unreachable,d1-fallback,relaxed}, got status=$STATUS ranker=$RANKER body=$(cat "$BODY_OUT" 2>/dev/null)"
fi

# --- 16. The fit filter genuinely excludes --------------------------------------------------------
#
# ceiling: uses two self-created objects tagged with a unique marker ("SmokeFitProbe") rather
# than the real catalog, so the assertion holds via the D1 text-match fallback path (guaranteed
# whenever no embedder answers, see lib/config.ts). Against a live server with a real embedder,
# a text query would instead go through Vectorize, where these ad hoc objects were never
# indexed -- this check is only meaningful against the D1 fallback. That is accepted here
# because DONE MEANS only requires this script to pass against the local offline server, and
# building a Vectorize-backed fixture is exactly the internet-dependent scope the task says to
# leave out.

PROBE_SMALL_FILE="$TMPDIR/probe_small.json"
cat > "$PROBE_SMALL_FILE" <<'EOF'
{
  "source": "catalog",
  "name": "SmokeFitProbe Small Stool",
  "category": "stool",
  "bboxMeters": { "w": 0.15, "h": 0.3, "d": 0.15 },
  "measure": { "method": "declared", "confidence": 0.3 }
}
EOF
PROBE_LARGE_FILE="$TMPDIR/probe_large.json"
cat > "$PROBE_LARGE_FILE" <<'EOF'
{
  "source": "catalog",
  "name": "SmokeFitProbe Large Bench",
  "category": "bench",
  "bboxMeters": { "w": 0.45, "h": 0.45, "d": 0.3 },
  "measure": { "method": "declared", "confidence": 0.3 }
}
EOF

req POST "/v1/objects" "$(cat "$PROBE_SMALL_FILE")"
PROBE_SMALL_STATUS="$STATUS"
PROBE_SMALL_ID="$(jget "$BODY_OUT" "obj.get('objectId')")"
req POST "/v1/objects" "$(cat "$PROBE_LARGE_FILE")"
PROBE_LARGE_STATUS="$STATUS"
PROBE_LARGE_ID="$(jget "$BODY_OUT" "obj.get('objectId')")"

if [ "$PROBE_SMALL_STATUS" = "200" ] && [ "$PROBE_LARGE_STATUS" = "200" ]; then
  remember "probe small: $PROBE_SMALL_ID"
  remember "probe large: $PROBE_LARGE_ID"
  req POST "/v1/search" '{"text":"SmokeFitProbe","fit":{"maxW":0.2},"limit":20}'
  NARROW_COUNT="$(jget "$BODY_OUT" "len(obj)")"
  req POST "/v1/search" '{"text":"SmokeFitProbe","fit":{"maxW":0.5},"limit":20}'
  WIDE_COUNT="$(jget "$BODY_OUT" "len(obj)")"
  if [ -n "$NARROW_COUNT" ] && [ -n "$WIDE_COUNT" ] && [ "$NARROW_COUNT" -lt "$WIDE_COUNT" ] 2>/dev/null; then
    pass "fit filter excludes: maxW=0.2 -> $NARROW_COUNT results, maxW=0.5 -> $WIDE_COUNT results"
  else
    fail "fit filter -> expected maxW=0.2 count < maxW=0.5 count, got narrow=$NARROW_COUNT wide=$WIDE_COUNT"
  fi
else
  fail "fit filter setup -> could not create probe objects, statuses small=$PROBE_SMALL_STATUS large=$PROBE_LARGE_STATUS"
fi

# --- 17. GET /v1/agents/room/{id}/memory -----------------------------------------------------------

req GET "/v1/agents/room/$ROOM_ID/memory" ""
HAS_STATE="$(jget "$BODY_OUT" "isinstance(obj.get('state'), dict)")"
HAS_TRANSCRIPT="$(jget "$BODY_OUT" "isinstance(obj.get('transcript'), list)")"
if [ "$STATUS" = "200" ] && [ "$HAS_STATE" = "true" ] && [ "$HAS_TRANSCRIPT" = "true" ]; then
  pass "GET /v1/agents/room/$ROOM_ID/memory -> state + transcript array"
else
  fail "agent memory -> expected 200 with state/transcript, got status=$STATUS body=$(cat "$BODY_OUT" 2>/dev/null)"
fi

# --- 18. Unknown route -> 404 -----------------------------------------------------------------------

req GET "/v1/this-route-does-not-exist" ""
if [ "$STATUS" = "404" ]; then
  pass "GET /v1/this-route-does-not-exist -> 404"
else
  fail "unknown route -> expected 404, got status=$STATUS"
fi

# --- summary -----------------------------------------------------------------------------------------

echo
echo "== Results: $PASS_N passed, $FAIL_N failed, $SKIP_N skipped =="
if [ "${#CREATED_IDS[@]}" -gt 0 ]; then
  echo
  echo "Created (not deleted -- there is no delete route):"
  for id in "${CREATED_IDS[@]}"; do
    echo "  - $id"
  done
fi

if [ "$FAIL_N" -eq 0 ]; then
  exit 0
else
  exit 1
fi
