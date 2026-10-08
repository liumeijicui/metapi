import { and, asc, desc, eq, gte, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { matchesModelPattern } from './tokenRouter.js';
import { getAdapter } from './platforms/index.js';
import { isReadyAccountToken } from './accountTokenService.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { fetchModelPricingCatalog, type ModelPricingCatalogInput } from './modelPricingService.js';
import type { PerfMetricsSummary, PlatformAdapter } from './platforms/base.js';

/**
 * 'models_only' 表示站点没有模型监控接口（sub2api、老版本 new-api 等），
 * 只靠凭据读了 `/v1/models`，页面只显示模型名，成功率/延迟/吞吐留空。
 */
export type ModelMonitorSiteStatus = 'ok' | 'models_only' | 'empty' | 'unsupported' | 'error';

export type ModelMonitorSiteResult = {
  siteId: number;
  siteName: string;
  platform: string;
  status: ModelMonitorSiteStatus;
  models: number;
  message: string | null;
};

export type ModelMonitorRunSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scannedSites: number;
  status: {
    ok: number;
    modelsOnly: number;
    empty: number;
    unsupported: number;
    error: number;
  };
  models: number;
  /** 因为「仅模型列表」站点今天已经刷过、本次被跳过的站点数。 */
  skippedModelListSites: number;
  sites: ModelMonitorSiteResult[];
};

export type ModelMonitorFilter = {
  siteId?: number | null;
  model?: string | null;
  minSuccessRate?: number | null;
  sort?: string | null;
};

/**
 * 站点价目表里的一个模型价格。`unit` 为 'token' 时价格是每 100 万 token 的
 * 美元价，为 'call' 时是每次调用的美元价（按次计费的模型没有 token 单价）。
 */
export type ModelMonitorModelPricing = {
  unit: 'token' | 'call';
  inputPrice: number | null;
  outputPrice: number | null;
};

export type ModelMonitorModelView = {
  siteId: number;
  siteName: string;
  siteUrl: string;
  platform: string;
  modelName: string;
  avgLatencyMs: number | null;
  successRate: number | null;
  avgTps: number | null;
  recentSuccess: Array<{ ts: number | null; rate: number }>;
  windowStart: number | null;
  windowEnd: number | null;
  showThroughput: boolean | null;
  /** false 表示这个站点没有监控接口，指标一律缺失，页面不显示指标只显示模型名。 */
  metricsAvailable: boolean;
  pricingUnit: 'token' | 'call' | null;
  inputPrice: number | null;
  outputPrice: number | null;
  fetchedAt: string | null;
};

export type ModelMonitorOverview = {
  updatedAt: string | null;
  running: boolean;
  windowStartHour: number;
  windowEndHour: number;
  intervalMs: number;
  /** 「仅模型列表」站点每天几点后刷新一次（其余轮次跳过）。 */
  modelListRefreshHour: number;
  /** 调度状态：让页面能显示「上次跑完 / 下次采集」，也方便排查任务有没有活着。 */
  scheduler: ModelMonitorSchedulerState;
  /**
   * 下拉筛选用的模型名清单（含每个模型覆盖几个站点）。跟着站点与最低成功率
   * 筛，但不跟着模型名本身筛，否则选中之后就没法在下拉里换其它模型。
   */
  modelOptions: Array<{ modelName: string; siteCount: number }>;
  sites: Array<{
    siteId: number;
    siteName: string;
    /** 站点主页，页面用来把站点名做成可点击的链接。 */
    url: string;
    platform: string;
    status: string;
    message: string | null;
    modelsCount: number;
    summaryAvgLatencyMs: number | null;
    summarySuccessRate: number | null;
    summaryAvgTps: number | null;
    fetchedAt: string | null;
  }>;
  models: ModelMonitorModelView[];
};

/** 同一时刻只允许一轮采集：上游是同一个网关，并发只会互相拖慢。 */
let monitorRunInFlight: Promise<ModelMonitorRunSummary> | null = null;
let monitorSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let monitorLastRunStartedAtMs = 0;
let monitorNextRunAtMs: number | null = null;
/**
 * 上一轮真正落库的采集时间（读库得到，重启后仍然有效）。
 *
 * 调度器的「下次可跑时间」只活在进程内，重启就丢；没有它，重启就等于「立刻
 * 再全量采一轮」——实测 10:57:22 重启、10:57:25 就起跑，而 10:56:26 刚跑完。
 */
let monitorLastFetchedAtMs: number | null = null;
/** 读上一轮时间这个动作是否已经完成；没完成前 tick 一律不抢跑。 */
let monitorSchedulerReady = false;
let monitorLastRunStartedAtIso: string | null = null;
let monitorLastRunFinishedAtIso: string | null = null;
let monitorSkippedRuns = 0;

export type ModelMonitorSchedulerState = {
  enabled: boolean;
  intervalMs: number;
  windowStartHour: number;
  windowEndHour: number;
  running: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  /** 因为上一轮还没跑完而被跳过的次数（跳过而不是排队，避免堆任务）。 */
  skippedRuns: number;
  nextRunAt: string | null;
};

const MONITOR_TICK_MS = 60_000;

type ModelMonitorPricingCatalog = Awaited<ReturnType<typeof fetchModelPricingCatalog>>;
type ModelMonitorPricingLoader = (input: ModelPricingCatalogInput) => Promise<ModelMonitorPricingCatalog>;

/**
 * 价格来自站点自己的 `/api/pricing`，走的是和 proxy 计费同一套带缓存的读取。
 * 抽成一层是为了让采集测试不必真的去打网络请求。
 */
let modelMonitorPricingLoader: ModelMonitorPricingLoader = fetchModelPricingCatalog;

