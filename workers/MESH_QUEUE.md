# Sequential catalogue generation: teammate deployment runbook

This change has **not been deployed or tested against a live GPU from this checkout**.
The existing Worker health endpoint was reachable on September 19, 2026, with D1
healthy, but `BASETEN_URL` and `BASETEN_API_KEY` were absent. The teammate with the
Cloudflare login should run the following from a fresh checkout, using Node 24+.

## 1. Deploy the queue and Worker

```sh
git pull --ff-only
cd workers
npm ci
npx wrangler login
npm run deploy:mesh
```

For the same checks/build without any deployment or account writes, run
`npm run deploy:mesh -- --check`.

The script typechecks, tests, builds a dry run, applies additive D1 migrations,
deploys the Worker, and displays the deployment and Queue. It uses the existing
resources in `wrangler.toml`; it does not delete or recreate the bucket/database.
For a fresh account, first run `bash infra/cloudflare/provision.sh` from the repo
root. Check that the account/resource IDs are yours. For another Worker hostname,
update `API_ORIGIN` in `wrangler.toml` and pass `--base https://your-worker` to the CLI.

Deployment registers `full-scale-jobs`, its consumer, the SQLite `MeshDispatcher`
Durable Object, both Workflows and a cron trigger every minute. Cron changes can
take several minutes to propagate. No laptop process must stay running to receive
queued items or orchestrate conversions. Scraping and embeddings still need their
configured services; submitting a manifest bypasses the scraper.

## 2. Configure the generation adapter, not the raw SF3D endpoint

**The generation adapter is a remaining prerequisite.** The committed
`services/gen/deploy/sf3d` accepts only `{image_base64}` and returns an **unscaled**
`{kind: "raw_sf3d_unscaled", glb_base64: ...}`. Setting `BASETEN_URL` to it will not
work. The default `services/gen/app/main.py` `/generate` also returns 503 until its
generation handler/provider is configured. Deploying this queue does not deploy
or prove that external model/adapter.

The generation owner must expose the composition described in
[GENERATION_HANDOFF.md](../services/gen/GENERATION_HANDOFF.md): read the selected
image, call Baseten, bind dimensions **once**, validate the result and return the
finished GLB. This Worker sends:

```json
{
  "tier": "live",
  "image_url": "https://your-worker/v1/assets/objects/UUID/frames/0.png",
  "bbox_meters": { "w": 0.8, "h": 0.9, "d": 0.7 },
  "object_id": "UUID",
  "source": "catalog",
  "upload_url": "https://your-worker/v1/uploads",
  "want_embedding": false
}
```

Return `{glbBase64: "...", artifact: {...}}`, or
`{glbKey: "objects/UUID/mesh.glb", artifact: {...}}` after storing the finished mesh
in this bucket. `caption`, `palette`, and the validation `artifact` receipt are
optional; receipts are preserved in R2. The Worker checks headers and object keys;
the generation component remains responsible for geometry, dimensions,
orientation, materials and its review policy. The committed raw SF3D model does
not support a separate quality tier or description-only generation.

Set secrets through interactive prompts; do not commit keys:

```sh
npx wrangler secret put BASETEN_URL
npx wrangler secret put BASETEN_API_KEY
npx wrangler secret put UPSTREAM_TOKEN
npm run mesh:verify
```

Existing secrets need not be replaced. `BASETEN_API_KEY` is sent as
`Authorization: Api-Key ...` to `BASETEN_URL`. When that is a composition service,
use its credential and keep the actual provider key inside that service.
`UPSTREAM_TOKEN` must match the submitter's environment or `infra/.env`.
`mesh:verify` checks deployment/configuration; it makes no paid inference and
does not establish GPU readiness.

## 3. Verify one item, then submit the list

The default file is `services/ingest/prebake/manifest.json` (100 scraped items).
From `workers/`, on Windows, macOS or Linux:

```sh
npm run mesh:submit -- --limit 1 --wait
```

This polls the job and checks that the ready object's GLB actually downloads from
R2 through the Worker. Inspect its dimensions/orientation in the viewer, then:

