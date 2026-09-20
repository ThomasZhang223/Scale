"""Hero-piece preparation: generate ONE raw mesh, then bind it after a human states the orientation.

    prepare.py generate --worker-origin https://<worker> --object-id ID --image PATH_OR_ASSET_URL --scope S --allow-paid
    prepare.py bind     --worker-origin https://<worker> --attempt KEY_PREFIX --reviewer ID --up Y+ --front Z-

`generate` records the attempt BEFORE the provider call, then saves the raw GLB and a JSON sidecar.
It never runs twice for the same attempt. `bind` replays the saved raw bytes through Ani's own
GenerationAttempt, so her binder and her receipt run once and unchanged. Neither subcommand reads
a secret from a file: the paid path reads BASETEN_PREDICT_URL and BASETEN_API_KEY from the
environment. See HERO_RUNBOOK.md.

# ceiling: one operator on one laptop, a local sqlite journal, no durable server-side attempt.
# The upgrade path is the durable review integration in Ani's plan, if app-triggered generation
# with a human pause is ever needed.
"""
import argparse
import hashlib
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np

import hero_store as hs
from hero_store import Refusal
import httpx
from app.binding import OrientationProfile, raw_key
from app.embedding.config import MAX_IMAGE_BYTES
from app.embedding.records import RecordError, canonical, safe_reference
from app.generation import (AmbiguousGeneration, GenerationAttempt, GenerationError, GenerationInput,
                            RawGeneration, check, identifier)
from app.generation_io import SF3DProvider, private_http, response_bytes
from deploy.sf3d.model.model import MODEL_REVISION, REVISIONS, SETTINGS, SOURCE_REVISION

# The three labels Ani's GenerationAttempt.prepare() accepts (generation.py, unknown_generation_evidence).
RAW_EVIDENCE = ("real_sf3d", "cached_real_sf3d", "fake_provider")
# SF3DProvider.generate raises these BEFORE it opens a connection (allow_paid check, then the
# endpoint check, then the client). Anything else may have reached the network.
# ceiling: coupled to her error strings; if she renames them, an unsent attempt is recorded as
# rejected and needs a manual journal delete. Upgrade path: a typed NotSent exception in her library.
NOT_SENT_CODES = ("paid_generation_not_enabled", "invalid_provider_endpoint")
# The raw mesh's own axes, as written on the command line: axis letter then sign ("Y+", "Z-").
# A leading sign would be read by argparse as an option flag. The project frame is +Y up / -Z front.
AXES = {"X+": (1, 0, 0), "X-": (-1, 0, 0), "Y+": (0, 1, 0), "Y-": (0, -1, 0), "Z+": (0, 0, 1), "Z-": (0, 0, -1)}


def say(message):
    print(message)


def attempt_key(scope, image_sha256):
    """Ani's raw_key: content-addressed, so the same image in the same scope is one paid call."""
    return raw_key(scope=scope, image_sha256=image_sha256, model_revision=SOURCE_REVISION,
                   generation_settings={
                       "weights_revision": MODEL_REVISION,
                       "secondary_weights": canonical({k: REVISIONS[k] for k in
                                                       ("dinov2", "open_clip", "rembg", "u2net_md5")}),
                       "preprocess_revision": SOURCE_REVISION,
                       "dtype": SETTINGS["dtype"],
                       # The deployed Truss accepts exactly {"image_base64"} (deploy/sf3d/model/transport.py),
                       # so the seed cannot be set by a caller. This states a fact, not a default.
                       "seed": "not-parameterised-by-truss-request",
                       "texture": SETTINGS["texture_resolution"],
                       "remesh": SETTINGS["remesh"],
                       "sf3d_settings": SETTINGS})


def paid_provider(allow_paid):
    """The only place a paid provider is built. Every missing input is a named, loud refusal."""
    if not allow_paid:
        raise Refusal("a paid generation needs --allow-paid. That flag is not budget authorization: "
                      "verify the credit budget and the Baseten deployment first (HERO_RUNBOOK.md)")
    values = {}
    for name in ("BASETEN_PREDICT_URL", "BASETEN_API_KEY"):
        values[name] = os.environ.get(name)
        if not values[name]:
            raise Refusal(f"environment variable {name} is not set")
    return SF3DProvider(values["BASETEN_PREDICT_URL"], values["BASETEN_API_KEY"], allow_paid=True)