export function __setModelMonitorPricingLoaderForTests(loader: ModelMonitorPricingLoader | null): void {
  modelMonitorPricingLoader = loader ?? fetchModelPricingCatalog;
}

function normalizePricingKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

/**
 * 读站点价目表并摊平成「模型名 -> 价格」。任何失败都只当「没有价格」，
 * 不能因为价目表挂了就把已经拿到的成功率/延迟丢掉。
 */
async function loadSiteModelPricing(
  site: SiteRow,
  credential: MonitorCredential,
): Promise<Map<string, ModelMonitorModelPricing>> {
  const apiToken = credential.kind === 'api_token' ? credential.value : null;
  const pricing: Map<string, ModelMonitorModelPricing> = new Map();
  try {
    const catalog = await withTimeout(
      modelMonitorPricingLoader({
        site: {
          id: site.id,
          url: site.url,
          platform: String(site.platform || ''),
          apiKey: apiToken,
        },
        account: {
          id: credential.id,
          accessToken: credential.kind === 'account' ? credential.value : null,
          apiToken,
        },
      }),
      config.modelMonitorTimeoutMs,
      `读取 ${site.name} 的模型价格`,
    );
    if (!catalog) return pricing;
    for (const entry of catalog.models) {
      const groupPricing = entry.groupPricing.default
        ?? Object.values(entry.groupPricing)[0]
        ?? null;
      if (!groupPricing) continue;
      if (groupPricing.quotaType === 1) {
        // new-api 的按次计费只给一个总价，one-hub/done-hub 才拆输入/输出。
        pricing.set(normalizePricingKey(entry.modelName), {
          unit: 'call',
          inputPrice: groupPricing.perCallInput ?? groupPricing.perCallTotal ?? null,
          outputPrice: groupPricing.perCallOutput ?? null,
        });
        continue;
      }
      pricing.set(normalizePricingKey(entry.modelName), {
        unit: 'token',
        inputPrice: groupPricing.inputPerMillion ?? null,
        outputPrice: groupPricing.outputPerMillion ?? null,
      });
    }
  } catch {
    return pricing;
  }
  return pricing;
}

type MonitorCredential = {
  kind: 'account' | 'api_token';
  id: number;
  value: string;
  platformUserId?: number;
};

type SiteRow = typeof schema.sites.$inferSelect;

function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function serializeRecentSuccess(samples: Array<{ ts: number | null; rate: number }>): string {
  return JSON.stringify(samples.map((sample) => ({
    ts: sample.ts === null ? null : Math.trunc(sample.ts),
    rate: Math.round(sample.rate * 100) / 100,
  })));
}

export function parseStoredRecentSuccess(raw: unknown): Array<{ ts: number | null; rate: number }> {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const samples: Array<{ ts: number | null; rate: number }> = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const rate = toNullableNumber((entry as Record<string, unknown>).rate);
      if (rate === null) continue;
      const ts = toNullableNumber((entry as Record<string, unknown>).ts);
      samples.push({ ts: ts === null ? null : Math.trunc(ts), rate });
    }
    return samples;
  } catch {
    return [];
  }
}

/**
 * 采集窗口：`[startHour, endHour)`，两端都按服务端本地时间算。跨夜的窗口
 * （start > end）按「跨过午夜」处理，这样把窗口写成 22-6 也仍然是直觉行为。
 */
/**
 * 「仅模型列表」站点（没有监控接口、只能靠密钥列模型）是否需要刷新：
 * 每天 `refreshHour` 点之后刷一次，当天刷过就跳过，避免 15 分钟一次的空转。
 * 没有任何上一轮记录（新站点）或时间戳不可解析时都算「需要刷」。
 */
export function isModelListDailyRefreshDue(
  fetchedAt: string | null | undefined,
  now: Date,
  refreshHour: number,
): boolean {
  if (!fetchedAt) return true;
  const fetchedMs = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMs)) return true;
  const boundaryMs = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    refreshHour,
    0,
    0,
    0,
  ).getTime();
  return fetchedMs < boundaryMs;
}

