/**
 * Keeps the credential a browser check-in establishes.
 *
 * Sites that gate the check-in behind Cloudflare Turnstile normally gate the
 * password login the same way (方舟 answers every `/api/user/login` without a
 * Turnstile token with "Turnstile token 为空"). The browser run is therefore the
 * only place such a site ever hands out a session, and what it hands out is the
 * refresh cookie it writes into its profile.
 *
 * This module is the single place that knows how those two halves fit together:
 * it runs the browser flow, reads that cookie back out of the profile, and
 * returns it in the `new_api_refresh=<value>` form the new-api adapter already
 * exchanges and rotates (see `accountCredentialRotation`).
 */
import { resolve } from 'node:path';
import { config } from '../config.js';
import { runBrowserCheckin, type BrowserCheckinOutcome } from './browserCheckinRunner.js';
import { readBrowserProfileCookie } from './browserProfileCredential.js';
import { resolveChannelProxyUrl, type SiteProxyConfigLike } from './siteProxy.js';

/** The only durable credential these forks leave behind; see the module docs. */
export const BROWSER_SESSION_COOKIE = 'new_api_refresh';

export type BrowserSessionCheckinInput = {
  site: SiteProxyConfigLike & { id: number; url: string };
  /**
   * Only needed when the site still shows a password form. A run that starts
   * from `sessionCredential` never types them, so they may be empty.
   */
  username: string;
  password: string;
  /** Account-level proxy override; the site's own setting is used without one. */
  accountExtraConfig?: string | null;
  /**
   * Session the operator or the OAuth handshake already earned, in
   * `Cookie`-style form. Seeding it lets the browser skip the login form
   * entirely, which is the only way in on sites whose sign-in is a GitHub
   * redirect (no password field to drive).
   */
  sessionCredential?: string | null;
};

export type BrowserSessionCheckinResult = {
  outcome: BrowserCheckinOutcome;
  /** `Cookie`-style credential, or null when the run stored no session. */
  accessToken: string | null;
};

/**
 * Reads the site's refresh cookie out of a finished browser profile.
 *
 * Exported for callers that already have a profile on disk (the login route
 * reuses the profile the daily check-in keeps per site).
 */
export function readBrowserSessionCredential(profileDir: string, siteUrl: string): string | null {
  let host: string;
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    return null;
  }
  if (!host) return null;

  const value = readBrowserProfileCookie({ profileDir, host, name: BROWSER_SESSION_COOKIE });
  return value ? `${BROWSER_SESSION_COOKIE}=${value}` : null;
}

/**
 * Reads a browser-ready session out of a stored access token.
 *
 * A token-only bind on a site whose sign-in is OAuth leaves the account holding
 * the `new_api_refresh` cookie the site handed the browser (see the module docs
 * above). Such a cookie is the whole credential: passing it to the browser is
 * what replaces the password login those sites never expose, so the check-in can
 * still be driven. Every other credential shape (an API key, a bare access
 * token) is not a cookie and is ignored here.
 */
export function asBrowserSessionCredential(accessToken: unknown): string | null {
  if (typeof accessToken !== 'string') return null;
  const value = accessToken.trim();
  return value.startsWith(`${BROWSER_SESSION_COOKIE}=`) ? value : null;
}

/**
 * Signs in on the site in a real browser and returns the session it created.
 *
 * The browser profile is keyed by site, so the profile a bind seeds is the one
 * the daily check-in later reuses, and both callers see the same login cookie.
 */
export async function runBrowserSessionCheckin(
  input: BrowserSessionCheckinInput,
): Promise<BrowserSessionCheckinResult> {
  const outcome = await runBrowserCheckin({
    siteUrl: input.site.url,
    username: input.username,
    password: input.password,
    proxyUrl: resolveChannelProxyUrl(input.site, input.accountExtraConfig),
    profileKey: `site-${input.site.id}`,
    logDir: resolve(config.dataDir, 'checkin-browser', `site-${input.site.id}`),
    cookieName: BROWSER_SESSION_COOKIE,
    sessionCredential: input.sessionCredential ?? null,
  });

  if (outcome.kind === 'unavailable') return { outcome, accessToken: null };
  return {
    outcome,
    accessToken: readBrowserSessionCredential(outcome.profileDir, input.site.url),
  };
}
