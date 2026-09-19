// Secrets are not part of what `wrangler types` generates from wrangler.toml, because a secret
// is never declared there. Declaration merging adds them to the generated global `Env`.
//
// Set with: npx wrangler secret put UPSTREAM_TOKEN
// Locally:  put UPSTREAM_TOKEN=... in workers/.dev.vars (gitignored)
interface Env {
  /** Shared header value proving a request to a tunnelled laptop service came from us. */
  UPSTREAM_TOKEN?: string;
  /** Baseten API key, used by the mesh pipeline when it calls the GPU endpoint directly. */
  BASETEN_API_KEY?: string;
  /** Baseten model endpoint, e.g. https://model-xxxx.api.baseten.co/production/predict */
  BASETEN_URL?: string;
}