export function isModelMonitorWindowOpen(
  now: Date,
  startHour: number,
  endHour: number,
): boolean {
  const hour = now.getHours();
  const start = Math.trunc(startHour);
  const end = Math.trunc(endHour);
  if (!Number.isFinite(hour) || !Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start === end) return true;
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function isModelMonitorRunning(): boolean {
  return monitorRunInFlight !== null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listSiteCredentials(siteId: number, preferredKind: string | null, preferredId: number | null): Promise<MonitorCredential[]> {
  // 优先用 active 账号；站点账号全部过期时也照试一遍，好让页面显示上游真正
  // 的失败原因（401），而不是一句本地的「没有凭据」。
  const accountRows: Array<typeof schema.accounts.$inferSelect> = await db.select()
    .from(schema.accounts)
    .where(eq(schema.accounts.siteId, siteId))
    .orderBy(desc(schema.accounts.status), desc(schema.accounts.isPinned), asc(schema.accounts.id))
    .all();
  const accounts = [
    ...accountRows.filter((account) => account.status === 'active'),
    ...accountRows.filter((account) => account.status !== 'active'),
  ];

  const accountCredentials: MonitorCredential[] = [];
  for (const account of accounts) {
    const value = String(account.accessToken || '').trim();
    if (!value) continue;
    accountCredentials.push({
      kind: 'account',
      id: account.id,
      value,
      platformUserId: resolvePlatformUserId(account.extraConfig, account.username),
    });
  }

  const tokenRows: Array<{
    id: number;
    accountId: number;
    token: string;
    valueStatus: string;
    enabled: boolean | null;
  }> = await db.select({
    id: schema.accountTokens.id,
    accountId: schema.accountTokens.accountId,
    token: schema.accountTokens.token,
    valueStatus: schema.accountTokens.valueStatus,
    enabled: schema.accountTokens.enabled,
  })
    .from(schema.accountTokens)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.accountTokens.accountId))
    .where(and(
      eq(schema.accounts.siteId, siteId),
      eq(schema.accountTokens.enabled, true),
    ))
    .orderBy(asc(schema.accountTokens.id))
    .all();

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const tokenCredentials: MonitorCredential[] = [];
  for (const row of tokenRows) {
    if (!isReadyAccountToken(row)) continue;
    const value = String(row.token || '').trim();
    if (!value) continue;
    const owner = accountById.get(row.accountId);
    tokenCredentials.push({
      kind: 'api_token',
      id: row.id,
      value,
      platformUserId: owner ? resolvePlatformUserId(owner.extraConfig, owner.username) : undefined,
    });
  }

  const ordered = [...accountCredentials, ...tokenCredentials];
  const seen = new Set<string>();
  const unique = ordered.filter((credential) => {
    if (seen.has(credential.value)) return false;
    seen.add(credential.value);
    return true;
  });

  if (preferredKind && preferredId) {
    const preferredIndex = unique.findIndex(
      (credential) => credential.kind === preferredKind && credential.id === preferredId,
    );
    if (preferredIndex > 0) {
      const [preferred] = unique.splice(preferredIndex, 1);
      unique.unshift(preferred);
    }
  }
  return unique;
}

type SiteMetricsFetchResult = {
  status: ModelMonitorSiteStatus;
  message: string | null;
  credential: MonitorCredential | null;
  data: PerfMetricsSummary | null;
  /** 模型名（小写）-> 站点自己的价格；读不到时是空表而不是 null。 */
  pricing: Map<string, ModelMonitorModelPricing>;
};

const MODEL_LIST_ONLY_MESSAGE = '站点没有模型监控接口，仅展示模型列表（指标无法获取）';
const MODEL_LIST_ONLY_UNAVAILABLE_MESSAGE = '该平台没有模型监控接口';

/** 降级读模型名时最多试几份凭据。 */
const MODEL_LIST_FALLBACK_LIMIT = 3;

/**
 * 降级采集：站点没有 `/api/perf-metrics`（sub2api、老版本 new-api 等）时，
 * 用同一份凭据（账号 JWT 或 sk- 密钥）读 `/v1/models`，只取模型名。
 * 成功率 / 延迟 / 吞吐读不到就留 null，页面显示成「—」，不编造 0。
 * 拿不到模型列表时返回 null，调用方维持原来的 unsupported / error 结论。
 */
/** 降级结果：成功带回模型行，失败带回一句能写进站点状态的原因。 */
type ModelListFallbackOutcome =
  | { ok: true; result: SiteMetricsFetchResult }
  | { ok: false; reason: string };

/**
 * 降级读模型列表时优先用 sk- 令牌（`/v1/models` 本来就是密钥接口），
 * 再退回账号 JWT；最多试 MODEL_LIST_FALLBACK_LIMIT 份，避免令牌多的站点
 * 把每一份都发一次上游请求。
 */
async function collectModelListFallback(
  site: SiteRow,
  adapter: PlatformAdapter,
  credentials: MonitorCredential[],
): Promise<ModelListFallbackOutcome> {
  const ordered = [
    ...credentials.filter((credential) => credential.kind === 'api_token'),
    ...credentials.filter((credential) => credential.kind !== 'api_token'),
  ].slice(0, MODEL_LIST_FALLBACK_LIMIT);

  let reason = '站点没有任何可用于读取模型列表的凭据';
  for (const credential of ordered) {
    const outcome = await fetchModelListOnly(site, adapter, credential);
    if (outcome.ok) return outcome;
    reason = outcome.reason;
  }
  return { ok: false, reason };
}

async function fetchModelListOnly(
  site: SiteRow,
  adapter: PlatformAdapter,
  credential: MonitorCredential,
): Promise<ModelListFallbackOutcome> {
  const listModels = adapter.getModels?.bind(adapter);
  if (typeof listModels !== 'function') {
    return { ok: false, reason: '站点类型暂不支持用密钥读模型列表' };
  }
  let models: string[];
  try {
    models = await withTimeout(
      listModels(site.url, credential.value, credential.platformUserId),
      config.modelMonitorTimeoutMs,
      `读取 ${site.name} 的模型列表`,
    );
  } catch (error) {
    return { ok: false, reason: `用密钥读模型列表失败：${(error as Error)?.message || 'unknown error'}` };
  }
  const unique = Array.from(new Set(
    (models || []).map((name) => String(name || '').trim()).filter(Boolean),
  ));
  if (!unique.length) {
    return { ok: false, reason: '用密钥没读回任何模型（密钥无权限或被盾拦截）' };
  }

  const pricing = await loadSiteModelPricing(site, credential);
  const data: PerfMetricsSummary = {
    summary: null,
    windowStart: null,
    windowEnd: null,
    // 站点连监控接口都没有，吞吐列直接不显示（false），而不是「未知」。
    showThroughput: false,
    models: unique.map((modelName) => ({
      modelName,
      avgLatencyMs: null,
      successRate: null,
      avgTps: null,
      recentSuccess: [],
    })),
  };
  return {
    ok: true,
    result: {
      status: 'models_only',
      message: MODEL_LIST_ONLY_MESSAGE,
      credential,
      data,
      pricing,
    },
  };
}

