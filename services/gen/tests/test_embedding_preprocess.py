"""Small synthetic inputs only. These tests do not load model weights."""

import base64
import io
from pathlib import Path
import sys

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.embedding import preprocess as p


def encoded(image, fmt="PNG", **kwargs):
    out = io.BytesIO()
    image.save(out, format=fmt, **kwargs)
    return out.getvalue()


def test_exif_and_full_frame():
    exif = Image.Exif()
    exif[274] = 6
    result = p.decode_image(encoded(Image.new("RGB", (20, 10)), "JPEG", exif=exif))
    assert result.size == (10, 20)  # Rotation only; resize is the processor's job.
    assert result.mode == "RGB"


@pytest.mark.parametrize("mode", ["RGBA", "P", "LA"])
def test_transparency_composited_on_white(mode):
    image = Image.new("RGBA", (2, 2), (0, 0, 0, 0))
    if mode == "P":
        image = image.convert("P")
        image.info["transparency"] = 0
    elif mode == "LA":
        image = image.convert("LA")
    result = p.decode_image(encoded(image))
    assert result.getpixel((0, 0)) == (255, 255, 255)


def test_partial_alpha_and_grayscale_cmyk():
    result = p.decode_image(encoded(Image.new("RGBA", (2, 2), (255, 0, 0, 128))))
    assert result.getpixel((0, 0)) == (255, 127, 127)
    for mode in ("L", "CMYK"):
        assert p.decode_image(encoded(Image.new(mode, (4, 4)), "JPEG")).mode == "RGB"


@pytest.mark.parametrize("raw", [b"", b"corrupt", b"\x89PNG\r\n\x1a\n", b"GIF89a"])
def test_invalid_bytes(raw):
    with pytest.raises(p.InputError):
        p.decode_image(raw)


def test_truncation_animation_and_format():
    raw = encoded(Image.new("RGB", (32, 32), "red"))
    with pytest.raises(p.InputError):
        p.decode_image(raw[:len(raw) // 2])
    first, second = Image.new("RGBA", (4, 4), "red"), Image.new("RGBA", (4, 4), "blue")
    animated = encoded(first, save_all=True, append_images=[second], duration=100)
    with pytest.raises(p.InputError):
        p.decode_image(animated)
    with pytest.raises(p.InputError):
        p.decode_image(encoded(first.convert("RGB"), "BMP"))


def test_byte_pixel_side_and_bomb_limits(monkeypatch):
    raw = encoded(Image.new("RGB", (8, 6)))
    monkeypatch.setattr(p, "MAX_IMAGE_BYTES", len(raw) - 1)
    with pytest.raises(p.InputTooLarge):
        p.decode_image(raw)
    monkeypatch.setattr(p, "MAX_IMAGE_BYTES", len(raw))
    monkeypatch.setattr(p, "MAX_IMAGE_PIXELS", 47)
    with pytest.raises(p.InputTooLarge):
        p.decode_image(raw)
    monkeypatch.setattr(p, "MAX_IMAGE_PIXELS", 100)
    monkeypatch.setattr(p, "MAX_IMAGE_SIDE", 7)
    with pytest.raises(p.InputTooLarge):
        p.decode_image(raw)
    monkeypatch.setattr(p, "MAX_IMAGE_SIDE", 100)
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 30)
    with pytest.raises(p.InputTooLarge):
        p.decode_image(raw)


def test_base64_bounds_and_text_policy(monkeypatch):
    assert p.image_bytes_from_base64(base64.b64encode(b"bytes").decode()) == b"bytes"
    with pytest.raises(p.InputError):
        p.image_bytes_from_base64("@@")
    monkeypatch.setattr(p, "MAX_IMAGE_BYTES", 1)
    with pytest.raises(p.InputTooLarge):
        p.image_bytes_from_base64(base64.b64encode(b"abc").decode())
    assert p.normalize_text("  WOOD Chair\n") == "wood chair"
    assert p.content_hash(p.normalize_text(" Chair ").encode()) == p.content_hash(b"chair")
    for text in (" ", "\ud800"):
        with pytest.raises(p.InputError):
            p.normalize_text(text)
    with pytest.raises(p.InputTooLarge):
        p.normalize_text("a" * 4097)
