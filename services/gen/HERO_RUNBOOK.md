# Hero piece runbook: one catalogue object, image to attached mesh

Two local scripts around Ani's library ([plan](GENERATION_HANDOFF.md), [binder](BINDING.md),
[Baseten procedure](SF3D_JUDGING.md)). One paid call per piece. Every step after `generate`
works from saved bytes and can be retried without Baseten.

```
prepare.py generate  ->  (look at raw)  ->  prepare.py bind  ->  (look at bound)  ->  approve.py
   paid, once             human: axes         binder, once          human: hash          upload + attach
```

## Before you start

- **Python.** Use a venv on 3.11 or 3.12 (the host 3.14 has no numpy/trimesh wheels):
  `pip install -r requirements-binding.txt httpx==0.28.1`. Run the scripts from `services/gen/`.
- **Worker.** `--worker-origin` is required on every command and must be `https://`. Attaching needs the Worker
  route that accepts `objects/<id>/mesh.glb` for a non-scan object (P-WORKER). Before that is deployed,
  `approve.py` uploads, then stops with `Worker answered 400 ... bad_mesh_key`. Nothing is lost: retry after deploy.
- **Store.** Default `~/.local/share/full-scale/hero`. It holds the journal, raw and bound meshes and receipts.
  It must stay outside the repo (the scripts refuse a path inside it). Back it up before the demo.
- **The object.** It must exist on the Worker with `source` `scan` or `catalog` and a complete `bboxMeters`.
  The scripts read the box from `GET /v1/objects/<id>` and never default a dimension.
- **The image.** Choose the ONE authorised source photo: a file, or `<worker-origin>/v1/assets/<key>`.
- **Scope.** Pick one `--scope` string (for example `htn-2026-hero`) and reuse it for every retry of the piece.
  Scope and image together are the attempt identity.

## Activate Baseten (7 to 10 minutes before `generate`)

Follow [SF3D_JUDGING.md](SF3D_JUDGING.md): Hack the North / Team 26 only, model `wdlgzjk3`,
deployment `w604592`, one L4 replica, stop catalogue submissions first. Never paste the key on a command line.

```bash
set -a; . ~/.config/full-scale/secrets.env; set +a     # BASETEN_PREDICT_URL, BASETEN_API_KEY
SF3D_BASE="https://api.baseten.co/v1/models/wdlgzjk3/deployments/w604592"
printf 'header = "Authorization: Api-Key %s"\n' "$BASETEN_API_KEY" > /tmp/bt.conf && chmod 600 /tmp/bt.conf
curl -sS -K /tmp/bt.conf -X POST "$SF3D_BASE/activate" -H 'content-type: application/json' -d '{}'
curl -sS -K /tmp/bt.conf "$SF3D_BASE"    # want status ACTIVE, active_replica_count 1, max_replica 1
```

Do not test with a dummy prediction: it is a paid call. Budget about 29 s for the first request.

## One piece, in order

```bash
W=https://<worker-origin>; ID=<object-id>; S=htn-2026-hero
python prepare.py generate --worker-origin $W --object-id $ID --image <file-or-asset-url> --scope $S --allow-paid
```
`--allow-paid` is not budget authorization: check the credit budget yourself. It prints the attempt key.
Use its first 8 characters as `--attempt` below.

**Look at the raw mesh** (open the printed `raw.glb` in Blender or any glTF viewer). Decide which of ITS axes
point up and to the front. Write each as axis letter then sign: `Y+`, `Z-`. SF3D output is often `Y+` up and
`Z-` front but that is never assumed: the profile is bound to this one raw sha256 and never reused.

```bash
python prepare.py bind --worker-origin $W --attempt <key8> --reviewer <you> --up Y+ --front Z-
```

**Look at the bound mesh** (printed `bound.glb`). Approve only if all of these hold:
- measured metres match target metres (the binder already fails above 1 mm);
- distortion is `eligible_for_visual_review` (ratio 1.25 or less). `review_required` (to 1.5) needs a second look
  at the shape. `proxy_recommended` (over 1.5) means the axes or the box are wrong: do not approve, rebind;
- it stands upright, the front faces the right way, it sits on the floor (origin bottom-centre), nothing floats;
- textures and the normal map are present and not smeared.

```bash
python approve.py --worker-origin $W --attempt <key8> --reviewer <you> --bound-sha256 <the printed bound sha256> [--room-id <room>]
```
The hash must be the one you inspected. The review receipt stays in the attempt directory (`review-receipt.json`).

Then check the object on the phone or in XR: `state` ready, mesh loads.

## Deactivate, and prove it

```bash
curl -sS -K /tmp/bt.conf -X POST "$SF3D_BASE/deactivate" -H 'content-type: application/json' -d '{}'
curl -sS -K /tmp/bt.conf "$SF3D_BASE"    # repeat until status INACTIVE, active_replica_count 0
rm -f /tmp/bt.conf
```
Scale-to-zero is not enough: the idle delay is 900 s. Keep the receipt.

## Retrying safely

| Step failed | Do this | Cost |
| --- | --- | --- |
| `generate`, exit 3 (`outcome unknown - reconcile by hand, do not resubmit`) | Do NOT rerun. Check Baseten for a request and its billing. Only after confirming nothing completed, delete that one row from `journal.sqlite3` by hand and rerun. The scripts have no flag for this on purpose | possible second paid call |
| `generate`, exit 4 | The provider answered with a failure. Same as exit 3. Any paid bytes are in `raw.rejected.glb` | same |
| `generate`, exit 1 | Nothing was sent. Fix the named cause and rerun | none |
| `generate` run again | Reports the saved state. No provider call | none |
| `bind` wrong axes | `bind ... --rebind` with new axes. Refused once approved. The old files move to `superseded/` | none |
| `bind` run again, same axes | Reports the saved result. The binder is not called | none |
| `approve`, exit 5 | Rerun the same command. It re-uploads the same saved bytes, checks the stored hash and re-attaches | none |
| `approve`, hash mismatch | You reviewed a different file. Open the printed path, then approve its hash | none |

## What each failure means

| Message | Meaning |
| --- | --- |
| `environment variable X is not set` | Source `secrets.env` in this shell (`set -a`). The scripts never read the file |
| `object ... has no bboxMeters` / `does not exist` | The catalogue row is missing or has no box. Fix the row; nothing is defaulted |
| `belongs to object ...` | The same image and scope are already recorded for a different object. Use a different `--scope` |
| `bboxMeters changed ... since the attempt` | The row's box moved after generate. The mesh no longer matches: start a new attempt |
| `mesh_binding_rejected` | Ani's binder rejected the mesh or the axes. Check `--up`/`--front`, or the mesh is unsupported |
| `delivery failed` / `Worker answered 5xx` | Storage or Worker trouble. Retry `approve` |
| `Worker answered 400 ... bad_mesh_key` | The Worker still only accepts `scans/<id>/mesh.glb`. Wait for the P-WORKER deploy, then retry `approve` |
| `Worker answered 409 ... mesh_not_uploaded` | The upload did not land. Retry `approve` |

Inspect the journal: `sqlite3 <store>/journal.sqlite3 "select attempt_key, object_id, state from attempts"`.