async function fetchSiteMetrics(
  site: SiteRow,
  preferredKind: string | null,
  preferredId: number | null,
): Promise<SiteMetricsFetchResult> {
  const emptyPricing = new Map<string, ModelMonitorModelPricing>();
  const adapter = getAdapter(String(site.platform || ''));
  if (!adapter) {
    return { status: 'unsupported', message: MODEL_LIST_ONLY_UNAVAILABLE_MESSAGE, credential: null, data: null, pricing: emptyPricing };
  }

  const credentials = await listSiteCredentials(site.id, preferredKind, preferredId);
  if (!credentials.length) {
    return { status: 'error', message: '站点下没有可用凭据（缺少账号或密钥）', credential: null, data: null, pricing: emptyPricing };
  }

  const perfMetrics = adapter.getPerfMetricsSummary?.bind(adapter);

  // 平台压根没有监控接口：直接降级用凭据读模型名。
  if (!perfMetrics) {
    const fallback = await collectModelListFallback(site, adapter, credentials);
    if (fallback.ok) return fallback.result;
    return {
      status: 'unsupported',
      message: `${MODEL_LIST_ONLY_UNAVAILABLE_MESSAGE}；${fallback.reason}`,
      credential: null,
      data: null,
      pricing: emptyPricing,
    };
  }

  let lastMessage = '';
  for (const credential of credentials) {
    const outcome = await withTimeout(
      perfMetrics(site.url, credential.value, credential.platformUserId),
      config.modelMonitorTimeoutMs,
      `读取 ${site.name} 的模型监控`,
    ).catch((error: unknown) => ({
      ok: false as const,
      unsupported: false,
      message: `请求上游失败：${(error as Error)?.message || 'unknown error'}`,
    }));

    if (outcome.ok) {
      // 价目表是可选的附带信息：拿不到就只显示成功率/延迟，不影响这一轮采集。
      const pricing = await loadSiteModelPricing(site, credential);
      return {
        status: outcome.data.models.length ? 'ok' : 'empty',
        message: null,
        credential,
        data: outcome.data,
        pricing,
      };
    }
    lastMessage = outcome.message;
    if (outcome.unsupported) {
      // 站点版本旧是所有凭据的共性问题，不用再逐个试监控接口；
      // 但模型列表可能只有某一份 sk- 密钥能读到，所以换几份凭据试降级。
      const fallback = await collectModelListFallback(site, adapter, credentials);
      if (fallback.ok) return fallback.result;
      return {
        status: 'unsupported',
        message: `${outcome.message}；${fallback.reason}`,
        credential: null,
        data: null,
        pricing: emptyPricing,
      };
    }
  }

  return { status: 'error', message: lastMessage || '读取上游模型监控失败', credential: null, data: null, pricing: emptyPricing };
}

async function persistSiteResult(
  site: SiteRow,
  result: SiteMetricsFetchResult,
  rememberedCredential: { kind: string | null; id: number | null },
): Promise<void> {
  const fetchedAt = new Date().toISOString();
  const data = result.data;
  // 失败时沿用上一轮跑通的那对凭据，下一轮直接命中，不再从头逐个试。
  const credentialKind = result.credential?.kind ?? rememberedCredential.kind ?? null;
  const credentialId = result.credential?.id ?? rememberedCredential.id ?? null;

  await db.transaction(async (tx) => {
    if (data) {
      const keep = new Set(data.models.map((model) => model.modelName));
      const existing = await tx.select({
        id: schema.siteModelMonitorModels.id,
        modelName: schema.siteModelMonitorModels.modelName,
      })
        .from(schema.siteModelMonitorModels)
        .where(eq(schema.siteModelMonitorModels.siteId, site.id))
        .all();
      const staleIds = existing.filter((row) => !keep.has(row.modelName)).map((row) => row.id);
      if (staleIds.length) {
        await tx.delete(schema.siteModelMonitorModels)
          .where(inArray(schema.siteModelMonitorModels.id, staleIds))
          .run();
      }

      for (const model of data.models) {
        const price = result.pricing.get(normalizePricingKey(model.modelName)) ?? null;
        const values = {
          siteId: site.id,
          modelName: model.modelName,
          avgLatencyMs: model.avgLatencyMs,
          successRate: model.successRate,
          avgTps: model.avgTps,
          recentSuccess: serializeRecentSuccess(model.recentSuccess),
          windowStart: data.windowStart,
          windowEnd: data.windowEnd,
          showThroughput: data.showThroughput,
          pricingUnit: price?.unit ?? null,
          inputPrice: price?.inputPrice ?? null,
          outputPrice: price?.outputPrice ?? null,
          fetchedAt,
        };
        await tx.insert(schema.siteModelMonitorModels)
          .values(values)
          .onConflictDoUpdate({
            target: [schema.siteModelMonitorModels.siteId, schema.siteModelMonitorModels.modelName],
            set: {
              avgLatencyMs: values.avgLatencyMs,
              successRate: values.successRate,
              avgTps: values.avgTps,
              recentSuccess: values.recentSuccess,
              windowStart: values.windowStart,
              windowEnd: values.windowEnd,
              showThroughput: values.showThroughput,
              pricingUnit: values.pricingUnit,
              inputPrice: values.inputPrice,
              outputPrice: values.outputPrice,
              fetchedAt: values.fetchedAt,
              updatedAt: sql`(datetime('now'))`,
            },
          })
          .run();
      }
    }

    const siteValues = {
      siteId: site.id,
      status: result.status,
      message: result.message,
      modelsCount: data ? data.models.length : 0,
      credentialKind,
      credentialId,
      showThroughput: data?.showThroughput ?? null,
      summaryAvgLatencyMs: data?.summary?.avgLatencyMs ?? null,
      summarySuccessRate: data?.summary?.successRate ?? null,
      summaryAvgTps: data?.summary?.avgTps ?? null,
      windowStart: data?.windowStart ?? null,
      windowEnd: data?.windowEnd ?? null,
      fetchedAt,
    };
    await tx.insert(schema.siteModelMonitorSites)
      .values(siteValues)
      .onConflictDoUpdate({
        target: schema.siteModelMonitorSites.siteId,
        set: {
          status: siteValues.status,
          message: siteValues.message,
          modelsCount: siteValues.modelsCount,
          credentialKind: siteValues.credentialKind,
          credentialId: siteValues.credentialId,
          showThroughput: siteValues.showThroughput,
          summaryAvgLatencyMs: siteValues.summaryAvgLatencyMs,
          summarySuccessRate: siteValues.summarySuccessRate,
          summaryAvgTps: siteValues.summaryAvgTps,
          windowStart: siteValues.windowStart,
          windowEnd: siteValues.windowEnd,
          fetchedAt: siteValues.fetchedAt,
          updatedAt: sql`(datetime('now'))`,
        },
      })
      .run();
  });
}

