#!/usr/bin/env bash
# NOTE 2026-09-20: the source GLBs were REMOVED from the repo once this seed had run (the headset
# loads its library from the Worker now). Eight of the eleven were untextured box/cylinder
# placeholders and were later deleted from D1, R2 and Vectorize; `chair`, `sofa` and `xander` remain
# as `source:"primitive"` rows. To add library models, put GLBs in a directory of your own and adapt
# the path below. This script is kept as the record of how the cloud library was built.
#
# Seed the headset's bundled GLB library (apps/xr/public/objects/*.glb) into the cloud, so the
# page can load every model from the Worker instead of from files shipped with the page.
#
# Per model, in order:
#   1. a FIXED objectId: UUIDv5 (namespace NAMESPACE_URL) of "full-scale:library:<file name>",
#      so a re-run upserts the same rows;
#   2. the GLB's bounds, from infra/cloudflare/glb_bounds.py, in the file's own units. glTF is
#      metres by definition. PLAUSIBILITY GATE: the largest side must be 0.05 m to 4 m. A model
#      that fails is NOT rescaled and NOT uploaded: a server object loads at scale 1, so a
#      centimetre file would arrive 100x too big. It is reported and the run exits 1;
#   3. POST /v1/objects (source "primitive");
#   4. the bytes to R2 at objects/<objectId>/mesh.glb, content-type model/gltf-binary;
#   5. the row flipped to ready with glb_key set, by D1 directly;
#   6. POST /v1/objects/<id>/index (token-gated) so agent search can find the model by text.
# Then it verifies every model from the outside: listing, glbUrl status/type/magic/length.
#
# Usage (run from anywhere; needs `npm ci` in workers/ and a logged-in wrangler):
#   bash infra/cloudflare/seed-library.sh https://full-scale-workers.thomaszhangdev.workers.dev
#
# Standing rule 4 (fail loud): the base URL is never defaulted, and a model name with no
# category below stops the run instead of getting a guessed one.
#
# Safe to run twice: same ids, POST /v1/objects upserts, `r2 object put` overwrites, the UPDATE
# is idempotent. One visible effect: the upsert sets state back to "measured" until step 5 of
# the same model runs again (glb_key is kept), so a re-run flickers each row for a moment.
#
# The measurement is "declared", confidence 0.5. Nobody measured a real object: these are
# authored models whose size is whatever the file says, so the low confidence is the honest signal.
#
# ceiling: reads the models from apps/xr/public/objects/, so it stops working once that folder is
# deleted (the owner's plan once the page loads from the cloud). After that the R2 objects are
# the source of truth, and a change to a model means a new file passed in by path.

set -euo pipefail

if [ "${1-}" = "" ]; then
  echo "usage: bash seed-library.sh <base-url>" >&2
  echo "  example: bash seed-library.sh https://full-scale-workers.thomaszhangdev.workers.dev" >&2
  exit 2
fi

BASE="${1%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MODELS_DIR="$REPO_ROOT/apps/xr/public/objects"
LIST_FILE="$REPO_ROOT/apps/xr/public/objects.json"
BOUNDS="$SCRIPT_DIR/glb_bounds.py"
ENV_FILE="$REPO_ROOT/infra/.env"
BUCKET="full-scale-objects"
D1_NAME="full-scale-db"

die() { echo "seed-library: $*" >&2; exit 1; }

[ -f "$LIST_FILE" ] || die "$LIST_FILE not found"
[ -f "$BOUNDS" ] || die "$BOUNDS not found"
[ -d "$REPO_ROOT/workers/node_modules" ] || die "run npm ci in workers/ first (wrangler is a devDependency)"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found (needs UPSTREAM_TOKEN)"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# The token goes to curl through a header file, never through argv, so it is not in `ps`.
TOKEN="$(grep '^UPSTREAM_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[ -n "$TOKEN" ] || die "UPSTREAM_TOKEN is empty in infra/.env"
printf 'x-upstream-token: %s\n' "$TOKEN" > "$TMPDIR/token.hdr"
unset TOKEN

# category for a display name. No default on purpose: a new model must be classified here.
category_for() {
  case "$1" in
    "chair") echo chair ;;
    "sofa") echo sofa ;;
    "xander") echo person ;;            # an Avaturn avatar, not furniture
    "dining table"|"coffee table") echo table ;;
    "tv") echo tv ;;
    "storage") echo storage ;;
    "desk") echo desk ;;
    "bed") echo bed ;;
    "lamp") echo lamp ;;
    "plant") echo plant ;;
    *) return 1 ;;
  esac
}

