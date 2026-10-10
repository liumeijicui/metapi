import { fetch } from 'undici';
import { NewApiAdapter } from './newApi.js';
import type {
  CheckinContext,
  CheckinResult,
  CredentialProbeVerdict,
  PerfMetricsModel,
  PerfMetricsOutcome,
  PerfMetricsSample,
  PerfMetricsSummary,
} from './base.js';
import { getAgentRouterProvider } from '../accountExtraConfig.js';
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
  /**
   * True when the site answered "this credential is not usable", which is a
   * verdict about the account rather than about the log. The renewal path keys
   * off it: without the distinction a dead credential looks like an unreadable
   * log, and the check-in would replay five logins instead of renewing once.
   */
  unauthorized?: boolean;
  reward?: string;
};

type LoginOutcome = {
  ok: boolean;
  message: string;
  /** `checked_in` from the login response, when the provider reports one. */
  checkedIn?: boolean;
};

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number.parseFloat(value) : Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 采样点的时间单位口径：`PerfMetricsSample.ts` / `windowStart` / `windowEnd` 全是
 * **秒**（`shared/modelMonitorBars` 用 `floor((ts - windowStart) / 3600)` 定位格子）。
 */
const SECONDS_PER_HOUR = 3600;
const DEFAULT_HEARTBEAT_BUCKET_SECONDS = 1200;

/**
 * 模型广场的 heartbeat 只给「档位」，不给百分比：
 * ok / warn / degraded / severe / bad / none
 * （站点自己的图例是 可用 / 轻微异常 / 明显异常 / 严重异常 / 完全不可用 / 无调用）。
 *
 * 我们页面的成功率条只需要一个颜色档位，所以把档位折算成代表值。这是刻意的
 * 近似：上游根本没给逐格百分比，与其不画，不如画出它自己那套档位。
 * 'none'（无调用）不产出采样点 —— 页面画成「未知」，而不是伪造一个 0%。
 */
const HEARTBEAT_TIER_RATE: Record<string, number> = {
  ok: 100,
  warn: 90,
  degraded: 70,
  severe: 40,
  bad: 0,
};

/**
 * 把 20 分钟一粒的档位心跳折成整点采样点（页面按整点铺 24 个槽位），时间戳按秒。
 *
 * 一粒可能横跨两个整点，同一整点内取最差的一档：对「可用性」而言，最差档才
 * 是有意义的信息。全是 'none' 的整点不产出采样点，让页面对应槽位留空。
 */
