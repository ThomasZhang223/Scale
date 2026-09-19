"""Local authorized image-key seam for demo photos; not an ingestion service."""
import hashlib
import json
from pathlib import Path
from starlette.concurrency import run_in_threadpool

from .records import digest, require
from .preprocess import InputTooLarge


class ManifestImageReader:
    """Trusted operator manifest; no caller-controlled file path or URL fetching.

    Entries: imageKey, path, sha256, principals. Relative paths use the manifest's
    directory. The same manifest can include corpus and unindexed query photos.
    """
    def __init__(self, manifest):
        path = Path(manifest).resolve(strict=True)
        rows = json.loads(path.read_text(encoding="utf-8"))
        require(isinstance(rows, list), "Image manifest must be a list")
        self.entries = {}
        for row in rows:
            require(isinstance(row, dict) and set(row) == {"imageKey", "path", "sha256", "principals"},
                    "Invalid image manifest entry")
            key, principals = row["imageKey"], row["principals"]
            require(isinstance(key, str) and bool(key) and key not in self.entries, "Duplicate/invalid image key")
            require(isinstance(principals, list) and bool(principals)
                    and all(isinstance(p, str) and p for p in principals), "Explicit principals required")
            target = (path.parent / row["path"]).resolve(strict=True)
            require(target.is_file(), "Image path must be a file")
            self.entries[key] = (target, digest(row["sha256"]), frozenset(principals))

    async def read_authorized(self, key, principal, max_bytes):
        entry = self.entries.get(key)
        if entry is None or principal.subject not in entry[2]:
            raise PermissionError("image_not_authorized")
        def read():
            with entry[0].open("rb") as handle:
                raw = handle.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise InputTooLarge("Image exceeds byte limit")
            if hashlib.sha256(raw).hexdigest() != entry[1]:
                raise OSError("image_content_changed")
            return raw
        return await run_in_threadpool(read)
