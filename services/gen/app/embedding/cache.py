"""Bounded persistent result cache; contains vectors and hashes, never raw inputs."""

import json
from contextlib import contextmanager
from pathlib import Path
import sqlite3
import threading
import time


class EmbeddingCache:
    def __init__(self, path, max_entries=10000):
        if max_entries < 1:
            raise ValueError("Cache capacity must be positive")
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = str(path)
        self.max_entries = max_entries
        # One model worker: guard lookup + inference; busy requests receive 429.
        self.lock = threading.Lock()
        with self.connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("""CREATE TABLE IF NOT EXISTS embeddings (
                fingerprint TEXT, modality TEXT, input_hash TEXT, result TEXT NOT NULL,
                accessed REAL NOT NULL, PRIMARY KEY (fingerprint, modality, input_hash))""")
            db.execute("CREATE INDEX IF NOT EXISTS embeddings_accessed ON embeddings(accessed)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, key):
        with self.connect() as db:
            row = db.execute("SELECT result FROM embeddings WHERE fingerprint=? AND modality=? AND input_hash=?", key).fetchone()
            if row is None:
                return None
            db.execute("UPDATE embeddings SET accessed=? WHERE fingerprint=? AND modality=? AND input_hash=?", (time.time(), *key))
        try:
            return json.loads(row[0])
        except (ValueError, TypeError):
            return None

    def put(self, key, result):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?, ?, ?)",
                       (*key, json.dumps(result, allow_nan=False), time.time()))
            db.execute("""DELETE FROM embeddings WHERE rowid IN (
                SELECT rowid FROM embeddings ORDER BY accessed DESC LIMIT -1 OFFSET ?)""",
                       (self.max_entries,))
