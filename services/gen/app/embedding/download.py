"""Explicit, opt-in acquisition; service startup and tests default to cache-only."""

import argparse
from pathlib import Path

from .config import MODEL_ID, REVISION, FILES


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-download", action="store_true")
    parser.add_argument("--cache-dir", type=Path, required=True)
    args = parser.parse_args()
    if not args.allow_download:
        parser.error("--allow-download is required; no download started")
    from huggingface_hub import snapshot_download
    snapshot = snapshot_download(MODEL_ID, revision=REVISION, cache_dir=args.cache_dir,
                                 allow_patterns=FILES, token=False, max_workers=2)
    assert Path(snapshot).name == REVISION
    print(f"Pinned public checkpoint cached: {snapshot}")


if __name__ == "__main__":
    main()
