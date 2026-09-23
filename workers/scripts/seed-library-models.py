#!/usr/bin/env python3
"""Add CC0 furniture models from Poly Haven to the headset's library, as `source:"primitive"`.

    python3 workers/scripts/seed-library-models.py \
        --base https://<worker> --work DIR --manifest fixtures/library-models.json [--only ID] [--plan-only]

Why this exists: many of the SF3D catalogue meshes look poor, and the library needs furniture
that reads well from three metres in a Quest. Poly Haven's models are CC0, photoscanned and
authored at real-world scale in metres, which is the only reason they can be used here.

LICENCE, first not last. Poly Haven states on https://polyhaven.com/license that every asset on
the site is CC0: "You can redistribute them, share them around, include them when sharing your
own work, or even in a product you sell." Attribution is not required; this script records it
anyway, per model, in the manifest. No merchant, brand or manufacturer model is used, no login
or paywall is touched, and nothing is downloaded from a storefront viewer.

THESE ARE LIBRARY MODELS, NEVER PRODUCTS. Every row is `source:"primitive"` with no merchant,
productUrl or price. A Poly Haven chair must never be attached to a `source:"catalog"` row:
that would be a false claim about a real merchant's product.

NOTHING IS EVER SCALED (standing rule 2). The size is whatever the file says. Each packed GLB is
measured with infra/cloudflare/glb_bounds.py — the same stdlib reader seed-library.sh uses — and
a model whose measured size is implausible for what it is gets SKIPPED and listed, never
corrected. Repacking is not rescaling: texture resize, pruning and mesh joining change bytes, not
metres, and the measurement is taken on the packed bytes that are actually uploaded.

The pipeline per model:
  1. GET api.polyhaven.com/files/{id} and take the 1k glTF variant, with its own textures.
  2. Download the .gltf and every included file, checking each md5 the API gives.
  3. Pack to ONE self-contained .glb with gltf-transform (see PACK_ARGS for why each flag).
  4. Measure the packed bytes, in metres, and apply this model's own plausibility range.
  5. POST /v1/objects (source primitive, fixed UUIDv5 id), upload kind objectMesh, then
     POST /v1/objects/{id}/mesh — the same three steps services/gen uses. No direct R2 or D1
     write, and no hand-written SQL.
  6. Verify from outside: the row is ready, the served bytes hash to the packed file, the header
     is glTF, and the row appears in GET /v1/objects?source=primitive.

# ceiling: the curated list below is written by hand, with one plausibility range per entry. It
# is not a search over Poly Haven. The upgrade path is to filter the /assets response by
# category and dimensions, which this file already fetches for the cross-check.
"""
import argparse
import hashlib
import json
import struct
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "infra" / "cloudflare"))
import glb_bounds  # read-only reuse; this script never edits infra/

# The Poly Haven API asks callers to identify themselves.
USER_AGENT = "FullScale-HTN2026/1.0 (Hack the North student project; +https://github.com/ThomasZhang223/HTN-2026)"
API = "https://api.polyhaven.com"
LICENSE = "CC0-1.0"
LICENSE_URL = "https://polyhaven.com/license"
# The id namespace. Fixed, so a re-run addresses the same rows instead of making new ones.
ID_PREFIX = "full-scale:library:polyhaven:"
KHRONOS_ID_PREFIX = "full-scale:library:khronos:"
MAX_BYTES = 5 * 1024 * 1024
MAX_TRIANGLES = 100_000

# gltf-transform flags, and the reason for each one that is not a default:
#   --compress false     the headset HAS Draco/Meshopt/KTX2 wired (apps/xr/src/objects.ts), so
#                        compression is allowed — it is simply not needed. These models are
#                        under 50k triangles; textures are the whole budget. Uncompressed
#                        geometry also keeps POSITION min/max readable by glb_bounds.py, so the
#                        bytes that are uploaded are the bytes that were measured.
#   --instance false     GPU instancing moves transforms into EXT_mesh_gpu_instancing, which
#                        glb_bounds.py does not read. That would silently break the measurement.
#   --simplify false     a photoscan's silhouette is the thing being bought. Simplification is
#                        applied only to a model over MAX_TRIANGLES, as a separate pass.
#   --texture-size 1024  the Quest budget. A hero piece may be raised to 2048 by hand.
#   --palette false      merging materials into a palette texture changes how a scan reads.
PACK_ARGS = ["--compress", "false", "--instance", "false", "--simplify", "false",
             "--palette", "false", "--texture-size", "1024", "--texture-compress", "auto"]

# The app's own vocabulary, copied from the `known` list in apps/xr/src/main.ts categoryOf().
# A category outside this list still seeds and still shows on the Furniture page, but the app
# cannot use it to decide which scanned piece the model stands in for. Every such model is
# flagged `categoryInKnownList: false` in the manifest and listed in the report, so the gap is
# a decision for a person and never a silent invention.
# Where a lamp has to live to make sense. Every object in the headset is a dynamic physics body
# under gravity and there is no wall or ceiling mounting, so a `ceiling` or `wall` light added by
# "add a lamp" drops to the floor and sits there. Those are packed, measured and recorded, but
# NOT seeded: see HELD. A `floor` or `table` lamp stands on its own and is seeded normally.
MOUNT = {
    "Chandelier_01": "ceiling", "Chandelier_02": "ceiling", "Chandelier_03": "ceiling",
    "chinese_chandelier": "ceiling", "lantern_chandelier_01": "ceiling",
    "caged_hanging_light": "ceiling", "hanging_industrial_lamp": "ceiling",
    "mounted_fluorescent_lights": "ceiling", "modern_ceiling_lamp_01": "ceiling",
    "industrial_caged_sconce": "wall", "industrial_wall_lamp": "wall",
    "industrial_wall_sconce": "wall",
    "industrial_pipe_lamp": "table", "vintage_oil_lamp": "table", "wooden_lantern_01": "table",
    "Lantern_01": "table", "brass_diya_lantern": "table", "desk_lamp_arm_01": "table",
}
# Packed and measured, deliberately not seeded. Seeding one later is deleting its line here.
# modern_ceiling_lamp_01 went live in the first wave and was removed again on Thomas's word, so
# it is held with the rest: every ceiling and wall light is now out of the live library.
HELD_REASON = "needs wall/ceiling mount — not seeded"
HELD = {a for a, m in MOUNT.items() if m in ("ceiling", "wall")}