# ---- Phase 1: measure everything and print the mapping, before anything is uploaded --------
python3 - "$LIST_FILE" > "$TMPDIR/entries.tsv" <<'PY'
import json, os, sys, uuid
for row in json.load(open(sys.argv[1])):
    file = os.path.basename(row["url"])
    print("\t".join([file, row["name"], str(uuid.uuid5(uuid.NAMESPACE_URL, "full-scale:library:" + file))]))
PY

COUNT=$(wc -l < "$TMPDIR/entries.tsv" | tr -d ' ')
echo "Library: ${COUNT} models -> ${BASE}"
printf '%-18s %-14s %-36s %-9s %s\n' file name objectId category "w x h x d (m)"

: > "$TMPDIR/passed.tsv"
GATE_FAILED=0
while IFS=$'\t' read -r FILE NAME OBJ_ID; do
  CAT="$(category_for "$NAME")" || die "no category for model name '$NAME' - add it to category_for()"
  [ -f "$MODELS_DIR/$FILE" ] || die "$MODELS_DIR/$FILE not found"
  python3 "$BOUNDS" "$MODELS_DIR/$FILE" > "$TMPDIR/bounds.json" || die "could not read the bounds of $FILE"
  VERDICT=$(python3 - "$TMPDIR/bounds.json" <<'PY'
import json, sys
b = json.load(open(sys.argv[1]))
w, h, d = b["extent"]
largest = max(w, h, d)
ok = 0.05 <= largest <= 4.0
print(("ok" if ok else "FAIL") + f" {w:.4f} {h:.4f} {d:.4f} {'transformed' if b['transformed'] else 'plain'}")
PY
)
  read -r STATE W H D XFORM <<< "$VERDICT"
  printf '%-18s %-14s %-36s %-9s %s x %s x %s  (%s)\n' "$FILE" "$NAME" "$OBJ_ID" "$CAT" "$W" "$H" "$D" "$XFORM"
  if [ "$STATE" != "ok" ]; then
    echo "  GATE FAIL ${FILE}: largest side outside 0.05 m to 4 m. Nothing uploaded for it. Not rescaled, no unit guessed." >&2
    GATE_FAILED=$((GATE_FAILED + 1))
    continue
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$FILE" "$NAME" "$OBJ_ID" "$CAT" "$W" "$H" "$D" >> "$TMPDIR/passed.tsv"
done < "$TMPDIR/entries.tsv"

# ---- Phase 2: upload the models that passed the gate ---------------------------------------
FAILED=0
while IFS=$'\t' read -r FILE NAME OBJ_ID CAT W H D; do
  echo "== ${NAME} (${OBJ_ID})"
  # objectId is a UUID computed above, never user input: safe to put in the SQL and the R2 key.
  case "$OBJ_ID" in *[!0-9a-f-]*) die "objectId '$OBJ_ID' is not a lowercase UUID" ;; esac

  python3 - "$NAME" "$OBJ_ID" "$CAT" "$W" "$H" "$D" > "$TMPDIR/body.json" <<'PY'
import json, sys
name, oid, cat, w, h, d = sys.argv[1:7]
print(json.dumps({
    "objectId": oid, "source": "primitive", "name": name, "category": cat,
    "bboxMeters": {"w": float(w), "h": float(h), "d": float(d)},
    "measure": {"method": "declared", "confidence": 0.5},
}))
PY
  STATUS=$(curl -sS -o "$TMPDIR/post.json" -w '%{http_code}' -X POST "$BASE/v1/objects" \
    -H 'content-type: application/json' --data @"$TMPDIR/body.json")
  if [ "$STATUS" != "200" ]; then echo "  FAIL  POST /v1/objects -> $STATUS $(cat "$TMPDIR/post.json")" >&2; FAILED=$((FAILED + 1)); continue; fi
  echo "  ok    POST /v1/objects"

  ( cd "$REPO_ROOT/workers" && npx wrangler r2 object put "$BUCKET/objects/$OBJ_ID/mesh.glb" \
      --file "$MODELS_DIR/$FILE" --content-type model/gltf-binary --remote >/dev/null ) \
    || { echo "  FAIL  r2 object put" >&2; FAILED=$((FAILED + 1)); continue; }
  echo "  ok    R2 objects/$OBJ_ID/mesh.glb"

  # ceiling: no HTTP route marks a non-scan, non-generated mesh ready (markObjectReady is called
  # only by the mesh workflow's finalize step, POST /v1/objects/{id}/mesh only accepts scan
  # keys), so this seed writes D1 directly. Upgrade path: a token-gated library-upload route.
  ( cd "$REPO_ROOT/workers" && npx wrangler d1 execute "$D1_NAME" --remote \
      --command "UPDATE objects SET state = 'ready', glb_key = 'objects/$OBJ_ID/mesh.glb' WHERE id = '$OBJ_ID' AND source = 'primitive'" >/dev/null ) \
    || { echo "  FAIL  d1 update" >&2; FAILED=$((FAILED + 1)); continue; }
  echo "  ok    D1 state=ready glb_key set"

  # Search text: the name, plus the category when the name does not already contain it.
  python3 - "$NAME" "$CAT" > "$TMPDIR/index.json" <<'PY'
