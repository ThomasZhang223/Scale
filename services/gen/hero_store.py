"""Local journal, file layout and Worker reads shared by prepare.py and approve.py.

Nothing here calls Baseten. It holds the parts both scripts need and neither may
implement twice: the attempt journal, the per-attempt directory, atomic writes, and
the read of the object row the scripts bind to.

# ceiling: one operator, one laptop. The journal is a local sqlite file and the
# artifacts are plain files under --store. There is no lock across machines and no
# durable server-side review; the upgrade path is the durable review integration Ani's
# plan names, built only if app-triggered generation with a human pause is needed.
"""
import json
import os
import re
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

GEN_ROOT = Path(__file__).resolve().parent
# `app` and `deploy` are top-level packages under services/gen, the same layout
# tests/run_saved_sf3d_binding.py relies on. Without this, `import app.generation_io`
# raises ModuleNotFoundError for `deploy` when a script is launched from another cwd.
sys.path.insert(0, str(GEN_ROOT))
REPO_ROOT = GEN_ROOT.parents[1]

import httpx  # noqa: E402
from app.generation import GenerationError, identifier  # noqa: E402
from app.generation_io import WorkerArtifactSink  # noqa: E402

# ceiling: the default lives outside the checkout because services/gen/.hero/ is not
# gitignored. Move it under the repo only after the root .gitignore covers it.
DEFAULT_STORE = Path.home() / ".local" / "share" / "full-scale" / "hero"

EXIT_REFUSED = 1      # a precondition failed; nothing was sent that changes state
EXIT_RECONCILE = 3    # a paid outcome is unknown or failed; a human must reconcile
EXIT_PROVIDER = 4     # the provider answered with a failure; recorded, never auto-retried
EXIT_UPSTREAM = 5     # the Worker refused or failed; retry the same command

RECONCILE_MESSAGE = "outcome unknown - reconcile by hand, do not resubmit"


class Refusal(Exception):
    """A loud, sanitized stop. `code` becomes the process exit status."""
    def __init__(self, message, code=EXIT_REFUSED):
        super().__init__(message)
        self.code = code


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def resolve_store(value):
    root = Path(value).expanduser().resolve()
    if root == REPO_ROOT or REPO_ROOT in root.parents:
        raise Refusal(f"--store must be outside the repository checkout ({REPO_ROOT}); "
                      "raw and bound meshes must never be committed")
    root.mkdir(parents=True, exist_ok=True)
    return root


def write_atomic(path, data):
    """Write to a temp file in the same directory, then rename over the target."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def write_json(path, value):
    write_atomic(path, (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class Journal:
    """The attempt record. A row is committed BEFORE any network call is made.

    States: in_flight (recorded, no result yet), raw_ok (raw GLB saved), ambiguous
    (timeout or unknown error after sending), rejected (the provider answered with a
    failure). Everything after raw_ok (bound, approved, attached) is derived from the
    files in the attempt directory, not from this table.
    """
    def __init__(self, root):
        self.root = Path(root)
        self.conn = sqlite3.connect(self.root / "journal.sqlite3", timeout=30)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS attempts ("
            " attempt_key TEXT PRIMARY KEY, object_id TEXT NOT NULL, image_sha256 TEXT NOT NULL,"
            " state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
        self.conn.commit()

    def close(self):
        self.conn.close()

    def begin(self, key, object_id, image_sha256):
        """Insert an in_flight row and commit. False means another attempt already owns the key.

        ON CONFLICT DO NOTHING plus the rowcount check is the race guard: a plain INSERT
        would let two processes both proceed to a paid call.
        """
        now = utc_now()
        cursor = self.conn.execute(
            "INSERT INTO attempts (attempt_key, object_id, image_sha256, state, created_at, updated_at)"
            " VALUES (?, ?, ?, 'in_flight', ?, ?) ON CONFLICT(attempt_key) DO NOTHING",
            (key, object_id, image_sha256, now, now))
        self.conn.commit()
        return cursor.rowcount == 1

    def get(self, key):
        return self.conn.execute("SELECT * FROM attempts WHERE attempt_key = ?", (key,)).fetchone()

    def set_state(self, key, state):
        self.conn.execute("UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_key = ?",
                          (state, utc_now(), key))
        self.conn.commit()

    def delete_in_flight(self, key):
        """Drop a row whose provider call never left this process."""
        self.conn.execute("DELETE FROM attempts WHERE attempt_key = ? AND state = 'in_flight'", (key,))
        self.conn.commit()

    def find(self, prefix):
        if not isinstance(prefix, str) or not re.fullmatch(r"[0-9a-f]{8,64}", prefix):
            raise Refusal("--attempt must be at least 8 lowercase hex characters of the attempt key")
        rows = self.conn.execute("SELECT * FROM attempts WHERE attempt_key LIKE ?", (prefix + "%",)).fetchall()
        if not rows:
            raise Refusal(f"no attempt matches {prefix}")
        if len(rows) > 1:
            raise Refusal(f"{prefix} matches {len(rows)} attempts; give more characters")
        return rows[0]


def attempt_dir(root, key):
    return Path(root) / "attempts" / key


def new_client():
    return httpx.Client(timeout=30, follow_redirects=False)


def validated_origin(origin, client):
    """Reuse Ani's origin rule (https, no credentials, no path). Construction does no I/O."""
    try:
        return WorkerArtifactSink(origin, client=client).origin
    except GenerationError as error:
        raise Refusal(f"--worker-origin rejected: {error}") from None


def fetch_object(client, origin, object_id):
    """GET the Object v1 row. A missing row is a refusal; nothing is defaulted."""
    identifier(object_id)
    try:
        response = client.get(f"{origin}/v1/objects/{object_id}")
    except httpx.HTTPError:
        raise Refusal(f"could not reach the Worker to read object {object_id}", EXIT_UPSTREAM) from None
    if response.status_code == 404:
        raise Refusal(f"object {object_id} does not exist on the Worker")
    if response.status_code != 200:
        raise Refusal(f"Worker answered {response.status_code} for GET /v1/objects/{object_id}", EXIT_UPSTREAM)
    try:
        row = response.json()
    except ValueError:
        raise Refusal(f"Worker answer for object {object_id} is not JSON", EXIT_UPSTREAM) from None
    if not isinstance(row, dict) or row.get("objectId") != object_id:
        raise Refusal(f"Worker answered a row that is not object {object_id}")
    if not isinstance(row.get("bboxMeters"), dict):
        raise Refusal(f"object {object_id} has no bboxMeters; refusing to guess a dimension")
    return row


def check_bbox_unchanged(row, recorded):
    """Stale dimensions must not be bound or attached: refuse if the row moved since generate."""
    if row["bboxMeters"] != recorded:
        raise Refusal(f"object {row['objectId']} bboxMeters changed on the Worker since the attempt "
                      f"was recorded ({recorded} -> {row['bboxMeters']}); start a new attempt")
