/*
 * A picture of every scan, rendered in the pipeline, with no headset in the loop.
 *
 * Object Capture uploads a mesh and nothing else. A scan row's name is "Captured object" and
 * its category is "unknown", so indexing a scan from its text puts every scan on the SAME point
 * in the embedding space and no query can tell two apart — measured: chair, lamp and sofa each
 * returned all three indexed scans with one identical score to four decimals.
 *
 * The headset fixed that by rendering the mesh and posting the render to
 * POST /v1/objects/{id}/thumbnail. That works, and it stays. But it only happens if a headset
 * is running and has drawn that tile. This module does the same thing the moment the mesh is
 * attached: it opens P-UX's standalone render page in Cloudflare Browser Rendering, takes the
 * JPEG, and feeds it to the SAME indexObject path the thumbnail route uses. One renderer, one
 * indexer, two triggers.
 *
 * Why this is not a ctx.waitUntil. A thumbnail upload once answered 202 "indexed: pending"
 * while the index inside its waitUntil threw and vanished; it was found with `wrangler tail`,
 * not by anything the system said about itself. So acceptance is a D1 row written before the
 * response, the one-minute cron is the thing that actually runs the work, and every outcome —
 * including every failure and its reason — is recorded on that row and readable on
 * GET /v1/objects/{id} and GET /v1/health.
 */
import { HttpError } from "./http";
import { R2Keys, sniffImageType } from "./keys";
import { indexObject } from "./embedding";
import { getObject } from "./store";
import type { ObjectV1 } from "./contracts";

/** How many times one object may be attempted before the row stops at `failed`. */
export const MAX_ATTEMPTS = 4;
/** First backoff, doubled per attempt. 60 s, 120 s, 240 s — inside one demo, not hours. */
const BACKOFF_BASE_MS = 60_000;
/** A claim is held this long. Longer than a render (about 1-3 s) plus an embed (up to 25 s). */
const LEASE_MS = 90_000;
/** The page's own timeout is 25 s; the browser must outlive it to see thumb-error as an error. */
const SELECTOR_TIMEOUT_MS = 27_000;

export type ThumbState = "pending" | "done" | "failed";

