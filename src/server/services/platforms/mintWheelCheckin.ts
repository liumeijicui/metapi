import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici';
import { withSiteProxyRequestInit } from '../siteProxy.js';
import type { CheckinResult } from './base.js';

/**
 * Session material for a 薄荷公益站 style external wheel check-in.
 *
 * The wheel is a separate deployment from the API relay (`up.x666.me` for
 * `x666.me`) and authenticates through its own Linux.do OAuth application, so
 * its credential is the `auth_token` JWT the callback hands out — never the
 * relay's `new_api_refresh`. The caller stores it on the account's extra config
 * (`externalCheckin`) and this module spends it.
 */
export type MintWheelSession = {
  /** Full cookie pair for the wheel host, e.g. `auth_token=<jwt>`. */
  cookieHeader?: string;
  /** Bearer form of the same JWT, when the caller captured one instead. */
  bearerToken?: string;
};

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function resolveOrigin(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return base;
  }
}

/**
 * Replaces `auth_token=` in a cookie header while preserving any sibling pairs.
 *
 * The wheel session is rotated by the OAuth callback that renews it, and the
 * account's binding holds a whole header (`auth_token=…`), so the fresh value has
 * to be swapped in rather than appended to.
 */
export function upsertAuthTokenCookie(cookieHeader: string | undefined, token: string): string {
  const parts = (cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith('auth_token='));
  parts.push(`auth_token=${token}`);
  return parts.join('; ');
}

/** Reads the `auth_token` value out of a stored cookie header, if any. */
export function readAuthTokenCookie(cookieHeader: string | undefined): string | undefined {
  return (cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('auth_token='))
    ?.slice('auth_token='.length)
    .trim() || undefined;
}

/** The wheel answers a second run for the same day with this wording, not an error. */
function isAlreadyClaimed(message: string): boolean {
  return /今日已(签到|抽奖|参与|领取)|已签到|already/i.test(message);
}

/**
 * Runs the daily wheel draw on a welfare site that exposes `POST /api/checkin/spin`.
 *
 * One POST with no body: the site picks the prize itself, so a repeat run after
 * the day's draw answers `{success:false, message:"今日已签到"}`. That answer is
 * a successful check-in for the caller (the day is claimed), not a failure to
 * retry, which is why it is folded into `success: true` rather than surfaced as
 * an error the scheduler would keep re-running.
 */
export async function runMintWheelCheckin(
  externalCheckinUrl: string,
  session: MintWheelSession,
): Promise<CheckinResult> {
  const base = stripTrailingSlashes((externalCheckinUrl || '').trim());
  const origin = resolveOrigin(base);
  const endpoint = `${base}/api/checkin/spin`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    // Required: the draw is refused with "跨站请求被拒绝（缺少 Origin）" without it.
    Origin: origin,
    Referer: `${origin}/`,
  };

  const bearer = (session.bearerToken || '').trim();
  const cookie = (session.cookieHeader || '').trim();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  } else if (cookie) {
    headers.Cookie = cookie.includes('=') ? cookie : `auth_token=${cookie}`;
  } else {
    return {
      success: false,
      message: '外部签到站会话未绑定：请先完成签到站的 Linux.do 授权，再重试签到',
    };
  }

  const requestInit: UndiciRequestInit = {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(20_000),
  };

  const { fetch } = await import('undici');
  let response: UndiciResponse;
  try {
    response = await fetch(endpoint, await withSiteProxyRequestInit(endpoint, requestInit));
  } catch (error) {
    return { success: false, message: `外部签到请求失败：${(error as Error)?.message || '网络错误'}` };
  }

  const rawBody = await response.text();
  let payload: any = null;
  try { payload = JSON.parse(rawBody); } catch {}

  if (response.status === 401) {
    return {
      success: false,
      message: '外部签到会话已失效（HTTP 401 未登录），请重新完成签到站的 Linux.do 授权',
    };
  }

  const message = typeof payload?.message === 'string' ? payload.message.trim() : '';

  if (payload?.success === true) {
    const label = typeof payload?.label === 'string' ? payload.label.trim() : '';
    const quota = typeof payload?.quota === 'number' && Number.isFinite(payload.quota) ? payload.quota : undefined;
    const reward = label || (quota === undefined ? '' : String(quota));
    return {
      success: true,
      message: message || '签到成功',
      ...(reward ? { reward } : {}),
    };
  }

  if (message && isAlreadyClaimed(message)) {
    return { success: true, message };
  }

  if (!response.ok) {
    return { success: false, message: message || `外部签到失败：HTTP ${response.status}` };
  }

  return { success: false, message: message || '外部签到失败：站点未返回结果' };
}
