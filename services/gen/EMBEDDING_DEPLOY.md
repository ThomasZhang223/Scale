# CPU embedding service and Cloudflare wiring

Compose service `embedding` builds `services/gen/Dockerfile`, listens on **8004**
inside and outside Docker, and starts with the `local` profile. Search moved to
**8005**. GPU mesh generation still uses `BASETEN_URL`; it is independent of this
CPU container. The image uses the existing hashed Linux x86_64 CPU lock and one
Uvicorn worker. On ARM hosts Docker must emulate linux/amd64.

## Start the container

Set a dedicated `EMBEDDING_API_KEY` in `infra/.env` and change an existing
`SEARCH_PORT=8004` to `SEARCH_PORT=8005`. Never use a Baseten/provider key here.
From the repository root:

```sh
docker compose build embedding
docker compose run --rm --no-deps embedding python -m app.embedding.download --allow-download --cache-dir /models
docker compose up -d embedding
curl http://localhost:8004/ready
```

The explicit download populates the `embedding-models` volume. Normal startup
never downloads weights. `/ready` is 503 until the pinned checkpoint loads;
`/health` is only liveness. Keep the fingerprint returned by this **container**:
the Windows runtime's fingerprint is different.

## Connect Cloudflare

From `workers/`, configure:

```sh
npx wrangler secret put EMBEDDING_API_KEY
npx wrangler kv key put --binding CONFIG "embedding:fingerprint" "<fingerprint-from-ready>" --remote
```

Use the same embedding token on the Worker and container. `infra/up.sh` now starts
an embedding tunnel and publishes `upstream:embedding` alongside the other origins.
For a manually started tunnel, pass its HTTPS origin as the optional fourth
argument to `infra/cloudflare/set-upstreams.sh`, or write `upstream:embedding`
directly to CONFIG. Deploy the updated Worker through the project's normal process.
`GET /v1/health` reports embedding origin, fingerprint and token presence.

The Worker reads image bytes directly from private R2 and sends `imageBase64` to
authenticated `/embed`. Text queries use the same endpoint and `expectedFingerprint`.
No image manifest, public image URL, compatibility flags, R2 credentials in the
container, or Baseten embedding response is needed.

## What is connected

- Catalog generation requests enqueue the API's existing job ID. The
  consumer inserts D1 jobs idempotently and reuses the Workflow on redelivery,
  including when a successful create response was lost. Scan generation starts
  its Workflow directly.
- The mesh Workflow reads object metadata from D1 and a frame from R2, generates
  the mesh through Baseten, obtains an image embedding from the CPU service,
  upserts Vectorize, then marks the D1 object ready and job done. Catalog source
  metadata is preserved. Failure to embed/index fails the job visibly.
- Query and indexed vectors are validated as finite, normalized, 768-dimensional
  values and use the same fingerprint as the Vectorize **namespace**. Existing
  unnamespaced vectors need reindexing; do not copy a Windows fingerprint onto
  Linux vectors. Vectorize mutations become searchable asynchronously.
- With `upstream:embedding` configured, `/v1/search` queries Vectorize and hydrates
  results from D1. This avoids the independent, possibly empty in-memory search
  service shadowing durable Cloudflare data. Without the embedding origin, the
  existing standalone ranker path remains. Embedding failures use the explicit
  `X-Ranker: d1-fallback` path.

## Persistent inference cache

`EMBEDDING_RESULT_CACHE=/data/embeddings.sqlite3` enables SQLite caching in the
`embedding-results` volume. Keys are `(model/runtime fingerprint, modality,
SHA-256 of input)`. Text hashes use the encoder's trim/lowercase policy; image
hashes cover original bytes. Changed images and model runtimes miss automatically.

Only validated successful vectors are saved, with a 10,000-entry LRU ceiling.
Authentication and storage authorization run before lookup; corrupt rows are
recomputed. The cache stores hashes and vectors, not raw images/text. Hits avoid
model inference but still make the HTTP request and, for image keys, read R2.
Concurrent misses return retryable 429; Workflow step retries can reuse the cache
after an interrupted response. This is a single-container cache; multiple replicas
need a shared cache or request coordination. `docker compose down` preserves it;
`down -v` removes both cache and model volumes.

## Verification and remaining limits

```sh
# Node 24+, from workers/
npm run test:embedding
npm run typecheck

# From repo root, with the pinned embedding Python environment
python -m pytest services/gen/tests/test_embedding_contract.py services/gen/tests/test_embedding_preprocess.py services/gen/tests/test_embedding_cache.py -q
```

Validation passed: 40 Python unit checks, two real-model checks, eight Worker tests,
the Worker TypeScript check and Wrangler's deployment dry-run. Worker dependency
installation encountered local filesystem errors; the Worker build was verified
in a clean temporary copy using the committed lockfile.

Worker tests simulate R2, D1, Vectorize, Queue and Workflow bindings; they are not a
deployed Cloudflare smoke test. The real checkpoint image/text tests also ran
successfully using the existing Windows model cache. Docker is unavailable on the
implementation machine, so the Linux image build and live Cloudflare round trip
remain unverified.

Merchant ingest currently creates measured D1 rows only. It does not upload
catalog frames or automatically request pre-bakes. Upload a frame and request
generation (`tier: "live"` is sufficient) to enter the queue/indexing pipeline. Queue consumer concurrency
does **not** cap running Workflows: large catalog batches still need an admission
limiter. Exhausted queue deliveries need operational recovery; no dead-letter
queue is provisioned here. No cloud resources or schema migrations were applied.
