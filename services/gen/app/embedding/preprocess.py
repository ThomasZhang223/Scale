"""Input policy applied before the checkpoint's own processor/tokenizer."""

import base64
import binascii
import hashlib
import io
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from .config import MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_IMAGE_SIDE, MAX_TEXT_BYTES


class InputError(ValueError):
    pass


class InputTooLarge(InputError):
    pass


def image_bytes_from_base64(value: str) -> bytes:
    if len(value) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
        raise InputTooLarge("Image exceeds byte limit")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise InputError("Invalid image base64") from None
    if len(raw) > MAX_IMAGE_BYTES:
        raise InputTooLarge("Image exceeds byte limit")
    return raw


def decode_image(raw: bytes) -> Image.Image:
    if not isinstance(raw, bytes) or not raw:
        raise InputError("Nonempty image bytes required")
    if len(raw) > MAX_IMAGE_BYTES:
        raise InputTooLarge("Image exceeds byte limit")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as source:
                if source.format not in {"JPEG", "PNG"}:
                    raise InputError("Only JPEG and PNG are supported")
                if getattr(source, "n_frames", 1) != 1:
                    raise InputError("Animated images are unsupported")
                if max(source.size) > MAX_IMAGE_SIDE or source.width * source.height > MAX_IMAGE_PIXELS:
                    raise InputTooLarge("Image exceeds pixel limit")
                source.load()  # Force complete decoding while the stream remains open.
                oriented = ImageOps.exif_transpose(source)
                rgba = oriented.convert("RGBA")
                white = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                return Image.alpha_composite(white, rgba).convert("RGB")
    except (Image.DecompressionBombWarning, Image.DecompressionBombError):
        raise InputTooLarge("Unsafe image dimensions") from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as exc:
        if isinstance(exc, InputError):
            raise
        raise InputError("Corrupt or unsupported image") from None


def normalize_text(text: str) -> str:
    if not isinstance(text, str):
        raise InputError("Text must be a string")
    try:
        if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
            raise InputTooLarge("Text exceeds UTF-8 byte limit")
        value = text.strip().lower()
        if len(value.encode("utf-8")) > MAX_TEXT_BYTES:
            raise InputTooLarge("Normalized text exceeds UTF-8 byte limit")
    except UnicodeError:
        raise InputError("Invalid Unicode text") from None
    if not value:
        raise InputError("Text is empty after normalization")
    return value


def content_hash(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()