export interface ThumbJobRow {
  object_id: string;
  state: ThumbState;
  attempts: number;
  error: string | null;
  next_attempt_at: string | null;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The origin that serves the render page.
 *
 * A [vars] entry rather than a KV key, deliberately: KV holds the four upstream origins because
 * those are quick-tunnel URLs that get a new hostname on every `infra/up.sh`. The headset origin
 * does not rotate, so a KV key would be an unversioned manual step that a fresh environment
 * silently lacks. Standing rule 4 still applies — unset, or not https, raises rather than
 * guessing an origin.
 */
export function renderOrigin(env: Env): string {
  const origin = env.RENDER_ORIGIN;
  if (!origin || !origin.startsWith("https://")) {
    throw new HttpError(
      503,
      "render_origin_unset",
      `RENDER_ORIGIN is ${JSON.stringify(origin ?? null)}; it must be the https origin that serves /thumb.`,
      `Set RENDER_ORIGIN in workers/wrangler.toml [vars] to the xr origin, then redeploy.`,
    );
  }
  return origin.replace(/\/+$/, "");
}

/**
 * Render one GLB to a 512-square JPEG in Cloudflare Browser Rendering.
 *
 * The completion signal is the CANVAS, not JavaScript. `quickAction` has no evaluate action, so
 * `window.__thumb` is out of reach — but apps/xr/src/thumb.ts appends its finished canvas to the
 * body ONLY on the success path, and `waitForSelector` makes the browser service wait for
 * exactly that. A refusal, a render failure and the page's own 25 s timeout all set
 * document.title and append nothing, so they arrive here as a selector timeout, which is an
 * error — which is what they are.
 *
 * `selector` then screenshots that one element, so the bytes are the picture and nothing else.
 * renderThumbnail() hands back a plain 2D canvas rather than the WebGL one, so the pixels are
 * still there when the screenshot is taken instead of a cleared drawing buffer.
 *
 * Deliberately NOT `bestAttempt: true`. Best-attempt would answer a failed render with a
 * screenshot of the empty white page, and a blank picture would be embedded as though it were
 * the object. A failure has to stay a failure.
 *
 * ceiling: a failure arrives as the browser's selector timeout, so the recorded reason names
 * the timeout rather than the page's own thumb-error text. Reading that text needs a second
 * browser action, and a second action fired immediately after the first returns HTTP 429. The
 * upgrade path is a DOM element carrying the error, which would let one screenshot call return
 * either outcome.
 */
export async function renderThumbJpeg(env: Env, meshKey: string): Promise<Uint8Array> {
  // A path, not an absolute URL: apps/xr/src/thumbUrl.ts resolves it against the page's own
  // origin and refuses anything that is not same-origin and under /v1/assets/.
  const glb = `/v1/assets/${meshKey}`;
  // /thumb, not /thumb.html: Cloudflare Assets answers the second with a 307.
  const url = `${renderOrigin(env)}/thumb?glb=${encodeURIComponent(glb)}`;
  const res = await env.BROWSER.quickAction("screenshot", {
    url,
    viewport: { width: 512, height: 512 },
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 30_000 },
    waitForSelector: { selector: "canvas", timeout: SELECTOR_TIMEOUT_MS },
    selector: "canvas",
    // Quality is 0-100 here and 0-1 in the canvas API; 90 is the page's own JPEG_QUALITY 0.9.
    screenshotOptions: { type: "jpeg", quality: 90 },
    // The picture of a mesh that was just attached must not come from a cached page.
    cacheTTL: 0,
  });
  if (!res.ok) {
    throw new Error(`Browser Rendering returned ${res.status} for ${url}: ${(await res.text()).slice(0, 300)}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  // The bytes decide, same rule as the upload route: an error page rendered as JSON would
  // otherwise be stored under a .jpg key and sent to the encoder.
  if (sniffImageType(bytes) !== "image/jpeg") {
    throw new Error(`Browser Rendering returned ${bytes.byteLength} bytes that are not a JPEG.`);
  }
  return bytes;
}

/**
 * Store a scan's picture under its own key. The one writer of scans/{id}/thumb.jpg.
 * Shared by the render step and POST /v1/objects/{id}/thumbnail so there is not a second
 * key rule or a second content-type rule to drift.
 */
export async function putScanThumb(env: Env, objectId: string, bytes: Uint8Array): Promise<void> {
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new HttpError(415, "not_an_image", "The body is neither PNG nor JPEG.");
  await env.BUCKET.put(R2Keys.scanThumb(objectId), bytes, { httpMetadata: { contentType } });
}

/**
 * Image-embed a stored picture into Vectorize. The argument mapping the thumbnail route, the
 * index route and this module all need — written once so a new metadata field reaches all three.
 */
export function indexObjectImage(env: Env, object: ObjectV1, imageKey: string) {
  return indexObject(env, {
    objectId: object.objectId,
    source: object.source,
    category: object.category,
    bboxMeters: object.bboxMeters,
    dominantHex: object.palette?.[0] ?? null,
    imageKey,
  });
}

/**
 * Accept the work, durably, before the response goes out.
 *
 * ceiling: scans only. A catalogue row already has a real product photo and a primitive is
 * already indexed from a real name, and POST /v1/objects/{id}/thumbnail refuses both for that
 * reason — a render would make their vectors worse, and embedInput's key allow-list does not
 * carry objects/{id}/thumb.jpg. The upgrade path, if a sourceless row ever needs this, is that
 * key in the allow-list and the caller's own reason for preferring a render to its own photo.
 */
export async function enqueueScanThumb(env: Env, objectId: string, at: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO scan_thumb_jobs
       (object_id, state, attempts, error, next_attempt_at, lease_until, created_at, updated_at)
     VALUES (?, 'pending', 0, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(object_id) DO NOTHING`,
  ).bind(objectId, at, at).run();
}

/** The recorded state of one object's picture, or null when none was ever accepted. */
export async function getThumbJob(env: Env, objectId: string): Promise<ThumbJobRow | null> {
  return env.DB.prepare("SELECT * FROM scan_thumb_jobs WHERE object_id = ?")
    .bind(objectId).first<ThumbJobRow>();
}

/** POST /v1/objects/{id}/thumbnail won the race: the picture exists and is indexed. */
export async function markThumbDone(env: Env, objectId: string, at: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE scan_thumb_jobs SET state = 'done', error = NULL, lease_until = NULL, updated_at = ? WHERE object_id = ?",
  ).bind(at, objectId).run();
}

/**
 * Take the claim on one due job, or return null because somebody else holds it.
 *
 * A single UPDATE is atomic in SQLite, so the row's own state is the lock: the cron and the
 * fast path can both fire and only one of them renders. `attempts` is incremented as part of
 * the claim, which is what makes retries bounded even if a runner dies mid-render — the lease
 * expires, the next tick takes the claim, and the count has already moved.
 */
async function claim(env: Env, objectId: string, now: Date): Promise<ThumbJobRow | null> {
  const at = now.toISOString();
  const result = await env.DB.prepare(
    `UPDATE scan_thumb_jobs SET attempts = attempts + 1, lease_until = ?, updated_at = ?
      WHERE object_id = ? AND state = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_until IS NULL OR lease_until <= ?)`,
  ).bind(new Date(now.getTime() + LEASE_MS).toISOString(), at, objectId, at, at).run();
  if (!result.meta.changes) return null;
  return getThumbJob(env, objectId);
}

/** Record why an attempt failed, and whether another one is coming. */
async function recordFailure(env: Env, objectId: string, attempts: number, error: string, now: Date): Promise<void> {
  const reason = error.slice(0, 500);
  const at = now.toISOString();
  if (attempts >= MAX_ATTEMPTS) {
    await env.DB.prepare(
      "UPDATE scan_thumb_jobs SET state = 'failed', error = ?, lease_until = NULL, next_attempt_at = NULL, updated_at = ? WHERE object_id = ?",
    ).bind(`after ${attempts} attempts: ${reason}`, at, objectId).run();
    return;
  }
  const delay = BACKOFF_BASE_MS * 2 ** (attempts - 1);
  await env.DB.prepare(
    "UPDATE scan_thumb_jobs SET error = ?, lease_until = NULL, next_attempt_at = ?, updated_at = ? WHERE object_id = ?",
  ).bind(`attempt ${attempts}: ${reason}`, new Date(now.getTime() + delay).toISOString(), at, objectId).run();
}

