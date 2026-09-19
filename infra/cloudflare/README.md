# infra/cloudflare — account-side provisioning

Owner: Thomas, written by the Cloudflare infra panel. Everything in this directory touches the
Cloudflare **account**. The laptop side — `cloudflared`, Docker, the solver container — lives in
`infra/` alongside this and is owned by the local-edge panel.

The full reasoning and the runbook are in `workers/DEPLOY.md`. This is the index.

| Script | What it does | How often |
| --- | --- | --- |
| `provision.sh` | Creates the R2 bucket, D1 database, KV namespace, Queue and the `objects-v1` Vectorize index with its seven metadata indexes. Writes the generated ids into `workers/wrangler.toml` and applies the D1 schema. | Once. Safe to re-run. |
| `set-upstreams.sh` | Writes the three `upstream:*` KV keys that tell the Worker where the laptop services are. | Every time `cloudflared` restarts, because a quick tunnel gets a new random hostname. |
| `offline-config.sh` | Generates `workers/.wrangler.offline.toml` with the remote-only bindings stripped, so `wrangler dev` runs with no account and no network. | Whenever `wrangler.toml` changes. |

## The three KV keys

```
upstream:solver   services/fit     (container port 8000)   POST /solve, POST /fit
upstream:search   services/search  (container port 8080)   POST /search  — optional re-ranker
upstream:ingest   services/ingest  (container port 8080)   reserved
```

There is no fallback origin and no "first registered service". An unset key makes the route
answer 503 naming the exact `wrangler kv key put` that fixes it. A fallback would be silently
wrong the moment a second service exists, and would look correct in every test until the demo.

## Prerequisites this does not install

- `npx wrangler login`, once. `provision.sh` refuses to run without it.
- `cloudflared`, which is the local-edge panel's concern, not this one.