```sh
npm run mesh:submit -- --limit 100
npm run mesh:status -- --wait --timeout-minutes 120
```

The first item is deduplicated in the full submission. Job IDs derive from stable
catalogue identity + image URL + dimensions; replaying an unchanged list does not
launch new paid inference. If image bytes change at the same URL, provide a
versioned URL. Metadata on an identical accepted job is not refreshed by replay.

For another list: `npm run mesh:submit -- --file /path/to/items.json --limit 20`.
The CLI accepts an array or `{products}`, `{objects}`, or `{items}` and submits
chunks of 25. Job IDs go to `workers/.wrangler/catalog-jobs.json` (gitignored).
Use `--receipt /path/to/batch.json` on submit and status to retain separate batches.
Use `--enqueue-only` to deliberately park jobs before provider secrets exist.

Any scraper can POST that same shape to `/v1/catalog/ingest`, with an
`X-Upstream-Token` header, at most 100 items per request. Every item needs:

- `name` or `title`, and HTTPS JPEG/PNG `imageUrl` or `extraction.imageUrl`.
- Positive `bboxMeters.w`, `.h`, `.d`, each at most 20 metres.
- Identity: `productUrl`, or `merchant` + `productId`, or `objectId`.
- Optional `description`/`body_html` (16,000 characters max), `category`,
  `measure`, `merchant`, `price`.

Description-only or dimensionless records are explicitly rejected.
`IngestMerchantWorkflow` now automatically queues extracted items with images;
its result counts `missingImage`. Writing arbitrary files into R2 alone does not
trigger generation: the source must call intake or run that merchant workflow.

## Runtime and recovery

```text
scraper/manifest -> authenticated intake -> D1 outbox -> cron -> Queue
  -> global MeshDispatcher -> ONE GenerateMeshWorkflow -> adapter -> Baseten
  -> R2 mesh -> D1 ready/done -> optional room notification
```

Queue concurrency alone cannot serialize asynchronous Workflows. The dispatcher
holds its slot until complete, errored or terminated, including sleeps/retries.
Duplicate deliveries reuse the job. Failures release the slot for other objects.
Queue delivery is not FIFO: execution is sequential in dispatcher admission order.
Do not manually start mesh Workflows if all jobs must share this admission slot.

The outbox retries until durable admission, including after queue retention or
retry exhaustion. Alarms advance work; cron also acts as a watchdog. Missing
provider secrets leave jobs waiting. Metadata and frames are persisted when their
generation workflow starts; D1 objects/jobs exist while waiting.

R2 stores `objects/{id}/catalog.json`, `objects/{id}/frames/0.jpg` or `0.png`,
`objects/{id}/mesh.glb`, and optional `objects/{id}/mesh-receipt.json`. Images are
limited to 10 MiB. GLBs are persisted before checkpointing their key, avoiding the
1 MiB workflow result limit. Source downloads and delivery retry; an ambiguous
paid prediction is **not automatically resubmitted**. Embedding failures leave
the mesh ready and record a warning on the done job; similarity search still
requires a configured encoder.

```sh
npx wrangler tail
npx wrangler queues info full-scale-jobs
npx wrangler workflows instances list generate-mesh
npx wrangler d1 execute full-scale-db --remote --command "SELECT state, COUNT(*) FROM jobs GROUP BY state"
npx wrangler d1 execute full-scale-db --remote --command "SELECT COUNT(*) AS undelivered FROM mesh_outbox WHERE delivered_at IS NULL"
npm run mesh:status
```

Status reports failures and checks successful assets; failed batches exit nonzero.
A 422 from raw SF3D or 503 from the default composition service means the adapter
prerequisite remains unresolved. For a failed prediction, inspect the provider's
outstanding requests before explicitly posting `{ "tier": "live" }` to
`/v1/objects/{objectId}/generate` for a new attempt using the saved frame.
Replaying the manifest deliberately does not retry failed paid jobs. Failed image
downloads need a corrected/versioned source URL resubmitted through intake.

Local tests simulate provider and Cloudflare boundaries. No successful live
generation or full-batch processing is claimed until the one-item check passes.
