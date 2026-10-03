import {
  captureNewApiGithubCredentials,
  supportsNewApiGithubOauth,
} from './newApiGithubOauthRelogin.js';
import type { AssistedLoginProviderId, CaptureResult } from '../types.js';

const SITE_ORIGIN = 'https://ai.hyper.nyc.mn';

/** Hyper uses POST flow tokens and a rotating refresh cookie instead of the legacy OAuth state API. */
export function supportsHyperGithubLogin(siteUrl: string, provider: AssistedLoginProviderId): boolean {
  if (!supportsNewApiGithubOauth(siteUrl, provider)) return false;
  try {
    const url = new URL(siteUrl);
    return url.origin === SITE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Hyper's own handshake: the generic New API GitHub flow, pinned to this origin.
 *
 * Every `needs_provider_login` this handshake can report means the same thing —
 * the GitHub session the handoff rides on is not usable — and the shared module
 * already retries once with the stored GitHub password before returning that
 * verdict, so the wrapper stays this thin on purpose.
 */
export function captureHyperGithubCredentials(): Promise<CaptureResult> {
  return captureNewApiGithubCredentials(SITE_ORIGIN);
}
