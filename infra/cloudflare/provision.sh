#!/usr/bin/env bash
# Create every Cloudflare resource the Worker binds, then write the generated ids into
# workers/wrangler.toml. Safe to re-run: every step tolerates a resource that already exists.
#
# Run this ONCE, after `npx wrangler login`. It touches the Cloudflare account, which is why it
# is a script you run and not something the Worker does at boot.
#
#   cd infra/cloudflare && bash provision.sh
#
# Free-plan notes:
#   * Every resource below is on the Workers Free plan. Nothing here needs the $5 plan.
#   * Containers would need the paid plan. That is why the solver stays on the laptop behind a
#     tunnel instead — see infra/README.md, which the local-edge panel owns.

set -euo pipefail

cd "$(dirname "$0")/../../workers"

BUCKET_NAME="full-scale-objects"
D1_NAME="full-scale-db"
KV_TITLE="full-scale-config"
VECTORIZE_INDEX="objects-v1"
QUEUE_NAME="full-scale-jobs"

w() { npx wrangler "$@"; }

echo "==> Checking login"
if ! w whoami >/dev/null 2>&1; then
	echo "Not logged in. Run: npx wrangler login" >&2
	exit 1
fi
w whoami | sed -n '1,6p'

echo
echo "==> R2 bucket: ${BUCKET_NAME}"
w r2 bucket create "${BUCKET_NAME}" 2>&1 | grep -v "already exists" || true

echo
echo "==> D1 database: ${D1_NAME}"
# `d1 create` prints the id on first creation and errors if it exists, so read it back from the
# list either way rather than parsing the create output.
w d1 create "${D1_NAME}" >/dev/null 2>&1 || true
D1_ID="$(w d1 list --json 2>/dev/null | python3 -c "
import json,sys
for db in json.load(sys.stdin):
    if db.get('name') == '${D1_NAME}':
        print(db['uuid']); break
")"
if [ -z "${D1_ID}" ]; then
	echo "Could not resolve the id for D1 database ${D1_NAME}." >&2
	exit 1
fi
echo "    database_id = ${D1_ID}"

echo
echo "==> KV namespace: ${KV_TITLE}"
w kv namespace create "${KV_TITLE}" >/dev/null 2>&1 || true
KV_ID="$(w kv namespace list 2>/dev/null | python3 -c "
import json,sys
for ns in json.load(sys.stdin):
    if ns.get('title','').endswith('${KV_TITLE}'):
        print(ns['id']); break
")"
if [ -z "${KV_ID}" ]; then
	echo "Could not resolve the id for KV namespace ${KV_TITLE}." >&2
	exit 1
fi
echo "    id = ${KV_ID}"

echo
echo "==> Queue: ${QUEUE_NAME}"
w queues create "${QUEUE_NAME}" 2>&1 | grep -v "already exists" || true

echo
echo "==> Vectorize index: ${VECTORIZE_INDEX} (768 dims, cosine)"
w vectorize create "${VECTORIZE_INDEX}" --dimensions=768 --metric=cosine 2>&1 | grep -v "already exists" || true

echo
echo "==> Vectorize metadata indexes"
# Without these, a $lte range filter on w_mm/h_mm/d_mm silently matches nothing. That failure
# looks exactly like "the catalog is empty", which is the worst way to lose an hour.
for field in w_mm h_mm d_mm; do
	w vectorize create-metadata-index "${VECTORIZE_INDEX}" --property-name="${field}" --type=number 2>&1 |
		grep -v "already exists" || true
done
for field in objectId source category dominant_hex; do
	w vectorize create-metadata-index "${VECTORIZE_INDEX}" --property-name="${field}" --type=string 2>&1 |
		grep -v "already exists" || true
done

echo
echo "==> Writing ids into wrangler.toml"
python3 - "${D1_ID}" "${KV_ID}" <<'PY'
import pathlib, sys
d1_id, kv_id = sys.argv[1], sys.argv[2]
p = pathlib.Path("wrangler.toml")
s = p.read_text()
s = s.replace("PLACEHOLDER_D1_DATABASE_ID", d1_id)
s = s.replace("PLACEHOLDER_KV_NAMESPACE_ID", kv_id)
p.write_text(s)
print("    wrangler.toml updated")
PY

echo
echo "==> Applying the D1 schema (remote)"
w d1 execute "${D1_NAME}" --remote --file=src/schema.sql

echo
echo "==> Regenerating types"
w types >/dev/null

cat <<'NEXT'

Provisioning complete. Three things are still needed before the agents work:

  1. Secrets. UPSTREAM_TOKEN must match what the laptop services check.
       npx wrangler secret put UPSTREAM_TOKEN
       npx wrangler secret put BASETEN_URL        # Ani's endpoint, e.g. https://model-xxx.api.baseten.co/production/predict
       npx wrangler secret put BASETEN_API_KEY

  2. Deploy.
       npm run deploy

  3. Tunnel origins. Start cloudflared (infra/up.sh, owned by the local-edge panel), then:
       bash infra/cloudflare/set-upstreams.sh <solver-url> <search-url> <ingest-url>

  Verify with:  curl https://full-scale-workers.<subdomain>.workers.dev/v1/health
NEXT
