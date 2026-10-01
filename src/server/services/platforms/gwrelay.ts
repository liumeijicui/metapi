import { BasePlatformAdapter } from './base.js';
import type {
  ApiTokenInfo,
  BalanceInfo,
  CheckinContext,
  CheckinResult,
  LoginResult,
  SiteAnnouncement,
  UserInfo,
} from './base.js';

/**
 * 辉哥中转 (ccwu.cc) runs its own PHP panel instead of any new-api fork.
 *
 * Every management call is a POST to `/api/keys.php?action=…` with the account's
 * `ut-…` user token in both the body and the `X-User-Token` header; there is no
 * `New-Api-User`, no bearer token and no `/api/status`. The daily check-in is
 * `action=checkin`, which pays 50-100 calls into the account balance — and, unlike
 * login, it is not gated behind Turnstile, so it answers a plain HTTP client
 * while the token is alive.
 *
 * The token itself is short-lived: the site invalidated one within the hour, so
 * the stored credential is treated as a cache. A refused call surfaces the site's
 * own `HTTP 401 user_unauthorized` — or the `HTTP 400 invalid_request` it answers
 * a token it cannot read at all — which `normalizeSessionRefusal()` rewrites so
 * the caller takes the re-login path described on `login()`.
 */

const KEYS_API_PATH = '/api/keys.php';
const REQUEST_TIMEOUT_MS = 30_000;

/** The site hands out `ut-…` tokens; a bare value also works when pasted in. */
export function normalizeUserToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
}

export class GwRelayAdapter extends BasePlatformAdapter {
  readonly platformName = 'gwrelay';

  /**
   * The panel's own bootstrap endpoint. It answers before login, it is not part
   * of any new-api fork, and its payload carries the check-in switch — which
   * makes it both a detector and a capability probe.
   */
  async detect(url: string): Promise<boolean> {
    try {
      const payload = await this.postAction<any>(url, '', 'register_status');
      return payload?.success === true
        && !!payload?.data
        && typeof payload.data.checkin_enabled === 'boolean';
    } catch {
      return false;
    }
  }

  /**
   * Logging in needs a Cloudflare Turnstile token, so a plain HTTP client can
   * never complete it: the site answers every attempt without one with
   * `请先完成人机验证 [400 captcha_required]`. The caller replays the login in the
   * managed browser instead (see `assistedLogin/sites/gwRelay.ts`), which is why
   * the refusal is worded so the shared classifier records a human check rather
   * than a wrong password.
   */
  async login(): Promise<LoginResult> {
    return {
      success: false,
      message: '站点登录需要 Cloudflare Turnstile 人机验证（captcha_required），请在受管浏览器中登录',
    };
  }

  override async checkin(baseUrl: string, accessToken: string): Promise<CheckinResult> {
    const token = normalizeUserToken(accessToken);
    if (!token) return { success: false, message: '账号未保存用户令牌（ut-…），请重新登录站点' };

    try {
      const payload = await this.postAction<any>(baseUrl, token, 'checkin');
      if (payload?.success === true) {
        const reward = Number(payload?.data?.reward);
        return {
          success: true,
          message: payload.message || '签到成功',
          reward: Number.isFinite(reward) && reward > 0 ? String(reward) : undefined,
        };
      }
      const message = readErrorMessage(payload) || '签到失败';
      return { success: false, message: refusalMessage(message) };
    } catch (error) {
      return { success: false, message: refusalMessage(describeRequestError(error)) };
    }
  }

  override async getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo> {
    const token = normalizeUserToken(accessToken);
    if (!token) throw new Error('账号未保存用户令牌（ut-…），请重新登录站点');

    let payload: any;
    try {
      payload = await this.postAction<any>(baseUrl, token, 'user_dashboard');
    } catch (error) {
      throw new Error(normalizeSessionRefusal(describeRequestError(error)));
    }
    if (payload?.success !== true || !payload?.data) {
      throw new Error(normalizeSessionRefusal(readErrorMessage(payload) || '读取余额失败'));
    }
    // The panel reports one account-level pool: wallet balance (usable, and
    // spendable on plans) plus the plan quota that expires with a subscription.
    const data = payload.data;
    const total = Number(data.total_balance ?? data.balance);
    if (!Number.isFinite(total)) throw new Error('站点未返回余额');
    return { balance: total, used: 0, quota: total };
  }

  override async getUserInfo(baseUrl: string, accessToken: string): Promise<UserInfo | null> {
    const token = normalizeUserToken(accessToken);
    if (!token) return null;
    try {
      const payload = await this.postAction<any>(baseUrl, token, 'user_info');
      if (payload?.success !== true || !payload?.data) return null;
      const data = payload.data;
      return {
        username: String(data.username || ''),
        // The panel masks the address itself (`31***@qq.com`); it is the only one it gives.
        email: typeof data.email === 'string' ? data.email : undefined,
      };
    } catch {
      return null;
    }
  }

