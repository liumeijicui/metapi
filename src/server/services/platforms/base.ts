import { createHash } from 'node:crypto';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { withSiteProxyRequestInit } from '../siteProxy.js';

export interface CheckinResult {
  success: boolean;
  message: string;
  reward?: string;
}

/**
 * Extra inputs a check-in call needs beyond the account credential.
 *
 * A site may hand its daily check-in to a separate welfare service
 * (`externalCheckinUrl`), whose session material is captured on the account
 * (`extraConfig`). Neither value is reachable from the adapter signature alone,
 * so the caller threads them through explicitly instead of the adapter
 * re-reading the database.
 */
export interface CheckinContext {
  /** Welfare/check-in site declared on the site record. */
  externalCheckinUrl?: string | null;
  /** Raw account `extraConfig` that may carry the welfare site session. */
  extraConfig?: string | null;
  /** Present only for sites whose daily grant is paid inside the login handler. */
  browserRelogin?: BrowserReloginGate;
}

/**
 * Whether this run may spend a headed-browser sign-in.
 *
 * The caller owns this because it depends on state the adapter cannot see — when
 * the account last spent one, and whether the day's grant is already settled —
 * and because adapters do not touch the database. On a relay that pays its daily
 * grant inside the login handler, a sign-in is worth exactly one grant a day, so
 * replaying it on every hourly run buys nothing and feeds the edge's IP throttle,
 * which then answers the whole site with `403 denied by http_ratelimit`.
 */
export interface BrowserReloginGate {
  /** The day's grant has been settled, so no sign-in is owed until tomorrow. */
  isSettledToday(): boolean;
  /** Milliseconds left in the back-off after a failed attempt; 0 when ready. */
  cooldownRemainingMs(): number;
  /** Records that a sign-in is about to be spent. Called before the attempt. */
  recordAttempt(): Promise<void>;
  /** Records that the day ended with nothing more to collect. */
  markSettled(): Promise<void>;
}


export interface SubscriptionPlanSummary {
  id?: number;
  groupId?: number;
  groupName?: string;
  status?: string;
  expiresAt?: string;
  dailyUsedUsd?: number;
  dailyLimitUsd?: number;
  weeklyUsedUsd?: number;
  weeklyLimitUsd?: number;
  monthlyUsedUsd?: number;
  monthlyLimitUsd?: number;
}

export interface SubscriptionSummary {
  activeCount: number;
  totalUsedUsd: number;
  subscriptions: SubscriptionPlanSummary[];
}

export interface BalanceInfo {
  balance: number;
  used: number;
  quota: number;
  todayIncome?: number;
  todayQuotaConsumption?: number;
  subscriptionSummary?: SubscriptionSummary;
}

export interface LoginResult {
  success: boolean;
  accessToken?: string;
  username?: string;
  message?: string;
  /**
   * Short-lived token for the calls this same sign-in flow makes before the
   * stored credential is usable.
   *
   * An adapter that keeps the rotatable refresh cookie as `accessToken` cannot
   * spend it on an API call directly, and exchanging it right away would roll
   * the secret while the caller is still holding the pre-roll value. Reporting
   * the access token separately lets the flow do its post-sign-in work (such as
   * listing the sessions to sign out) without touching the durable credential.
   */
  bearerToken?: string;
  /**
   * Site-side user id (the value of the `New-Api-User` header).
   * Most New API compatible sites return it in the login payload as
   * `data.id`, so adapters can surface it here instead of forcing callers
   * to guess it from the username or re-discover it on every request.
   */
  platformUserId?: number;
  /**
   * Long-lived half of the pair a site mints at sign-in, for the platforms
   * whose session is a rotating token pair rather than a cookie.
   *
   * Dropping it is what turns a sign-in into a one-off: on Sub2API the access
   * token lives for hours, so an account that only ever stores it has to sign
   * in again on every expiry — and a site that gates that sign-in behind a
   * Turnstile has no way to do even that. Reporting the pair lets the caller
   * keep renewing over HTTP from then on.
   */
  refreshToken?: string;
  /** Absolute expiry of `refreshToken`, in ms, when the site states one. */
  tokenExpiresAt?: number;
}

