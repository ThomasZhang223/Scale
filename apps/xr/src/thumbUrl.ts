/*
 * Which meshes /thumb.html will render.
 *
 * Its own file so it can be tested: thumb.ts starts rendering the moment it is imported, and
 * this is the one part of that page that must be right the first time. The page is public and
 * takes a URL — without this check it is an open fetch-and-render proxy for anything on the
 * internet, reachable by anyone who finds the path.
 */

/** Only what our own API serves. Not the whole origin: not the app, not a dev-server route. */
export const ALLOWED_PREFIX = '/v1/assets/';

export type MeshUrl = { url: string } | { error: string };

/**
 * @param raw the `glb` query parameter, absolute or relative
 * @param origin the page's own origin, which is the only one accepted
 */
export function meshUrl(raw: string | null, origin: string): MeshUrl {
  if (!raw) return { error: 'no glb parameter' };
  let parsed: URL;
  try {
    parsed = new URL(raw, origin);
  } catch {
    return { error: 'glb is not a URL' };
  }
  if (parsed.origin !== origin) return { error: `glb must be same-origin; got ${parsed.origin}` };
  // Checked on the PARSED pathname, which is already normalised: "/v1/assets/../../x" arrives
  // here as "/x" and is refused, rather than being matched as a prefix and let through.
  if (!parsed.pathname.startsWith(ALLOWED_PREFIX)) return { error: `glb must be under ${ALLOWED_PREFIX}; got ${parsed.pathname}` };
  return { url: parsed.href };
}
