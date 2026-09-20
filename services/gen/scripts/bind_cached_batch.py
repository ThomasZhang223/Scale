"""Bind Paul's saved SF3D catalogue meshes to their D1 dimensions, then attach them.

    python scripts/bind_cached_batch.py --models ~/Downloads/Paul-3D-models \
        --worker-origin https://<worker> --store /store --scope <scope> --reviewer <id> \
        --report out.json [--only SLUG] [--limit N] [--plan-only]

Paul generated 88 textured GLBs with SF3D offline. They are RAW reconstructions: roughly
unit-sized, dimensions never applied (see the set's README.txt). A raw mesh must never become
an object's mesh -- standing rule 2 says the scale binding happens exactly once, in this
component. This script does not bind anything itself. For each mesh it seeds one hero_store
attempt, exactly as prepare.py's `generate` subcommand would after a paid call, and then calls
prepare.py `bind` and approve.py. Ani's binder, her receipt, her deliver() and her
WorkerArtifactSink all run once and unchanged, and the provider is never contacted: the replay
path is prepare.py's own CachedRawProvider, whose evidence label is `cached_real_sf3d`.

What the seeder must establish before it writes an attempt, per model:

  identity     the objectId comes from the Worker, never from this script. productUrl matches
               a live catalogue row, the Worker's own stableId of that productUrl reproduces
               the row's id, and the merchant agrees. The public object API does not expose
               productId, so productId+merchant is proven by the R2 key instead: the image at
               catalog/{merchant}/{productId}/source.jpg must hash to the manifest's
               source_sha256. All four checks must hold or the model is listed unmatched.
  dimensions   from the D1 row's bboxMeters, in metres, never from the manifest. A disagreement
               with the manifest beyond 1 mm is recorded and the D1 value is used. A missing or
               non-positive dimension is a skip, never a default (standing rule 4).
  bytes        the GLB must hash to the manifest's sha256, and the source image to its
               source_sha256, before either is copied into the store.

Orientation is the identity profile, the same one app/generate_server.py declares for the live
path, expressed as `--up Y+ --front Z-`. Every mesh is also MEASURED against its target box:
the report carries the raw extents, the target, and the best axis permutation with its score,
so a mesh that fits the box far better after a 90-degree yaw is listed as suspect. Nothing is
silently reoriented -- a suspect mesh is still bound with identity and Ani's own validation is
what decides whether it is accepted at all.

# ceiling: one orientation for all 88, so a mesh SF3D produced facing another way is bound as
# is. Same ceiling app/generate_server.py accepts; the upgrade is a reviewed per-model profile,
# which prepare.py already supports through --up/--front.
# ceiling: 12 Bend Goods meshes were generated from a white-composited derivative of the
# catalogue image (background-corrections.json). Those composited bytes were not kept, so the
# receipt's imageSha256 names the catalogue source image they were derived from. The report
# records submittedImageSha256 and backgroundCorrection for every one of them, and so does the
# attempt sidecar. The upgrade is for the generator to keep the submitted bytes.
"""
import argparse
import hashlib
import io
import json
import sys
from pathlib import Path

GEN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(GEN_ROOT))

import numpy as np
import trimesh

import approve
import hero_store as hs
import prepare
from hero_store import Refusal

# The axis pair that produces the identity matrix in prepare.orientation_matrix(): the project
# frame itself (+Y up, -Z front). Asserted below rather than trusted.
UP, FRONT = "Y+", "Z-"
IDENTITY = ((1, 0, 0), (0, 1, 0), (0, 0, 1))
DIMENSION_TOLERANCE_M = 0.001
# A permutation must beat identity by more than this in max |log ratio| before the mesh is
# called suspect. Below it the two fits are not meaningfully different.
SUSPECT_MARGIN = 0.10
AXES_ORDER = ("w", "h", "d")


def normalise_merchant(value):
    """For MATCHING only. Three merchant spellings reach D1; none of them is rewritten."""
    return "".join(c for c in str(value or "").lower() if c.isalnum())