  override async getApiTokens(baseUrl: string, accessToken: string): Promise<ApiTokenInfo[]> {
    const token = normalizeUserToken(accessToken);
    if (!token) return [];
    try {
      const payload = await this.postAction<any>(baseUrl, token, 'user_info');
      const keys: unknown = payload?.data?.keys;
      if (!Array.isArray(keys)) return [];
      return keys
        .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
        .map((key, index) => ({
          name: `密钥 ${index + 1}`,
          key: key.trim(),
          enabled: true,
          tokenGroup: null,
        }));
    } catch {
      return [];
    }
  }

  override async getModels(baseUrl: string, apiToken: string): Promise<string[]> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/v1/models`, {
        headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
      });
      const items = Array.isArray(res?.data) ? res.data : [];
      return items
        .map((item: any) => (typeof item?.id === 'string' ? item.id.trim() : ''))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  override async getSiteAnnouncements(
    baseUrl: string,
    accessToken: string,
  ): Promise<SiteAnnouncement[]> {
    try {
      const payload = await this.postAction<any>(
        baseUrl,
        normalizeUserToken(accessToken),
        'notice_feed',
      );
      const announcements: unknown = payload?.data?.announcements;
      if (!Array.isArray(announcements)) return [];
      const parsed: SiteAnnouncement[] = [];
      for (const item of announcements) {
        const content = typeof item?.content === 'string' ? item.content.trim() : '';
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        if (!content && !title) continue;
        parsed.push({
          sourceKey: this.buildNoticeSourceKey(`${item?.id ?? title}:${content}`),
          title: title || '站点公告',
          content: content || title,
          level: normalizeAnnouncementLevel(item?.level),
          sourceUrl: KEYS_API_PATH,
          rawPayload: item,
        });
      }
      return parsed;
    } catch {
      return [];
    }
  }

  /** One POST to the panel's action router, with the token in header and body. */
  private async postAction<T>(
    baseUrl: string,
    token: string,
    action: string,
    extra?: Record<string, unknown>,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers['X-User-Token'] = token;
    const res = await this.fetchJson<T>(
      `${baseUrl.trim().replace(/\/+$/, '')}${KEYS_API_PATH}?action=${encodeURIComponent(action)}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_token: token, ...(extra || {}) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    return res;
  }
}

/** The panel nests its refusals under `error`, and its verdicts under `message`. */
export function readErrorMessage(payload: unknown): string {
  const record = payload as { message?: unknown; error?: { message?: unknown } } | null;
  const nested = record?.error?.message;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  if (typeof record?.message === 'string' && record.message.trim()) return record.message.trim();
  return '';
}

/**
 * Keeps the HTTP status in the message.
 *
 * The panel answers a dead token with `HTTP 401 user_unauthorized`, and that
 * status is what tells the caller to sign in again rather than to give up; the
 * shared `fetchJson` already words it that way, so the body is only appended.
 */
export function describeRequestError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const parsed = raw.match(/^HTTP\s+(\d{3})\s*:\s*([\s\S]*)$/i);
  if (!parsed) return raw.split('\n')[0].slice(0, 200) || '请求失败';
  const body = parsed[2].trim();
  let message = '';
  try {
    message = readErrorMessage(JSON.parse(body));
  } catch {}
  return `HTTP ${parsed[1]}${message ? ` ${message}` : ''}`;
}

/**
 * The panel reports a repeat with "今天已经签到过了" and a 400 status, so the
 * wording — not the status — is what says the day is already collected.
 */
export function isAlreadyCheckedIn(message: string): boolean {
  return /已经签到|签到过|已签到|已领取|重复签到|already\s*(checked|signed)/i.test(message);
}

/**
 * True when the panel is saying the stored credential is unusable.
 *
 * An expired token is answered with `HTTP 401 user_unauthorized`, but a revoked
 * or malformed one never gets that far: the panel cannot read it as a session at
 * all and replies `HTTP 400 invalid_request` / “请先登录，或携带 api_key 参数”.
 * Both mean the same thing to the caller.
 */
export function isSessionRefusal(message: string): boolean {
  return /user_unauthorized|请先登录|请重新登录|登录已失效|登录状态.{0,4}失效/i.test(message);
}

/**
 * Rewords a dead session into the phrasing the shared failure classifier reads
 * as an expired token.
 *
 * Only the 401 shape matches that classifier on its own. Without this the 400
 * shape is reported as a plain error: the hourly balance refresh keeps failing
 * and, worse, marks the account `expired` — which drops it out of the daily
 * check-in set, so nothing would ever sign it back in.
 */
export function normalizeSessionRefusal(message: string): string {
  if (!isSessionRefusal(message)) return message;
  return `访问令牌无效或已过期，请重新登录（${message}）`;
}

/** The two refusals worth rewording: an already-collected day, and a dead session. */
function refusalMessage(message: string): string {
  return isAlreadyCheckedIn(message) ? '今日已签到' : normalizeSessionRefusal(message);
}

function normalizeAnnouncementLevel(level: unknown): SiteAnnouncement['level'] {
  if (level === 'warning' || level === 'error') return level;
  return 'info';
}