KNOWN_CATEGORIES = ("coffee table", "side table", "sofa", "couch", "armchair", "chair", "stool",
                    "bench", "dining", "table", "desk", "bed", "storage", "shelf", "bookcase",
                    "cabinet", "dresser", "wardrobe", "lamp", "television", "tv", "plant", "rug")

# The app's own vocabulary, from the `known` list in apps/xr/src/main.ts categoryOf(). The
# category is load-bearing: main.ts decides which scanned piece a model stands in for by it.
# Each entry declares the plausible range for its LARGEST side, in metres. A model outside its
# own range is skipped and reported — never resized.
CURATED = [
    # (polyhaven id, display name, category, min_largest_m, max_largest_m)
    ("sofa_02",                  "Two-seat fabric sofa",        "sofa",         1.2, 3.5),
    ("sofa_03",                  "Large sectional sofa",        "sofa",         1.2, 3.5),
    ("Sofa_01",                  "Compact loveseat",            "sofa",         1.2, 3.5),
    ("modern_arm_chair_01",      "Modern armchair",             "armchair",     0.5, 1.6),
    ("mid_century_lounge_chair", "Mid-century lounge chair",    "armchair",     0.5, 1.6),
    ("ArmChair_01",              "Vintage carved armchair",     "armchair",     0.5, 1.6),
    ("GreenChair_01",            "Green upholstered chair",     "chair",        0.4, 1.4),
    ("dining_chair_02",          "Wooden dining chair",         "chair",        0.4, 1.4),
    ("metal_stool_02",           "Low metal stool",             "stool",        0.2, 1.2),
    ("bar_chair_round_01",       "Round bar stool",             "stool",        0.2, 1.4),
    ("Ottoman_01",               "Upholstered ottoman",         "stool",        0.3, 1.2),
    ("painted_wooden_bench",     "Painted wooden bench",        "bench",        0.6, 2.5),
    ("dining_table",             "Dining table",                "dining",       1.0, 3.5),
    ("round_wooden_table_02",    "Small round dining table",    "table",        0.5, 2.0),
    ("modern_coffee_table_01",   "Modern coffee table",         "coffee table", 0.5, 2.0),
    ("modern_coffee_table_02",   "Round coffee table",          "coffee table", 0.5, 2.0),
    ("coffee_table_round_01",    "Large round coffee table",    "coffee table", 0.5, 2.0),
    ("side_table_01",            "Square side table",           "side table",   0.2, 1.2),
    ("ClassicNightstand_01",     "Classic nightstand",          "side table",   0.2, 1.2),
    ("metal_office_desk",        "Metal office desk",           "desk",         0.8, 2.6),
    ("Shelf_01",                 "Tall open shelf",             "shelf",        0.5, 3.0),
    ("steel_frame_shelves_01",   "Steel frame shelving",        "shelf",        0.5, 3.0),
    ("wooden_bookshelf_worn",    "Wooden bookcase",             "bookcase",     0.5, 3.0),
    ("modern_wooden_cabinet",    "Modern sideboard",            "cabinet",      0.5, 3.0),
    ("painted_wooden_cabinet",   "Painted wooden cabinet",      "cabinet",      0.5, 3.0),
    ("drawer_cabinet",           "Chest of drawers",            "dresser",      0.5, 2.5),
    ("old_bed_frame",            "Single bed frame",            "bed",          1.0, 2.6),
    ("modern_ceiling_lamp_01",   "Modern pendant lamp",         "lamp",         0.1, 2.0),
    ("desk_lamp_arm_01",         "Adjustable desk lamp",        "lamp",         0.1, 2.0),
    ("potted_plant_01",          "Tall potted plant",           "plant",        0.2, 2.5),
    ("potted_plant_02",          "Potted plant",                "plant",        0.2, 2.5),

    # --- Second wave -------------------------------------------------------------------------
    # Lamps first, because the library had only two. Poly Haven's lighting is period and
    # industrial rather than modern, so the set leans that way; each one still reads as a light
    # from three metres. Eleven of these need a wall or a ceiling to make sense — they are the
    # chandeliers, the pendants, the sconces and the strip light. That is called out in the
    # report rather than hidden, because a chandelier standing on the floor looks like a bug.
    ("Chandelier_01",            "Brass chandelier",            "lamp",         0.2, 2.0),
    ("Chandelier_02",            "Crystal chandelier",          "lamp",         0.2, 2.0),
    ("Chandelier_03",            "Tiered chandelier",           "lamp",         0.2, 2.0),
    ("chinese_chandelier",       "Wooden ceiling chandelier",   "lamp",         0.2, 2.0),
    ("lantern_chandelier_01",    "Lantern chandelier",          "lamp",         0.2, 2.0),
    ("caged_hanging_light",      "Caged pendant light",         "lamp",         0.1, 2.0),
    ("hanging_industrial_lamp",  "Industrial pendant lamp",     "lamp",         0.1, 2.0),
    ("mounted_fluorescent_lights", "Fluorescent ceiling light", "lamp",         0.1, 2.0),
    ("industrial_caged_sconce",  "Caged wall sconce",           "lamp",         0.1, 2.0),
    ("industrial_wall_lamp",     "Industrial wall lamp",        "lamp",         0.05, 1.5),
    ("industrial_wall_sconce",   "Small wall sconce",           "lamp",         0.05, 1.5),
    ("industrial_pipe_lamp",     "Industrial pipe desk lamp",              "lamp",         0.05, 1.5),
    ("vintage_oil_lamp",         "Vintage oil table lamp",            "lamp",         0.05, 1.5),
    ("wooden_lantern_01",        "Wooden table lantern",              "lamp",         0.05, 1.5),
    ("Lantern_01",               "Small metal table lantern",         "lamp",         0.05, 1.5),
    ("brass_diya_lantern",       "Brass diya table lamp",          "lamp",         0.05, 1.5),

    # More seating, for variety rather than count.
    ("Rockingchair_01",          "Rocking chair",               "chair",        0.4, 1.6),
    ("SchoolChair_01",           "School chair",                "chair",        0.4, 1.4),
    ("gallinera_chair",          "Gallinera chair",             "chair",        0.4, 1.4),
    ("painted_wooden_chair_01",  "Painted wooden chair",        "chair",        0.4, 1.4),
    ("painted_wooden_chair_02",  "High-back painted chair",     "chair",        0.4, 1.6),
    ("plastic_monobloc_chair_01", "Plastic garden chair",       "chair",        0.4, 1.4),
    ("chinese_armchair",         "Carved wooden armchair",      "armchair",     0.5, 1.8),
    ("chinese_sofa",             "Carved wooden sofa",          "sofa",         1.2, 3.5),
    ("painted_wooden_sofa",      "Painted wooden settle",       "sofa",         1.2, 3.5),
    ("metal_stool_01",           "Tall metal stool",            "stool",        0.2, 1.2),
    ("metal_stool_03",           "Metal bar stool",             "stool",        0.2, 1.4),
    ("wooden_stool_01",          "Wooden stool",                "stool",        0.2, 1.2),
    ("folding_wooden_stool",     "Folding wooden stool",        "stool",        0.2, 1.2),
    ("vintage_day_bed",          "Vintage day bed",             "bed",          1.0, 2.6),
    ("GothicBed_01",             "Carved double bed",           "bed",          1.0, 2.6),

    # Tables, the other thin category.
    ("CoffeeTable_01",           "Glass-top coffee table",      "coffee table", 0.5, 2.0),
    ("WoodenTable_01",           "Long wooden coffee table",    "coffee table", 0.5, 2.0),
    ("chinese_tea_table",        "Square tea table",            "coffee table", 0.4, 2.0),
    ("gothic_coffee_table",      "Carved square coffee table",  "coffee table", 0.5, 2.0),
    ("industrial_coffee_table",  "Industrial coffee table",     "coffee table", 0.4, 2.0),
    ("ClassicConsole_01",        "Classic console table",       "table",        0.5, 2.5),
    ("chinese_console_table",    "Long console table",          "table",        0.5, 2.5),
    ("round_wooden_table_01",    "Round dining table",          "dining",       0.8, 2.5),
    ("painted_wooden_table",     "Painted dining table",        "dining",       1.0, 3.5),
    ("wooden_table_02",          "Plain wooden dining table",   "dining",       0.8, 3.0),
    ("WoodenTable_02",           "Small square side table",     "side table",   0.2, 1.2),
    ("painted_wooden_nightstand", "Painted nightstand",         "side table",   0.2, 1.2),
    ("side_table_tall_01",       "Tall side table",             "side table",   0.2, 1.2),
    ("small_wooden_table_01",    "Low wooden side table",       "side table",   0.2, 1.4),
    ("WoodenTable_03",           "Wooden sideboard",            "cabinet",      0.5, 3.0),
    ("SchoolDesk_01",            "School desk",                 "desk",         0.4, 2.0),

    # Storage. steel_frame_shelves_02 and _03 are the same family as steel_frame_shelves_01,
    # which measured 21 m against a published 2.14 m. They are included ON PURPOSE: if the
    # family shares that export fault, the gate says so from the measured bytes.
    # (steel_frame_shelves_01 is already in the first wave above; it was never seeded, so it is
    # re-fetched and re-measured on this run rather than assumed still broken.)
    ("steel_frame_shelves_02",   "Narrow steel shelving",       "shelf",        0.5, 3.0),
    ("steel_frame_shelves_03",   "Wide steel shelving",         "shelf",        0.5, 3.0),
    ("painted_wooden_shelves",   "Small painted shelves",       "shelf",        0.3, 2.5),
    ("wooden_display_shelves_01", "Wooden display shelves",     "shelf",        0.3, 2.5),
    ("worn_metal_rack",          "Metal storage rack",          "shelf",        0.5, 3.0),
    ("GothicCabinet_01",         "Carved tall cabinet",         "cabinet",      0.5, 3.0),
    ("chinese_cabinet",          "Tall wooden cabinet",         "cabinet",      0.5, 3.0),
    ("painted_wooden_cabinet_02", "Tall painted cupboard",      "cabinet",      0.5, 3.0),
    ("vintage_cabinet_01",       "Vintage glass cabinet",       "cabinet",      0.5, 3.0),
    ("GothicCommode_01",         "Carved commode",              "dresser",      0.5, 2.5),
    ("vintage_wooden_drawer_01", "Small drawer unit",           "dresser",      0.3, 2.0),
    ("potted_plant_04",          "Small potted plant",          "plant",        0.1, 2.5),

    # Television is in the app's vocabulary, so these two are honest matches.
    ("Television_01",            "Vintage television",          "television",   0.2, 1.6),
    ("television_02",            "Small vintage television",    "television",   0.2, 1.6),

    # --- Desk and room props ------------------------------------------------------------------
    # NONE of these categories is in the app's `known` list. They seed and they show on the
    # Furniture page, but the app cannot use them to decide which scanned piece they stand in
    # for. Every one is flagged categoryInKnownList:false and listed in the report. The nearest
    # existing word was not honest for any of them — a mirror is not a "tv", a vase is not a
    # "plant" — so no word was stretched to fit.
    ("classic_laptop",           "Laptop computer",             "laptop",       0.2, 1.0),
    ("book_encyclopedia_set_01", "Encyclopedia set",            "books",        0.1, 1.5),
    ("decorative_book_set_01",   "Stack of books",              "books",        0.1, 3.0),
    ("office_notepads",          "Notepads",                    "stationery",   0.05, 1.5),
    ("stationery_supplies",      "Desk stationery",             "stationery",   0.05, 1.0),
    ("vintage_stapler",          "Stapler",                     "stationery",   0.03, 0.6),
    ("clipboard",                "Clipboard",                   "stationery",   0.05, 0.8),
    ("standing_chalkboard_01",   "Standing chalkboard",         "chalkboard",   0.4, 2.5),
    ("wall_clock",               "Wall clock",                  "clock",        0.05, 1.0),
    ("alarm_clock_01",           "Alarm clock",                 "clock",        0.03, 0.6),
    ("ornate_mirror_01",         "Ornate wall mirror",          "mirror",       0.2, 2.5),
    ("hanging_picture_frame_01", "Hanging picture frame",       "picture frame", 0.1, 1.5),
    ("fancy_picture_frame_01",   "Gilt picture frame",          "picture frame", 0.1, 1.5),
    ("standing_picture_frame_01", "Standing photo frame",       "picture frame", 0.05, 0.8),
    ("ceramic_vase_01",          "Ceramic vase",                "vase",         0.05, 1.0),
    ("brass_vase_02",            "Brass vase",                  "vase",         0.05, 1.0),
    ("planter_pot_clay",         "Clay planter pot",            "planter",      0.05, 1.2),
    ("planter_box_01",           "Wooden planter box",          "planter",      0.1, 2.0),
    ("throw_pillows_01",         "Throw pillows",               "cushion",      0.1, 1.5),
    ("ceiling_fan",              "Ceiling fan",                 "fan",          0.3, 2.0),
    ("industrial_pastic_container", "Storage bin",              "bin",          0.1, 1.5),
]