export interface UserInfo {
  username: string;
  displayName?: string;
  email?: string;
  role?: number;
}

export interface TokenVerifyResult {
  tokenType: 'session' | 'apikey' | 'unknown';
  userInfo?: UserInfo | null;
  balance?: BalanceInfo | null;
  apiToken?: string | null;
  models?: string[];
  /**
   * Why an `unknown` verdict was reached. `rate-limited` means the site's own
   * edge refused the request while the site was busy, so the credential was
   * never judged and callers must not treat it as invalid.
   */
  failureReason?: 'rate-limited' | null;
}

export interface ApiTokenInfo {
  name: string;
  key: string;
  enabled?: boolean;
  tokenGroup?: string | null;
}

/**
 * A key the site minted, together with whatever its own create response said
 * about it.
 *
 * Some relays print a key exactly once — in the answer to the create call — and
 * mask it in every later listing. For those the create response is the only
 * moment the plaintext exists, so a caller that drops it ends up with a key on
 * the site that nothing here can ever route through. `key` stays null for sites
 * that keep the value to themselves; callers then read the listing as before.
 */
export interface CreatedApiToken {
  name: string;
  key: string | null;
  tokenGroup?: string | null;
  /**
   * New session cookie the site handed back while the security check was
   * completed. Callers holding the account row must write it back, otherwise the
   * verification is lost with the response and the next create starts over.
   */
  rotatedSession?: { cookieName: string; value: string; previousValue?: string } | null;
}

export interface SiteAnnouncement {
  sourceKey: string;
  title: string;
  content: string;
  level: 'info' | 'warning' | 'error';
  sourceUrl?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  upstreamCreatedAt?: string | null;
  upstreamUpdatedAt?: string | null;
  rawPayload?: unknown;
}

export interface CreateApiTokenOptions {
  name?: string;
  group?: string;
  unlimitedQuota?: boolean;
  remainQuota?: number;
  expiredTime?: number;
  allowIps?: string;
  modelLimitsEnabled?: boolean;
  modelLimits?: string;
  /**
   * Account password, used only when the site gates key creation behind a
   * second-factor step (some New API forks answer `VERIFICATION_REQUIRED` and
   * expect `POST /api/verify` first). Callers pass it for this one call; it is
   * never stored on the token or written back anywhere.
   */
  securityPassword?: string | null;
}

/**
 * One sign-in session as the site itself reports it.
 *
 * Some New API forks cap how many sessions an account may hold and refuse the
 * next login once the cap is reached (`409 AUTH_SESSION_LIMIT`). Those forks
 * also expose this list, which is what makes it possible to retire the stale
 * sessions instead of asking the operator to do it by hand.
 */
export interface SiteSessionInfo {
  sid: string;
  /** True for the session the credential used to read the list belongs to. */
  current: boolean;
  loginMethod?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  createdAt?: number | null;
  lastActiveAt?: number | null;
  expiresAt?: number | null;
}

/**
 * What a platform's daily lottery looks like right now.
 *
 * The site is the only honest source for "how many draws are left today": its
 * counter is what a repeat run is refused against, so the caller re-reads it
 * instead of keeping a local tally that drifts.
 */
export interface LotteryStatus {
  enabled: boolean;
  canDraw: boolean;
  /** Draws already made today, per the site's own counter. */
  todayDraws: number;
  /** The site's own ceiling for the day. */
  dailyDrawLimit: number;
  todayRemaining: number;
  /** Draws the site hands out as a reward; these are spent before any credit. */
  bonusDraws: number;
  /** Free credit available to pay for draws, in USD. */
  freeBalance: number;
  /** Largest batch the site accepts in one call. */
  batchMax: number;
  /** Whether paying a draw with free credit is allowed, and its price. */
  freeCost: { enabled: boolean; amount: number };
}

export interface LotteryDraw {
  costType: string;
  prizeType: string;
  prizeAmount: number;
  status: string;
}

export interface LotteryDrawRequest {
  costType: 'bonus' | 'free' | 'activity' | 'paid';
  count: number;
  /** Lets a retry of the same batch be recognised instead of charged twice. */
  idempotencyKey: string;
}

export interface LotteryDrawOutcome {
  draws: LotteryDraw[];
  /** The site's updated counter, when it returns one. */
  todayDraws?: number;
}