async function executeModelMonitorFetch(): Promise<ModelMonitorRunSummary> {
  const startedAtMs = Date.now();
  const sites = await db.select()
    .from(schema.sites)
    .where(eq(schema.sites.status, 'active'))
    .orderBy(asc(schema.sites.id))
    .all();

  const previous: Array<{
    siteId: number;
    status: string;
    fetchedAt: string | null;
    credentialKind: string | null;
    credentialId: number | null;
  }> = await db.select({
    siteId: schema.siteModelMonitorSites.siteId,
    status: schema.siteModelMonitorSites.status,
    fetchedAt: schema.siteModelMonitorSites.fetchedAt,
    credentialKind: schema.siteModelMonitorSites.credentialKind,
    credentialId: schema.siteModelMonitorSites.credentialId,
  }).from(schema.siteModelMonitorSites).all();
  const previousBySite = new Map(previous.map((row) => [row.siteId, row]));

  const summary: ModelMonitorRunSummary = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    scannedSites: 0,
    status: { ok: 0, modelsOnly: 0, empty: 0, unsupported: 0, error: 0 },
    models: 0,
    skippedModelListSites: 0,
    sites: [],
  };

  const now = new Date();
  for (const site of sites) {
    const remembered = previousBySite.get(site.id);
    // 「仅模型列表」站点今天刷新过就跳过：模型列表变化很少，没必要 15 分钟拉一次。
    // 跳过不写库、不清数据，页面继续沿用上一轮结果。
    if (
      remembered?.status === 'models_only'
      && !isModelListDailyRefreshDue(remembered.fetchedAt, now, config.modelMonitorModelListRefreshHour)
    ) {
      summary.skippedModelListSites += 1;
      continue;
    }
    summary.scannedSites += 1;
    let result: Awaited<ReturnType<typeof fetchSiteMetrics>>;
    try {
      result = await fetchSiteMetrics(site, remembered?.credentialKind ?? null, remembered?.credentialId ?? null);
    } catch (error) {
      result = {
        status: 'error',
        message: (error as Error)?.message || 'unknown error',
        credential: null,
        data: null,
        pricing: new Map<string, ModelMonitorModelPricing>(),
      };
    }

    try {
      await persistSiteResult(site, result, {
        kind: remembered?.credentialKind ?? null,
        id: remembered?.credentialId ?? null,
      });
    } catch (error) {
      result = {
        status: 'error',
        message: `写入监控数据失败：${(error as Error)?.message || 'unknown error'}`,
        credential: null,
        data: null,
        pricing: new Map<string, ModelMonitorModelPricing>(),
      };
    }

    // 'models_only' 在计数对象里叫 modelsOnly，别按状态值直接当 key 用。
    if (result.status === 'models_only') summary.status.modelsOnly += 1;
    else summary.status[result.status] += 1;
    if (result.data) summary.models += result.data.models.length;
    summary.sites.push({
      siteId: site.id,
      siteName: site.name,
      platform: String(site.platform || ''),
      status: result.status,
      models: result.data ? result.data.models.length : 0,
      message: result.message,
    });
  }

  if (summary.skippedModelListSites > 0) {
    console.log(
      `[ModelMonitor] skipped ${summary.skippedModelListSites} models-only sites `
      + `(already refreshed after ${config.modelMonitorModelListRefreshHour}:00 today)`,
    );
  }
  summary.finishedAt = new Date().toISOString();
  summary.durationMs = Date.now() - startedAtMs;
  return summary;
}

/**
 * 采集全部活跃站点的模型监控。单飞：同一时刻只有一轮，上一轮没跑完时
 * 再次调用会直接复用那一轮，而不是把请求翻倍。
 */
export function runModelMonitorFetch(): Promise<ModelMonitorRunSummary> {
  if (monitorRunInFlight) return monitorRunInFlight;
  const run = executeModelMonitorFetch().finally(() => {
    monitorRunInFlight = null;
  });
  monitorRunInFlight = run;
  return run;
}

export function getModelMonitorSchedulerState(): ModelMonitorSchedulerState {
  return {
    enabled: config.modelMonitorEnabled,
    intervalMs: config.modelMonitorIntervalMs,
    windowStartHour: config.modelMonitorWindowStartHour,
    windowEndHour: config.modelMonitorWindowEndHour,
    running: isModelMonitorRunning(),
    lastRunStartedAt: monitorLastRunStartedAtIso,
    lastRunFinishedAt: monitorLastRunFinishedAtIso,
    skippedRuns: monitorSkippedRuns,
    nextRunAt: monitorNextRunAtMs === null ? null : new Date(monitorNextRunAtMs).toISOString(),
  };
}