def load_image(client, origin, spec):
    """The ONE authorised source image: a local file, or an asset served by --worker-origin."""
    if spec.startswith(("http://", "https://")):
        prefix = origin + "/v1/assets/"
        parts = urlsplit(spec)
        if not spec.startswith(prefix) or parts.query or parts.fragment or parts.username or parts.password:
            raise Refusal(f"--image URL must be {prefix}<key> with no query, fragment or credentials")
        try:
            with private_http(), client.stream("GET", spec, follow_redirects=False) as response:
                return response_bytes(response, MAX_IMAGE_BYTES), spec[len(prefix):]
        except (httpx.HTTPError, GenerationError):
            raise Refusal("could not read the source image from the Worker", hs.EXIT_UPSTREAM) from None
    path = Path(spec).expanduser().resolve()
    if not path.is_file():
        raise Refusal(f"--image is not a file: {path}")
    data = path.read_bytes()
    if len(data) > MAX_IMAGE_BYTES:
        raise Refusal(f"--image is larger than {MAX_IMAGE_BYTES} bytes")
    return data, str(path)


def validate_raw(raw, request):
    check(isinstance(raw, RawGeneration) and isinstance(raw.glb, bytes) and bool(raw.glb),
          "invalid_provider_response")
    check(raw.image_sha256 == request.image_sha256, "provider_image_mismatch")
    check(raw.evidence in RAW_EVIDENCE, "unknown_generation_evidence")
    safe_reference(raw.generator_revision)
    if raw.request_id is not None:
        identifier(raw.request_id)


def report_existing(row, store, object_id):
    """A second invocation for the same attempt reports the record and never calls the provider."""
    key = row["attempt_key"]
    if row["object_id"] != object_id:
        raise Refusal(f"attempt {key} belongs to object {row['object_id']}. The same image in the same "
                      f"--scope cannot be reused for {object_id}; use a different --scope for a new attempt")
    if row["state"] == "raw_ok":
        say(f"attempt {key} is already generated. No provider call was made.")
        say(f"raw GLB to inspect: {hs.attempt_dir(store, key) / 'raw.glb'}")
        return 0
    raise Refusal(f"{hs.RECONCILE_MESSAGE} [attempt {key}, recorded state: {row['state']}]", hs.EXIT_RECONCILE)


def run_provider(provider, request, key, journal, store):
    started = time.perf_counter()
    try:
        raw = provider.generate(request.image, request.image_sha256)
    except (TimeoutError, AmbiguousGeneration):
        journal.set_state(key, "ambiguous")
        raise Refusal(f"{hs.RECONCILE_MESSAGE} [attempt {key}; the request may have been billed]",
                      hs.EXIT_RECONCILE) from None
    except GenerationError as error:
        if str(error) in NOT_SENT_CODES:
            journal.delete_in_flight(key)
            raise Refusal(f"nothing was sent to the provider: {error}") from None
        journal.set_state(key, "rejected")
        raise Refusal(f"the provider call failed ({error}). {hs.RECONCILE_MESSAGE} [attempt {key}]",
                      hs.EXIT_PROVIDER) from None
    except Exception:
        # An unknown error type cannot prove the request never left, so treat it as sent.
        journal.set_state(key, "ambiguous")
        raise Refusal(f"the provider raised an unexpected error. {hs.RECONCILE_MESSAGE} [attempt {key}]",
                      hs.EXIT_RECONCILE) from None
    provider_seconds = time.perf_counter() - started
    directory = hs.attempt_dir(store, key)
    try:
        validate_raw(raw, request)
    except (GenerationError, RecordError) as error:
        journal.set_state(key, "rejected")
        if isinstance(getattr(raw, "glb", None), bytes):
            hs.write_atomic(directory / "raw.rejected.glb", raw.glb)  # paid output is never discarded
        raise Refusal(f"the provider answer was rejected ({error}); any bytes are in {directory}. "
                      f"{hs.RECONCILE_MESSAGE}", hs.EXIT_PROVIDER) from None
    # The raw bytes and the image go to disk before the journal says raw_ok. A crash in between
    # leaves in_flight, which is loud, never a silent second paid call.
    hs.write_atomic(directory / "raw.glb", raw.glb)
    hs.write_atomic(directory / "source-image", request.image)
    hs.write_json(directory / "attempt.json", {
        "schemaVersion": 1, "attemptKey": key, "objectId": request.object_id, "source": request.source,
        "scope": request.scope, "imageRef": request.image_ref, "imageSha256": request.image_sha256,
        "bboxMeters": request.bbox_meters, "rawSha256": hashlib.sha256(raw.glb).hexdigest(),
        "rawBytes": len(raw.glb), "generatorRevision": raw.generator_revision,
        "providerRequestId": raw.request_id, "evidence": raw.evidence,
        "timings": {"providerSeconds": provider_seconds}, "createdAt": hs.utc_now()})
    journal.set_state(key, "raw_ok")
    say(f"attempt {key}")
    say(f"generated in {provider_seconds:.1f}s, evidence {raw.evidence}")
    say(f"raw GLB to inspect: {directory / 'raw.glb'}")
    say("Open the raw GLB, decide which of ITS axes point up and front, then run `bind`.")
    return 0


