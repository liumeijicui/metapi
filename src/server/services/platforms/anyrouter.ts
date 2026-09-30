import { NewApiAdapter } from './newApi.js';

/**
 * anyrouter is a free public relay ("公益站"): every user leaves through the
 * same egress pool, so the Alibaba ESA edge in front of it throttles by IP and
 * answers `403 denied by http_ratelimit` even for a perfectly valid token.
 *
 * That verdict is about the site being busy, never about the credential, so the
 * branch below retries a throttled call a few times before giving up and lets
 * the verification result say "site throttled" instead of "token invalid".
 */
export class AnyRouterAdapter extends NewApiAdapter {
  readonly platformName = 'anyrouter';

  /** Shortest useful backoff: the throttle window clears in seconds to minutes. */
  protected override get edgeRateLimitRetryDelaysMs(): readonly number[] {
    return [1_500, 6_000];
  }

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    return normalized.includes('anyrouter');
  }
}
