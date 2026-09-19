import type { LogEntry, RoomState } from './types.ts';
import { now } from './types.ts';
import type { RoomGeometry } from './room.ts';
import { placementToSolver } from './room.ts';

/*
 * Cleaning the data before planning: deterministic checks, each written as a decision a
 * judge can read on the wrist (03_WORKER_AGENT.md §2). Nothing here edits stored data;
 * decisions apply to this solve only.
 */

export interface CleanResult {
  log: LogEntry[];
  /** Per object: may it move, why not, and the size to solve with (cm: w, d, h). */
  objects: Record<string, { movable: boolean; note?: string; sizeCm?: [number, number, number] }>;
  /** Placement ids to drop entirely (no usable size). */
  excluded: string[];
  /** Door swing arcs in the last fit report that pointed outside the room. */
  mirroredDoors: string[];
}

const entry = (kind: LogEntry['kind'], message: string, severity: LogEntry['severity'] = 'info'): LogEntry => ({ at: now(), kind, message, severity });

function label(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function cleanState(state: RoomState, geo: RoomGeometry, pins: string[], requestText: string, wholeRoom = false): CleanResult {
  const log: LogEntry[] = [];
  const objects: CleanResult['objects'] = {};
  const excluded: string[] = [];
  const mentioned = requestText.toLowerCase();
  // A whole-room request (rearrange / tidy) is about every object, named or not.
  const names = (o: { category: string; name?: string }) =>
    wholeRoom || mentioned.includes(o.category.toLowerCase()) || (!!o.name && mentioned.includes(o.name.toLowerCase()));
  const b = geo.bounds;

  // Duplicate ids: keep the newer (later) placement.
  const seen = new Map<string, number>();
  state.placements.forEach((p, i) => {
    if (seen.has(p.objectId)) log.push(entry('data', `Two placements for ${p.objectId}: keeping the newer one.`, 'warn'));
    seen.set(p.objectId, i);
  });

  for (const [objectId, index] of seen) {
    const p = state.placements[index];
    const o = state.objects[objectId];
    if (!o) {
      excluded.push(objectId);
      log.push(entry('data', `${objectId} has a placement but no object data: left untouched.`, 'warn'));
      continue;
    }
    const name = label(o.name || o.category);
    const bbox = o.bboxMeters;
    if (!bbox || !(bbox.w > 0 && bbox.d > 0)) {
      excluded.push(objectId);
      log.push(entry('data', `${name} has no size data: left untouched.`, 'warn'));
      continue;
    }
    let sizeCm: [number, number, number] = [Math.round(bbox.w * 100), Math.round(bbox.d * 100), Math.round(bbox.h * 100)];
    let movable = true;
    let note: string | undefined;

    if (o.source === 'scan' && o.detectedDims) {
      const [dw, , dd] = o.detectedDims;
      const diff = Math.max(Math.abs(bbox.w - dw) / Math.max(dw, 0.01), Math.abs(bbox.d - dd) / Math.max(dd, 0.01));
      if (diff > 0.1) {
        log.push(entry('data', `${name} scan is ${bbox.w.toFixed(2)} m, detected box ${dw.toFixed(2)} m: using the scan (a real scan beats an estimate).`, 'warn'));
      }
    }
    if (o.source === 'box') {
      const named = names(o);
      if (o.confidence === 'low') {
        movable = false;
        note = 'low-confidence detection';
        sizeCm = [sizeCm[0] + 20, sizeCm[1] + 20, sizeCm[2]];
        log.push(entry('data', `Low-confidence '${o.category}' detection: keeping clear of it (+10 cm margin).`, 'warn'));
      } else if (!named) {
        movable = false;
        note = 'no scan yet';
        log.push(entry('data', `${name} has no scan yet: treating it as fixed.`));
      } else {
        log.push(entry('data', `${name} has no scan yet, but the request names it: allowed to move as its detected box.`));
      }
    }

    // Inside a wall or off the room: freed to move so the solver can fix it.
    const pose = placementToSolver(p, geo);
    const upright = pose.rotDeg % 180 === 0;
    const hw = (upright ? sizeCm[0] : sizeCm[1]) / 2;
    const hd = (upright ? sizeCm[1] : sizeCm[0]) / 2;
    const overlapCm = Math.max(b.minX - (pose.xCm - hw), pose.xCm + hw - b.maxX, b.minZ - (pose.zCm - hd), pose.zCm + hd - b.maxZ);
    if (overlapCm > 0.5) {
      movable = true;
      note = undefined;
      log.push(entry('data', `${name} was ${Math.round(overlapCm)} cm inside the wall: freeing it to move.`, 'warn'));
    } else if (Math.abs(pose.exactDeg - pose.rotDeg) > 2 && movable && !pins.includes(objectId)) {
      if (names(o)) {
        log.push(entry('data', `${name} sits at ${Math.round(pose.exactDeg)}°: snapping it to ${pose.rotDeg}° for this solve.`));
      } else {
        movable = false;
        note = 'odd angle';
        log.push(entry('data', `${name} sits at ${Math.round(pose.exactDeg)}°, not square to the walls: keeping it as an obstacle.`));
      }
    }
    if (pins.includes(objectId) && movable) {
      movable = false;
      note = 'pinned';
    }
    objects[objectId] = note ? { movable, note, sizeCm } : { movable, sizeCm };
  }

  const mirroredDoors: string[] = [];
  for (const v of state.fitReport?.violations ?? []) {
    const g = v.geometry;
    if (v.kind !== 'door_swing' || !g || g.type !== 'arc' || !g.center || !g.radiusM) continue;
    // A swing arc must lie inside the room; the fixture's points the other way.
    const [cx, cz] = g.center;
    const mid = ((g.startDeg ?? 0) + (g.endDeg ?? 0)) / 2;
    const px = cx + Math.cos((mid * Math.PI) / 180) * g.radiusM;
    const pz = cz - Math.sin((mid * Math.PI) / 180) * g.radiusM;
    const [sx, sz] = [px + geo.offset[0], pz + geo.offset[2]];
    if (sx * 100 < b.minX || sx * 100 > b.maxX || sz * 100 < b.minZ || sz * 100 > b.maxZ) {
      mirroredDoors.push(v.placementId ?? '');
      log.push(entry('data', `A door's swing arc points outside the wall: mirrored inward for this solve (the stored data is untouched).`, 'warn'));
    }
  }
  for (const n of geo.notes) log.push(entry('data', n));
  return { log, objects, excluded, mirroredDoors };
}
