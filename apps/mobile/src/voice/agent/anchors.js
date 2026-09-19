// find_anchor v0 — client-side, zero dependencies on anyone else.
//
// Turns "beside my desk" into a place with a measured free span, using only RoomCapture v1,
// which Thomas already serves. v1 is Justin's POST /gaps (see ../TOOLS.md); the tool contract
// is identical, so swapping is a one-function change and nothing above it moves.
//
// ceiling: footprints are treated as axis-aligned and yaw is ignored, so a desk at 30 degrees
// to the wall reports a span a few cm optimistic. Spans are scanned along +/-X and +/-Z only —
// no diagonal gaps, no multi-object pockets. Upgrade path is Justin's /gaps.
//
// Metres everywhere.

// A column-major 16-float transform stores translation at 12, 13, 14.
function positionOf(transform) {
  if (!Array.isArray(transform) || transform.length !== 16) {
    throw new Error('anchors: transform must be 16 floats, column-major');
  }
  return { x: transform[12], y: transform[13], z: transform[14] };
}

function footprint(entity) {
  const p = positionOf(entity.transform);
  const [w, , d] = entity.dimensions; // RoomCapture v1 object dimensions are [w, h, d]
  return {
    id: entity.id,
    category: entity.category,
    cx: p.x,
    cz: p.z,
    halfW: w / 2,
    halfD: d / 2,
  };
}

// Doors and windows are things people point at ("by the door"), but they live in
// room.openings with `kind` instead of `category`, and zero depth. Give them a nominal
// depth so a span can start from their face.
const OPENING_DEPTH_M = 0.1;

function openingFootprint(opening) {
  const p = positionOf(opening.transform);
  const [w] = opening.dimensions;
  return {
    id: opening.id,
    category: opening.kind,
    isOpening: true,
    cx: p.x,
    cz: p.z,
    halfW: w / 2,
    halfD: OPENING_DEPTH_M / 2,
  };
}

