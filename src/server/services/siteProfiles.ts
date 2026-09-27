/**
 * Per-site quirks discovered by hand, expressed as code.
 *
 * Some registries cannot be reached or cannot be logged into without special
 * handling, and re-deriving that from scratch every time is expensive: the
 * "why is this site stuck" investigation takes minutes of browser probing. When
 * a quirk is confirmed, record it here so the runtime applies it automatically.
 *
 * This is a declaration of *site* behaviour, not user configuration. Anything a
 * user is expected to toggle belongs in the sites table instead; the entries
 * below are facts about the site that the user cannot reasonably know.
 */

/**
 * Hosts that are unreachable from this network unless the request goes through
 * the configured system proxy (the local Clash instance during development).
 *
 * Confirmed by direct connect failing while the proxied request succeeds, and
 * by the assisted-login capture flipping from needs_provider_login/timeout to a
 * successful bind once the proxy applies.
 */
export const SITES_REQUIRING_SYSTEM_PROXY: readonly string[] = [
  'happycoding.xyz',
  'anyrouter.top',
  'welfare.darkforger.com',
  'sub2api.remixjc.cn',
  'cloudcode-pa.googleapis.com',
];

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\./, '');
}

/**
 * True when the host (or one of its subdomains) is known to require the system
 * proxy. Subdomain matching keeps `api.example.com` covered by an entry for
 * `example.com`, which is how these registries are usually deployed.
 */
export function siteRequiresSystemProxy(host: string | null | undefined): boolean {
  const normalized = normalizeHost(String(host || ''));
  if (!normalized) return false;
  return SITES_REQUIRING_SYSTEM_PROXY.some(
    (candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`),
  );
}

/** Convenience wrapper that accepts a full URL and tolerates malformed input. */
export function siteUrlRequiresSystemProxy(rawUrl: string | null | undefined): boolean {
  try {
    return siteRequiresSystemProxy(new URL(String(rawUrl || '')).host);
  } catch {
    return false;
  }
}
