import { fetch } from 'undici';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isReadyAccountToken } from './accountTokenService.js';
import { buildOauthProviderHeaders } from './oauth/service.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { resolveChannelProxyUrl, withSiteRecordProxyRequestInit, UNLIMITED_BODY_TIMEOUT } from './siteProxy.js';
import {
  buildUpstreamEndpointRequest,
  resolveUpstreamEndpointCandidates,
  type UpstreamEndpoint,
} from './upstreamEndpointRuntime.js';
import { executeEndpointFlow } from '../proxy-core/orchestration/endpointFlow.js';
import { getObservedResponseMeta } from '../proxy-core/firstByteTimeout.js';

/**
 * 模型监控的「对话」：用站点自己的账号 / 密钥直连上游，完全不经过网关路由。
 *
 * 之前对话只能固定到 route_channels，于是「站点有账号和 sk、但这个模型没配路由」
 * 时会提示「该站点没有可直连的通道」。这里改成直接按「站点 + 账号 + 凭据」发起
 * 请求，与路由配置无关：只要站点下存在可用凭据（账号 JWT 或 sk- 令牌）就能聊。
 */

/** 一条可直连的凭据：账号本身（JWT）或账号下的某个 sk- 令牌。 */
export type SiteDirectChatTarget = {
  accountId: number;
  /** 非空表示用账号下的这个 sk- 令牌；为空表示用账号自己的凭据。 */
  tokenId: number | null;
  accountName: string;
  tokenName: string | null;
  /** 界面上显示的一行文案。 */
  label: string;
  /** 凭据类型，纯展示用。 */
  credential: 'api_token' | 'account';
};

type AccountRow = typeof schema.accounts.$inferSelect;

function buildLabel(accountName: string, tokenName: string | null): string {
  return tokenName ? `${accountName} · ${tokenName}` : accountName;
}

/**
 * 列出该站点下可直连的凭据。
 * 优先账号自己的 sk- 令牌（`/v1/chat/completions` 本来就是密钥接口），
 * 没有令牌的账号退化成用账号凭据（apiToken / accessToken）。
 */
export async function listSiteDirectChatTargets(siteId: number): Promise<SiteDirectChatTarget[]> {
  if (!Number.isFinite(siteId) || siteId <= 0) return [];

  const accounts: AccountRow[] = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.siteId, siteId))
    .orderBy(asc(schema.accounts.sortOrder), asc(schema.accounts.id))
    .all();
  const usable = [
    ...accounts.filter((account) => account.status === 'active'),
    ...accounts.filter((account) => account.status !== 'active'),
  ];
  if (!usable.length) return [];

  const tokens = await db
    .select()
    .from(schema.accountTokens)
    .where(and(
      inArray(schema.accountTokens.accountId, usable.map((account) => account.id)),
      eq(schema.accountTokens.enabled, true),
    ))
    .orderBy(asc(schema.accountTokens.id))
    .all();

  const tokensByAccount = new Map<number, typeof tokens>();
  for (const token of tokens) {
    const list = tokensByAccount.get(token.accountId) || [];
    list.push(token);
    tokensByAccount.set(token.accountId, list);
  }

  const targets: SiteDirectChatTarget[] = [];
  for (const account of usable) {
    const accountName = String(account.username || '').trim() || `#${account.id}`;
    const readyTokens = (tokensByAccount.get(account.id) || [])
      .filter((token) => isReadyAccountToken(token) && String(token.token || '').trim());
    if (readyTokens.length) {
      for (const token of readyTokens) {
        const tokenName = String(token.name || '').trim() || `令牌#${token.id}`;
        targets.push({
          accountId: account.id,
          tokenId: token.id,
          accountName,
          tokenName,
          label: buildLabel(accountName, tokenName),
          credential: 'api_token',
        });
      }
      continue;
    }
    if (resolveAccountCredential(account)) {
      targets.push({
        accountId: account.id,
        tokenId: null,
        accountName,
        tokenName: null,
        label: buildLabel(accountName, null),
        credential: 'account',
      });
    }
  }
  return targets;
}

