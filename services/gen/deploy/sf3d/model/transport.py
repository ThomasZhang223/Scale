"""Bounded synchronous spike transport. No storage, URLs or model imports."""

import base64
import binascii
import hashlib
import io
import json
import struct
import warnings
import time

from PIL import Image, ImageOps, UnidentifiedImageError

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
MAX_IMAGE_SIDE = 8192
MAX_GLB_BYTES = 16 * 1024 * 1024
MAX_RESPONSE_BYTES = 24 * 1024 * 1024
KIND = "raw_sf3d_unscaled"


def decode_base64(value, limit):
    if not isinstance(value, str) or not value or len(value) > 4 * ((limit + 2) // 3):
        raise ValueError("Invalid or oversized base64 payload")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise ValueError("Invalid base64 payload") from None
    if not raw or len(raw) > limit:
        raise ValueError("Invalid or oversized decoded payload")
    return raw


def decode_image(raw):
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError("Image byte limit exceeded or empty image")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in {"JPEG", "PNG"} or getattr(source, "n_frames", 1) != 1:
                    raise ValueError("One still JPEG or PNG is required")
                w, h = source.size
                if w * h > MAX_IMAGE_PIXELS or max(w, h) > MAX_IMAGE_SIDE:
                    raise ValueError("Image pixel limit exceeded")
                source.load()
                return ImageOps.exif_transpose(source).convert("RGBA")
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise ValueError("Invalid or unsafe image") from None


def decode_request(payload, diagnostics=None):
    start = time.perf_counter()
    if not isinstance(payload, dict) or set(payload) != {"image_base64"}:
        raise ValueError("Expected exactly one field: image_base64")
    raw = decode_base64(payload["image_base64"], MAX_IMAGE_BYTES)
    decoded = time.perf_counter()
    image = decode_image(raw)
    if diagnostics is not None:
        diagnostics.update(request_decode_ms=(decoded - start) * 1000,
                           image_decode_rgba_ms=(time.perf_counter() - decoded) * 1000,
                           image_size=list(image.size), image_mode=image.mode)
    return image, hashlib.sha256(raw).hexdigest()


def inspect_glb(raw):
    """Structural textured-GLB check only; NOT mesh/normalization validation."""
    if not isinstance(raw, bytes) or not 28 <= len(raw) <= MAX_GLB_BYTES:
        raise ValueError("GLB byte limit exceeded or empty artifact")
    magic, version, length = struct.unpack_from("<4sII", raw)
    if (magic, version, length) != (b"glTF", 2, len(raw)):
        raise ValueError("Invalid GLB header")
    chunks = []
    offset = 12
    while offset < length:
        if offset + 8 > length:
            raise ValueError("Truncated GLB chunk")
        size, kind = struct.unpack_from("<I4s", raw, offset)
        offset += 8
        if size % 4 or offset + size > length:
            raise ValueError("Invalid GLB chunk length")
        chunks.append((kind, raw[offset:offset + size]))
        offset += size
    if len(chunks) != 2 or chunks[0][0] != b"JSON" or chunks[1][0] != b"BIN\x00":
        raise ValueError("Expected embedded JSON and BIN GLB chunks")
    try:
        doc = json.loads(chunks[0][1])
        if not all(doc.get(k) for k in ("meshes", "materials", "textures", "images")):
            raise ValueError("GLB has no textured mesh")
        if any("uri" in b for b in doc.get("buffers", [])):
            raise ValueError("External GLB buffers are not allowed")
        if any("bufferView" not in img or "uri" in img for img in doc["images"]):
            raise ValueError("GLB textures must be embedded")
    except (json.JSONDecodeError, UnicodeDecodeError, AttributeError, TypeError):
        raise ValueError("Invalid GLB document") from None
    return {"meshes": len(doc["meshes"]), "materials": len(doc["materials"]),
            "textures": len(doc["textures"]), "images": len(doc["images"])}


def artifact_response(raw, input_hash, **metadata):
    counts = inspect_glb(raw)
    result = {"schema_version": 1, "kind": KIND, "input_sha256": input_hash,
              "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
              "glb_base64": base64.b64encode(raw).decode("ascii"),
              "structure": counts, **metadata}
    if len(json.dumps(result).encode("utf-8")) > MAX_RESPONSE_BYTES:
        raise ValueError("Response size limit exceeded")
    return result


def decode_response(payload, expected_input_hash):
    if not isinstance(payload, dict) or payload.get("schema_version") != 1 or payload.get("kind") != KIND:
        raise ValueError("Unexpected feasibility response")
    if payload.get("input_sha256") != expected_input_hash:
        raise ValueError("Response belongs to a different input")
    raw = decode_base64(payload.get("glb_base64"), MAX_GLB_BYTES)
    if payload.get("bytes") != len(raw) or payload.get("sha256") != hashlib.sha256(raw).hexdigest():
        raise ValueError("Artifact length/hash mismatch")
    inspect_glb(raw)
    return raw
