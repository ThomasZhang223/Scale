"""Shared helpers for the hero-script tests. No network, no paid call, no Baseten host.

The Worker is an in-process WSGI app reached through httpx.WSGITransport. A plain-HTTP
localhost server cannot be used: Ani's WorkerArtifactSink accepts only an https origin.
"""
import hashlib
import io
import json
import sqlite3
import sys
from pathlib import Path

import httpx
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).parent / "data" / "mesh"))
from synthetic import fixture  # noqa: E402
from app import generation as g  # noqa: E402
import approve  # noqa: E402
import hero_store as hs  # noqa: E402
import prepare  # noqa: E402

ORIGIN = "https://worker.invalid"
OBJECT_ID = "hero-1"
BOX = {"w": 0.61, "h": 1.07, "d": 0.49}
SCOPE = "hero-test-scope"


def png(color="red"):
    out = io.BytesIO()
    Image.new("RGB", (4, 5), color).save(out, format="PNG")
    return out.getvalue()


class FakeProvider:
    """The labelled fake from test_generation_adapter.py. `evidence` lets a test assert label handling."""
    def __init__(self, evidence="fake_provider", store=None):
        self.calls, self.glb, self.evidence, self.store = [], fixture(), evidence, store
        self.state_seen_during_call = None

    def generate(self, image, image_sha256):
        if self.store is not None:  # a second connection sees only COMMITTED rows
            with sqlite3.connect(Path(self.store) / "journal.sqlite3") as other:
                self.state_seen_during_call = [r[0] for r in other.execute("SELECT state FROM attempts")]
        self.calls.append((image, image_sha256))
        return g.RawGeneration(self.glb, image_sha256, "synthetic-fixture-v1", self.evidence, "req-fake-1")


class FakeWorker:
    """WSGI stand-in for the Worker. Every request is logged as (method, path, body)."""
    def __init__(self):
        self.objects = {OBJECT_ID: {"schemaVersion": 1, "objectId": OBJECT_ID, "source": "catalog",
                                    "state": "measured", "bboxMeters": dict(BOX), "glbUrl": None}}
        self.stored = {}
        self.calls = []
        self.fail_put = 0
        self.fail_mesh = 0
        self.scan_keys_only = False
        self.mesh_bodies = []

    def paths(self):
        return [(method, path) for method, path, _ in self.calls]

    def __call__(self, environ, start_response):
        method, path = environ["REQUEST_METHOD"], environ["PATH_INFO"]
        body = environ["wsgi.input"].read()
        self.calls.append((method, path, body))
        status, payload = self.route(method, path, body)
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        start_response(f"{status} X", [("content-type", "application/json"), ("content-length", str(len(data)))])
        return [data]

    def route(self, method, path, body):
        parts = path.strip("/").split("/")
        if method == "GET" and parts[:2] == ["v1", "objects"] and len(parts) == 3:
            row = self.objects.get(parts[2])
            return (200, row) if row else (404, {"error": "not_found"})
        if method == "GET" and parts[:2] == ["v1", "assets"]:
            key = "/".join(parts[2:])
            return (200, self.stored[key]) if key in self.stored else (404, {"error": "not_found"})
        if method == "POST" and path == "/v1/uploads":
            request = json.loads(body)
            key = f"objects/{request['objectId']}/mesh.glb"
            return 200, {"key": key, "putUrl": f"{ORIGIN}/v1/uploads/{key}?t=test-only"}
        if method == "PUT" and parts[:2] == ["v1", "uploads"]:
            if self.fail_put:
                self.fail_put -= 1
                return 500, {"error": "boom"}
            self.stored["/".join(parts[2:])] = body
            return 200, {}
        if method == "POST" and parts[:2] == ["v1", "objects"] and parts[3:] == ["mesh"]:
            if self.fail_mesh:
                self.fail_mesh -= 1
                return 500, {"error": "boom"}
            request = json.loads(body)
            self.mesh_bodies.append(request)
            if self.scan_keys_only and not request["key"].startswith("scans/"):  # the Worker before P-WORKER
                return 400, {"error": "bad_mesh_key"}
            if request["key"] not in self.stored:
                return 409, {"error": "mesh_not_uploaded"}
            self.objects[parts[2]].update(state="ready", glbUrl=f"{ORIGIN}/v1/assets/{request['key']}")
            return 200, self.objects[parts[2]]
        return 404, {"error": "no_route"}

    def client(self):
        return httpx.Client(transport=httpx.WSGITransport(app=self), follow_redirects=False)


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Env:
    """One hero attempt's world: a fake Worker, a store, and the ONE source image on disk."""
    def __init__(self, tmp_path, evidence="fake_provider"):
        tmp_path.mkdir(parents=True, exist_ok=True)
        self.worker, self.store, self.image = FakeWorker(), tmp_path / "store", tmp_path / "chair.png"
        self.image.write_bytes(png())
        self.provider = FakeProvider(evidence, store=self.store)
        self.key = prepare.attempt_key(SCOPE, sha(png()))

    def base(self):
        return ["--worker-origin", ORIGIN, "--store", str(self.store)]

    def generate(self, *extra, provider=None, image=None):
        provider = provider or self.provider
        return prepare.main(["generate", *self.base(), "--object-id", OBJECT_ID, "--scope", SCOPE,
                             "--image", str(image or self.image), *extra],
                            client=self.worker.client(), provider_factory=lambda: provider)

    def bind(self, *extra, up="Y+", front="Z-", attempt=None):
        return prepare.main(["bind", *self.base(), "--attempt", attempt or self.key, "--reviewer", "tester",
                             "--up", up, "--front", front, *extra], client=self.worker.client())

    def approve(self, *extra, reviewer="tester", bound_sha256=None, attempt=None):
        digest = bound_sha256 or hs.read_json(self.dir / "bound-receipt.json")["boundSha256"]
        return approve.main([*self.base(), "--attempt", attempt or self.key, "--reviewer", reviewer,
                             "--bound-sha256", digest, *extra], client=self.worker.client())

    @property
    def dir(self):
        return hs.attempt_dir(self.store, self.key)

    def rows(self):
        if not (self.store / "journal.sqlite3").exists():
            return []  # refused before anything was recorded
        with sqlite3.connect(self.store / "journal.sqlite3") as conn:
            return conn.execute("SELECT state FROM attempts").fetchall()


def bound_env(tmp_path, evidence="fake_provider"):
    env = Env(tmp_path, evidence)
    assert env.generate() == 0 and env.bind() == 0
    env.worker.calls.clear()
    return env