/** 账号自带凭据：非 oauth 账号优先 apiToken，其次 accessToken；oauth 账号只能用 accessToken。 */
function resolveAccountCredential(account: AccountRow): string {
  const oauth = getOauthInfoFromAccount(account);
  const value = String(
    (oauth ? account.accessToken : account.apiToken || account.accessToken) || '',
  ).trim();
  return value;
}

/**
 * 把若干 AbortSignal 合成一个：任意一条触发，合成的这条就触发。
 *
 * 这一次直连同时受两条超时约束 —— 业务层的空闲 / 总时长预算（下面的
 * armIdleTimer / totalTimer），以及 executeEndpointFlow 的首字预算。之前只接了
 * 业务那一条，于是首字超时（本意是「这么久没有任何响应头 / 数据就判失败」）触发时
 * 只是让 Promise.race 提前返回了一个 408，底层 fetch 还挂在 socket 上继续等，直到
 * 上游自己收尾。两条都接进来，谁先到都能真正掐断连接。
 */
function mergeAbortSignals(signals: Array<AbortSignal | null | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => !!signal);
  if (!active.length) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export type SiteDirectChatInput = {
  siteId: number;
  accountId: number;
  tokenId?: number | null;
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  /** 总时长上限（毫秒）。到点必断，防止连接一直挂着。 */
  timeoutMs: number;
  /** 空闲上限（毫秒）：多久没有收到新数据才算卡死。推理模型首字很慢，所以单独给一份预算。 */
  idleTimeoutMs?: number;
  /** 额外的 OpenAI 协议字段（例如 reasoning_effort），原样透传给上游。 */
  extraBody?: Record<string, unknown> | null;
  signal?: AbortSignal;
};

export type SiteDirectChatResolution =
  | { ok: true; site: typeof schema.sites.$inferSelect; account: AccountRow; tokenValue: string }
  | { ok: false; status: number; message: string };

/** 解析「站点 + 账号 + 凭据」，任何一步缺失都给出能直接展示的原因。 */
export async function resolveSiteDirectChat(input: {
  siteId: number;
  accountId: number;
  tokenId?: number | null;
}): Promise<SiteDirectChatResolution> {
  const site = await db
    .select()
    .from(schema.sites)
    .where(eq(schema.sites.id, Math.trunc(input.siteId)))
    .get();
  if (!site) return { ok: false, status: 404, message: '站点不存在' };

  const account = await db
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, Math.trunc(input.accountId)))
    .get();
  if (!account || account.siteId !== site.id) {
    return { ok: false, status: 404, message: '账号不存在或不属于该站点' };
  }

  const tokenId = input.tokenId == null ? null : Math.trunc(input.tokenId);
  if (tokenId !== null) {
    if (!Number.isFinite(tokenId) || tokenId <= 0) {
      return { ok: false, status: 400, message: '令牌 ID 不合法' };
    }
    const token = await db
      .select()
      .from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, tokenId))
      .get();
    if (!token || token.accountId !== account.id) {
      return { ok: false, status: 404, message: '令牌不存在或不属于该账号' };
    }
    const value = String(token.token || '').trim();
    if (!value || !isReadyAccountToken(token)) {
      return { ok: false, status: 400, message: '该令牌当前不可用（未就绪或被掩码）' };
    }
    return { ok: true, site, account, tokenValue: value };
  }

  const fallback = resolveAccountCredential(account);
  if (!fallback) {
    return { ok: false, status: 400, message: '该账号没有可用于直连的凭据' };
  }
  return { ok: true, site, account, tokenValue: fallback };
}

/** 直连的结果：拿到底层 Response 交给调用方直接 pipe，或带上一句失败原因。 */
export type SiteDirectChatOutcome =
  | {
    ok: true;
    response: Awaited<ReturnType<typeof globalThis.fetch>>;
    latencyMs: number;
    /**
     * 上游第一个响应体的到达耗时（毫秒），拿不到时为 null。
     *
     * 这就是日志里要记的「首字」：由 `fetchWithObservedFirstByte` 在读到第一块
     * 数据时打点，和网关路由记的是同一套口径（见 chatSurface 里的同名取值）。
     * 响应对象上没带观测信息时（测试桩、非流式空 body 等）退回 null，不编造数字。
     */
    firstByteLatencyMs: number | null;
    /** 每读到一块流数据就调用一次，用来把「空闲计时」往后推。 */
    touch: () => void;
    /** 我方主动掐断时（空闲 / 总时长超限）的真实原因；没掐断时返回 null。 */
    timeoutReason: () => string | null;
  }
  | { ok: false; status: number; message: string };