// Floor extent from the room polygon, so a span is bounded by the room and not by infinity.
function floorBounds(room) {
  const poly = room?.floor?.polygon;
  if (!Array.isArray(poly) || poly.length === 0) {
    throw new Error('anchors: room has no floor polygon — cannot bound a span');
  }
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

const DIRECTIONS = [
  { name: 'right', phrase: 'to the right of', axis: 'x', sign: 1 },
  { name: 'left', phrase: 'to the left of', axis: 'x', sign: -1 },
  { name: 'front', phrase: 'in front of', axis: 'z', sign: 1 },
  { name: 'behind', phrase: 'behind', axis: 'z', sign: -1 },
];

// "By the door" means the floor in front of it, not two metres along the same wall. An
// opening sits on the room boundary, so the only direction that means anything is inward —
// toward the middle of the floor.
function inwardDirections(ref, bounds) {
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midZ = (bounds.minZ + bounds.maxZ) / 2;
  const dx = midX - ref.cx;
  const dz = midZ - ref.cz;
  const axis = Math.abs(dz) >= Math.abs(dx) ? 'z' : 'x';
  const sign = (axis === 'z' ? dz : dx) >= 0 ? 1 : -1;
  return DIRECTIONS.filter((d) => d.axis === axis && d.sign === sign);
}

// How far you can travel from `from`'s edge in one direction before hitting another
// footprint that overlaps on the perpendicular axis, or the edge of the floor.
function spanInDirection(from, others, bounds, dir) {
  const alongCentre = dir.axis === 'x' ? from.cx : from.cz;
  const alongHalf = dir.axis === 'x' ? from.halfW : from.halfD;
  const crossCentre = dir.axis === 'x' ? from.cz : from.cx;
  const crossHalf = dir.axis === 'x' ? from.halfD : from.halfW;

  const start = alongCentre + dir.sign * alongHalf;

  const wallLimit =
    dir.axis === 'x'
      ? dir.sign > 0 ? bounds.maxX : bounds.minX
      : dir.sign > 0 ? bounds.maxZ : bounds.minZ;
  let limit = wallLimit;

  for (const o of others) {
    const oAlong = dir.axis === 'x' ? o.cx : o.cz;
    const oAlongHalf = dir.axis === 'x' ? o.halfW : o.halfD;
    const oCross = dir.axis === 'x' ? o.cz : o.cx;
    const oCrossHalf = dir.axis === 'x' ? o.halfD : o.halfW;

    // Only things that actually sit in the corridor can block it.
    const overlaps = Math.abs(oCross - crossCentre) < crossHalf + oCrossHalf;
    if (!overlaps) continue;

    const nearEdge = oAlong - dir.sign * oAlongHalf;
    const distance = dir.sign * (nearEdge - start);
    if (distance <= 0) continue; // behind us
    const candidate = start + dir.sign * distance;
    if (dir.sign > 0 ? candidate < limit : candidate > limit) limit = candidate;
  }

  const freeSpan = Math.abs(limit - start);
  return {
    direction: dir.name,
    phrase: dir.phrase,
    freeSpanMeters: freeSpan,
    // Anchor sits in the middle of the free span, on the floor.
    p: dir.axis === 'x'
      ? [start + dir.sign * (freeSpan / 2), 0, from.cz]
      : [from.cx, 0, start + dir.sign * (freeSpan / 2)],
  };
}

// Loose word match so "desk" finds a RoomPlan "table", which is the category it actually
// assigns to desks. ceiling: hand-written synonyms, not a classifier.
const SYNONYMS = {
  desk: ['table', 'desk'],
  table: ['table', 'desk'],
  couch: ['sofa', 'couch'],
  sofa: ['sofa', 'couch'],
  shelf: ['storage', 'shelf', 'bookcase'],
  bookshelf: ['storage', 'shelf', 'bookcase'],
};

function matchesCategory(entityCategory, wanted) {
  const want = wanted.toLowerCase();
  const cat = String(entityCategory).toLowerCase();
  if (cat === want || cat.includes(want)) return true;
  return (SYNONYMS[want] || []).some((s) => cat.includes(s));
}

/**
 * Find candidate anchors matching a spoken description.
 * Returns [] when nothing matches — the caller asks the user rather than guessing
 * (standing rule 4).
 */
export function findAnchors(room, { description, category }) {
  if (!room) throw new Error('anchors: no room — cannot resolve a place without geometry');

  const bounds = floorBounds(room);
  const objects = (room.objects || []).map(footprint);
  const openings = (room.openings || []).map(openingFootprint);
  const referenceable = [...objects, ...openings];

  // Which room object is the phrase relative to? Prefer an explicit category, else scan the
  // phrase for a word naming something actually in this room.
  const words = String(description || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const wanted = category ? [category] : words;

  const referents = referenceable.filter((o) => wanted.some((w) => matchesCategory(o.category, w)));
  if (referents.length === 0) return [];

  const candidates = [];
  for (const ref of referents) {
    const others = objects.filter((o) => o.id !== ref.id); // openings never block a span
    for (const dir of (ref.isOpening ? inwardDirections(ref, bounds) : DIRECTIONS)) {
      const span = spanInDirection(ref, others, bounds, dir);
      // A gap narrower than this can't hold anything worth placing.
      if (span.freeSpanMeters < 0.2) continue;
      candidates.push({
        anchorId: `${ref.id}:${span.direction}`,
        relativeTo: { objectId: ref.id, category: ref.category },
        direction: span.direction,
        phrase: span.phrase,
        p: span.p,
        freeSpanMeters: span.freeSpanMeters,
        // The perpendicular extent is bounded by the referent for now.
        depthMeters: span.direction === 'left' || span.direction === 'right'
          ? ref.halfD * 2
          : ref.halfW * 2,
      });
    }
  }

  // Widest gap first — it's the one a person means by "beside" far more often than not.
  candidates.sort((a, b) => b.freeSpanMeters - a.freeSpanMeters);
  return candidates;
}