/**
 * 采集调度：窗口内（默认 07:00-23:00）每 `intervalMs`（默认 15 分钟）跑一轮，
 * 单线程、按站点顺序一个个采集（见 executeModelMonitorFetch），同一时刻只有一轮。
 *
 * 与旧实现的区别：
 * - 用显式的「下次可跑时间」代替 `now - 上次开始 < interval` 的隐式判断；
 * - 启动时先读上一轮落库的采集时间：只落后超过一个间隔才补一轮，刚刚采过就等
 *   下一个间隔。否则每次重启都会立刻再全量采一轮（「一进去就采集」）；
 * - 到点发现上一轮还没跑完时，直接跳过这一次（不排队、不并发），并计数 + 打日志；
 * - 每次起跑 / 跑完都打日志，任务有没有活着一眼能从 journalctl 看出来。
 */
export function startModelMonitorScheduler(): ModelMonitorSchedulerState {
  stopModelMonitorScheduler();
  const state = {
    enabled: config.modelMonitorEnabled,
    intervalMs: Math.max(MONITOR_TICK_MS, config.modelMonitorIntervalMs),
    windowStartHour: config.modelMonitorWindowStartHour,
    windowEndHour: config.modelMonitorWindowEndHour,
  };
  monitorNextRunAtMs = null;
  if (!state.enabled) {
    console.log('[Scheduler] Model monitor disabled (MODEL_MONITOR_ENABLED=false)');
    return getModelMonitorSchedulerState();
  }

  const tick = () => {
    // 还没读到上一轮采集时间就什么都别做：这一瞬间开跑正是「重启就采集」。
    if (!monitorSchedulerReady) return;
    const nowMs = Date.now();
    if (!isModelMonitorWindowOpen(new Date(nowMs), state.windowStartHour, state.windowEndHour)) {
      // 窗口外什么都不做；进窗口后的第一次 tick 会立刻补一轮。
      monitorNextRunAtMs = null;
      return;
    }
    if (monitorNextRunAtMs === null) {
      monitorNextRunAtMs = resolveInitialNextRunAtMs(nowMs, state.intervalMs, monitorLastFetchedAtMs);
    }
    if (nowMs < monitorNextRunAtMs) return;
    if (isModelMonitorRunning()) {
      monitorSkippedRuns += 1;
      monitorNextRunAtMs = nowMs + state.intervalMs;
      console.log(`[Scheduler] Model monitor slot skipped: previous run still in flight (skipped=${monitorSkippedRuns})`);
      return;
    }
    monitorNextRunAtMs = nowMs + state.intervalMs;
    monitorLastRunStartedAtMs = nowMs;
    monitorLastRunStartedAtIso = new Date(nowMs).toISOString();
    console.log(`[Scheduler] Model monitor run started at ${monitorLastRunStartedAtIso}`);
    void runModelMonitorFetch()
      .then((summary) => {
        monitorLastRunFinishedAtIso = summary.finishedAt;
        console.log(
          `[Scheduler] Model monitor run complete: ${summary.scannedSites} sites, `
          + `${summary.models} models in ${summary.durationMs}ms `
          + `(ok=${summary.status.ok} modelsOnly=${summary.status.modelsOnly} empty=${summary.status.empty} `
          + `unsupported=${summary.status.unsupported} error=${summary.status.error} `
          + `skipList=${summary.skippedModelListSites})`,
        );
      })
      .catch((error: unknown) => {
        monitorLastRunFinishedAtIso = new Date().toISOString();
        console.error('[Scheduler] Model monitor error:', error);
      });
  };

  // 先占位，让返回的调度状态里「下次采集」不是空的；真正的值等读库回来再定。
  monitorNextRunAtMs = Date.now();
  monitorLastFetchedAtMs = null;
  monitorSchedulerReady = false;
  void loadLastMonitorFetchedAtMs()
    .then((lastFetchedAtMs) => {
      monitorLastFetchedAtMs = lastFetchedAtMs;
      // 上一轮跑完的时间也顺手补上：重启后页面显示的「上次跑完」不该是空的。
      if (lastFetchedAtMs !== null) {
        monitorLastRunFinishedAtIso = new Date(lastFetchedAtMs).toISOString();
      }
    })
    .catch(() => {})
    .finally(() => {
      monitorSchedulerReady = true;
      monitorNextRunAtMs = null;
      tick();
      monitorSchedulerTimer = setInterval(tick, MONITOR_TICK_MS);
      monitorSchedulerTimer.unref?.();
    });
  return getModelMonitorSchedulerState();
}

/**
 * 决定本轮是「现在就跑」还是「等满一个采集间隔」。
 *
 * 只有落后超过一个间隔（或压根没有记录）才立刻补一轮；刚刚采过就让位给下一个
 * 间隔，否则每次重启都会多出一轮毫无必要的全量采集。
 */
function resolveInitialNextRunAtMs(
  nowMs: number,
  intervalMs: number,
  lastFetchedAtMs: number | null,
): number {
  if (
    lastFetchedAtMs !== null
    // 未来时间（时钟回拨 / 假时钟）当成没有记录，不然会一直等下去。
    && lastFetchedAtMs <= nowMs
    && nowMs - lastFetchedAtMs < intervalMs
  ) {
    return lastFetchedAtMs + intervalMs;
  }
  return nowMs;
}

