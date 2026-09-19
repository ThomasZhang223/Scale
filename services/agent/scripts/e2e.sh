#!/usr/bin/env bash
# Whole-chain run (E1–E6 in apps/xr/docs/agent/09_END_TO_END_TESTS.md) against a live agent,
# solver and fit service. Usage: scripts/e2e.sh [agent-base-url] [room-id]
#   agent: wrangler dev --port 8789      solver: uvicorn app.main:app --port 8080 (SOLVER_KEY=dev-solver-key)
#   fit:   uvicorn app.main:app --port 8000
set -u
A="${1:-http://127.0.0.1:8789}/v1/agent/${2:-e2e-room}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="${TMPDIR:-/tmp}/agent-e2e"; mkdir -p "$TMP"

python3 - "$HERE/../../../apps/xr/public/room-scan.json" <<'EOF' > "$TMP/state.json"
import json, sys
room = json.load(open(sys.argv[1]))
pl = lambda pid, oid, p, yaw: {"placementId": pid, "objectId": oid, "p": p, "yawDeg": yaw, "scale": 1, "lockedToWallId": None, "flags": []}
print(json.dumps({"room": room,
 "objects": {
  "obj_sofa": {"name": "sofa", "category": "sofa", "bboxMeters": {"w": 2.19, "h": 0.79, "d": 1.02}, "source": "scan", "detectedDims": [2.0, 0.85, 0.9]},
  "obj_chair": {"name": "chair", "category": "chair", "bboxMeters": {"w": 0.83, "h": 0.69, "d": 0.57}, "source": "scan", "detectedDims": [0.6, 0.9, 0.6]},
  "obj_table": {"name": "table", "category": "table", "bboxMeters": {"w": 1.0, "h": 0.45, "d": 0.6}, "source": "box", "confidence": "high"},
  "obj_storage": {"name": "storage", "category": "storage", "bboxMeters": {"w": 0.8, "h": 1.8, "d": 0.4}, "source": "box", "confidence": "high"}},
 "placements": [pl("pl_sofa","obj_sofa",[0.7,-1.4,-0.34],0), pl("pl_chair","obj_chair",[2.1,-1.4,1.2],270),
                pl("pl_table","obj_table",[0.7,-1.4,1.18],0), pl("pl_storage","obj_storage",[-1.15,-1.4,1.7],90)],
 # A door-swing arc that points outside the south wall: the mirrored-door decision (E5).
 "fitReport": {"violations": [{"kind": "door_swing", "placementId": "pl_sofa",
   "geometry": {"type": "arc", "center": [1.5, 2.7], "radiusM": 0.9, "startDeg": 180, "endDeg": 270}}]}}))
EOF

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
wait_done() {  # request id
  for _ in $(seq 1 40); do sleep 0.5
    st=$(curl -s "$A/requests/$1" | json "d['state']")
    [ "$st" = proposed ] || [ "$st" = failed ] && { echo "$st"; return; }
  done; echo timeout
}
show() {  # request id
  curl -s "$A/requests/$1" | python3 -c "
import json,sys; r=json.load(sys.stdin)
for e in r['log']: print('   [%s/%s] %s' % (e['kind'], e['severity'], e['message']))
p=r.get('proposal')
if p: print('   proposal:', p['summary'], '|', p['explanation'], '| moves:', [(m['objectId'], m['to']['p'], m['to']['yawDeg']) for m in p['moves']], '| fit:', p['fit'], '| tradeoffs:', p['tradeoffs'])
if r.get('error'): print('   error:', r['error'])"
}

echo "== reset memory =="; curl -s -X DELETE "$A/memory"; echo
echo "== health =="; curl -s "$A/health"; echo
echo "== upload state =="; curl -s -X POST "$A/state" -H 'content-type: application/json' --data @"$TMP/state.json"; echo

echo "== E1 + E5: preset 'reading_corner' (mirrored door in the fit report) =="
t0=$(date +%s%N)
R1=$(curl -s -X POST "$A/requests" -H 'content-type: application/json' -d '{"preset":"reading_corner","pins":[],"source":"laptop"}' | json "d['requestId']")
echo "   state: $(wait_done "$R1") in $(( ($(date +%s%N) - t0) / 1000000 )) ms"; show "$R1"

echo "== E2: accept =="
curl -s -X POST "$A/requests/$R1/accept" -H 'content-type: application/json' -d '{}'; echo
curl -s "$A/state" | json "('current', d['currentVersionId'], 'sofa at', [p['p'] for p in d['state']['placements'] if p['objectId']=='obj_sofa'])"

echo "== E3: undo, memory, ask again =="
curl -s -X POST "$A/undo"; echo
curl -s "$A/memory" | json "[p['text'] for p in d['preferences']]"
R2=$(curl -s -X POST "$A/requests" -H 'content-type: application/json' -d '{"preset":"reading_corner","pins":[],"source":"laptop"}' | json "d['requestId']")
echo "   state: $(wait_done "$R2")"; show "$R2" | grep -E "memory|proposal|error"

echo "== E4: someone moves the table, then accepting the old proposal → 409 =="
python3 - "$TMP/state.json" <<'EOF' > "$TMP/state2.json"
import json,sys; s=json.load(open(sys.argv[1])); s['placements'][2]['p']=[0.7,-1.4,0.6]; s.pop('fitReport',None); print(json.dumps(s))
EOF
curl -s -X POST "$A/state" -H 'content-type: application/json' --data @"$TMP/state2.json"; echo
curl -s -o /dev/null -w "   accept → %{http_code}\n" -X POST "$A/requests/$R2/accept" -H 'content-type: application/json' -d '{}'

echo "== typed request (planner offline → needs a preset) =="
R3=$(curl -s -X POST "$A/requests" -H 'content-type: application/json' -d '{"text":"Put the sofa against the east wall","pins":[],"source":"laptop"}' | json "d.get('requestId', d)")
echo "   state: $(wait_done "$R3")"; show "$R3" | grep -E "error|plan"

echo "== stub timeline (X-Stub: 1) =="
curl -s -X POST "$A/requests" -H 'X-Stub: 1'; echo; sleep 1.5
curl -s "$A/requests/stub-req-1" | json "('state', d['state'], 'log lines', len(d['log']))"

echo "== E6: solver offline (stop it, preset falls back to the stub proposal) =="
echo "   (run with SOLVER_DOWN=1 after stopping the solver to exercise this)"
if [ "${SOLVER_DOWN:-0}" = 1 ]; then
  R4=$(curl -s -X POST "$A/requests" -H 'content-type: application/json' -d '{"preset":"clear_door","pins":[],"source":"laptop"}' | json "d['requestId']")
  echo "   state: $(wait_done "$R4")"; show "$R4" | grep -E "solver|Solver|proposal"
  curl -s "$A/health"; echo
fi
echo "== versions =="; curl -s "$A/versions" | python3 -c "import json,sys; [print('  ', v['versionId'], v['status'], v['createdBy'], v['label']) for v in json.load(sys.stdin)['versions']]"
