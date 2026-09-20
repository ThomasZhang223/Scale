"""Hero-piece approval: record the human review, upload the saved bound bytes, attach them to the object.

    approve.py --worker-origin https://<worker> --attempt KEY_PREFIX --reviewer ID --bound-sha256 HASH [--room-id ROOM]

The reviewer states the bound sha256 they inspected. It must equal the saved bytes' hash or this
refuses before any request is sent. The upload reuses Ani's deliver() and WorkerArtifactSink on
THOSE saved bytes, then POST /v1/objects/{id}/mesh attaches the returned key. Retrying never
calls the provider and never binds again. See HERO_RUNBOOK.md.

# ceiling: one operator on one laptop; the review receipt is a local file, not a durable
# server-side review. Closing a parked queued mesh job and indexing the object are the
# Worker route's job (P-WORKER's change to POST /v1/objects/{id}/mesh); this script does neither.
"""
import argparse
import hashlib
import sys

import hero_store as hs
from hero_store import Refusal
import httpx
from app.generation import GenerationError, PreparedArtifact, VisualReview, deliver, identifier
from app.generation_io import WorkerArtifactSink


def cmd_approve(args, client):
    origin = hs.validated_origin(args.worker_origin, client)
    store = hs.resolve_store(args.store)
    identifier(args.reviewer)
    if args.room_id is not None:
        identifier(args.room_id)
    journal = hs.Journal(store)
    try:
        row = journal.find(args.attempt)
    finally:
        journal.close()
    key = row["attempt_key"]
    directory = hs.attempt_dir(store, key)
    receipt_path, bound_path = directory / "bound-receipt.json", directory / "bound.glb"
    if row["state"] != "raw_ok" or not receipt_path.exists():
        raise Refusal(f"attempt {key} is not bound yet; run prepare.py bind first")
    glb = bound_path.read_bytes()
    actual = hashlib.sha256(glb).hexdigest()
    if args.bound_sha256 != actual:
        raise Refusal(f"hash mismatch: you reviewed {args.bound_sha256} but the saved bound bytes are "
                      f"{actual}. Nothing was uploaded; inspect {bound_path} and approve its hash")

    artifact = PreparedArtifact(glb, receipt_path.read_text(encoding="utf-8"))
    receipt = artifact.receipt
    # Ani's reviewed_receipt requires synthetic_test for a fake_provider artifact and manual_review
    # for everything else; the reviewer's inspection is what manual_review attests.
    evidence = "synthetic_test" if receipt["evidence"] == "fake_provider" else "manual_review"
    review = VisualReview(actual, args.reviewer, evidence)
    reviewed = artifact.reviewed_receipt(review)  # validates hash, evidence and identity before any request
    object_id = receipt["objectId"]
    hs.check_bbox_unchanged(hs.fetch_object(client, origin, object_id), receipt["bboxMeters"])

    review_path = directory / "review-receipt.json"
    if review_path.exists():
        earlier = hs.read_json(review_path)["reviewedReceipt"]["visualReview"]
        if earlier != reviewed["visualReview"]:
            raise Refusal(f"attempt {key} was already approved by {earlier['reviewer']}; "
                          "retry with the same --reviewer and --bound-sha256")
    else:
        hs.write_json(review_path, {"approvedAt": hs.utc_now(), "reviewedReceipt": reviewed})

    try:
        delivered = deliver(artifact, WorkerArtifactSink(origin, client=client), review)
    except GenerationError as error:
        raise Refusal(f"delivery failed ({error}). The review receipt is saved; retry this command with "
                      "the same arguments. The saved bytes do not change", hs.EXIT_UPSTREAM) from None

    # The key is whatever Ani's sink returned. It is never rewritten here.
    body = {"key": delivered["glbKey"]}
    if args.room_id is not None:
        body["roomId"] = args.room_id
    try:
        response = client.post(f"{origin}/v1/objects/{object_id}/mesh", json=body)
    except httpx.HTTPError:
        raise Refusal("could not reach the Worker to attach the mesh. The upload is stored; "
                      "retry this command", hs.EXIT_UPSTREAM) from None
    if response.status_code != 200:
        raise Refusal(f"Worker answered {response.status_code} for POST /v1/objects/{object_id}/mesh: "
                      f"{response.text[:300]}. The upload is stored; retry this command after the Worker "
                      "accepts this key", hs.EXIT_UPSTREAM)
    try:
        attached = response.json()
    except ValueError:
        attached = None
    if not isinstance(attached, dict) or attached.get("state") != "ready":
        raise Refusal(f"Worker answered 200 but the object is not ready: {response.text[:300]}", hs.EXIT_UPSTREAM)
    hs.write_json(directory / "attached.json", {"objectId": object_id, "glbKey": delivered["glbKey"],
                                                "roomId": args.room_id, "attachedAt": hs.utc_now()})
    print(f"attached: object {object_id} is ready, mesh key {delivered['glbKey']}")
    print(f"review receipt kept at: {review_path}")
    return 0


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--worker-origin", required=True, help="https origin of the Worker; never defaulted")
    parser.add_argument("--store", default=str(hs.DEFAULT_STORE),
                        help="local directory for the journal and artifacts (outside the repository)")
    parser.add_argument("--attempt", required=True, help="attempt key, or its first 8+ hex characters")
    parser.add_argument("--reviewer", required=True, help="who inspected the bound mesh")
    parser.add_argument("--bound-sha256", required=True, help="the bound hash the reviewer saw")
    parser.add_argument("--room-id", default=None, help="optional room to notify")
    return parser


def main(argv=None, *, client=None):
    args = build_parser().parse_args(argv)
    own_client = client is None
    client = client or hs.new_client()
    try:
        return cmd_approve(args, client)
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