/** 上一轮采集落库的时间：`site_model_monitor_sites.fetched_at` 里最新的那个。 */
async function loadLastMonitorFetchedAtMs(): Promise<number | null> {
  const row = await db
    .select({ fetchedAt: schema.siteModelMonitorSites.fetchedAt })
    .from(schema.siteModelMonitorSites)
    .where(isNotNull(schema.siteModelMonitorSites.fetchedAt))
    .orderBy(desc(schema.siteModelMonitorSites.fetchedAt))
    .limit(1)
    .get();
  const parsed = row?.fetchedAt ? Date.parse(String(row.fetchedAt)) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

export function stopModelMonitorScheduler(): void {
  if (monitorSchedulerTimer) {
    clearInterval(monitorSchedulerTimer);
    monitorSchedulerTimer = null;
  }
}

export function __resetModelMonitorStateForTests(): void {
  stopModelMonitorScheduler();
  monitorRunInFlight = null;
  monitorLastRunStartedAtMs = 0;
  monitorNextRunAtMs = null;
  monitorLastRunStartedAtIso = null;
  monitorLastRunFinishedAtIso = null;
  monitorSkippedRuns = 0;
  modelMonitorPricingLoader = fetchModelPricingCatalog;
}

/**
 * 「对话」用的可固定通道：某站点下、能接这个模型（按路由 pattern 或对外显示名
 * 命中）且启用的通道。返回空数组时页面只提供「自动路由」。
 */
export type ModelMonitorChatChannel = {
  channelId: number;
  routeId: number;
  routeName: string;
  sourceModel: string | null;
  accountName: string;
  /** 通道实际会请求的上游模型名：转发通道用自己的 source_model，否则用路由暴露的名字。 */
  upstreamModel: string;
};

export async function listChatChannelsForSiteModel(
  siteId: number,
  modelName: string,
): Promise<ModelMonitorChatChannel[]> {
  const model = String(modelName || '').trim();
  if (!Number.isFinite(siteId) || siteId <= 0 || !model) return [];

  const rows: Array<{
    channelId: number;
    routeId: number;
    routeModel: string | null;
    routeName: string | null;
    routeMode: string | null;
    channelEnabled: boolean | null;
    sourceModel: string | null;
    accountName: string | null;
    accountTokenName: string | null;
  }> = await db.select({
    channelId: schema.routeChannels.id,
    routeId: schema.tokenRoutes.id,
    routeModel: schema.tokenRoutes.modelPattern,
    routeName: schema.tokenRoutes.displayName,
    routeMode: schema.tokenRoutes.routeMode,
    channelEnabled: schema.routeChannels.enabled,
    sourceModel: schema.routeChannels.sourceModel,
    accountName: schema.accounts.username,
  })
    .from(schema.routeChannels)
    .innerJoin(schema.tokenRoutes, eq(schema.tokenRoutes.id, schema.routeChannels.routeId))
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.routeChannels.accountId))
    .where(and(
      eq(schema.accounts.siteId, siteId),
      eq(schema.routeChannels.enabled, true),
    ))
    .orderBy(asc(schema.routeChannels.priority), asc(schema.routeChannels.id))
    .all();

  const matched = rows.filter((row) => {
    const pattern = String(row.routeModel || '');
    const displayName = String(row.routeName || '').trim();
    // 转发路由的暴露名在 display_name 上（model_pattern 是 forward:<名字>）。
    return matchesModelPattern(model, pattern) || displayName === model;
  });

  return matched.map((row) => ({
    channelId: row.channelId,
    routeId: row.routeId,
    routeName: String(row.routeName || '').trim() || String(row.routeModel || ''),
    sourceModel: row.sourceModel ? String(row.sourceModel) : null,
    accountName: String(row.accountName || '') || `#${row.channelId}`,
    upstreamModel: row.sourceModel ? String(row.sourceModel) : (String(row.routeModel || '').trim() || model),
  }));
}

/**
 * 对话弹窗只做「直连」：固定到这个站点自己的通道，直接打到目标站，不参与网关选路。
 *
 * 注意别被 `model_forward_targets` 影响：对外模型转发是给真实流量用的，
 * 模型监控里的对话要的是「点哪个站的哪个模型，就直连那个站」，所以这里既不给
 * 对外模型名，也不做任何新路由 / 老路由转发。返回的通道仅用于在同一站点的
 * 多个账号之间切换，仍然都是直连。
 */
export type ModelMonitorChatTarget = {
  /** 请求体里的模型名：就是页面上点中的那个模型，用来命中该站点的直连通道。 */
  requestedModel: string;
  /** 可直连的通道（该站点自己的账号）；为空表示这个站点没配可直连的账号。 */
  channels: ModelMonitorChatChannel[];
};

export async function resolveChatTargetForSiteModel(
  siteId: number,
  modelName: string,
): Promise<ModelMonitorChatTarget> {
  const model = String(modelName || '').trim();
  if (!Number.isFinite(siteId) || siteId <= 0 || !model) {
    return { requestedModel: model, channels: [] };
  }
  return { requestedModel: model, channels: await listChatChannelsForSiteModel(siteId, model) };
}