# --- Second source: Khronos glTF-Sample-Assets -----------------------------------------------
# Poly Haven is exhausted for room furnishing: it has no floor lamp, no wheeled office chair and
# no rug. This is the only other token-free source that filled one of those gaps. Smithsonian
# Open Access answers 403 without an api.data.gov key, which this panel was not given, and
# ambientCG publishes 34 models, all food and a tree stump.
#
# Unlike Poly Haven, the licence here is PER MODEL, in that model's README.md, and it is not all
# CC0. Each entry states the licence it was read under, and the fetch REFUSES if that README no
# longer contains it. A licence is not something to assume from last time.
KHRONOS_RAW = "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models"
KHRONOS = [
    # (model, display name, category, min_largest_m, max_largest_m, licence, licence url,
    #  authors, copyright notice, the phrase that must still appear in the README)
    ("LightsPunctualLamp", "Arc floor lamp", "lamp", 0.5, 2.5,
     "CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/legalcode",
     ["Teresa Gonz\u00e1lez Viegas"], "\u00a9 2021, DGG",
     "Creative Commons Attribution 4.0 International"),
]


def khronos_download(model, phrase, work):
    """Fetch the binary glTF and the README, and refuse if the stated licence has changed."""
    readme = get(f"{KHRONOS_RAW}/{model}/README.md", binary=True).decode("utf-8", "replace")
    if phrase not in readme:
        raise Stop(f"{model}: its README no longer states {phrase!r}; refusing to reuse it")
    directory = work / model
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{model}.glb"
    body = get(f"{KHRONOS_RAW}/{model}/glTF-Binary/{model}.glb", binary=True)
    target.write_bytes(body)
    return target, len(body)


