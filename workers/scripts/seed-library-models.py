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
]


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


def object_id(asset_id):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, ID_PREFIX + asset_id))


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


def process(spec, args, index):
    asset_id, name, category, low, high = spec
    record = {"source": "polyhaven", "assetId": asset_id, "name": name, "category": category,
              "url": f"https://polyhaven.com/a/{asset_id}", "license": LICENSE,
              "licenseUrl": LICENSE_URL, "objectId": object_id(asset_id), "status": None}
    meta = index.get(asset_id)
    if meta is None:
        return {**record, "status": "skipped", "reason": "not in the Poly Haven model list"}
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
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if not args.base.startswith("https://"):
        raise SystemExit("--base must be an https origin")
    args.base = args.base.rstrip("/")
    Path(args.work).mkdir(parents=True, exist_ok=True)
    index = get(f"{API}/assets?type=models")
    specs = [s for s in CURATED if not args.only or s[0] in set(args.only)]
    records = []
    for number, spec in enumerate(specs, 1):
        try:
            record = process(spec, args, index)
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
    return 1 if any(r["status"] == "failed" for r in records) else 0


if __name__ == "__main__":
    sys.exit(main())