/**
 * The fallback the permanent failure leaves behind.
 *
 * If no picture can be made, a text vector is still better than no vector: it is exactly what
 * this row would have had before any of this existed. It is not a guessed value and it is not
 * silent — the job row still says `failed` and still says why. Without embeddable text there is
 * nothing to write and the object stays unsearchable, which is also recorded.
 */
async function indexFromTextAsFloor(env: Env, object: ObjectV1): Promise<void> {
  const text = [object.name, object.category].filter((p) => p && p !== "unknown").join(" ").trim();
  if (!text) return;
  await indexObject(env, {
    objectId: object.objectId,
    source: object.source,
    category: object.category,
    bboxMeters: object.bboxMeters,
    dominantHex: object.palette?.[0] ?? null,
    text,
  });
}

/**
 * One attempt at one object: render if there is no picture yet, then index, then record done.
 *
 * An existing scans/{id}/thumb.jpg skips the RENDER but never the index. That is the expensive
 * half saved and the cheap half repeated, and repeating the cheap half is the point: the index
 * is an upsert on the object's own vector id, so running it twice costs one encoder call and
 * REPAIRS the exact failure this module exists for — a headset that stored a picture while its
 * own background index threw.
 */
export async function runThumbJob(
  env: Env,
  objectId: string,
  now = new Date(),
): Promise<"done" | "skipped" | "failed"> {
  const claimed = await claim(env, objectId, now);
  if (!claimed) return "skipped";
  let object: ObjectV1 | undefined;
  try {
    // API_ORIGIN only decides the glbUrl that getObject builds, and nothing on this path reads
    // it — the index uses the R2 key, never a URL. It is a configured var, not a guessed origin.
    object = await getObject(env, objectId, env.API_ORIGIN);
    if (object.source !== "scan") throw new Error(`source is "${object.source}"; only a scan takes a rendered thumbnail.`);
    const meshKey = R2Keys.scanMesh(objectId);
    const key = R2Keys.scanThumb(objectId);
    if (!(await env.BUCKET.head(key))) {
      await putScanThumb(env, objectId, await renderThumbJpeg(env, meshKey));
    }
    await indexObjectImage(env, object, key);
    await markThumbDone(env, objectId, new Date().toISOString());
    return "done";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await recordFailure(env, objectId, claimed.attempts, reason, new Date());
    if (claimed.attempts >= MAX_ATTEMPTS && object) {
      // Best effort, and its own failure must not hide the one above.
      await indexFromTextAsFloor(env, object).catch((err: unknown) =>
        console.error(`scan_thumb_text_floor_failed ${objectId}: ${String(err).slice(0, 200)}`));
    }
    console.error(`scan_thumb_failed ${objectId} attempt ${claimed.attempts}: ${reason.slice(0, 300)}`);
    return "failed";
  }
}

/**
 * The cron's share of the work: ONE object per tick.
 *
 * One, because a second Browser Rendering action fired straight after the first answers HTTP
 * 429, and because this cron also relays the mesh outbox — a tick that took four renders would
 * make the outbox wait on browsers. At one per minute a backlog drains slowly and visibly,
 * which is the right trade for a path whose fast case never reaches the cron at all.
 */
export async function runScanThumbJobs(env: Env): Promise<void> {
  const now = new Date();
  const at = now.toISOString();
  const due = await env.DB.prepare(
    `SELECT object_id FROM scan_thumb_jobs
      WHERE state = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        AND (lease_until IS NULL OR lease_until <= ?)
      ORDER BY created_at LIMIT 1`,
  ).bind(at, at).first<{ object_id: string }>();
  if (!due) return;
  await runThumbJob(env, due.object_id, now);
}

/** What GET /v1/health says about this path. Counts, and the newest failure with its reason. */
export async function thumbHealth(env: Env): Promise<Record<string, unknown>> {
  const { results } = await env.DB.prepare(
    "SELECT state, COUNT(*) AS n FROM scan_thumb_jobs GROUP BY state",
  ).all<{ state: string; n: number }>();
  const counts: Record<string, number> = { pending: 0, done: 0, failed: 0 };
  for (const row of results ?? []) counts[row.state] = row.n;
  const worst = await env.DB.prepare(
    "SELECT object_id, state, attempts, error, updated_at FROM scan_thumb_jobs WHERE error IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
  ).first<{ object_id: string; state: string; attempts: number; error: string; updated_at: string }>();
  let renderOriginConfigured = true;
  try {
    renderOrigin(env);
  } catch {
    renderOriginConfigured = false;
  }
  return { ...counts, renderOriginConfigured, maxAttempts: MAX_ATTEMPTS, lastError: worst ?? null };
}