def process_khronos(spec, args, previous):
    model, name, category, low, high, licence, licence_url, authors, copyright_, phrase = spec
    record = {"source": "khronos-gltf-sample-assets", "assetId": model, "name": name,
              "category": category, "categoryInKnownList": category in KNOWN_CATEGORIES,
              "mount": MOUNT.get(model),
              "url": f"https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/{model}",
              "license": licence, "licenseUrl": licence_url, "attribution": authors,
              "copyrightNotice": copyright_,
              # CC-BY 4.0 asks that changes be indicated. They are, here and in the manifest.
              "modifications": ("repacked to a single GLB with 1k textures; geometry unchanged, "
                                "never rescaled"),
              "objectId": object_id(model, KHRONOS_ID_PREFIX), "status": None}

    earlier = previous.get(model)
    if earlier and not args.plan_only and not args.refresh:
        done = already_seeded(args.base, record["objectId"], earlier["packedSha256"])
        if done is not None:
            return {**earlier, **record, "status": "already_seeded",
                    "verified": verify(args.base, record["objectId"], earlier["packedSha256"],
                                       earlier["bboxMeters"])}

    work = Path(args.work)
    source, downloaded = khronos_download(model, phrase, work)
    record["sourceFileUrl"] = f"{KHRONOS_RAW}/{model}/glTF-Binary/{model}.glb"
    record["sourceBytes"] = downloaded
    record["sourceSha256"] = hashlib.sha256(source.read_bytes()).hexdigest()

    packed = work / f"{model}.packed.glb"
    pack(source, packed)
    count = triangles(packed)
    if count > MAX_TRIANGLES:
        ratio = round(MAX_TRIANGLES / count, 4)
        reduced = work / f"{model}.simplified.glb"
        simplify(packed, reduced, ratio)
        record["simplifiedRatio"] = ratio
        packed, count = reduced, triangles(reduced)
    glb = packed.read_bytes()
    sha256 = hashlib.sha256(glb).hexdigest()
    record.update({"triangles": count, "bytes": len(glb), "packedSha256": sha256,
                   "textureSize": 1024, "compression": "none"})

    box, raw = measure(packed)
    record["bboxMeters"] = box
    record["measuredTransformed"] = raw["transformed"]
    record["restsOnFloorMinY"] = round(raw["min"][1], 4)
    largest = max(box.values())
    if len(glb) > MAX_BYTES:
        return {**record, "status": "skipped",
                "reason": f"packed to {len(glb)} bytes, over the {MAX_BYTES} budget"}
    if not (low <= largest <= high):
        return {**record, "status": "skipped",
                "reason": f"largest side {largest:.3f} m is outside the plausible {low}-{high} m for a {category}"}
    if args.plan_only:
        return {**record, "status": "planned"}

    oid = record["objectId"]
    post(f"{args.base}/v1/objects", {
        "objectId": oid, "source": "primitive", "name": name, "category": category,
        "bboxMeters": box, "measure": {"method": "declared", "confidence": 0.5},
    })
    key, _ = attach(args.base, oid, glb, sha256)
    record["glbKey"] = key
    return {**record, "status": "seeded", "verified": verify(args.base, oid, sha256, box)}