/** 上游模型监控里的单个成功率采样点；ts 缺失表示上游没给时间轴。 */
export interface PerfMetricsSample {
  ts: number | null;
  rate: number;
}

/**
 * 指标为 null 表示这个平台没有监控接口，只拿到了模型名（例如 sub2api
 * 或老版本 new-api，只能靠 sk- 密钥读 `/v1/models`）。页面把 null 显示成
 * 「—」，不会编造 0 来假装有数据。
 */
export interface PerfMetricsModel {
  modelName: string;
  avgLatencyMs: number | null;
  successRate: number | null;
  avgTps: number | null;
  recentSuccess: PerfMetricsSample[];
}

export interface PerfMetricsSummary {
  summary: {
    avgLatencyMs: number;
    successRate: number;
    avgTps: number;
  } | null;
  windowStart: number | null;
  windowEnd: number | null;
  showThroughput: boolean | null;
  models: PerfMetricsModel[];
}

/**
 * 站点自己的模型监控读数。失败时把「站点没有这个接口」与「这次请求失败」
 * 分开，页面才能区分「站点版本旧」和「凭据/网络挂了」。
 *
 * `edgeBlocked` 是第三种失败：站点边缘（ESA / tengine）用 JS 挑战页或按 IP
 * 限流把 `/api/*` 拦在应用之前。它既不是「接口不存在」，也不是「凭据无效」，
 * 判定发生在凭据被读到之前，换凭据不会有任何改变——所以调用方应当把它当成
 * 「站点自己的监控接口此刻读不到」，落到用密钥读模型列表的降级通道上。
 */
export type PerfMetricsOutcome =
  | { ok: true; data: PerfMetricsSummary }
  | { ok: false; unsupported: boolean; message: string; edgeBlocked?: boolean };

/**
 * Verdict of a credential keep-alive probe.
 *
 * `refused` is a statement the site itself made about the account, so it is the
 * only verdict worth spending a sign-in on. `unknown` covers every way the probe
 * failed to get an answer — a shield page, a timeout, an outage — and must never
 * be read as a dead credential: renewing on it would sign the account in on
 * every tick, and on a site that grants its quota per login that burst is what
 * gets the account throttled.
 */
export type CredentialProbeVerdict = 'ok' | 'refused' | 'unknown';

export interface PlatformAdapter {
  readonly platformName: string;
  /**
   * Set when the site's own quota endpoint cannot be read over HTTP — typically
   * because a web application firewall only lets a real browser through. The
   * balance refresh then skips the account instead of filing a credential
   * failure the operator cannot act on; login and check-in are unaffected.
   */
  readonly balanceUnavailableReason?: string;