def cmd_generate(args, client, provider_factory):
    origin = hs.validated_origin(args.worker_origin, client)
    store = hs.resolve_store(args.store)
    row = hs.fetch_object(client, origin, args.object_id)
    image, image_ref = load_image(client, origin, args.image)
    request = GenerationInput.from_object(row, image, image_sha256=hashlib.sha256(image).hexdigest(),
                                          image_ref=image_ref, scope=args.scope)
    key = attempt_key(request.scope, request.image_sha256)
    journal = hs.Journal(store)
    try:
        existing = journal.get(key)
        if existing is None:
            # Built before the row is written: a missing flag or variable must not leave in_flight behind.
            provider = provider_factory()
            if journal.begin(key, request.object_id, request.image_sha256):
                return run_provider(provider, request, key, journal, store)
            existing = journal.get(key)  # another process won the insert; it owns the paid call
        return report_existing(existing, store, request.object_id)
    finally:
        journal.close()


def orientation_matrix(up, front):
    """Rows of the proper rotation source axes -> project frame (+Y up, -Z front, +X right)."""
    u, f = np.array(AXES[up]), np.array(AXES[front])
    if u @ f != 0:
        raise Refusal("--up and --front must name two different, perpendicular axes of the raw mesh")
    return tuple(tuple(int(x) for x in row) for row in (np.cross(f, u), u, -f))


class CachedRawProvider:
    """Replays saved raw bytes so Ani's attempt runs her binder and builds her receipt. No network."""
    def __init__(self, raw_glb, sidecar):
        self.raw_glb, self.sidecar, self.calls = raw_glb, sidecar, 0

    def generate(self, image, image_sha256):
        self.calls += 1
        evidence = "fake_provider" if self.sidecar["evidence"] == "fake_provider" else "cached_real_sf3d"
        return RawGeneration(self.raw_glb, image_sha256, self.sidecar["generatorRevision"], evidence,
                             self.sidecar["providerRequestId"])


