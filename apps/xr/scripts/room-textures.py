#!/usr/bin/env python3
"""
Turns the six perspective-corrected room photos into the six delivery textures.

The photos are four-point transforms of one real room (Judging Room H): each one maps a
wall/floor/ceiling rectangle onto the WHOLE image, so the image aspect is NOT the surface
aspect. That is deliberate — the renderer maps each texture to UV 0..1 over the true metre
rectangle, so the stretch is undone in 3D. Nothing here preserves aspect.

Two jobs:
  1. Fix the back wall. Its four-point warp was picked slightly inside the wall's right edge,
     so the image carries a wedge of the RIGHT wall along its right side: ~178 px at the top,
     nothing below y ~ 2300 (the corner line leaves the frame there). A crop cannot remove a
     wedge, so this re-warps the true wall quad back onto the full rectangle.
  2. Deliver. Longest side 2048, JPEG q85, sRGB. Six 20 MB PNGs will not load in a Quest.

Run (host Python is 3.14 and has no Pillow wheel — use the container):
    docker run --rm -v "$PWD:/w" python:3.12-slim \
      sh -c "pip install -q pillow && python /w/apps/xr/scripts/room-textures.py /w/in /w/out"
"""

import sys
from pathlib import Path

from PIL import Image

LONGEST_SIDE = 2048
JPEG_QUALITY = 85

# The six photos, by the name they arrive with. A surface key here is the same key the room's
# `appearance.surfaces` uses (contracts.md), so the output file name IS the surface key.
SOURCES = {
    "front": "pixlane-perspective-transform-result (1).png",
    "left": "pixlane-perspective-transform-result (2).png",
    "back": "pixlane-perspective-transform-result (3).png",
    "floor": "pixlane-perspective-transform-result (4).png",
    "ceiling": "pixlane-perspective-transform-result (5).png",
    "right": "pixlane-perspective-transform-result.png",
}

# The back wall's true right edge, measured off the 3024x4032 source: the lit corner between the
# back wall and the right wall sits at x = 2812 at the top and drifts right by 0.0769 px per row
# (it leaves the frame at y ~ 2380). Everything right of that line is the right wall, not this one.
BACK_CORNER_X_AT_TOP = 2812.0
BACK_CORNER_SLOPE = 0.0769
# Below the row where the corner line leaves the frame, the true wall runs past the image edge and
# those pixels were never photographed. Padding by edge replication fills a triangle of 0.9% of the
# image in the bottom-right corner.
# ceiling: edge replication, not inpainting — at 0.9% of one wall it is invisible at 1:1, and the
# upgrade path is to re-shoot the back wall square-on rather than to paint the corner in.
BACK_PAD_RIGHT = 160


def fix_back_wall(im: Image.Image) -> Image.Image:
    """Re-warps the true back-wall quad onto the full rectangle, dropping the right-wall wedge."""
    w, h = im.size
    padded = Image.new("RGB", (w + BACK_PAD_RIGHT, h))
    padded.paste(im, (0, 0))
    edge = im.crop((w - 1, 0, w, h)).resize((BACK_PAD_RIGHT, h))
    padded.paste(edge, (w, 0))

    top_right = BACK_CORNER_X_AT_TOP
    bottom_right = BACK_CORNER_X_AT_TOP + BACK_CORNER_SLOPE * h
    # Pillow's QUAD takes the source quad as NW, SW, SE, NE.
    quad = (0.0, 0.0, 0.0, float(h), bottom_right, float(h), top_right, 0.0)
    return padded.transform((w, h), Image.Transform.QUAD, quad, Image.Resampling.BICUBIC)


def deliver(im: Image.Image) -> Image.Image:
    w, h = im.size
    scale = LONGEST_SIDE / max(w, h)
    if scale < 1:
        im = im.resize((round(w * scale), round(h * scale)), Image.Resampling.LANCZOS)
    return im.convert("RGB")


def main(src_dir: str, out_dir: str) -> None:
    src, out = Path(src_dir), Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    for surface, filename in SOURCES.items():
        path = src / filename
        if not path.exists():
            raise SystemExit(f"missing source for {surface}: {path}")
        im = Image.open(path).convert("RGB")
        if surface == "back":
            # Kept for the before/after: the uncorrected wall, same delivery size, never uploaded.
            deliver(im).save(out / "back.uncorrected.jpg", quality=JPEG_QUALITY)
            im = fix_back_wall(im)
        im = deliver(im)
        target = out / f"{surface}.jpg"
        im.save(target, quality=JPEG_QUALITY, subsampling=1)
        print(f"{surface}: {im.size[0]}x{im.size[1]}  {target.stat().st_size // 1024} KB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: room-textures.py <source-dir> <output-dir>")
    main(sys.argv[1], sys.argv[2])
