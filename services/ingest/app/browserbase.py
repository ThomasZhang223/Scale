"""Browserbase Fetch client for step 2.5. See ../EXTRACTION.md.

Fetch, not Browser Automation: a Shopify product page renders its metafields server-side, so a
plain HTTP fetch through Browserbase gets the dimensions without spending a browser hour. Fall
back to the browser (`browse open --remote`) only for a store that renders specs in JS — start
simple, per Browserbase's own guidance.

The transport is injected so the whole pipeline is testable without an API key or network, the
same way the /products.json verifier is. `BrowserbaseFetch` is the real one.

Untrusted input: page content is remote data. Nothing here or downstream treats it as
instructions, and any LLM pass over it must stay on a constrained output schema.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
from dataclasses import dataclass

API_URL = "https://api.browserbase.com/v1/fetch"

# Fetch's documented failures. 429 is a CONCURRENCY limit, not a quota, and 502/503/504 are
# transient upstream trouble — all clear on their own, so all are worth retrying. A first real
# run lost four products to bare 503s that a single retry would very likely have caught.
RETRY_STATUS = {429, 502, 503, 504}
MAX_RETRIES = 3
BACKOFF_S = 1.5


class FetchError(RuntimeError):
    def __init__(self, status: int | None, message: str):
        super().__init__(message)
        self.status = status


@dataclass
class FetchResult:
    url: str
    status_code: int
    content: str
    content_type: str | None = None
    request_id: str | None = None


class BrowserbaseFetch:
    """POST /v1/fetch. Needs BROWSERBASE_API_KEY."""

    def __init__(self, api_key: str | None = None, *, timeout: float = 30.0, client=None):
        self.api_key = api_key or os.environ.get("BROWSERBASE_API_KEY")
        if not self.api_key:
            # standing rule 4: no silent fallback to a direct request, which would defeat the
            # point (anti-bot, rate limits) and quietly change what the pipeline is doing.
            raise ValueError(
                "BROWSERBASE_API_KEY is not set. Step 2.5 needs it; run the pipeline without "
                "--browserbase to skip the rendered-page pass."
            )
        self._timeout = timeout
        self._client = client

    def fetch(self, url: str) -> FetchResult:
        import httpx

        client = self._client or httpx.Client(timeout=self._timeout)
        last: Exception | None = None
        for attempt in range(MAX_RETRIES):
            try:
                r = client.post(
                    API_URL,
                    headers={"X-BB-API-Key": self.api_key, "Content-Type": "application/json"},
                    json={"url": url, "allowRedirects": True},
                )
            except httpx.HTTPError as e:
                last = FetchError(None, f"{type(e).__name__}: {e}")
            else:
                if r.status_code in RETRY_STATUS:
                    last = FetchError(r.status_code, _explain(r.status_code))
                elif r.status_code >= 400:
                    raise FetchError(r.status_code, _explain(r.status_code))
                else:
                    body = r.json()
                    return FetchResult(
                        url=url,
                        status_code=int(body.get("statusCode", r.status_code)),
                        content=body.get("content") or "",
                        content_type=body.get("contentType"),
                        request_id=body.get("id"),
                    )
            if attempt < MAX_RETRIES - 1:
                time.sleep(BACKOFF_S * (attempt + 1))
        raise last or FetchError(None, "fetch failed with no error recorded")


def _explain(status: int) -> str:
    return {
        400: "invalid request body",
        403: "invalid or missing BROWSERBASE_API_KEY",
        429: "concurrent request limit exceeded — slow down, this clears on its own",
        502: "response too large, TLS verification failed, or a transient upstream error",
        503: "upstream temporarily unavailable — transient, retried",
        504: "request timed out",
    }.get(status, f"HTTP {status}")


class CachedFetch:
    """Fetch through a directory of saved pages.

    Not a trick for the demo: a crawl that re-fetches every page on every run is slow, rude to
    the merchant, and burns browser hours. The cache is how the pipeline is developed and how
    the pre-bake is reproducible — and it is why the demo can show ONE genuinely live fetch on
    stage with everything else already in hand, instead of pretending.
    """

    def __init__(self, cache_dir: str, upstream: "BrowserbaseFetch | None" = None):
        self.cache_dir = cache_dir
        self.upstream = upstream
        os.makedirs(cache_dir, exist_ok=True)
        self.hits = 0
        self.misses = 0
        # Callers fetch from a thread pool, so the counters need a lock: `+= 1` is a
        # read-modify-write and would quietly undercount.
        self._lock = threading.Lock()

    def _path(self, url: str) -> str:
        return os.path.join(self.cache_dir,
                            hashlib.sha256(url.encode()).hexdigest()[:24] + ".html")

    def fetch(self, url: str) -> FetchResult:
        path = self._path(url)
        if os.path.exists(path):
            with self._lock:
                self.hits += 1
            with open(path) as f:
                return FetchResult(url=url, status_code=200, content=f.read(),
                                   content_type="text/html")
        if self.upstream is None:
            raise FetchError(None, f"cache miss for {url} and no upstream fetcher configured")
        with self._lock:
            self.misses += 1
        result = self.upstream.fetch(url)
        self._write_atomically(path, result.content)
        return result

    def _write_atomically(self, path: str, content: str) -> None:
        """Write via a temp file and rename.

        `open(path, "w")` truncates immediately, so a second thread reaching the
        os.path.exists check mid-write would read a half-written or empty page — which this
        pipeline cannot distinguish from a merchant that simply lists no dimensions. A wrong
        answer that looks like a real one is the worst outcome here, and os.replace is atomic
        on POSIX and Windows alike. The temp file carries the thread id so two threads racing
        on the same URL cannot clobber each other's partial file either.
        """
        tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
        try:
            with open(tmp, "w") as f:
                f.write(content)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