export function buildModelStatusHeartbeatSamples(
  heartbeat: unknown,
  heartbeatStartSeconds: unknown,
  bucketSeconds: unknown,
): PerfMetricsSample[] {
  if (!Array.isArray(heartbeat) || !heartbeat.length) return [];
  const safeBucketSeconds = toFiniteNumber(bucketSeconds) ?? DEFAULT_HEARTBEAT_BUCKET_SECONDS;
  if (!(safeBucketSeconds > 0)) return [];
  const startSeconds = toFiniteNumber(heartbeatStartSeconds) ?? 0;
  const hasTimeline = startSeconds > 0;

  const byHour = new Map<number, number>();
  (heartbeat as unknown[]).forEach((rawTier, index) => {
    const tier = typeof rawTier === 'string' ? rawTier.trim().toLowerCase() : '';
    const rate = HEARTBEAT_TIER_RATE[tier];
    if (rate === undefined) return;
    // 没有时间轴时用序号当整点下标，页面会把这串采样点右对齐铺到尾部。
    // 全部按秒算：毫秒口径不会报错，只会让页面上 24 个格子只剩第 1 格能对上。
    const hourStart = hasTimeline
      ? Math.floor((startSeconds + index * safeBucketSeconds) / SECONDS_PER_HOUR) * SECONDS_PER_HOUR
      : Math.floor((index * safeBucketSeconds) / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
    const current = byHour.get(hourStart);
    if (current === undefined || rate < current) byHour.set(hourStart, rate);
  });

  return Array.from(byHour.keys())
    .sort((left, right) => left - right)
    .map((slot) => ({
      ts: hasTimeline ? slot : null,
      rate: byHour.get(slot) as number,
    }));
}

/**
 * 归一化 `GET /api/user/model-status`（agentrouter 的 `/console/model-status` 页面
 * 就读它）。和 new-api 的 `/api/perf-metrics/summary` 完全是两个接口、两套形状，
 * 所以单独一个采集分支，不去套 `parsePerfMetricsSummaryPayload`。
 *
 * 上游只报「平均延迟」，没有吞吐，所以 `showThroughput` 固定 false：页面上吞吐
 * 那一列直接隐藏，而不是显示成一堆 0。它另外给的 TTFT P90 目前页面没有对应
 * 列，暂不入表。
 */
export function parseAgentRouterModelStatusPayload(payload: unknown): PerfMetricsSummary | null {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const rawData = record && 'data' in record ? record.data : payload;
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
    ? rawData as Record<string, unknown>
    : null;
  if (!data || !Array.isArray(data.models)) return null;

  const bucketSeconds = toFiniteNumber(data.bucket_seconds) ?? DEFAULT_HEARTBEAT_BUCKET_SECONDS;
  const models: PerfMetricsModel[] = [];
  for (const rawModel of data.models as unknown[]) {
    if (!rawModel || typeof rawModel !== 'object') continue;
    const model = rawModel as Record<string, unknown>;
    const modelName = typeof model.name === 'string' ? model.name.trim() : '';
    if (!modelName) continue;

    models.push({
      modelName,
      avgLatencyMs: toFiniteNumber(model.avg_latency_ms),
      successRate: toFiniteNumber(model.success_rate_24h),
      // 站点不报吞吐；页面按 showThroughput=false 隐藏这一列。
      avgTps: 0,
      recentSuccess: buildModelStatusHeartbeatSamples(
        model.heartbeat,
        model.heartbeat_start,
        bucketSeconds,
      ),
    });
  }
  if (!models.length) return null;

  // 站点级概览优先用 tiles 的 24 小时可用率；没有就按模型的可用率平均，仍没有
  // 就留 0（页面显示「—」），不编造一个好看的数。
  const tiles = data.tiles && typeof data.tiles === 'object'
    ? data.tiles as Record<string, unknown>
    : null;
  const modelLatencies = models
    .map((model) => model.avgLatencyMs)
    .filter((value): value is number => value !== null);
  const modelRates = models
    .map((model) => model.successRate)
    .filter((value): value is number => value !== null);
  const tileRate = toFiniteNumber(tiles?.success_rate_24h);

  const sampleTimes = models
    .flatMap((model) => model.recentSuccess.map((sample) => sample.ts))
    .filter((value): value is number => value !== null);

  return {
    summary: {
      avgLatencyMs: modelLatencies.length
        ? modelLatencies.reduce((sum, value) => sum + value, 0) / modelLatencies.length
        : 0,
      successRate: tileRate ?? (modelRates.length
        ? modelRates.reduce((sum, value) => sum + value, 0) / modelRates.length
        : 0),
      avgTps: 0,
    },
    windowStart: sampleTimes.length ? Math.min(...sampleTimes) : null,
    windowEnd: sampleTimes.length ? Math.max(...sampleTimes) + SECONDS_PER_HOUR : null,
    showThroughput: false,
    models,
  };
}

/** The site writes the daily grant into its system log with this wording. */
export function isDailyCheckinLogEntry(content: unknown): boolean {
  return typeof content === 'string' && content.includes(CLAIM_LOG_KEYWORD);
}

/**
 * True when the site's own words say the credential was refused.
 *
 * agentrouter answers a rejected access token with the same HTTP 200 and
 * `success:false` envelope it uses for every refusal, so the only signal is the
 * message. Kept as a narrowing check on purpose: a generic "not success" must
 * stay an unreadable log, or a site-side outage would be filed as a dead
 * credential and trigger a re-login it cannot help with.
 */
export function isCredentialRefusal(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (!text) return false;
  return /access\s*token\s*无效/i.test(text)
    || /access\s+token\s+(?:is\s+)?(?:invalid|expired)/i.test(text)
    || /令牌(?:无效|已过期|失效)/.test(text)
    || /未登录且未提供\s*access\s*token/i.test(text);
}

/** Pulls the reward out of "每日签到成功，增加额度 ＄25.000000 额度". */
export function extractDailyReward(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  const match = content.match(/(\d+(?:\.\d+)?)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? String(value) : undefined;
}

/**
 * Midnight of the day the site is counting, in the site's own timezone.
 *
 * The site files its log in Asia/Shanghai, and the container this runs in
 * usually has no `TZ` set — which makes the local-midnight arithmetic below read
 * the host clock as UTC. That lands eight hours early, in the direction that
 * matters here: a grant arriving at 00:11 +08 is stamped 16:11 the previous day
 * in UTC, so it fell outside the "today" window and looked like yesterday's
 * entry. The offset is therefore pinned to the site's timezone instead of being
 * inherited from the host.
 */
const SITE_UTC_OFFSET_SECONDS = 8 * 3600;
const SECONDS_PER_DAY = 86_400;

function startOfLocalDaySeconds(now: Date = new Date()): number {
  const shifted = Math.floor(now.getTime() / 1000) + SITE_UTC_OFFSET_SECONDS;
  return Math.floor(shifted / SECONDS_PER_DAY) * SECONDS_PER_DAY - SITE_UTC_OFFSET_SECONDS;
}

export class AgentRouterAdapter extends NewApiAdapter {
  readonly platformName = 'agentrouter';

  /**
   * `/api/user/self` intermittently answers with the Aliyun WAF challenge page
   * (`<!doctype ...`) no matter the credential or the proxy — measured 5/5
   * refusals in a row while `/api/log/self` and `/api/status` kept serving JSON.
   * The console reads the quota from a browser that has cleared that challenge,
   * so nothing here reliably can; the balance is reported as unavailable instead
   * of as a broken credential. Check-in and login are unaffected: they go
   * through the OAuth login and the system log.
   */
  readonly balanceUnavailableReason =
    '站点余额接口受阿里云 WAF 保护，HTTP 无法读取余额（签到与登录不受影响）';

  async detect(url: string): Promise<boolean> {
    return (url || '').toLowerCase().includes('agentrouter');
  }

  /**
   * 模型广场读数（独立采集分支）。
   *
   * 站点自己的 `/console/model-status` 页面读 `GET /api/user/model-status`，
   * 和 new-api 的 `/api/perf-metrics/summary` 不是一回事，所以这里不复用父类实现。
   *
   * 两点和 new-api 不一样：
   * - 必须带 `New-Api-User`：缺了它站点直接回 401「未提供 New-Api-User」，
   *   而不是把凭据当无效；
   * - 窗口固定 24 小时，`hours` 参数上游不认，收下但忽略。
   */
  override async getPerfMetricsSummary(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    _hours = 24,
  ): Promise<PerfMetricsOutcome> {
    const root = (baseUrl || '').replace(/\/+$/, '');
    if (!root) return { ok: false, unsupported: true, message: '站点地址为空' };

    const url = `${root}/api/user/model-status`;
    const headers: Record<string, string> = {
      ...this.buildCredentialRequestHeaders(accessToken, platformUserId),
      'User-Agent': BROWSER_USER_AGENT,
      Origin: root,
      Referer: `${root}/console/model-status`,
    };

    let status = 0;
    let payload: unknown = null;
    try {
      const response = await fetch(url, await withSiteProxyRequestInit(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }));
      status = response.status;
      const text = await response.text();
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }
    } catch (error) {
      return {
        ok: false,
        unsupported: false,
        message: `请求上游失败：${(error as Error)?.message || 'unknown error'}`,
      };
    }

    if (status !== 200) {
      if (status === 401) {
        return {
          ok: false,
          unsupported: false,
          message: 'HTTP 401：站点判定当前会话无效（需要重新登录后再读模型状态）',
        };
      }
      if (status === 404) {
        return { ok: false, unsupported: true, message: '站点没有 /api/user/model-status 接口（版本较旧）' };
      }
      if (status === 403) {
        return { ok: false, unsupported: false, message: 'HTTP 403：被站点边缘 / WAF 拦截（可能需要过盾）' };
      }
      return { ok: false, unsupported: false, message: `HTTP ${status}：模型状态接口未返回可用数据` };
    }

    const parsed = parseAgentRouterModelStatusPayload(payload);
    if (!parsed) {
      return { ok: false, unsupported: false, message: '上游返回的模型状态数据无法解析' };
    }
    return { ok: true, data: parsed };
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
    // A refused credential is not a claim verdict, and the daily grant can only
    // be read back with a live one. Failing here — rather than replaying the
    // login with the same dead token — is what lets the caller renew first (see
    // `autoRelogin`), after which this run is retried with the fresh credential.
    if (before.unauthorized) {
      return {
        success: false,
        message: '访问令牌已失效（access token 无效），需要重新登录后再签到',
      };
    }
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

      // The sign-in only drops the cookie session; the account's access token
      // survives it, so the grant is read back with the credential this run
      // started from. A token that had died never reaches this loop — the
      // unauthorized check above sends the caller to renew it first.
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
      // Read through the shield-aware path on purpose. This site's management
      // endpoints sit behind the Aliyun WAF, which answers a plain request with
      // its JS challenge page instead of JSON (measured 5/5 refusals), and only
      // this path sends the same-origin headers the console sends and solves
      // `acw_sc__v2`. Without it the log reads as unreadable, and an unreadable
      // log is exactly what made a refused credential look like a site outage.
      const res = await this.fetchSiteJson<any>(
        `${baseUrl}/api/log/self?p=1&page_size=${CLAIM_LOG_PAGE_SIZE}&type=4`,
        accessToken,
        platformUserId,
      );
      const items = Array.isArray(res?.data?.items) ? res.data.items : null;
      if (!res?.success || !items) {
        // The site answers a refused credential with HTTP 200 and
        // `success:false, message:"无权进行此操作，access token 无效"`, so the
        // credential verdict has to be read out of the body.
        return {
          known: false,
          claimed: false,
          unauthorized: isCredentialRefusal(res?.message),
        };
      }

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
    const { loginAgentRouterWithGitHub } = await import('../assistedLogin/sites/agentRouter.js');
    return loginAgentRouterWithGitHub({ baseUrl });
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

  /**
   * Exchanges a session the sign-in established for the account's bearer token.
   *
   * The deployment mints exactly one `access_token` per user: `GET
   * /api/user/token` rotates it and answers with the new value, retiring the
   * previous one. That is the credential shape these accounts hold and the only
   * one the paths that send `Authorization: Bearer` can use, so a renewal that
   * stopped at the session cookie would leave the account half alive. The
   * cookie is still the fallback: the management routes accept it too, and a
   * site that answers no token is better held by it than dropped.
   */
  async issueAccessTokenFromSession(
    baseUrl: string,
    sessionCookie: string,
    platformUserId?: number,
  ): Promise<string | null> {
    const root = (baseUrl || '').replace(/\/+$/, '');
    if (!root || !sessionCookie) return null;
    const res = await this.fetchSiteJson<any>(`${root}/api/user/token`, sessionCookie, platformUserId);
    if (res?.success !== true) return null;
    const token = typeof res.data === 'string' ? res.data.trim() : '';
    return token || null;
  }

  /**
   * 保活探针：读一次系统日志，只取「凭据被拒」这一个判断。
   *
   * 这个站点的余额接口读不出来（见 `balanceUnavailableReason`），所以余额轮询
   * 会整天跳过它，而下次签到要等到定时任务。中间这段时间里凭据死了没人知道：
   * 账号继续显示健康，直到某次调用报 401。用日志做探针是因为它同时是签到要读
   * 的那份数据 —— 一次请求既确认凭据，又顺带知道今天有没有到账，不会多花站点
   * 的任何一次登录。
   */
  async probeCredential(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<CredentialProbeVerdict> {
    const state = await this.readDailyClaim(baseUrl, accessToken, platformUserId);
    if (state.unauthorized) return 'refused';
    return state.known ? 'ok' : 'unknown';
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

  /**
   * Carries whichever credential shape the account holds, plus exactly one id
   * header — the spelling this site's frontend sends.
   *
   * The renewed credential is the site's bearer, but a renewal whose token
   * exchange did not answer keeps the session cookie instead, and this site's
   * console routes accept either. Sending `Bearer <cookie>` for the second shape
   * is what would make a usable account read as dead.
   *
   * The parent's compatibility set is deliberately not inherited here. It sends
   * the same id under seven spellings because new-api deployments differ in
   * which one they read; this deployment reads every spelling it recognises and
   * refuses a caller that carries more than one. Header names are
   * case-insensitive, so Node folds `New-API-User` and `New-Api-User` into a
   * single comma-joined value, and the site answers 401「New-Api-User 格式错误」
   * — which is what every log read and balance refresh on this account was
   * hitting. Passing no id to the parent is what keeps its set out of the way.
   */
  protected override buildCredentialRequestHeaders(
    accessToken: string,
    platformUserId?: number,
  ): Record<string, string> {
    const headers = super.buildCredentialRequestHeaders(accessToken);
    if (platformUserId) headers['New-Api-User'] = String(platformUserId);
    return headers;
  }
}
