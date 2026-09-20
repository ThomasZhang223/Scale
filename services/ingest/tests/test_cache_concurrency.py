"""The page cache under a thread pool. Run: python3 tests/test_cache_concurrency.py

Step 2.5 fetches from worker threads now, so CachedFetch is shared mutable state: a counter
and a file per URL. The file matters more than the counter — a truncated read looks exactly
like a merchant that lists no dimensions, and this pipeline would believe it.
"""

import sys, pathlib, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.browserbase import CachedFetch, FetchResult

BIG = "<html><body>" + ("x" * 200_000) + "</body></html>"


class SlowUpstream:
    """Writes slowly enough that a truncating writer would be visible to a reader."""
    def __init__(self, body=BIG): self.body, self.calls = body, []
    def fetch(self, url):
        self.calls.append(url)
        time.sleep(0.02)
        return FetchResult(url=url, status_code=200, content=self.body,
                           content_type="text/html")


def test_parallel_fetches_of_different_urls_all_land_intact():
    with tempfile.TemporaryDirectory() as d:
        up = SlowUpstream()
        c = CachedFetch(d, upstream=up)
        urls = [f"https://s.com/products/item-{i}" for i in range(24)]
        with ThreadPoolExecutor(max_workers=8) as ex:
            results = list(ex.map(c.fetch, urls))
        assert all(r.content == BIG for r in results), "a page came back truncated"
        assert c.misses == 24, f"misses={c.misses}, want 24 (a lost counter increment)"
        # Re-read from cache: every file on disk must be complete.
        with ThreadPoolExecutor(max_workers=8) as ex:
            again = list(ex.map(c.fetch, urls))
        assert all(r.content == BIG for r in again), "a cached page on disk was truncated"
        assert c.hits == 24, f"hits={c.hits}, want 24"


def test_the_destination_file_is_never_observably_partial():
    """The one that matters, and the one that has to be able to fail.

    A reader decides on os.path.exists. If the writer truncates the destination and fills it
    in place, a reader arriving mid-write gets a short page — which this pipeline reads as
    "this merchant lists no dimensions", a wrong answer wearing a right answer's clothes.

    So: write a body big enough that the write takes real time, and poll the destination
    throughout. Against open(path,"w") the poller catches a short file. Against temp-then-
    os.replace the path does not exist until it is complete, and then it is complete.
    """
    huge = "<html>" + ("y" * 40_000_000) + "</html>"      # ~40 MB, hundreds of ms to write
    with tempfile.TemporaryDirectory() as d:
        c = CachedFetch(d, upstream=SlowUpstream(huge))
        url = "https://s.com/products/contested"
        path = c._path(url)

        partials, stop = [], threading.Event()

        def poll():
            while not stop.is_set():
                try:
                    size = pathlib.Path(path).stat().st_size
                except OSError:
                    continue                      # not there yet — the correct state
                if size != len(huge):
                    partials.append(size)
                    return

        watcher = threading.Thread(target=poll, daemon=True)
        watcher.start()
        c.fetch(url)
        stop.set()
        watcher.join(timeout=5)

        assert not partials, (
            f"a reader saw {partials[0]} bytes of a {len(huge)}-byte page — "
            "the destination was written in place")
        assert pathlib.Path(path).stat().st_size == len(huge)


def test_no_temp_files_are_left_behind():
    with tempfile.TemporaryDirectory() as d:
        c = CachedFetch(d, upstream=SlowUpstream())
        with ThreadPoolExecutor(max_workers=8) as ex:
            list(ex.map(c.fetch, [f"https://s.com/p/{i}" for i in range(12)]))
        leftovers = [p.name for p in pathlib.Path(d).iterdir() if p.name.endswith(".tmp")]
        assert not leftovers, f"left {len(leftovers)} temp files behind: {leftovers[:3]}"


def test_a_failing_upstream_leaves_no_partial_cache_entry():
    class Boom:
        def fetch(self, url): raise RuntimeError("upstream died mid-render")
    with tempfile.TemporaryDirectory() as d:
        c = CachedFetch(d, upstream=Boom())
        try:
            c.fetch("https://s.com/p/1")
        except RuntimeError:
            pass
        assert not list(pathlib.Path(d).iterdir()), "a failed fetch left a cache file"


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn(); print(f"PASS {name}")
            except Exception as e:
                print(f"FAIL {name}: {type(e).__name__}: {e}"); fails += 1
    print(f"\n{fails} failed")
    sys.exit(1 if fails else 0)