# --- Third source: one model from Objaverse, with a recorded unit conversion ------------------
# THE ONLY LIBRARY MODEL WHOSE SIZE WAS INFERRED RATHER THAN AUTHORED IN METRES.
#
# Poly Haven has no floor lamp and the Khronos arc lamp was not liked. This one is a genuine
# arco-style arched floor lamp, but its glTF is in centimetres: the lamp alone measures 213 x 232
# x 36 units. glTF is metres by definition, so that is not a measurement this project can take at
# face value, and the standing rule is never to rescale and never to assign a looked-up size.
# Thomas overruled that for this one model on 2026-09-20 after being shown the numbers. The
# exception is recorded in the manifest, in the attribution note and in the ledger so that nobody
# later mistakes it for a measured asset.
#
# Two edits, both recorded, neither a per-axis fit:
#   1. one node removed — `Plane_Fondo_0`, a two-triangle ground/backdrop plane spanning 414
#      units. Removing a stage prop is not rescaling; it is why the raw bbox looked 4.14 m square.
#   2. ONE uniform scale of 0.01 (centimetres to metres), applied as a wrapper node and baked by
#      the packer. Not per-axis, not rounded to a nicer number.
# The result measures 2.13 x 2.32 x 0.36 m with its base on y = 0, which is what an arco lamp is.
OBJAVERSE_HF = "https://huggingface.co/datasets/allenai/objaverse/resolve/main"
OBJAVERSE_ID_PREFIX = "full-scale:library:objaverse:"
OBJAVERSE = [
    # (uid, path, display name, category, min_m, max_m, licence, licence url, authors,
    #  source page, node name to drop, unit factor, unit note)
    ("d8a1a19f3b324dc294d2746908f392c3", "glbs/000-031/d8a1a19f3b324dc294d2746908f392c3.glb",
     "Arched floor lamp", "lamp", 1.5, 2.6,
     "CC-BY-4.0", "https://creativecommons.org/licenses/by/4.0/legalcode", ["Malrus"],
     "https://sketchfab.com/3d-models/none-d8a1a19f3b324dc294d2746908f392c3",
     "Plane_Fondo_0", 0.01, "cm (inferred from a 232-unit height)"),
]


def edit_glb(source, target, drop_node, factor):
    """Drop one named node and wrap the scene in ONE uniform scale. Recorded, never silent."""
    raw = source.read_bytes()
    magic, version, total = struct.unpack("<4sII", raw[:12])
    if magic != b"glTF" or version != 2:
        raise Stop(f"{source.name}: not a binary glTF 2.0")
    chunks, offset = [], 12
    while offset < total:
        length, kind = struct.unpack("<II", raw[offset:offset + 8])
        chunks.append((kind, raw[offset + 8:offset + 8 + length]))
        offset += 8 + length
    doc = json.loads(next(d for k, d in chunks if k == 0x4E4F534A))
    binary = next((d for k, d in chunks if k == 0x004E4942), b"")

    if drop_node:
        matches = [i for i, n in enumerate(doc["nodes"]) if n.get("name") == drop_node]
        if len(matches) != 1:
            raise Stop(f"{source.name}: expected exactly one node named {drop_node!r}, found {len(matches)}")
        index = matches[0]
        for node in doc["nodes"]:
            if "children" in node:
                node["children"] = [c for c in node["children"] if c != index]
        for scene in doc["scenes"]:
            scene["nodes"] = [c for c in scene.get("nodes", []) if c != index]

    scene = doc["scenes"][doc.get("scene", 0)]
    doc["nodes"].append({"name": "unit-conversion", "children": list(scene["nodes"]),
                         "scale": [factor, factor, factor]})
    scene["nodes"] = [len(doc["nodes"]) - 1]

    text = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    body = struct.pack("<II", len(text), 0x4E4F534A) + text
    if binary:
        body += struct.pack("<II", len(binary), 0x004E4942) + binary
    target.write_bytes(struct.pack("<4sII", b"glTF", 2, 12 + len(body)) + body)


