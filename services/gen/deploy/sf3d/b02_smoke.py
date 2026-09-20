"""Explicitly opt-in ONE synchronous request, saving actual GLB bytes. Never deploys."""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.parse import urlsplit

import httpx

from model.transport import MAX_IMAGE_BYTES, MAX_RESPONSE_BYTES, decode_image, decode_response
from model.model import MODEL_REVISION, SOURCE_REVISION, validate_bake_resolution


def validate_endpoint(endpoint):
    url = urlsplit(endpoint)
    if (url.scheme != "https" or url.username or url.password or url.query or url.fragment
            or url.port not in (None, 443)
            or not re.fullmatch(r"model-[a-zA-Z0-9-]+\.api\.baseten\.co", url.hostname or "")
            or not url.path.endswith("/predict") or "async" in url.path):
        raise ValueError("Use the dashboard's HTTPS synchronous custom-model /predict endpoint")


def run_once(endpoint, image_path, output_dir, token, timeout=180, client=None, bake_resolution=None):
    if bake_resolution is not None:
        validate_bake_resolution(bake_resolution)
    validate_endpoint(endpoint)
    if not token:
        raise ValueError("Set BASETEN_API_KEY securely; never pass it as a command argument")
    if not 1 <= timeout <= 300:
        raise ValueError("Timeout must be between 1 and 300 seconds")
    with Path(image_path).open("rb") as handle:
        raw = handle.read(MAX_IMAGE_BYTES + 1)
    decode_image(raw)  # Reject invalid inputs before making a billable request.
    input_hash = hashlib.sha256(raw).hexdigest()
    out = Path(output_dir)
    # A fresh directory prevents overwriting anyone's previous generated artifact.
    out.mkdir(parents=True, exist_ok=False)
    payload = {"image_base64": base64.b64encode(raw).decode("ascii")}
    if bake_resolution is not None:
        payload["_profile_bake_resolution"] = bake_resolution
    own_client = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(timeout, connect=15),
                                    follow_redirects=False)
    started = time.perf_counter()
    try:
        with client.stream("POST", endpoint, headers={"Authorization": "Bearer " + token},
                           json=payload) as response:
            if response.status_code != 200:
                raise RuntimeError(f"Inference HTTP {response.status_code}; response body redacted; not retried")
            length = response.headers.get("content-length")
            if length is not None and int(length) > MAX_RESPONSE_BYTES:
                raise ValueError("Response exceeds byte limit")
            body = bytearray()
            for chunk in response.iter_bytes(chunk_size=64 * 1024):
                if time.perf_counter() - started > timeout:
                    raise RuntimeError("Response deadline exceeded; remote generation may still run. Not retried.")
                if len(body) + len(chunk) > MAX_RESPONSE_BYTES:
                    raise ValueError("Response exceeds byte limit")
                body.extend(chunk)
            result = json.loads(body)
        artifact = decode_response(result, input_hash)
        revisions = result.get("revisions", {})
        if bake_resolution is not None and result.get("settings", {}).get("texture_resolution") != bake_resolution:
            raise ValueError("Requested/effective bake resolution mismatch")
        if revisions.get("sf3d_source") != SOURCE_REVISION or revisions.get("sf3d_weights") != MODEL_REVISION:
            raise ValueError("Unexpected deployed SF3D revision")
        with (out / "mesh.glb").open("xb") as handle:
            handle.write(artifact)
        report = {k: result.get(k) for k in ("kind", "input_sha256", "sha256", "bytes",
                                             "structure", "revisions", "settings", "runtime", "timings")}
        report.update({"client_elapsed_s": time.perf_counter() - started,
                       "request_id": response.headers.get("x-baseten-request-id"),
                       "endpoint": endpoint, "artifact": str(out / "mesh.glb"),
                       "validation": "structural GLB only; visual review and normalization NOT performed"})
        with (out / "report.json").open("x", encoding="utf-8") as handle:
            json.dump(report, handle, indent=2)
        return report
    except httpx.RequestError:
        raise RuntimeError("Request failed or timed out; remote generation may still run. Do not auto-retry.") from None
    finally:
        if own_client:
            client.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-paid-request", action="store_true",
                        help="Required acknowledgement AFTER separate cost/access authorization")
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--bake-resolution", type=int, choices=(512, 1024),
                        help="Internal profiling deployment only; production defaults to 1024")
    args = parser.parse_args(argv)
    if not args.allow_paid_request:
        parser.error("No request sent: --allow-paid-request is required after explicit authorization")
    try:
        report = run_once(args.endpoint, args.image, args.output_dir,
                          os.environ.get("BASETEN_API_KEY"), args.timeout, bake_resolution=args.bake_resolution)
    except (ValueError, RuntimeError, OSError) as exc:
        print(f"B02 failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
