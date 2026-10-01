import { NewApiAdapter, QUOTA_PER_UNIT } from './newApi.js';
import type { CheckinContext, CheckinResult } from './base.js';
import { getOauthProviderFromExtraConfig } from '../accountExtraConfig.js';
import { quotaToUsd } from './quota.js';

/**
 * anyrouter is a free public relay ("公益站"): every user leaves through the
 * same egress pool, so the Alibaba ESA edge in front of it throttles by IP and
 * answers `403 denied by http_ratelimit` — or its JS challenge page — even for a
 * perfectly valid token. That verdict is about the site being busy, never about
 * the credential, so the branch below retries a throttled call a few times before
 * giving up and lets the verification result say "site throttled" instead of
 * "token invalid".
 *
 * Any Router also pays its daily $25 inside the login handler, and its check-in
 * route is a shell: `/api/user/sign_in` answers `success` without touching the
 * balance and without writing a single line to the account log, which is why the
 * panel kept reporting a check-in that never paid. The grant lands on the *next
 * sign-in* — the site's own FAQ wording for its sibling relay applies here too:
 * 需要退出后重新登录才会到账.
 *
 * So a check-in is: run the site's cheap route first (it still pays when the day
 * is fresh), then, when the balance did not move, replay the Linux.do OAuth
 * handshake in the managed browser and look at the balance again. Nothing less is
 * a verdict — the log holds no check-in entries and the two `success` answers the
 * site gives cannot be told apart without the balance.
 */