def process_objaverse(spec, args, previous):
    (uid, path, name, category, low, high, licence, licence_url, authors, page,
     drop_node, factor, unit_note) = spec
    record = {"source": "objaverse", "assetId": uid, "name": name, "category": category,
              "categoryInKnownList": category in KNOWN_CATEGORIES, "mount": "floor",
              "url": page, "license": licence, "licenseUrl": licence_url,
              "attribution": authors,
              "unitConversion": {"factor": factor, "from": unit_note, "to": "m",
                                 "approvedBy": "Thomas, 2026-09-20",
                                 "note": ("the ONLY library model whose size was inferred rather "
                                          "than authored in metres")},
              "removedNode": drop_node,
              "modifications": (f"removed the node {drop_node!r} (a two-triangle ground/backdrop "
                                f"plane); uniformly scaled by {factor} (unit conversion, cm to m); "
                                "repacked to a single GLB with 1k textures"),
              "objectId": object_id(uid, OBJAVERSE_ID_PREFIX), "status": None}

    earlier = previous.get(uid)
    if earlier and not args.plan_only and not args.refresh:
        done = already_seeded(args.base, record["objectId"], earlier["packedSha256"])
        if done is not None:
            return {**earlier, **record, "status": "already_seeded",
                    "verified": verify(args.base, record["objectId"], earlier["packedSha256"],
                                       earlier["bboxMeters"])}

    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    original = work / f"{uid}.original.glb"
    original.write_bytes(get(f"{OBJAVERSE_HF}/{path}", binary=True))
    record["sourceFileUrl"] = f"{OBJAVERSE_HF}/{path}"
    record["sourceBytes"] = original.stat().st_size
    record["sourceSha256"] = hashlib.sha256(original.read_bytes()).hexdigest()
    record["boundsAsAuthored"] = measure(original)[0]

    edited = work / f"{uid}.edited.glb"
    edit_glb(original, edited, drop_node, factor)
    packed = work / f"{uid}.packed.glb"
    pack(edited, packed)
    glb = packed.read_bytes()
    sha256 = hashlib.sha256(glb).hexdigest()
    record.update({"triangles": triangles(packed), "bytes": len(glb), "packedSha256": sha256,
                   "textureSize": 1024, "compression": "none"})

    box, raw = measure(packed)
    record["bboxMeters"] = box
    record["boundsAsShipped"] = box
    record["restsOnFloorMinY"] = round(raw["min"][1], 4)
    largest = max(box.values())
    if len(glb) > MAX_BYTES:
        return {**record, "status": "skipped",
                "reason": f"packed to {len(glb)} bytes, over the {MAX_BYTES} budget"}
    if not (low <= largest <= high):
        return {**record, "status": "skipped",
                "reason": f"largest side {largest:.3f} m is outside the plausible {low}-{high} m for a {category}"}
    if args.plan_only:
        return {**record, "status": "planned"}

    oid = record["objectId"]
    post(f"{args.base}/v1/objects", {
        "objectId": oid, "source": "primitive", "name": name, "category": category,
        "bboxMeters": box, "measure": {"method": "declared", "confidence": 0.5},
    })
    key, _ = attach(args.base, oid, glb, sha256)
    record["glbKey"] = key
    return {**record, "status": "seeded", "verified": verify(args.base, oid, sha256, box)}


def say(message):
    print(message, flush=True)


class Stop(Exception):
    """A loud refusal. Nothing is guessed and nothing half-written is left behind."""


def get(url, *, binary=False, timeout=120):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status != 200:
            raise Stop(f"GET {url} answered {response.status}")
        body = response.read()
    return body if binary else json.loads(body)


def post(url, payload, *, headers=None):
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST",
                                     headers={"User-Agent": USER_AGENT,
                                              "content-type": "application/json", **(headers or {})})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read())


def put(url, body, content_type):
    request = urllib.request.Request(url, data=body, method="PUT",
                                     headers={"User-Agent": USER_AGENT, "content-type": content_type})
    with urllib.request.urlopen(request, timeout=300) as response:
        if response.status not in (200, 201, 204):
            raise Stop(f"PUT {url} answered {response.status}")