def cmd_bind(args, client):
    origin = hs.validated_origin(args.worker_origin, client)
    store = hs.resolve_store(args.store)
    matrix = orientation_matrix(args.up, args.front)
    identifier(args.reviewer)
    journal = hs.Journal(store)
    try:
        row = journal.find(args.attempt)
    finally:
        journal.close()
    key = row["attempt_key"]
    if row["state"] != "raw_ok":
        raise Refusal(f"attempt {key} is in state {row['state']}, not raw_ok; nothing to bind")
    directory = hs.attempt_dir(store, key)
    sidecar = hs.read_json(directory / "attempt.json")
    raw = (directory / "raw.glb").read_bytes()
    if hashlib.sha256(raw).hexdigest() != sidecar["rawSha256"]:
        raise Refusal(f"raw.glb of attempt {key} no longer matches its recorded sha256")
    bound_path, receipt_path = directory / "bound.glb", directory / "bound-receipt.json"
    orientation_path = directory / "orientation.json"

    # The receipt is written last, so its presence means the other two files are complete.
    if receipt_path.exists():
        recorded = hs.read_json(receipt_path)
        if args.rebind:
            if (directory / "review-receipt.json").exists():
                raise Refusal(f"attempt {key} is already approved; a rebind would replace reviewed bytes")
            old = directory / "superseded" / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                                              + "-" + recorded["boundSha256"][:8])
            old.mkdir(parents=True)
            for path in (bound_path, orientation_path, receipt_path):
                path.rename(old / path.name)
            say(f"previous binding moved to {old}")
        else:
            orientation = hs.read_json(orientation_path)
            if (orientation["up"], orientation["front"]) != (args.up, args.front):
                raise Refusal(f"attempt {key} is already bound with up={orientation['up']} "
                              f"front={orientation['front']}; pass --rebind to bind again from the raw mesh")
            if hashlib.sha256(bound_path.read_bytes()).hexdigest() != recorded["boundSha256"]:
                raise Refusal(f"bound.glb of attempt {key} no longer matches its receipt")
            say(f"attempt {key} is already bound. The binder was not called.")
            say(f"bound GLB to inspect: {bound_path}")
            say(f"bound sha256: {recorded['boundSha256']}")
            return 0

    hs.check_bbox_unchanged(hs.fetch_object(client, origin, sidecar["objectId"]), sidecar["bboxMeters"])
    request = GenerationInput.from_object(
        {"objectId": sidecar["objectId"], "source": sidecar["source"], "bboxMeters": sidecar["bboxMeters"]},
        (directory / "source-image").read_bytes(), image_sha256=sidecar["imageSha256"],
        image_ref=sidecar["imageRef"], scope=sidecar["scope"])
    # One profile per raw sha256: the name carries it and the file lives inside this attempt only.
    # It is never a shared registry, so it cannot be applied to a different mesh by accident.
    profile = OrientationProfile(f"hero-{sidecar['objectId']}-{sidecar['rawSha256'][:8]}-manual-review",
                                 "1", matrix, "manual_review")
    artifact = GenerationAttempt(request, CachedRawProvider(raw, sidecar), profile).prepare()
    receipt = artifact.receipt
    hs.write_atomic(bound_path, artifact.glb)
    hs.write_json(orientation_path, {"name": profile.name, "version": profile.version,
                                     "matrix": [list(r) for r in matrix], "evidence": profile.evidence,
                                     "up": args.up, "front": args.front, "reviewer": args.reviewer,
                                     "rawSha256": sidecar["rawSha256"], "attemptKey": key,
                                     "reviewedAt": hs.utc_now()})
    hs.write_atomic(receipt_path, artifact.receipt_json.encode("utf-8"))
    validation = receipt["validation"]
    say(f"attempt {key}")
    say(f"bound GLB to inspect: {bound_path}")
    say(f"bound sha256 (give this to approve.py): {receipt['boundSha256']}")
    say(f"target metres {validation['target_meters']}, measured {validation['measured_meters']}")
    say(f"distortion {validation['distortion_ratio']:.3f} ({validation['distortion_diagnostic']}), "
        f"evidence {receipt['evidence']}")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--worker-origin", required=True, help="https origin of the Worker; never defaulted")
    common.add_argument("--store", default=str(hs.DEFAULT_STORE),
                        help="local directory for the journal and artifacts (outside the repository)")
    generate = commands.add_parser("generate", parents=[common], help="one paid generation, saved raw")
    generate.add_argument("--object-id", required=True)
    generate.add_argument("--image", required=True, help="path, or <worker-origin>/v1/assets/<key>")
    generate.add_argument("--scope", required=True, help="authorised scope string; part of the attempt identity")
    generate.add_argument("--allow-paid", action="store_true", help="permit the paid Baseten call")
    bind = commands.add_parser("bind", parents=[common], help="bind the saved raw mesh once")
    bind.add_argument("--attempt", required=True, help="attempt key, or its first 8+ hex characters")
    bind.add_argument("--reviewer", required=True, help="who inspected the raw mesh")
    bind.add_argument("--up", required=True, choices=list(AXES), help="raw-mesh axis that points up")
    bind.add_argument("--front", required=True, choices=list(AXES), help="raw-mesh axis that points to the front")
    bind.add_argument("--rebind", action="store_true", help="replace an unapproved binding, from the raw mesh")
    return parser


def main(argv=None, *, client=None, provider_factory=None):
    args = build_parser().parse_args(argv)
    own_client = client is None
    client = client or hs.new_client()
    try:
        if args.command == "generate":
            return cmd_generate(args, client, provider_factory or (lambda: paid_provider(args.allow_paid)))
        return cmd_bind(args, client)
    except Refusal as refusal:
        print(f"error: {refusal}", file=sys.stderr)
        return refusal.code
    except GenerationError as error:
        print(f"error: {error}", file=sys.stderr)
        return hs.EXIT_REFUSED
    finally:
        if own_client:
            client.close()


if __name__ == "__main__":
    sys.exit(main())
