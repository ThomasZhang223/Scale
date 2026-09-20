-- Additive migration, safe to reapply before deployment. See src/lib/scan-thumb.ts.
--
-- One row per scan whose mesh has been attached and whose picture has not been rendered yet.
-- Written synchronously by POST /v1/objects/{id}/mesh, so acceptance is durable BEFORE any
-- background work starts. Nothing here is best-effort: a row left `pending` is picked up by the
-- one-minute cron for as many attempts as it is allowed, and then says why it stopped.
CREATE TABLE IF NOT EXISTS scan_thumb_jobs (
  object_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,             -- pending | done | failed
  attempts INTEGER NOT NULL,
  error TEXT,
  next_attempt_at TEXT,            -- ISO 8601. NULL means "due now".
  lease_until TEXT,                -- ISO 8601. One runner at a time; an expired lease is free.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The only query the cron runs: the oldest due pending row.
CREATE INDEX IF NOT EXISTS idx_scan_thumb_jobs_due ON scan_thumb_jobs (state, next_attempt_at);
