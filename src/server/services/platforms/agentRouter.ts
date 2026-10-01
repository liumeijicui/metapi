import { fetch } from 'undici';
import { NewApiAdapter } from './newApi.js';
import type { CheckinContext, CheckinResult } from './base.js';
import { getAgentRouterProvider } from '../accountExtraConfig.js';
import { readImportedSession } from '../assistedLogin/importedSession.js';
import { withSiteProxyRequestInit } from '../siteProxy.js';

/**
 * Agent Router (agentrouter.org) has no check-in endpoint.
 *
 * The site grants the daily $25 inside its login handler and reports it on the
 * login response as `checked_in`; its FAQ says so in plain words — "需要退出后
 * 重新登陆才会到账 / Log out & back in to activate". A check-in therefore means
 * logging the account in again through the OAuth provider it was registered
 * with, then verifying that a "每日签到成功" entry appeared in today's system
 * log, which is the same evidence the site's own console shows.
 *
 * `github_*` accounts go through GitHub over plain HTTP (the imported GitHub
 * session is enough). `linuxdo_*` accounts must pass Cloudflare on
 * connect.linux.do, so their part runs in the managed Linux.do browser (see
 * `assistedLogin/sites/agentRouter.ts`).
 *
 * The account's provider is declared on `extraConfig.agentRouter.provider`,
 * because nothing else on the account record distinguishes the two.
 */

const GITHUB_ORIGIN = 'https://github.com';
const REQUEST_TIMEOUT_MS = 30_000;
/** The FAQ asks for one logout+login; a stuck day gives up after five. */
const MAX_LOGIN_ATTEMPTS = 5;
const CLAIM_LOG_PAGE_SIZE = 20;
const CLAIM_LOG_KEYWORD = '签到成功';
const DEFAULT_DAILY_REWARD = '25';
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

type DailyClaimState = {
  /** False when the log could not be read — that is not the same as "not claimed". */
  known: boolean;
  claimed: boolean;
  reward?: string;
};

type LoginOutcome = {
  ok: boolean;
  message: string;
  /** `checked_in` from the login response, when the provider reports one. */
  checkedIn?: boolean;
};

/** The site writes the daily grant into its system log with this wording. */
export function isDailyCheckinLogEntry(content: unknown): boolean {
  return typeof content === 'string' && content.includes(CLAIM_LOG_KEYWORD);
}

/** Pulls the reward out of "每日签到成功，增加额度 ＄25.000000 额度". */
export function extractDailyReward(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  const match = content.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? String(value) : undefined;
}

/** The site and this deployment both live in Asia/Shanghai. */
function startOfLocalDaySeconds(now: Date = new Date()): number {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(start.getTime() / 1000);
}

export class AgentRouterAdapter extends NewApiAdapter {
  readonly platformName = 'agentrouter';

  /**
   * `/api/user/self` answers every HTTP client with an Aliyun WAF challenge
   * page (`aliyun_waf_aa`/`bb`), no matter the headers or the proxy, while the
   * neighbouring routes (`/api/log/self`, `/api/status`) serve JSON normally.
   * The console reads the quota from a browser that has cleared that challenge,
   * so nothing here can; the balance is reported as unavailable instead of as a
   * broken credential. Daily check-in is unaffected — it goes through the OAuth
   * login and the system log.
   */
  readonly balanceUnavailableReason =
    '站点余额接口受阿里云 WAF 保护，HTTP 无法读取余额（签到与登录不受影响）';

  async detect(url: string): Promise<boolean> {
    return (url || '').toLowerCase().includes('agentrouter');
  }

  override async checkin(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    context?: CheckinContext,
  ): Promise<CheckinResult> {
    const provider = getAgentRouterProvider(context?.extraConfig);
    if (!provider) {
      return {
        success: false,
        message: '未配置 agentRouter.provider（github 或 linuxdo），无法执行退出重登签到',
      };
    }

    const before = await this.readDailyClaim(baseUrl, accessToken, platformUserId);
    if (before.claimed) {
      return { success: false, message: '今日已签到' };
    }

    let lastMessage = '';
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
      const login = provider === 'github'
        ? await this.loginWithGitHub(baseUrl)
        : await this.loginWithLinuxDo(baseUrl, platformUserId);
      if (!login.ok) {
        lastMessage = login.message;
        continue;
      }

      const after = await this.readDailyClaim(baseUrl, accessToken, platformUserId);
      if (after.claimed) {
        return {
          success: true,
          message: `退出重登后签到到账（第 ${attempt} 次）`,
          reward: after.reward || DEFAULT_DAILY_REWARD,
        };
      }
      if (!after.known && !before.known && login.checkedIn === true) {
        // The log could not be read at all; the login response is then the only
        // verdict available, and it says this login brought the quota in.
        return {
          success: true,
          message: `登录响应确认签到到账（第 ${attempt} 次）`,
          reward: DEFAULT_DAILY_REWARD,
        };
      }
      lastMessage = login.message;
    }