  /**
   * Set when the site pays its daily grant inside the login handler.
   *
   * The check-in then has to replay a sign-in to collect it, and the caller
   * arms `CheckinContext.browserRelogin` so that sign-in is spent once a day
   * instead of once an hour.
   */
  readonly dailyGrantBehindLogin?: boolean;
  detect(url: string): Promise<boolean>;
  login(baseUrl: string, username: string, password: string): Promise<LoginResult>;
  getUserInfo(baseUrl: string, accessToken: string, platformUserId?: number): Promise<UserInfo | null>;
  verifyToken(baseUrl: string, token: string, platformUserId?: number): Promise<TokenVerifyResult>;
  checkin(baseUrl: string, accessToken: string, platformUserId?: number, context?: CheckinContext): Promise<CheckinResult>;
  getBalance(baseUrl: string, accessToken: string, platformUserId?: number): Promise<BalanceInfo>;
  getModels(baseUrl: string, token: string, platformUserId?: number, contextSourceScope?: string): Promise<string[]>;
  getApiToken(baseUrl: string, accessToken: string, platformUserId?: number): Promise<string | null>;
  /**
   * Trades a session the sign-in just established for the site's own bearer.
   *
   * Only sites that hand out both credentials need this: their login leaves a
   * session cookie, while the account row (and every path that sends
   * `Authorization: Bearer`) expects the access token the deployment mints from
   * it. Optional on purpose — a site with a single credential shape has nothing
   * to exchange, and callers keep the session when this answers null.
   */
  issueAccessTokenFromSession?(baseUrl: string, sessionCookie: string, platformUserId?: number): Promise<string | null>;
  /**
   * Cheap authenticated probe answering one question: is this credential still
   * accepted?
   *
   * Only sites whose balance endpoint cannot be read over HTTP need it. Those
   * accounts are skipped by the balance pass (`balanceUnavailableReason`), so
   * without a probe nothing at all looks at their credential between check-ins,
   * and a session that dies in between stays dead — and keeps reading as healthy
   * — until the next scheduled sign-in. `refused` must mean the site said so in
   * its own words; anything unreadable is `unknown`, which callers treat as
   * "no verdict" rather than as a reason to spend a sign-in.
   */
  probeCredential?(baseUrl: string, accessToken: string, platformUserId?: number): Promise<CredentialProbeVerdict>;
  getApiTokens(baseUrl: string, accessToken: string, platformUserId?: number): Promise<ApiTokenInfo[]>;
  getSiteAnnouncements(baseUrl: string, accessToken: string, platformUserId?: number): Promise<SiteAnnouncement[]>;
  /**
   * 站点自己的模型监控（成功率 / 延迟 / 吞吐）。只有带
   * `GET /api/perf-metrics/summary` 的 new-api 构建才有；调用方按能力判断，
   * 不支持时返回 `unsupported`，而不是靠捕获 404。
   */
  getPerfMetricsSummary?(baseUrl: string, accessToken: string, platformUserId?: number, hours?: number): Promise<PerfMetricsOutcome>;
  getUserGroups(baseUrl: string, accessToken: string, platformUserId?: number): Promise<string[]>;
  createApiToken(baseUrl: string, accessToken: string, platformUserId?: number, options?: CreateApiTokenOptions): Promise<boolean>;
  /**
   * The same write as `createApiToken`, but it also reports the key the site
   * answered with. Optional on purpose: an adapter whose listing already carries
   * plaintext keys has nothing to gain from it, and callers check for the
   * capability rather than relying on a not-implemented default.
   */
  createApiTokenWithValue?(baseUrl: string, accessToken: string, platformUserId?: number, options?: CreateApiTokenOptions): Promise<CreatedApiToken | null>;
  deleteApiToken(baseUrl: string, accessToken: string, tokenKey: string, platformUserId?: number): Promise<boolean>;
  /**
   * Both are absent on sites with no session-management API. Callers check for
   * the capability instead of catching a not-implemented error, so an adapter
   * that never had it is not asked to grow one.
   */
  listSessions?(baseUrl: string, accessToken: string, platformUserId?: number): Promise<SiteSessionInfo[] | null>;
  revokeSession?(baseUrl: string, accessToken: string, platformUserId: number | undefined, sid: string): Promise<boolean>;
  /**
   * The platform's own daily lottery, absent on every build that ships none.
   * `getLotteryStatus` answers null when the site has no such route, which is
   * how the caller tells "this platform has no lottery" from "the draw failed".
   */
  getLotteryStatus?(baseUrl: string, accessToken: string): Promise<LotteryStatus | null>;
  drawLottery?(baseUrl: string, accessToken: string, request: LotteryDrawRequest): Promise<LotteryDrawOutcome>;
}

export abstract class BasePlatformAdapter implements PlatformAdapter {
  abstract readonly platformName: string;

  abstract detect(url: string): Promise<boolean>;
  abstract checkin(baseUrl: string, accessToken: string, platformUserId?: number, context?: CheckinContext): Promise<CheckinResult>;
  abstract getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo>;
  abstract getModels(baseUrl: string, token: string, platformUserId?: number, contextSourceScope?: string): Promise<string[]>;

  async verifyToken(baseUrl: string, token: string, _platformUserId?: number): Promise<TokenVerifyResult> {
    // 1. Try as session/access token first (for management APIs)
    const userInfo = await this.getUserInfo(baseUrl, token);
    if (userInfo) {
      let balance: BalanceInfo | null = null;
      try { balance = await this.getBalance(baseUrl, token); } catch {}
      let apiToken: string | null = null;
      try { apiToken = await this.getApiToken(baseUrl, token); } catch {}
      return { tokenType: 'session', userInfo, balance, apiToken };
    }

    // 2. Try as API key (for /v1/models)
    try {
      const models = await this.getModels(baseUrl, token);
      if (models && models.length > 0) {
        return { tokenType: 'apikey', models };
      }
    } catch {}

    return { tokenType: 'unknown' };
  }