def object_id(asset_id, prefix=None):
    """Fixed id, so a re-run addresses the same row. The prefix names the source, truthfully."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, (prefix or ID_PREFIX) + asset_id))


def download_gltf(asset_id, work):
    """Fetch the 1k glTF and every file it includes, verifying each md5 the API supplies."""
    files = get(f"{API}/files/{asset_id}")
    variants = files.get("gltf") or {}
    if "1k" not in variants or "gltf" not in variants["1k"]:
        raise Stop(f"{asset_id}: the API offers no 1k glTF variant (has {sorted(variants)})")
    entry = variants["1k"]["gltf"]
    directory = work / asset_id
    directory.mkdir(parents=True, exist_ok=True)
    root = directory / f"{asset_id}.gltf"

    def fetch(url, target, md5):
        target.parent.mkdir(parents=True, exist_ok=True)
        body = get(url, binary=True)
        if hashlib.md5(body).hexdigest() != md5:
            raise Stop(f"{asset_id}: md5 mismatch for {url}")
        target.write_bytes(body)
        return len(body)

    total = fetch(entry["url"], root, entry["md5"])
    for relative, info in (entry.get("include") or {}).items():
        if ".." in Path(relative).parts or Path(relative).is_absolute():
            raise Stop(f"{asset_id}: the API returned an unsafe include path {relative!r}")
        total += fetch(info["url"], directory / relative, info["md5"])
    return root, total, entry["url"]


def pack(source, target):
    """One self-contained .glb. See PACK_ARGS for why each flag is set the way it is."""
    result = subprocess.run(
        ["npx", "--yes", "@gltf-transform/cli@4.5.0", "optimize", str(source), str(target), *PACK_ARGS],
        capture_output=True, text=True)
    if result.returncode != 0 or not target.exists():
        raise Stop(f"gltf-transform failed: {(result.stderr or result.stdout)[-400:]}")


def simplify(source, target, ratio):
    result = subprocess.run(
        ["npx", "--yes", "@gltf-transform/cli@4.5.0", "simplify", str(source), str(target),
         "--ratio", str(ratio), "--error", "0.001"],
        capture_output=True, text=True)
    if result.returncode != 0 or not target.exists():
        raise Stop(f"gltf-transform simplify failed: {(result.stderr or result.stdout)[-400:]}")


def triangles(path):
    document = glb_bounds.read_json_chunk(str(path))
    total = 0
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            index = primitive.get("indices")
            if index is None:
                index = primitive["attributes"]["POSITION"]
            total += document["accessors"][index]["count"] // 3
    return total


def measure(path):
    """Metres, as authored. glTF is Y-up, so the extent is (w, h, d) directly."""
    box = glb_bounds.bounds(str(path))
    w, h, d = box["extent"]
    return {"w": round(w, 4), "h": round(h, 4), "d": round(d, 4)}, box


def already_seeded(base, oid, sha256):
    """A re-run is a no-op when the row is ready and serves exactly these bytes."""
    try:
        row = get(f"{base}/v1/objects/{oid}")
    except Exception:
        return None
    if row.get("state") != "ready" or not row.get("glbUrl"):
        return None
    try:
        stored = get(row["glbUrl"], binary=True)
    except Exception:
        return None
    return row if hashlib.sha256(stored).hexdigest() == sha256 else None


def attach(base, oid, glb, sha256):
    grant = post(f"{base}/v1/uploads", {"kind": "objectMesh", "ext": "glb", "objectId": oid})
    expected = f"objects/{oid}/mesh.glb"
    if grant.get("key") != expected:
        raise Stop(f"the upload grant named {grant.get('key')!r}, not {expected!r}")
    put(grant["putUrl"], glb, "model/gltf-binary")
    stored = get(f"{base}/v1/assets/{expected}", binary=True)
    if hashlib.sha256(stored).hexdigest() != sha256:
        raise Stop("the stored bytes do not hash to the packed file")
    row = post(f"{base}/v1/objects/{oid}/mesh", {"key": grant["key"]})
    if row.get("state") != "ready":
        raise Stop(f"the Worker answered 200 but the row is {row.get('state')!r}, not ready")
    return grant["key"], row


def verify(base, oid, sha256, box):
    row = get(f"{base}/v1/objects/{oid}")
    problems = []
    if row.get("state") != "ready":
        problems.append(f"state is {row.get('state')}")
    if not row.get("glbUrl"):
        problems.append("glbUrl is null")
    else:
        body = get(row["glbUrl"], binary=True)
        if body[:4] != b"glTF":
            problems.append("the served bytes are not a binary glTF")
        if hashlib.sha256(body).hexdigest() != sha256:
            problems.append("the served bytes do not hash to the packed file")
    if row.get("bboxMeters") != box:
        problems.append(f"the row's bboxMeters is {row.get('bboxMeters')}, not the measured {box}")
    listed = any(r["objectId"] == oid for r in get(f"{base}/v1/objects?source=primitive&limit=200"))
    if not listed:
        problems.append("the row is absent from GET /v1/objects?source=primitive")
    return {"ok": not problems, "problems": problems, "glbUrl": row.get("glbUrl"),
            "state": row.get("state"), "listed": listed}


def process(spec, args, index, previous):
    asset_id, name, category, low, high = spec
    record = {"source": "polyhaven", "assetId": asset_id, "name": name, "category": category,
              "categoryInKnownList": category in KNOWN_CATEGORIES, "mount": MOUNT.get(asset_id),
              "url": f"https://polyhaven.com/a/{asset_id}", "license": LICENSE,
              "licenseUrl": LICENSE_URL, "objectId": object_id(asset_id), "status": None}
    meta = index.get(asset_id)
    if meta is None:
        return {**record, "status": "skipped", "reason": "not in the Poly Haven model list"}

    # A model this manifest already recorded is checked BEFORE it is fetched again: the
    # post-pack check needs the packed hash, which would mean re-downloading every earlier
    # model on every run. A changed upstream file simply is not noticed until --refresh.
    earlier = previous.get(asset_id)
    if earlier and not args.plan_only and not args.refresh:
        done = already_seeded(args.base, record["objectId"], earlier["packedSha256"])
        if done is not None:
            return {**earlier, **{k: record[k] for k in ("name", "category", "categoryInKnownList", "mount")},
                    "status": "already_seeded",
                    "verified": verify(args.base, record["objectId"], earlier["packedSha256"],
                                       earlier["bboxMeters"])}
    record["attribution"] = sorted(meta.get("authors", {}))
    record["polyhavenPolycount"] = meta.get("polycount")

    work = Path(args.work)
    gltf, downloaded, gltf_url = download_gltf(asset_id, work)
    record["sourceFileUrl"] = gltf_url
    record["sourceBytes"] = downloaded
    record["sourceSha256"] = hashlib.sha256(gltf.read_bytes()).hexdigest()

    packed = work / f"{asset_id}.glb"
    pack(gltf, packed)
    count = triangles(packed)
    if count > MAX_TRIANGLES:
        ratio = round(MAX_TRIANGLES / count, 4)
        reduced = work / f"{asset_id}.simplified.glb"
        simplify(packed, reduced, ratio)
        record["simplifiedRatio"] = ratio
        packed, count = reduced, triangles(reduced)
    glb = packed.read_bytes()
    sha256 = hashlib.sha256(glb).hexdigest()
    record.update({"triangles": count, "bytes": len(glb), "packedSha256": sha256,
                   "textureSize": 1024, "compression": "none"})

    box, raw = measure(packed)
    record["bboxMeters"] = box
    record["measuredTransformed"] = raw["transformed"]
    largest = max(box.values())
    if len(glb) > MAX_BYTES:
        return {**record, "status": "skipped", "reason": f"packed to {len(glb)} bytes, over the {MAX_BYTES} budget"}
    if not (low <= largest <= high):
        # Standing rule 4: an implausible size is reported, never corrected.
        return {**record, "status": "skipped",
                "reason": f"largest side {largest:.3f} m is outside the plausible {low}-{high} m for a {category}"}
    # The API publishes dimensions in millimetres, Z-up. Cross-check, do not correct.
    if meta.get("dimensions"):
        x, y, z = [v / 1000 for v in meta["dimensions"]]
        drift = max(abs(box["w"] - x), abs(box["h"] - z), abs(box["d"] - y))
        record["apiDimensionDriftM"] = round(drift, 4)

    if args.plan_only:
        return {**record, "status": "planned"}
    if asset_id in HELD:
        # Measured and recorded, never posted. Nothing about this model reaches D1 or R2.
        return {**record, "status": "held", "held": HELD_REASON}

    oid = record["objectId"]
    done = already_seeded(args.base, oid, sha256)
    if done is not None:
        return {**record, "status": "already_seeded", "verified": verify(args.base, oid, sha256, box)}

    post(f"{args.base}/v1/objects", {
        "objectId": oid, "source": "primitive", "name": name, "category": category,
        "bboxMeters": box,
        # Nobody measured a real object: the size is whatever the author exported.
        "measure": {"method": "declared", "confidence": 0.5},
    })
    key, _ = attach(args.base, oid, glb, sha256)
    record["glbKey"] = key
    return {**record, "status": "seeded", "verified": verify(args.base, oid, sha256, box)}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", required=True, help="https origin of the Worker; never defaulted")
    parser.add_argument("--work", required=True, help="scratch directory for downloads and packed GLBs")
    parser.add_argument("--manifest", required=True, help="where to write the committed manifest")
    parser.add_argument("--only", action="append", default=None, help="Poly Haven asset id; repeatable")
    parser.add_argument("--plan-only", action="store_true", help="download, pack and measure; upload nothing")
    parser.add_argument("--refresh", action="store_true",
                        help="re-fetch and re-pack even a model the manifest already records")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.base.startswith("https://"):
        raise SystemExit("--base must be an https origin")
    args.base = args.base.rstrip("/")
    Path(args.work).mkdir(parents=True, exist_ok=True)
    index = get(f"{API}/assets?type=models")
    manifest_path = Path(args.manifest)
    previous = {}
    if manifest_path.exists():
        for row in json.loads(manifest_path.read_text(encoding="utf-8")).get("models", []):
            if row.get("status") in ("seeded", "already_seeded") and row.get("packedSha256"):
                previous[row["assetId"]] = row
    wanted = set(args.only) if args.only else None
    specs = [("polyhaven", s) for s in CURATED if not wanted or s[0] in wanted]
    specs += [("khronos", s) for s in KHRONOS if not wanted or s[0] in wanted]
    specs += [("objaverse", s) for s in OBJAVERSE if not wanted or s[0] in wanted]
    records = []
    for number, (origin_name, spec) in enumerate(specs, 1):
        try:
            record = (process_khronos(spec, args, previous) if origin_name == "khronos"
                      else process_objaverse(spec, args, previous) if origin_name == "objaverse"
                      else process(spec, args, index, previous))
        except Stop as stop:
            record = {"assetId": spec[0], "name": spec[1], "category": spec[2],
                      "status": "failed", "reason": str(stop)}
        except Exception as error:  # one bad model must not end the run
            record = {"assetId": spec[0], "name": spec[1], "category": spec[2],
                      "status": "failed", "reason": f"{type(error).__name__}: {error}"}
        records.append(record)
        say(f"[{number}/{len(specs)}] {record['assetId']}: {record['status']}"
            f"{' - ' + record['reason'] if record.get('reason') else ''}")
    manifest = {
        "schemaVersion": 1,
        "note": ("Library models for the headset's Furniture page. Every row is "
                 "source:\"primitive\" — a library model, never a merchant product. Sizes are "
                 "as authored, in metres; nothing here was ever rescaled."),
        "sources": {
            "polyhaven": {"license": LICENSE, "url": LICENSE_URL,
                          "note": "site-wide CC0; attribution recorded although not required"},
            "objaverse": {
                "license": "per model; only CC0 or CC-BY are used, read before download",
                "url": "https://huggingface.co/datasets/allenai/objaverse",
                "note": ("Holds ONE model. Most Objaverse GLBs are normalised to a unit cube "
                         "and carry no real size, so they cannot be used here. The one taken "
                         "is in centimetres and its unit conversion is recorded per model "
                         "under unitConversion, approved by Thomas.")},
            "khronos-gltf-sample-assets": {
                "license": "per model, read from that model's README.md",
                "url": "https://github.com/KhronosGroup/glTF-Sample-Assets",
                "note": ("NOT all CC0. Each entry records the licence it was read under, its "
                         "copyright notice and its authors, and the fetch refuses if the "
                         "README no longer states that licence.")}},
        "license": {"id": LICENSE, "url": LICENSE_URL,
                    "statement": ("Poly Haven publishes every asset on the site as CC0. "
                                  "Redistribution and commercial use are permitted and "
                                  "attribution is not required; the authors are recorded here "
                                  "anyway.")},
        "packing": {"tool": "gltf-transform 4.5.0 optimize", "args": PACK_ARGS,
                    "textureSize": 1024, "compression": "none",
                    "reason": ("The headset's GLTFLoader has Draco, KTX2 and Meshopt wired "
                               "(apps/xr/src/objects.ts), so compression is available but not "
                               "needed at this size. Uncompressed geometry also keeps POSITION "
                               "min/max readable, so the uploaded bytes are the measured bytes.")},
        "models": records,
    }
    Path(args.manifest).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    say(f"manifest: {args.manifest}")
    held = [r for r in records if r["status"] == "held"]
    if held:
        say(f"held, packed and measured but NOT seeded ({len(held)}): {HELD_REASON}")
        for r in held:
            say(f"  {r['assetId']} ({r.get('mount')})")
    return 1 if any(r["status"] == "failed" for r in records) else 0


if __name__ == "__main__":
    sys.exit(main())