    return {
      success: false,
      message: `连续 ${MAX_LOGIN_ATTEMPTS} 次退出重登仍未到账${lastMessage ? `（最后一次：${lastMessage}）` : ''}`,
    };
  }

  /** Reads today's grant out of the account's system log. */
  private async readDailyClaim(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<DailyClaimState> {
    try {
      const res = await this.fetchJson<any>(
        `${baseUrl}/api/log/self?p=1&page_size=${CLAIM_LOG_PAGE_SIZE}&type=4`,
        { headers: this.buildAuthHeaders(accessToken, platformUserId) },
      );
      const items = Array.isArray(res?.data?.items) ? res.data.items : null;
      if (!res?.success || !items) return { known: false, claimed: false };

      const todayStart = startOfLocalDaySeconds();
      for (const item of items) {
        const createdAt = Number(item?.created_at);
        if (!Number.isFinite(createdAt) || createdAt < todayStart) continue;
        if (!isDailyCheckinLogEntry(item?.content)) continue;
        return { known: true, claimed: true, reward: extractDailyReward(item.content) };
      }
      return { known: true, claimed: false };
    } catch {
      return { known: false, claimed: false };
    }
  }

  /** Replays the GitHub OAuth login with the imported GitHub session. */
  private async loginWithGitHub(baseUrl: string): Promise<LoginOutcome> {
    const imported = await readImportedSession('github');
    if (!imported?.cookieHeader) {
      return { ok: false, message: '未导入 GitHub 会话，请先在辅助登录中导入' };
    }

    const clientId = await this.readOAuthClientId(baseUrl, 'github');
    if (!clientId) return { ok: false, message: '站点未启用 GitHub 登录' };
    const state = await this.readOAuthState(baseUrl);
    if (!state) return { ok: false, message: '站点未返回 OAuth state' };

    const authorize = new URL('/login/oauth/authorize', GITHUB_ORIGIN);
    authorize.search = new URLSearchParams({ client_id: clientId, scope: 'user:email', state }).toString();

    // Provider cookies only ever go to GitHub: the redirect is followed by hand,
    // so nothing is forwarded to the callback host.
    const github = await fetch(authorize, await withSiteProxyRequestInit(String(authorize), {
      headers: {
        Accept: 'text/html',
        Cookie: imported.cookieHeader,
        'User-Agent': BROWSER_USER_AGENT,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    await github.body?.cancel();

    const location = github.headers.get('location');
    if (github.status === 200 || github.status === 401) {
      return { ok: false, message: 'GitHub 会话需要重新登录或重新授权' };
    }
    if ((github.status !== 302 && github.status !== 303) || !location) {
      return { ok: false, message: `GitHub 授权未完成（HTTP ${github.status}）` };
    }

    const callback = new URL(location, GITHUB_ORIGIN);
    const code = callback.searchParams.get('code');
    const site = new URL(baseUrl);
    if (
      callback.host !== site.host
      || callback.pathname !== '/oauth/github'
      || !code
      || callback.searchParams.get('state') !== state
    ) {
      return { ok: false, message: 'GitHub OAuth 回调校验失败' };
    }

    const completed = await this.fetchJson<any>(
      `${baseUrl}/api/oauth/github?${new URLSearchParams({ code, state, mode: 'login' })}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!completed?.success) {
      return { ok: false, message: completed?.message || '站点未完成 GitHub 登录' };
    }
    return {
      ok: true,
      message: 'GitHub 重新登录成功',
      checkedIn: completed?.data?.checked_in === true,
    };
  }

  /** Replays the Linux.do OAuth login in the managed Linux.do browser. */
  private async loginWithLinuxDo(baseUrl: string, platformUserId?: number): Promise<LoginOutcome> {
    const clientId = await this.readOAuthClientId(baseUrl, 'linuxdo');
    if (!clientId) return { ok: false, message: '站点未启用 Linux.do 登录' };

    // The state and the sign-out both have to happen inside the browser, so the
    // whole handshake is delegated. Imported lazily: the browser stack is only
    // needed for Linux.do accounts.
    const { loginAgentRouterWithLinuxDo } = await import('../assistedLogin/sites/agentRouter.js');
    return loginAgentRouterWithLinuxDo({ baseUrl, clientId, expectedUserId: platformUserId });
  }

  private async readOAuthState(baseUrl: string): Promise<string | null> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/oauth/state?mode=login`, {
        headers: { Accept: 'application/json' },
      });
      const state = typeof res?.data === 'string' ? res.data.trim() : '';
      return state || null;
    } catch {
      return null;
    }
  }

  private async readOAuthClientId(
    baseUrl: string,
    provider: 'github' | 'linuxdo',
  ): Promise<string | null> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/status`, {
        headers: { Accept: 'application/json' },
      });
      const data = res?.data;
      if (!data) return null;
      const enabled = provider === 'github' ? data.github_oauth : data.linuxdo_oauth;
      const clientId = provider === 'github' ? data.github_client_id : data.linuxdo_client_id;
      if (enabled !== true || typeof clientId !== 'string' || !clientId.trim()) return null;
      return clientId.trim();
    } catch {
      return null;
    }
  }

  private buildAuthHeaders(accessToken: string, platformUserId?: number): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    };
    if (platformUserId) headers['New-Api-User'] = String(platformUserId);
    return headers;
  }
}
