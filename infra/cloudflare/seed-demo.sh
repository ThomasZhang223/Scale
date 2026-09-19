#!/usr/bin/env bash
# Demo seed data for the Full Scale backend.
#
# This is DEMO seed data, not measured data. Every object in seed-data.json has
# measure.method "declared" with a confidence below 0.6, because nobody scanned these with
# LiDAR -- the low confidence is the honest signal of that, not a bug to fix later.
#
# Usage:
#   bash seed-demo.sh <base-url>
#   bash seed-demo.sh http://127.0.0.1:8799
#   bash seed-demo.sh https://full-scale-workers.thomaszhangdev.workers.dev
#
# Standing rule 4 (fail loud): the base URL is never defaulted. Missing it is a usage error,
# not a guess at "probably localhost".
#
# Safe to run twice: every object in seed-data.json carries a fixed objectId, and
# POST /v1/objects upserts on that id (INSERT ... ON CONFLICT(id) DO UPDATE in lib/store.ts).
# Re-running this script updates the same twelve rows instead of duplicating them. Merchant
# seeding is keyed on name in ScoutAgent's own table and is idempotent the same way.

set -euo pipefail

if [ "${1-}" = "" ]; then
  echo "usage: bash seed-demo.sh <base-url>" >&2
  echo "  example: bash seed-demo.sh http://127.0.0.1:8799" >&2
  echo "  example: bash seed-demo.sh https://full-scale-workers.thomaszhangdev.workers.dev" >&2
  exit 2
fi

BASE="${1%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_FILE="$SCRIPT_DIR/seed-data.json"

if [ ! -f "$DATA_FILE" ]; then
  echo "seed-data.json not found next to this script at: $DATA_FILE" >&2
  exit 2
fi

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# jget.py: read one JSON file, eval a Python expression against it as `obj`, print the result.
# Same small helper infra/cloudflare/smoke.sh uses -- no jq dependency, python3 only.
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
jget() { python3 "$TMPDIR/jget.py" "$1" "$2"; }

OBJECT_COUNT=$(jget "$DATA_FILE" "len(obj['objects'])")
echo "Seeding ${OBJECT_COUNT} catalog objects to ${BASE} ..."

FAILED=0
for i in $(seq 0 $((OBJECT_COUNT - 1))); do
  BODY_FILE="$TMPDIR/obj_$i.json"
  python3 -c "
import json
doc = json.load(open('$DATA_FILE'))
json.dump(doc['objects'][$i], open('$BODY_FILE', 'w'))
"
  NAME=$(jget "$DATA_FILE" "obj['objects'][$i]['name']")
  RESP_FILE="$TMPDIR/resp_$i.json"
  STATUS=$(curl -sS -o "$RESP_FILE" -w '%{http_code}' -X POST "$BASE/v1/objects" \
    -H "content-type: application/json" --data @"$BODY_FILE")

  if [ "$STATUS" = "200" ]; then
    OBJ_ID=$(jget "$RESP_FILE" "obj['objectId']")
    echo "  ok    ${NAME} -> ${OBJ_ID}"
  else
    echo "  FAIL  ${NAME} -> HTTP ${STATUS}: $(cat "$RESP_FILE")"
    FAILED=1
  fi
done

echo
echo "Seeding merchants to ${BASE}/v1/scout/seed ..."
MERCHANTS_BODY_FILE="$TMPDIR/merchants.json"
python3 -c "
import json
doc = json.load(open('$DATA_FILE'))
json.dump({'merchants': doc['merchants']}, open('$MERCHANTS_BODY_FILE', 'w'))
"
MERCHANT_RESP_FILE="$TMPDIR/merchants_resp.json"
STATUS=$(curl -sS -o "$MERCHANT_RESP_FILE" -w '%{http_code}' -X POST "$BASE/v1/scout/seed" \
  -H "content-type: application/json" --data @"$MERCHANTS_BODY_FILE")

if [ "$STATUS" = "200" ]; then
  MERCHANTS_KNOWN=$(jget "$MERCHANT_RESP_FILE" "obj['merchantsKnown']")
  SESSION_ID=$(jget "$MERCHANT_RESP_FILE" "obj['sessionId']")
  echo "  ok    session ${SESSION_ID} now knows ${MERCHANTS_KNOWN} merchants"
else
  echo "  FAIL  merchant seed -> HTTP ${STATUS}: $(cat "$MERCHANT_RESP_FILE")"
  FAILED=1
fi

echo
if [ "$FAILED" = "1" ]; then
  echo "Seeding finished with failures. See FAIL lines above."
  exit 1
fi
echo "Seeding finished cleanly. Try: curl -X POST ${BASE}/v1/search -H 'content-type: application/json' --data '{\"text\":\"chair\"}'"
exit 0
