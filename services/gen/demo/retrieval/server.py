"""Local, offline demo of B03 embeddings over Paul's downloaded catalog."""
import argparse
import hashlib
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
sys.dont_write_bytecode = True
GEN = Path(__file__).resolve().parents[2]
REPO = GEN.parents[1]
sys.path.insert(0, str(GEN))

import numpy as np
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.concurrency import run_in_threadpool

from app.embedding.config import DIMENSION, MAX_BATCH, MAX_IMAGE_BYTES, MAX_TEXT_BYTES
from app.embedding.encoder import SiglipEncoder
from app.embedding.preprocess import InputError, InputTooLarge

HERE = Path(__file__).resolve().parent
DEFAULT_ROOT = Path(tempfile.gettempdir()) / "ani-siglip2-b03"


def load_catalog(manifest_path):
    manifest_path = manifest_path.resolve(strict=True)
    raw_manifest = manifest_path.read_bytes()
    manifest = json.loads(raw_manifest)
    products = manifest["products"]
    if not products or len(products) != manifest["count"]:
        raise ValueError("Catalog is empty or its count does not match")
    paths, hashes, seen = [], [], set()
    for product in products:
        key = product["r2Key"]
        path = (manifest_path.parent / key).resolve(strict=True)
        if (key in seen or product.get("downloadError") or product.get("source") != "catalog"
                or not path.is_relative_to(manifest_path.parent) or not path.is_file()):
            raise ValueError("Invalid or unsafe catalog image")
        seen.add(key)
        with path.open("rb") as handle:
            raw = handle.read(MAX_IMAGE_BYTES + 1)
        if len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("Catalog image exceeds B03 byte limit")
        paths.append(path)
        hashes.append(hashlib.sha256(raw).hexdigest())
    return products, paths, hashlib.sha256(raw_manifest).hexdigest(), hashes


def load_matrix(encoder, paths, signature, cache_dir):
    """Reuse the existing evaluator's exact signature and .npy layout."""
    cache_dir = cache_dir.resolve()
    if cache_dir.is_relative_to(REPO):
        raise ValueError("Embedding cache must be outside the repository")
    meta, vectors = cache_dir / "image-cache.json", cache_dir / "image-vectors.npy"
    try:
        if json.loads(meta.read_text(encoding="utf-8"))["signature"] == signature:
            matrix = np.load(vectors, allow_pickle=False)
            if (matrix.shape == (len(paths), DIMENSION) and matrix.dtype == np.float32
                    and np.isfinite(matrix).all()
                    and np.allclose(np.linalg.norm(matrix, axis=1), 1, atol=1e-5, rtol=0)):
                return matrix, True
    except (OSError, ValueError, KeyError, EOFError):
        pass
    started = time.perf_counter()
    batches = []
    for offset in range(0, len(paths), MAX_BATCH):
        batch = []
        for i in range(offset, min(offset + MAX_BATCH, len(paths))):
            raw = paths[i].read_bytes()
            if hashlib.sha256(raw).hexdigest() != signature["imageSha256"][i]:
                raise ValueError("Catalog image changed during initialization; restart")
            batch.append(raw)
        batches.append(encoder.embed_images(batch))
        print(f"Embedded {min(offset + MAX_BATCH, len(paths))}/{len(paths)} products", flush=True)
    matrix = np.concatenate(batches)
    cache_dir.mkdir(parents=True, exist_ok=True)
    # Remove the old signature first: an interrupted rebuild cannot validate stale vectors.
    meta.unlink(missing_ok=True)
    np.save(vectors, matrix, allow_pickle=False)
    meta.write_text(json.dumps({"signature": signature,
                               "imageEmbeddingSeconds": time.perf_counter() - started}), encoding="utf-8")
    return matrix, False


def rank(matrix, vector, k=5):
    # Metadata is deliberately absent from this function.
    scores = matrix @ vector
    order = np.argsort(-scores, kind="stable")[:k]
    return order, scores


