-- D1 schema. Authority: .claude/contracts.md "D1 tables". Do not edit without updating there.

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  name TEXT,
  captured_at TEXT,
  north_bearing_deg REAL,
  created_at TEXT
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  room_id TEXT,
  parent_id TEXT,
  label TEXT,
  content_hash TEXT,
  placements_json TEXT,
  materials_json TEXT,
  created_at TEXT
);

CREATE TABLE objects (
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

CREATE TABLE jobs (
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
