# workers — Cloudflare Workers

Owner: **Thomas**. Every HTTP route lives here, including `/search` and `/solve`, which this
worker proxies to services owned by Paul (`services/search`) and Justin (`services/fit`,
for `/solve`'s solver) respectively — see `.claude/contracts.md` "Split ownership, stated once".

## Scope

The full `/v1` HTTP surface, R2/D1/Vectorize/Queue bindings, and the per-room SSE fan-out
Durable Object. `.claude/contracts.md` is the authority for every route, schema, and storage key.

## Stub rule

Every route in `src/index.ts` checks for the `X-Stub: 1` header first and, when present, serves
the matching file from `fixtures/` instead of running real logic. This is what lets every other
component build against a fixed contract before any backend logic exists.

## CORS

Every response, including 404s and 501s, carries permissive CORS headers, and `OPTIONS` is
answered directly. Needed so the WebXR runtime in `apps/xr` (a different origin) can call this
Worker from the browser.

## Run

`npm install` once in this directory, then `wrangler dev` locally; fill in the placeholder
resource ids in `wrangler.toml` before deploying.