  async getUserInfo(baseUrl: string, accessToken: string): Promise<UserInfo | null> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res?.success && res?.data) {
        return {
          username: res.data.username || res.data.display_name || '',
          displayName: res.data.display_name,
          email: res.data.email,
          role: res.data.role,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Pull the site-side user id out of the login payload.
   *
   * New API compatible sites return `{ success: true, data: { id, ... } }` on
   * `/api/user/login`, so the id is already there at login time. Without it,
   * callers fall back to `guessPlatformUserIdFromUsername()`, which only works
   * when the username happens to end with the id.
   *
   * This lives on the base adapter so every subclass benefits. Veloera, for
   * one, inherits `login()` as-is, yet its `authHeaders()` only sends
   * `Veloera-User` / `New-API-User` / `User-id` when an id was resolved — so
   * without this it hits the same e-mail-login failure.
   */
  protected extractLoginUserId(payload: any): number | undefined {
    const candidates: unknown[] = [
      payload?.data?.id,
      payload?.data?.user?.id,
      payload?.user?.id,
      payload?.id,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === 'number') {
        if (Number.isSafeInteger(candidate) && candidate > 0) return candidate;
        continue;
      }
      // Only accept a string that is *entirely* digits. `Number.parseInt` would
      // happily turn "80305abc" or "80305.9" into 80305 and we would then send a
      // wrong `New-Api-User` header.
      if (typeof candidate === 'string' && /^\d+$/.test(candidate.trim())) {
        const value = Number(candidate.trim());
        if (Number.isSafeInteger(value) && value > 0) return value;
      }
    }
    return undefined;
  }

  async login(baseUrl: string, username: string, password: string): Promise<LoginResult> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/login`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      if (res?.success && res?.data) {
        return {
          success: true,
          accessToken: typeof res.data === 'string' ? res.data : res.data.token || res.data.access_token,
          username,
          platformUserId: this.extractLoginUserId(res),
        };
      }
      return { success: false, message: res?.message || '登录失败' };
    } catch (err: any) {
      return { success: false, message: err.message || '登录请求失败' };
    }
  }

  async getApiToken(_baseUrl: string, _accessToken: string, _platformUserId?: number): Promise<string | null> {
    return null;
  }

  async getApiTokens(baseUrl: string, accessToken: string, platformUserId?: number): Promise<ApiTokenInfo[]> {
    const token = await this.getApiToken(baseUrl, accessToken, platformUserId);
    if (!token) return [];
    return [{ name: 'default', key: token, enabled: true, tokenGroup: 'default' }];
  }

  async getSiteAnnouncements(
    _baseUrl: string,
    _accessToken: string,
    _platformUserId?: number,
  ): Promise<SiteAnnouncement[]> {
    return [];
  }

  async createApiToken(
    _baseUrl: string,
    _accessToken: string,
    _platformUserId?: number,
    _options?: CreateApiTokenOptions,
  ): Promise<boolean> {
    return false;
  }

  async getUserGroups(
    _baseUrl: string,
    _accessToken: string,
    _platformUserId?: number,
  ): Promise<string[]> {
    return ['default'];
  }

  async deleteApiToken(
    _baseUrl: string,
    _accessToken: string,
    _tokenKey: string,
    _platformUserId?: number,
  ): Promise<boolean> {
    return false;
  }

  protected async fetchJson<T>(url: string, options?: UndiciRequestInit): Promise<T> {
    const { fetch } = await import('undici');
    const requestOptions: UndiciRequestInit = {
      ...options,
      body: options?.body ?? undefined,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    };
    const proxiedRequestOptions = await withSiteProxyRequestInit(url, requestOptions);
    const res = await fetch(url, proxiedRequestOptions);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return res.json() as Promise<T>;
  }

  protected buildNoticeSourceKey(content: string): string {
    const normalized = (content || '').trim();
    return `notice:${createHash('sha1').update(normalized).digest('hex')}`;
  }
}