import json, sys
name, cat = sys.argv[1:3]
print(json.dumps({"text": name if cat in name else f"{name} {cat}"}))
PY
  STATUS=$(curl -sS -o "$TMPDIR/index.out" -D "$TMPDIR/index.hdr" -w '%{http_code}' -X POST "$BASE/v1/objects/$OBJ_ID/index" \
    -H 'content-type: application/json' -H @"$TMPDIR/token.hdr" --data @"$TMPDIR/index.json")
  if [ "$STATUS" != "200" ]; then echo "  FAIL  index -> $STATUS $(cat "$TMPDIR/index.out")" >&2; FAILED=$((FAILED + 1)); continue; fi
  XI=$(grep -i '^x-indexed' "$TMPDIR/index.hdr" | tr -d '\r' || true)
  echo "  ok    index -> $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("modality="+d["modality"], "fingerprint="+d["fingerprint"][:12]+"...")' "$TMPDIR/index.out") ${XI:+($XI)}"
done < "$TMPDIR/passed.tsv"

# ---- Phase 3: verify from the outside ------------------------------------------------------
echo "== verify"
EXPECTED=$(wc -l < "$TMPDIR/passed.tsv" | tr -d ' ')
curl -sS "$BASE/v1/objects?source=primitive&limit=50" > "$TMPDIR/list.json"
python3 - "$TMPDIR/list.json" "$TMPDIR/passed.tsv" "$EXPECTED" <<'PY' || FAILED=$((FAILED + 1))
import json, sys
rows = json.load(open(sys.argv[1]))
want = {l.split("\t")[2] for l in open(sys.argv[2]).read().splitlines() if l}
have = {r["objectId"] for r in rows}
bad = [r["name"] for r in rows if r["objectId"] in want and (r["state"] != "ready" or not r.get("glbUrl"))]
print(f"listing: {len(rows)} primitive rows, expected {sys.argv[3]}, missing {len(want - have)}, not ready/no glbUrl {len(bad)}")
sys.exit(0 if not (want - have) and not bad else 1)
PY
while IFS=$'\t' read -r FILE NAME OBJ_ID CAT W H D; do
  URL=$(python3 -c 'import json,sys; print(next(r["glbUrl"] for r in json.load(open(sys.argv[1])) if r["objectId"]==sys.argv[2]))' "$TMPDIR/list.json" "$OBJ_ID" 2>/dev/null || true)
  if [ -z "$URL" ]; then echo "  FAIL  ${NAME}: no glbUrl in the listing" >&2; FAILED=$((FAILED + 1)); continue; fi
  CODE=$(curl -sS -o "$TMPDIR/dl.glb" -D "$TMPDIR/dl.hdr" -w '%{http_code}' "$URL")
  CTYPE=$(grep -i '^content-type' "$TMPDIR/dl.hdr" | tr -d '\r' | cut -d' ' -f2- || true)
  MAGIC=$(head -c 4 "$TMPDIR/dl.glb")
  GOT=$(wc -c < "$TMPDIR/dl.glb" | tr -d ' ')
  WANT=$(wc -c < "$MODELS_DIR/$FILE" | tr -d ' ')
  if [ "$CODE" = "200" ] && [ "$CTYPE" = "model/gltf-binary" ] && [ "$MAGIC" = "glTF" ] && [ "$GOT" = "$WANT" ]; then
    echo "  ok    ${NAME}: 200 ${CTYPE} glTF ${GOT} bytes"
  else
    echo "  FAIL  ${NAME}: http=${CODE} type=${CTYPE} magic=${MAGIC} bytes=${GOT} want=${WANT}" >&2
    FAILED=$((FAILED + 1))
  fi
done < "$TMPDIR/passed.tsv"

echo
echo "uploaded ${EXPECTED} of ${COUNT}; gate failures ${GATE_FAILED}; other failures ${FAILED}"
if [ "$GATE_FAILED" -ne 0 ] || [ "$FAILED" -ne 0 ]; then exit 1; fi