export async function loadModelMonitorOverview(filter: ModelMonitorFilter = {}): Promise<ModelMonitorOverview> {
  // 站点的模型清单要「跟着站点/成功率筛，但不跟着模型名筛」：选中某个模型后
  // 如果清单只剩它自己，下拉里就没法换别的模型了。
  const facetConditions: SQL[] = [];
  const siteId = toNullableNumber(filter.siteId);
  if (siteId !== null && siteId > 0) {
    facetConditions.push(eq(schema.siteModelMonitorModels.siteId, Math.trunc(siteId)));
  }
  const minSuccessRate = toNullableNumber(filter.minSuccessRate);
  if (minSuccessRate !== null) {
    facetConditions.push(gte(schema.siteModelMonitorModels.successRate, minSuccessRate));
  }

  const conditions: SQL[] = [...facetConditions];
  const model = String(filter.model || '').trim();
  if (model) {
    // 页面上的模型是下拉选出来的完整模型名，按精确匹配算，免得选
    // `gpt-5.5` 时把 `gpt-5.5-mini` 也一起带出来。
    conditions.push(eq(schema.siteModelMonitorModels.modelName, model));
  }

  const siteRows: Array<typeof schema.siteModelMonitorSites.$inferSelect> = await db
    .select()
    .from(schema.siteModelMonitorSites)
    .all();

  const modelOptionQuery = db.select({
    modelName: schema.siteModelMonitorModels.modelName,
    siteCount: sql<number>`count(*)`,
  }).from(schema.siteModelMonitorModels);
  const modelOptionRows: Array<{ modelName: string; siteCount: number | string }> = facetConditions.length
    ? await modelOptionQuery
      .where(and(...facetConditions))
      .groupBy(schema.siteModelMonitorModels.modelName)
      .orderBy(asc(schema.siteModelMonitorModels.modelName))
      .all()
    : await modelOptionQuery
      .groupBy(schema.siteModelMonitorModels.modelName)
      .orderBy(asc(schema.siteModelMonitorModels.modelName))
      .all();
  const modelOptions = modelOptionRows.map((row) => ({
    modelName: row.modelName,
    siteCount: Math.trunc(Number(row.siteCount) || 0),
  }));

  const siteNameById = new Map<number, { name: string; url: string; platform: string }>();
  const allSites: Array<{ id: number; name: string; url: string; platform: string }> = await db.select({
    id: schema.sites.id,
    name: schema.sites.name,
    url: schema.sites.url,
    platform: schema.sites.platform,
  }).from(schema.sites).all();
  for (const site of allSites) {
    siteNameById.set(site.id, {
      name: site.name,
      url: String(site.url || ''),
      platform: String(site.platform || ''),
    });
  }

  // 站点状态决定模型行要不要显示指标：'models_only' 的站点这一轮的模型
  // 只有名字，页面对这些行隐藏成功率/延迟/吞吐，避免误以为有采样。
  const metricsAvailableBySite = new Map<number, boolean>();
  for (const row of siteRows) {
    metricsAvailableBySite.set(row.siteId, row.status !== 'models_only');
  }

  const modelQuery = db.select().from(schema.siteModelMonitorModels);
  const modelRows: Array<typeof schema.siteModelMonitorModels.$inferSelect> = conditions.length
    ? await modelQuery.where(and(...conditions)).all()
    : await modelQuery.all();

  const models: ModelMonitorModelView[] = modelRows.map((row) => ({
    siteId: row.siteId,
    siteName: siteNameById.get(row.siteId)?.name || `#${row.siteId}`,
    siteUrl: siteNameById.get(row.siteId)?.url || '',
    platform: siteNameById.get(row.siteId)?.platform || '',
    modelName: row.modelName,
    avgLatencyMs: row.avgLatencyMs,
    successRate: row.successRate,
    avgTps: row.avgTps,
    recentSuccess: parseStoredRecentSuccess(row.recentSuccess),
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    showThroughput: row.showThroughput,
    metricsAvailable: metricsAvailableBySite.get(row.siteId) !== false,
    pricingUnit: row.pricingUnit === 'token' || row.pricingUnit === 'call' ? row.pricingUnit : null,
    inputPrice: row.inputPrice,
    outputPrice: row.outputPrice,
    fetchedAt: row.fetchedAt,
  }));

  const sortKey = String(filter.sort || 'success').trim();
  models.sort((left, right) => {
    if (sortKey === 'latency') {
      return (left.avgLatencyMs ?? Number.MAX_SAFE_INTEGER) - (right.avgLatencyMs ?? Number.MAX_SAFE_INTEGER);
    }
    if (sortKey === 'tps') {
      return (right.avgTps ?? -1) - (left.avgTps ?? -1);
    }
    if (sortKey === 'site') {
      return left.siteName.localeCompare(right.siteName) || left.modelName.localeCompare(right.modelName);
    }
    return (right.successRate ?? -1) - (left.successRate ?? -1) || left.modelName.localeCompare(right.modelName);
  });

  const updatedAt = siteRows.reduce<string | null>((latest, row) => {
    if (!row.fetchedAt) return latest;
    if (!latest || row.fetchedAt > latest) return row.fetchedAt;
    return latest;
  }, null);

  return {
    updatedAt,
    running: isModelMonitorRunning(),
    windowStartHour: config.modelMonitorWindowStartHour,
    windowEndHour: config.modelMonitorWindowEndHour,
    intervalMs: config.modelMonitorIntervalMs,
    modelListRefreshHour: config.modelMonitorModelListRefreshHour,
    scheduler: getModelMonitorSchedulerState(),
    modelOptions,
    sites: siteRows
      .map((row) => ({
        siteId: row.siteId,
        siteName: siteNameById.get(row.siteId)?.name || `#${row.siteId}`,
        url: siteNameById.get(row.siteId)?.url || '',
        platform: siteNameById.get(row.siteId)?.platform || '',
        status: row.status,
        message: row.message,
        modelsCount: row.modelsCount,
        summaryAvgLatencyMs: row.summaryAvgLatencyMs,
        summarySuccessRate: row.summarySuccessRate,
        summaryAvgTps: row.summaryAvgTps,
        fetchedAt: row.fetchedAt,
      }))
      .sort((left, right) => left.siteName.localeCompare(right.siteName)),
    models,
  };
}
