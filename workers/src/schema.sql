-- D1 schema. Authority: .claude/contracts.md "D1 tables". Do not edit without updating there.
--
-- IF NOT EXISTS throughout, so `wrangler d1 execute --file` is safe to re-run. Re-running the
-- provisioning script must never be a destructive act.

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  name TEXT,
  captured_at TEXT,
  north_bearing_deg REAL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  parent_id TEXT,
  label TEXT,
  content_hash TEXT,
  placements_json TEXT,
  materials_json TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS objects (
  id TEXT PRIMARY KEY,
  source TEXT,
  state TEXT,
  name TEXT,
  category TEXT,
  glb_key TEXT,            -- R2 key, never a URL. The API returns glbUrl, built from this.
  bbox_w REAL,
  bbox_h REAL,
  bbox_d REAL,
  measure_method TEXT,
  measure_confidence REAL,
  caption TEXT,
  palette_json TEXT,
  price_cents INTEGER,
  currency TEXT,
  product_url TEXT,
  merchant TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  object_id TEXT,
  kind TEXT,
  tier TEXT,
  state TEXT,
  progress_pct REAL,
  error TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- Indexes for the three queries this backend actually runs on a hot path. D1 is SQLite and
-- writes are not free, so there is one index per real access pattern and no others.

-- GET /v1/rooms/{id}/versions, and the parent lookup on every version write.
CREATE INDEX IF NOT EXISTS idx_versions_room_created ON versions (room_id, created_at);

-- The /v1/search d1-fallback path filters on state and source, then orders by created_at.
CREATE INDEX IF NOT EXISTS idx_objects_state_source ON objects (state, source, created_at);

-- The mesh workflow reads a job by object during a re-run.
CREATE INDEX IF NOT EXISTS idx_jobs_object ON jobs (object_id);