/**
 * 把「上游失败」翻译成可以安全回给浏览器的状态码与文案。
 *
 * 关键点：上游站点自己回 401/403（凭据被拒、风控拦截等）**绝不能原样转发**。
 * 前端的 `fetchAuthenticatedResponse` 把 401/403 一律当作「本系统会话过期」，
 * 会清掉本地 token 并刷新回登录页 —— 表现就是「和这个站一对话就被退出登录」，
 * agentrouter 的 `unauthorized client detected` 就是这么把用户踢下线的。
 * 这里统一改写成 502（网关侧失败），并把真实状态码写进文案，便于排查。
 */
export function toClientFacingDirectChatFailure(input: {
  status: number;
  message: string;
}): { status: number; message: string } {
  const upstreamAuthRejected = input.status === 401 || input.status === 403;
  const status = upstreamAuthRejected ? 502 : input.status;
  return {
    status: Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502,
    message: upstreamAuthRejected
      ? `上游站点拒绝了这次调用（HTTP ${input.status}）：${input.message}`
      : input.message,
  };
}

/**
 * 直连上游发起一轮对话。**不查路由、不选通道、不改写模型名**：
 * 请求体里的 model 就是页面上点中的那个。
 */
export async function requestSiteDirectChat(input: SiteDirectChatInput): Promise<SiteDirectChatOutcome> {
  const resolved = await resolveSiteDirectChat(input);
  if (!resolved.ok) return { ok: false, status: resolved.status, message: resolved.message };
  const { site, account, tokenValue } = resolved;

  const stream = input.stream !== false;
  // 页面选中的思考强度之类的字段，原样透传（openai 协议下就是 chat/completions 的顶层字段）。
  const extraBody = input.extraBody && typeof input.extraBody === 'object' ? input.extraBody : {};
  const openaiBody: Record<string, unknown> = {
    ...extraBody,
    model: input.model,
    messages: input.messages,
    stream,
  };

  // 0 = 不限制。放开之后真正能中断这轮对话的只剩「用户点停止 / 关掉页面」。
  const totalMs = Math.max(0, Math.trunc(input.timeoutMs));
  const idleMs = input.idleTimeoutMs == null
    ? totalMs
    : Math.max(0, Math.trunc(input.idleTimeoutMs));
  // 两个都给了具体上限时，空闲预算不超过总预算（保持原本的收紧关系）。
  const idleBudgetMs = totalMs > 0 && idleMs > 0 ? Math.min(idleMs, totalMs) : idleMs;
  const abortController = new AbortController();
  const onAbort = () => abortController.abort(new Error('direct chat aborted'));
  input.signal?.addEventListener('abort', onAbort, { once: true });

  // 流式对话默认不设时间上限：只要上游还在吐字就一直等（推理模型首字可能等十几分钟）。
  // 两个预算都为 0 时不会挂任何定时器；配成正数则恢复「空闲 / 总时长」两条硬线。
  let timeoutMessage = totalMs > 0
    ? `直连对话超过 ${Math.round(totalMs / 1000)} 秒上限`
    : '直连对话已被中断';
  let abortedByUs = false;
  const timeoutReason = () => (abortedByUs ? timeoutMessage : null);
  const abortWithReason = (reason: string) => {
    abortedByUs = true;
    timeoutMessage = reason;
    abortController.abort(new Error(reason));
  };
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (idleBudgetMs <= 0) return;
    idleTimer = setTimeout(() => {
      abortWithReason(`上游 ${Math.round(idleBudgetMs / 1000)} 秒没有返回任何新数据（空闲超时）`);
    }, idleBudgetMs);
    idleTimer.unref?.();
  };
  const totalTimer = totalMs > 0
    ? setTimeout(() => {
      abortWithReason(`对话总时长超过 ${Math.round(totalMs / 1000)} 秒上限`);
    }, totalMs)
    : null;
  totalTimer?.unref?.();
  armIdleTimer();

  const startedAt = Date.now();
  try {
    // 固定按 OpenAI 协议发起：候选表里第一个就是 /v1/chat/completions，
    // 我们只发这一个（见下面的 disableCrossProtocolFallback）。
    const endpointCandidates = await resolveUpstreamEndpointCandidates(
      { site, account },
      input.model,
      'openai',
      input.model,
    );
    if (!endpointCandidates.length) {
      return { ok: false, status: 502, message: '该站点没有可用的上游端点' };
    }

    const oauth = getOauthInfoFromAccount(account);
    const providerHeaders = buildOauthProviderHeaders({ account, downstreamHeaders: {} });
    const channelProxyUrl = resolveChannelProxyUrl(site, account.extraConfig);

    const buildRequest = (endpoint: UpstreamEndpoint) => {
      const request = buildUpstreamEndpointRequest({
        endpoint,
        modelName: input.model,
        stream,
        tokenValue,
        oauthProvider: oauth?.provider,
        oauthProjectId: oauth?.projectId,
        sitePlatform: site.platform,
        siteUrl: site.url,
        openaiBody,
        downstreamFormat: 'openai',
        downstreamHeaders: {},
        providerHeaders,
      });
      return {
        endpoint,
        path: request.path,
        headers: request.headers,
        body: request.body as Record<string, unknown>,
        runtime: request.runtime,
      };
    };

    const result = await executeEndpointFlow({
      siteUrl: site.url,
      // 明确「一次请求定胜负」：只用第一个候选端点（openai 协议下就是
      // /v1/chat/completions），失败不换协议、不换端点，把上游原因原样带回去。
      disableCrossProtocolFallback: true,
      // 注意：站点代理只在 dispatchRequest 里通过 withSiteRecordProxyRequestInit 生效，
      // 不能把代理地址当 proxyUrl 传给 executeEndpointFlow —— 那会把代理当成 API base。
      endpointCandidates,
      buildRequest,
      dispatchRequest: async (request, targetUrl, signal) => {
        // 直连：一次请求定胜负，失败就把上游原因原样带回去，不做跨协议降级重试。
        //
        // 必须带 UNLIMITED_BODY_TIMEOUT：undici 默认 bodyTimeout 是 300s（响应体数据
        // 之间的最大间隔），推理模型憋 5 分钟以上不吐字时会被底层直接掐断，报错是一句
        // 看不出所以然的 terminated。关掉它之后，超时判定回到上面的空闲 / 总时长预算。
        const init = withSiteRecordProxyRequestInit(
          site,
          {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: mergeAbortSignals([abortController.signal, signal]),
          },
          channelProxyUrl,
          UNLIMITED_BODY_TIMEOUT,
        );
        return fetch(targetUrl, init as never) as never;
      },
      // 首字预算同样按「空闲」算：这段时间内没有任何响应头/数据就判失败。
      // 0 = 不设首字预算（fetchWithObservedFirstByte 对 0 就是「不挂定时器」）。
      firstByteTimeoutMs: idleBudgetMs,
    });

    if (!result.ok) {
      return {
        ok: false,
        status: result.status || 502,
        message: String(result.rawErrText || result.errText || '上游请求失败').trim(),
      };
    }
    return {
      ok: true,
      response: result.upstream as never,
      latencyMs: Date.now() - startedAt,
      firstByteLatencyMs: getObservedResponseMeta(result.upstream as never)?.firstByteLatencyMs ?? null,
      touch: armIdleTimer,
      timeoutReason,
    };
  } catch (error) {
    if (input.signal?.aborted) {
      return { ok: false, status: 499, message: '已停止（用户中断）' };
    }
    if (abortedByUs) {
      return { ok: false, status: 504, message: timeoutMessage };
    }
    const raw = error instanceof Error ? error.message : String(error || '');
    return {
      ok: false,
      status: 502,
      message: raw && raw !== 'direct chat timeout' ? raw : '直连上游失败',
    };
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    if (idleTimer) clearTimeout(idleTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}