const ANY_ROUTER_HOST = 'anyrouter.top';
const ANY_ROUTER_DAILY_REWARD_USD = '25';
/** Smaller movements are drift, not a daily grant. */
const QUOTA_EPSILON_USD = 0.01;

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

  override async checkin(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    context?: CheckinContext,
  ): Promise<CheckinResult> {
    const before = await this.readBalanceUsd(baseUrl, accessToken, platformUserId);

    // An unreadable first balance means the edge is shielding this host, and the
    // site's own routes answer the same way it just did: asking them only spends
    // the check-in's whole budget on timeouts before the browser is consulted.
    let siteCheckin: CheckinResult = { success: false, message: '站点接口不可用' };
    let afterSiteCheckin: number | null = null;
    if (before !== null) {
      siteCheckin = await super.checkin(baseUrl, accessToken, platformUserId);
      afterSiteCheckin = await this.readBalanceUsd(baseUrl, accessToken, platformUserId);

      const directGain = this.measureGain(before, afterSiteCheckin);
      if (directGain > 0) {
        return {
          success: true,
          message: `${siteCheckin.message || 'checkin success'}（额度 +$${formatUsd(directGain)}）`,
          reward: formatUsd(directGain),
        };
      }
    }

    const httpReadable = before !== null && afterSiteCheckin !== null;
    // Readable and unchanged means the site's `success` paid nothing, and the
    // daily grant is waiting behind a fresh login.
    if (getOauthProviderFromExtraConfig(context?.extraConfig) !== 'linuxdo') {
      return httpReadable ? { success: false, message: ALREADY_CHECKED_IN_MESSAGE } : siteCheckin;
    }

    const clientId = await this.readLinuxDoClientId(baseUrl, accessToken, platformUserId);

    // Imported lazily: the site module pulls in the browser stack, and only the
    // Linux.do accounts ever need it. A client id read over HTTP is only a
    // head start — the driver resolves it inside the page when the edge hid it.
    const { loginAnyRouterWithLinuxDo } = await import('../assistedLogin/sites/anyRouter.js');
    const relogin = await loginAnyRouterWithLinuxDo({
      baseUrl,
      clientId: clientId ?? '',
      expectedUserId: platformUserId,
    });
    if (!relogin.ok) return { success: false, message: relogin.message };

    // The SPA fires the site's own check-in once the callback lands; this path
    // drives the callback outside the page, so repeat the call. It is idempotent,
    // and it is the half that pays on a fresh day — but asking a shielded edge
    // again only wastes a timeout, so it runs only when HTTP was answering.
    if (httpReadable) await super.checkin(baseUrl, accessToken, platformUserId);

    const afterRelogin = httpReadable
      ? await this.readBalanceUsd(baseUrl, accessToken, platformUserId)
      : null;
    const gain = before !== null && afterRelogin !== null
      ? this.measureGain(before, afterRelogin)
      : this.measureBrowserGain(relogin, before);

    if (gain !== null && gain > 0) {
      return {
        success: true,
        message: `退出重登后签到到账（额度 +$${formatUsd(gain)}）`,
        reward: formatUsd(gain),
      };
    }
    if (gain === 0) return { success: false, message: ALREADY_CHECKED_IN_MESSAGE };
    // The login itself worked but no balance could be read around it, so there is
    // no evidence of a grant to report — and calling a real check-in a failure
    // would be worse than saying so.
    return { success: true, message: `${relogin.message}（额度不可读，未确认发放）` };
  }

  /**
   * Reads the USD balance straight off /api/user/self.
   *
   * The inherited `getBalance` walks a whole fallback ladder (bearer → cookie →
   * alternate user id, each with its own timeouts) and on this site that ladder
   * takes minutes once the edge starts throttling. A check-in reads the balance
   * three times, so it asks the one question it has — with the account's own
   * credential — and treats an unreadable answer as "no evidence", never as zero.
   */
  private async readBalanceUsd(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<number | null> {
    const payload = await this.fetchSiteJson<any>(
      `${baseUrl}/api/user/self`,
      accessToken,
      platformUserId,
    );
    if (payload?.success !== true) return null;
    const quota = Number(payload?.data?.quota);
    return Number.isFinite(quota) ? quotaToUsd(quota, QUOTA_PER_UNIT) : null;
  }

  /** Positive movement between two readable balances, otherwise 0. */
  private measureGain(before: number | null, after: number | null): number {
    if (before === null || after === null) return 0;
    const delta = Number((after - before).toFixed(6));
    return delta > QUOTA_EPSILON_USD ? delta : 0;
  }

  /**
   * The same measurement, taken from the quota the browser read around the login
   * — the only channel that answers while the edge shields plain HTTP. Returns
   * null when even the browser could not read the balance, so the caller can tell
   * "no grant" apart from "no evidence".
   */
  private measureBrowserGain(
    relogin: { quotaBefore?: number | null; quotaAfter?: number | null },
    httpBefore: number | null,
  ): number | null {
    const after = readQuotaUsd(relogin.quotaAfter);
    if (after === null) return null;
    const before = readQuotaUsd(relogin.quotaBefore) ?? httpBefore;
    if (before === null) return null;
    const delta = Number((after - before).toFixed(6));
    return delta > QUOTA_EPSILON_USD ? delta : 0;
  }

  /**
   * The edge answers an unauthenticated /api/status with a JS challenge, so the
   * call carries the account's own credential even though the route is public.
   */
  private async readLinuxDoClientId(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<string | null> {
    const payload = await this.fetchSiteJson<any>(
      `${baseUrl}/api/status`,
      accessToken,
      platformUserId,
    );
    const data = payload?.data ?? payload;
    if (data?.linuxdo_oauth !== true) return null;
    const clientId = typeof data?.linuxdo_client_id === 'string' ? data.linuxdo_client_id.trim() : '';
    return clientId || null;
  }
}

/**
 * The site grants nothing on a repeat, and says so with an empty message, so the
 * panel keeps this wording for "there is nothing left to collect today": it is
 * the phrase the check-in scheduler treats as a satisfied check-in.
 */
const ALREADY_CHECKED_IN_MESSAGE = `今日已签到（站点未发放额度，日额度 $${ANY_ROUTER_DAILY_REWARD_USD} 需退出重登后到账）`;

function readQuotaUsd(quota: unknown): number | null {
  // `Number(null)` is 0, and this value is read off a page that reports an
  // absent quota as null — "no reading" must not become "zero dollars".
  if (typeof quota !== 'number' || !Number.isFinite(quota)) return null;
  return quotaToUsd(quota, QUOTA_PER_UNIT);
}

function formatUsd(value: number): string {
  return String(Number(value.toFixed(6)));
}
