/*
 * Object ids for things pulled out of the palette.
 *
 * The designer agent (services/agent) keys everything by objectId: the room state it is sent
 * is a map objectId → object, the solver's ids are objectIds, and a proposal's moves name an
 * objectId. Two chairs pulled from the same tile therefore have to carry two different ids, or
 * the agent sees one chair, plans for one, and the headset moves whichever it finds first —
 * the "Rearrange only moved some of the furniture" bug.
 *
 * Local palette ids (`local:<name>`) are made up here and mean nothing to the server, so they
 * are free to be numbered. Server ids (Object v1) are the catalog identity a Placement v1 must
 * keep, so they are returned unchanged.
 * ceiling: the same server object placed twice still collides in the agent; the fix for that
 * is keying services/agent by placementId, not aliasing ids here.
 */
export function instanceObjectId(base: string, taken: Iterable<string>): string {
  if (!base.startsWith('local:')) return base;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}#${n}`;
    if (!used.has(candidate)) return candidate;
  }
}