def worker_object_id(product_url):
    """workers/src/lib/catalog-ingest.ts stableId(contentHash(productUrl)), reproduced."""
    h = hashlib.sha256(json.dumps(product_url, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-5{h[13:16]}-a{h[17:20]}-{h[20:32]}"


def fetch_catalog_index(client, origin):
    response = client.get(f"{origin}/v1/objects", params={"source": "catalog", "limit": 500})
    if response.status_code != 200:
        raise Refusal(f"GET /v1/objects answered {response.status_code}", hs.EXIT_UPSTREAM)
    rows = response.json()
    if not isinstance(rows, list) or not rows:
        raise Refusal("the Worker returned no catalogue objects", hs.EXIT_UPSTREAM)
    index = {}
    for row in rows:
        index.setdefault(row.get("productUrl"), []).append(row)
    return rows, index


def fetch_source_image(client, origin, merchant, product_id):
    key = f"catalog/{merchant}/{product_id}/source.jpg"
    response = client.get(f"{origin}/v1/assets/{key}")
    if response.status_code != 200:
        return None, key, response.status_code
    return response.content, key, 200


def shape_score(extents, target):
    """Scale-free shape distance: max |log ratio| after dividing each triple by its geo mean."""
    a = np.asarray(extents, dtype=float)
    b = np.asarray(target, dtype=float)
    if np.any(a <= 0) or np.any(b <= 0):
        return float("inf")
    a = a / float(np.exp(np.mean(np.log(a))))
    b = b / float(np.exp(np.mean(np.log(b))))
    return float(np.max(np.abs(np.log(a / b))))


def distortion_ratio(extents, target):
    """Ani's r = max(scale) / min(scale), where scale = target / extent (BINDING.md)."""
    scale = [float(t) / float(e) for t, e in zip(target, extents)]
    return max(scale) / min(scale)


def orientation_measurement(raw_glb, target):
    """Compare the raw mesh's own extents with the target box under every axis permutation."""
    scene = trimesh.load(io.BytesIO(raw_glb), file_type="glb", process=False)
    extents = [float(v) for v in np.asarray(scene.extents, dtype=float)]
    candidates = {
        "identity": (0, 1, 2),
        "yaw90-swap-w-d": (2, 1, 0),
        "z-up-to-y-up": (0, 2, 1),
        "z-up-to-y-up-yaw90": (1, 2, 0),
        "x-up-to-y-up": (1, 0, 2),
        "x-up-to-y-up-yaw90": (2, 0, 1),
    }
    scores = {name: shape_score([extents[i] for i in perm], target) for name, perm in candidates.items()}
    best = min(scores, key=scores.get)
    identity = scores["identity"]
    return {
        "rawExtents": dict(zip(("x", "y", "z"), extents)),
        "targetMeters": dict(zip(AXES_ORDER, [float(v) for v in target])),
        "scores": scores,
        "best": best,
        "identityScore": identity,
        "bestScore": scores[best],
        "suspect": best != "identity" and (identity - scores[best]) > SUSPECT_MARGIN,
        # The binder's own r = max(scale)/min(scale), predicted here before it runs, for the
        # mapping as bound and for the w/d swap. A large ratio on both is SF3D guessing depth
        # from one front-on photo, not a yaw error.
        "asBoundRatio": distortion_ratio([extents[i] for i in (0, 1, 2)], target),
        "swappedRatio": distortion_ratio([extents[i] for i in (2, 1, 0)], target),
    }


def seed_attempt(store, key, entry, row, raw_glb, image, image_ref, scope):
    """Write exactly what prepare.py `generate` writes, from saved bytes. No provider call."""
    directory = hs.attempt_dir(store, key)
    hs.write_atomic(directory / "raw.glb", raw_glb)
    hs.write_atomic(directory / "source-image", image)
    hs.write_json(directory / "attempt.json", {
        "schemaVersion": 1, "attemptKey": key, "objectId": row["objectId"], "source": row["source"],
        "scope": scope, "imageRef": image_ref,
        "imageSha256": hashlib.sha256(image).hexdigest(),
        "bboxMeters": row["bboxMeters"], "rawSha256": hashlib.sha256(raw_glb).hexdigest(),
        "rawBytes": len(raw_glb),
        "generatorRevision": prepare.SOURCE_REVISION + ":" + prepare.MODEL_REVISION,
        "providerRequestId": None, "evidence": "cached_real_sf3d",
        "timings": {"providerSeconds": 0.0}, "createdAt": hs.utc_now(),
        # Provenance this replay carries that prepare.py has no field for. Read the module
        # docstring's second ceiling before trusting imageSha256 for a corrected entry.
        "cachedBatch": {
            "producer": "Paul, SF3D 1024, offline batch 2026-09-20",
            "manifestFile": entry["file"],
            "sourceImageSha256": entry["source_sha256"],
            "submittedImageSha256": entry["submitted_sha256"],
            "backgroundCorrection": bool(entry["background_correction"]),
        },
    })


def already_attached(store, key, row):
    """A re-run is a no-op when this attempt is attached and the row points at its bytes."""
    directory = hs.attempt_dir(store, key)
    receipt_path, attached_path = directory / "bound-receipt.json", directory / "attached.json"
    if not receipt_path.exists() or not attached_path.exists():
        return None
    if row.get("state") != "ready" or not row.get("glbUrl"):
        return None
    return hs.read_json(receipt_path)


def verify_attached(client, origin, object_id, receipt):
    """Re-read the row and the stored bytes. Every check is on what the Worker actually serves."""
    row = hs.fetch_object(client, origin, object_id)
    problems = []
    if row.get("state") != "ready":
        problems.append(f"state is {row.get('state')}, not ready")
    if not row.get("glbUrl"):
        problems.append("glbUrl is null")
    stored_sha = None
    if row.get("glbUrl"):
        response = client.get(row["glbUrl"])
        if response.status_code != 200:
            problems.append(f"GET glbUrl answered {response.status_code}")
        else:
            body = response.content
            stored_sha = hashlib.sha256(body).hexdigest()
            if body[:4] != b"glTF":
                problems.append("stored bytes are not a binary glTF")
            if stored_sha != receipt["boundSha256"]:
                problems.append("stored bytes do not hash to the bound sha256")
    validation = receipt["validation"]
    target, measured = validation["target_meters"], validation["measured_meters"]
    if row.get("bboxMeters") != receipt["bboxMeters"]:
        problems.append("the row's bboxMeters moved since the receipt was written")
    # The binder reports these as [w, h, d] lists, in the AXES_ORDER order.
    for position, axis in enumerate(AXES_ORDER):
        if abs(float(measured[position]) - float(target[position])) > DIMENSION_TOLERANCE_M:
            problems.append(f"{axis} measured {measured[position]} against target {target[position]}")
        if abs(float(target[position]) - float(row["bboxMeters"][axis])) > DIMENSION_TOLERANCE_M:
            problems.append(f"{axis} bound to {target[position]} but the row says {row['bboxMeters'][axis]}")
    return {"ok": not problems, "problems": problems, "glbUrl": row.get("glbUrl"),
            "state": row.get("state"), "storedSha256": stored_sha,
            "measuredMeters": dict(zip(AXES_ORDER, [float(v) for v in measured])),
            "targetMeters": dict(zip(AXES_ORDER, [float(v) for v in target])),
            "distortionRatio": validation["distortion_ratio"],
            "distortionDiagnostic": validation["distortion_diagnostic"]}


def process(entry, args, client, origin, store, index):
    slug = Path(entry["file"]).stem
    record = {"slug": slug, "title": entry["title"], "merchant": entry["merchant"],
              "productId": str(entry["productId"]), "productUrl": entry["product_url"],
              "objectId": None, "status": None, "reason": None}

    glb_path = Path(args.models) / entry["file"]
    if not glb_path.is_file():
        return {**record, "status": "skipped", "reason": "glb_file_missing"}
    raw_glb = glb_path.read_bytes()
    if hashlib.sha256(raw_glb).hexdigest() != entry["sha256"]:
        return {**record, "status": "skipped", "reason": "glb_hash_mismatch"}

    matches = index.get(entry["product_url"], [])
    if len(matches) != 1:
        return {**record, "status": "unmatched",
                "reason": f"productUrl matches {len(matches)} catalogue rows"}
    candidate = matches[0]
    expected_id = worker_object_id(entry["product_url"])
    if candidate["objectId"] != expected_id:
        return {**record, "status": "unmatched", "reason": "stableId(productUrl) disagrees with the row id"}
    if normalise_merchant(candidate.get("merchant")) != normalise_merchant(entry["merchant"]):
        return {**record, "status": "unmatched",
                "reason": f"merchant {entry['merchant']} against row {candidate.get('merchant')}"}
    object_id = candidate["objectId"]
    record["objectId"] = object_id

    row = hs.fetch_object(client, origin, object_id)
    box = row["bboxMeters"]
    if set(box) != set(AXES_ORDER) or any(not isinstance(box[a], (int, float)) or box[a] <= 0
                                          for a in AXES_ORDER):
        return {**record, "status": "skipped", "reason": f"row bboxMeters is not usable: {box}"}
    record["bboxMeters"] = box

    manifest_box = {"w": entry["catalog_width_m"], "h": entry["catalog_height_m"],
                    "d": entry["catalog_depth_m"]}
    drift = {a: round(float(box[a]) - float(manifest_box[a]), 6) for a in AXES_ORDER}
    if any(abs(v) > DIMENSION_TOLERANCE_M for v in drift.values()):
        record["dimensionDrift"] = {"d1": box, "manifest": manifest_box, "delta": drift}

    # productId + merchant, proven against the R2 key the catalogue writes them into.
    image, image_key, status = fetch_source_image(client, origin, entry["merchant"], entry["productId"])
    if image is None:
        return {**record, "status": "unmatched",
                "reason": f"GET /v1/assets/{image_key} answered {status}"}
    if hashlib.sha256(image).hexdigest() != entry["source_sha256"]:
        return {**record, "status": "skipped", "reason": "catalogue source image is not Paul's input image"}

    record["orientation"] = orientation_measurement(raw_glb, [box[a] for a in AXES_ORDER])
    key = prepare.attempt_key(args.scope, hashlib.sha256(image).hexdigest())
    record["attemptKey"] = key

    done = already_attached(store, key, row)
    if done is not None:
        return {**record, "status": "already_attached", "boundSha256": done["boundSha256"],
                "verified": verify_attached(client, origin, object_id, done)}
    if args.plan_only:
        return {**record, "status": "planned"}

    journal = hs.Journal(store)
    try:
        existing = journal.get(key)
        if existing is None:
            if not journal.begin(key, object_id, hashlib.sha256(image).hexdigest()):
                existing = journal.get(key)
        if existing is not None and existing["object_id"] != object_id:
            return {**record, "status": "skipped",
                    "reason": f"attempt {key} already belongs to object {existing['object_id']}"}
        if existing is None or existing["state"] != "raw_ok":
            seed_attempt(store, key, entry, row, raw_glb, image, image_key, args.scope)
            journal.set_state(key, "raw_ok")
    finally:
        journal.close()

    code = prepare.main(["bind", "--worker-origin", origin, "--store", str(store), "--attempt", key,
                         "--reviewer", args.reviewer, "--up", UP, "--front", FRONT], client=client)
    if code != 0:
        return {**record, "status": "failed", "reason": f"prepare.py bind exited {code}"}
    receipt = hs.read_json(hs.attempt_dir(store, key) / "bound-receipt.json")
    record["boundSha256"] = receipt["boundSha256"]
    record["evidence"] = receipt["evidence"]
    record["distortion"] = {"ratio": receipt["validation"]["distortion_ratio"],
                            "diagnostic": receipt["validation"]["distortion_diagnostic"],
                            "swappedRatio": record["orientation"]["swappedRatio"]}

    code = approve.main(["--worker-origin", origin, "--store", str(store), "--attempt", key,
                         "--reviewer", args.reviewer, "--bound-sha256", receipt["boundSha256"]],
                        client=client)
    if code != 0:
        return {**record, "status": "failed", "reason": f"approve.py exited {code}"}
    return {**record, "status": "attached", "verified": verify_attached(client, origin, object_id, receipt)}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models", required=True, help="the directory holding manifest.json and GLB/")
    parser.add_argument("--worker-origin", required=True)
    parser.add_argument("--store", required=True, help="hero_store directory, outside the repository")
    parser.add_argument("--scope", required=True)
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--report", required=True, help="JSON report written at the end")
    parser.add_argument("--only", action="append", default=None, help="slug to process; repeatable")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--plan-only", action="store_true", help="map and measure; write nothing")
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    if prepare.orientation_matrix(UP, FRONT) != IDENTITY:
        raise SystemExit("prepare.orientation_matrix no longer maps Y+/Z- to the identity matrix")
    client = hs.new_client()
    try:
        origin = hs.validated_origin(args.worker_origin, client)
        store = hs.resolve_store(args.store)
        entries = json.loads((Path(args.models) / "manifest.json").read_text(encoding="utf-8"))
        if args.only:
            wanted = set(args.only)
            entries = [e for e in entries if Path(e["file"]).stem in wanted]
        if args.limit is not None:
            entries = entries[:args.limit]
        rows, index = fetch_catalog_index(client, origin)
        results = []
        for number, entry in enumerate(entries, 1):
            try:
                result = process(entry, args, client, origin, store, index)
            except Refusal as refusal:
                result = {"slug": Path(entry["file"]).stem, "status": "failed", "reason": str(refusal)}
            except Exception as error:  # one bad model must not end the batch
                result = {"slug": Path(entry["file"]).stem, "status": "failed",
                          "reason": f"{type(error).__name__}: {error}"}
            results.append(result)
            print(f"[{number}/{len(entries)}] {result['slug']}: {result['status']}"
                  f"{' - ' + str(result.get('reason')) if result.get('reason') else ''}", flush=True)
        report = {"scope": args.scope, "reviewer": args.reviewer, "orientation": {"up": UP, "front": FRONT},
                  "catalogRows": len(rows), "results": results, "writtenAt": hs.utc_now()}
        Path(args.report).write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        failures = [r for r in results if r["status"] in ("failed",)]
        return 1 if failures else 0
    except Refusal as refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return refusal.code
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
