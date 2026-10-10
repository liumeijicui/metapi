import type { Locator, Page } from 'playwright-core';
import type { AssistedLoginProvider } from './types.js';

/**
 * Locates the provider's login entry on a site's own pages.
 *
 * The tricky part is not finding *a* match but finding the *right* one. Several
 * panels print their community links on the landing page as bare URLs, so an
 * anchor whose text is `https://linux.do/t/topic/12345` matches both the entry
 * name pattern and the `[href*="linux.do"]` selectors. Clicking it navigates to
 * a forum topic, and the capture then reports "provider session expired" while
 * the session behind it was perfectly valid — the click simply never reached
 * the OAuth handoff.
 *
 * Providers therefore declare the href substrings that mark a *content* link,
 * and every candidate is intersected with "not one of those". A real entry
 * points at the provider's authorize URL or at the site's own callback route,
 * never at a content path, so the filter cannot hide a genuine entry. Buttons
 * carry no `href` at all and so always pass the intersection.
 */

/** Escapes a literal for use inside a double-quoted CSS attribute value. */
function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Builds the `*:not([href*="…"])…` filter for the declared content-link hrefs.
 *
 * `*` rather than `a` on purpose: the filter is intersected with role-based
 * candidates that may resolve to buttons, and a `*` prefix keeps those matches
 * alive while still dropping the offending anchors.
 *
 * Returns null when the provider declares nothing, so the callers can skip the
 * intersection entirely instead of paying for a no-op locator.
 */
export function buildEntryAnchorDenySelector(prefixes: readonly string[]): string | null {
  const cleaned = prefixes.map((prefix) => prefix.trim()).filter((prefix) => prefix.length > 0);
  if (cleaned.length === 0) return null;
  return `*${cleaned.map((prefix) => `:not([href*="${escapeCssAttributeValue(prefix)}"])`).join('')}`;
}

/**
 * One union locator covering every entry shape, with the provider's content
 * links filtered out.
 *
 * Waiting on the candidates *sequentially* spent the full timeout on each one,
 * so a site whose entry lives behind its own login dialog burned ~180s before
 * the fallback ran. A single union waits once and resolves as soon as any shape
 * appears.
 */
export function buildEntryLocator(page: Page, provider: AssistedLoginProvider): Locator {
  const candidates = [
    page.getByRole('button', { name: provider.entryNamePattern }),
    page.getByRole('link', { name: provider.entryNamePattern }),
    ...provider.entryTextSelectors.map((selector) => page.locator(selector)),
    ...provider.entrySelectors.map((selector) => page.locator(selector)),
  ];

  const denySelector = buildEntryAnchorDenySelector(provider.entryAnchorDenyHrefSubstrings ?? []);
  if (!denySelector) {
    return candidates.reduce((combined, candidate) => combined.or(candidate));
  }
  const deny = page.locator(denySelector);
  return candidates
    .map((candidate) => candidate.and(deny))
    .reduce((combined, candidate) => combined.or(candidate));
}
