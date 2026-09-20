-- Additive migration, safe to reapply before deployment.
CREATE TABLE IF NOT EXISTS mesh_outbox (
  job_id TEXT PRIMARY KEY,
  params_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_mesh_outbox_delivery ON mesh_outbox (delivered_at);