class Retrieval:
    def __init__(self, manifest, model_cache, cache_dir):
        self.products, self.paths, manifest_hash, image_hashes = load_catalog(manifest)
        started = time.perf_counter()
        self.encoder = SiglipEncoder(str(model_cache))
        load_ms = (time.perf_counter() - started) * 1000
        signature = {"fingerprint": self.encoder.fingerprint, "manifestSha256": manifest_hash,
                     "imageSha256": image_hashes}
        self.matrix, reused = load_matrix(self.encoder, self.paths, signature, cache_dir)
        self.lock = threading.Lock()
        self.info = {"products": len(self.products), "dimension": DIMENSION,
                     "modelLoadMs": load_ms, "cacheReused": reused}
        print(json.dumps(self.info), flush=True)

    def search(self, *, text=None, photo=None):
        with self.lock:
            started = time.perf_counter()
            vector = (self.encoder.embed_texts([text]) if photo is None
                      else self.encoder.embed_images([photo]))[0]
            encoded = time.perf_counter()
            order, scores = rank(self.matrix, vector)
            ranked = time.perf_counter()
        results = []
        for index in order:
            i = int(index)
            product = self.products[i]
            results.append({"id": i, "title": product.get("title") or "Untitled product",
                            "merchant": product.get("merchant", ""), "image": f"/images/{i}",
                            "dimensions": product.get("bboxMeters"), "similarity": float(scores[i])})
        return {"results": results, "weakMatch": bool(scores[order[0]] <= 0),
                "timing": {"embeddingMs": (encoded - started) * 1000,
                           "rankingMs": (ranked - encoded) * 1000,
                           "queryMs": (ranked - started) * 1000}}


def create_app(retrieval):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def local_only(request, call_next):
        if request.headers.get("host") not in {"127.0.0.1:8765", "localhost:8765", "testserver"}:
            return JSONResponse({"error": "Use the local demo URL."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin not in {"http://127.0.0.1:8765", "http://localhost:8765"}:
            return JSONResponse({"error": "Open the demo locally."}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.get("/")
    def page():
        return FileResponse(HERE / "index.html", headers={"Cache-Control": "no-cache"})

    @app.get("/api/info")
    def info():
        return retrieval.info

    @app.get("/images/{index}")
    def image(index: int):
        if not 0 <= index < len(retrieval.paths):
            return JSONResponse({"error": "Image not found."}, status_code=404)
        path = retrieval.paths[index]
        # Paul's source.jpg files can contain PNG bytes.
        with path.open("rb") as handle:
            mime = "image/png" if handle.read(8) == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
        return FileResponse(path, media_type=mime, headers={"Cache-Control": "private, max-age=3600"})

    @app.post("/api/search/{mode}")
    async def search(mode: str, request: Request):
        if mode not in {"text", "photo"}:
            return JSONResponse({"error": "Choose text or photo."}, status_code=404)
        limit = MAX_IMAGE_BYTES if mode == "photo" else MAX_TEXT_BYTES * 6 + 100
        try:
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > limit:
                    raise InputTooLarge("Image must be 10 MB or smaller." if mode == "photo" else "Text is too long.")
            if mode == "photo":
                return await run_in_threadpool(retrieval.search, photo=bytes(raw))
            body = json.loads(raw)
            if not isinstance(body, dict) or set(body) != {"text"}:
                raise InputError("Enter a description to search.")
            return await run_in_threadpool(retrieval.search, text=body["text"])
        except InputTooLarge as exc:
            return JSONResponse({"error": str(exc)}, status_code=413)
        except (InputError, ValueError, UnicodeError) as exc:
            return JSONResponse({"error": str(exc) if isinstance(exc, InputError) else "Invalid search input."}, status_code=422)
        except Exception:
            logging.exception("Demo search failed")
            return JSONResponse({"error": "Search couldn't finish. Please try again."}, status_code=500)

    return app


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=REPO / "services/ingest/prebake/manifest.json")
    parser.add_argument("--model-cache", type=Path, default=DEFAULT_ROOT / "models")
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_ROOT / "catalog-eval")
    args = parser.parse_args()
    retrieval = Retrieval(args.manifest, args.model_cache, args.cache_dir)
    import uvicorn
    uvicorn.run(create_app(retrieval), host="127.0.0.1", port=8765, access_log=False)
