/**
 * Disjoint localhost debugging-port windows for managed browser profiles.
 *
 * The first implementation started every profile search at the same port (9333)
 * and remembered the chosen port per profile. Two profiles could therefore both
 * record 9333, and whichever Chrome happened to hold that port won every later
 * reattach. A Linux.do session could silently attach to the GitHub browser and
 * then report "logged out", because it was reading a cookie jar that never
 * contained the Linux.do login token.
 *
 * Giving each profile its own window means a remembered port can only ever
 * resolve to that profile's own browser.
 */

/** How many ports each profile may search within its own window. */
export const PORT_WINDOW_SIZE = 10;

/** Profiles whose windows are pinned so upgrades keep the established port. */
const KNOWN_PROFILE_PORT_BASES: Record<string, number> = {
  'linuxdo-browser': 9333,
  'github-browser': 9433,
};

/** Unlisted profiles land above the known windows and never overlap them. */
const FALLBACK_PORT_BASE = 9533;
const FALLBACK_WINDOW_COUNT = 40;

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** First port of the window reserved for this profile. */
export function resolvePortWindow(profileDirName: string): number {
  const known = KNOWN_PROFILE_PORT_BASES[profileDirName];
  if (typeof known === 'number') return known;
  return FALLBACK_PORT_BASE + (hashString(profileDirName) % FALLBACK_WINDOW_COUNT) * PORT_WINDOW_SIZE;
}

/** True when a port belongs to the given profile window. */
export function isWithinWindow(port: number, windowBase: number): boolean {
  return Number.isInteger(port) && port >= windowBase && port < windowBase + PORT_WINDOW_SIZE;
}
