import { and, asc, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import { isReadyAccountToken } from './accountTokenService.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { fetchModelPricingCatalog, type ModelPricingCatalogInput } from './modelPricingService.js';
import type { PerfMetricsSummary } from './platforms/base.js';

export type ModelMonitorSiteStatus = 'ok' | 'empty' | 'unsupported' | 'error';

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
    empty: number;
    unsupported: number;
    error: number;
  };
  models: number;
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

async function fetchSiteMetrics(
  site: SiteRow,
  preferredKind: string | null,
  preferredId: number | null,
): Promise<SiteMetricsFetchResult> {
  const emptyPricing = new Map<string, ModelMonitorModelPricing>();
  const adapter = getAdapter(String(site.platform || ''));
  if (!adapter || typeof adapter.getPerfMetricsSummary !== 'function') {
    return { status: 'unsupported', message: '该平台没有模型监控接口', credential: null, data: null, pricing: emptyPricing };
  }

  const credentials = await listSiteCredentials(site.id, preferredKind, preferredId);
  if (!credentials.length) {
    return { status: 'error', message: '站点下没有可用凭据（缺少账号或密钥）', credential: null, data: null, pricing: emptyPricing };
  }

  let lastMessage = '';
  for (const credential of credentials) {
    const outcome = await withTimeout(
      adapter.getPerfMetricsSummary(site.url, credential.value, credential.platformUserId),
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
      return { status: 'unsupported', message: outcome.message, credential: null, data: null, pricing: emptyPricing };
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
    credentialKind: string | null;
    credentialId: number | null;
  }> = await db.select({
    siteId: schema.siteModelMonitorSites.siteId,
    credentialKind: schema.siteModelMonitorSites.credentialKind,
    credentialId: schema.siteModelMonitorSites.credentialId,
  }).from(schema.siteModelMonitorSites).all();
  const previousBySite = new Map(previous.map((row) => [row.siteId, row]));

  const summary: ModelMonitorRunSummary = {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(startedAtMs).toISOString(),
    durationMs: 0,
    scannedSites: 0,
    status: { ok: 0, empty: 0, unsupported: 0, error: 0 },
    models: 0,
    sites: [],
  };

  for (const site of sites) {
    summary.scannedSites += 1;
    const remembered = previousBySite.get(site.id);
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

    summary.status[result.status] += 1;
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

export function startModelMonitorScheduler(): {
  enabled: boolean;
  intervalMs: number;
  windowStartHour: number;
  windowEndHour: number;
} {
  stopModelMonitorScheduler();
  const state = {
    enabled: config.modelMonitorEnabled,
    intervalMs: config.modelMonitorIntervalMs,
    windowStartHour: config.modelMonitorWindowStartHour,
    windowEndHour: config.modelMonitorWindowEndHour,
  };
  if (!state.enabled) return state;

  monitorLastRunStartedAtMs = 0;
  monitorSchedulerTimer = setInterval(() => {
    if (isModelMonitorRunning()) return;
    const now = new Date();
    if (!isModelMonitorWindowOpen(now, state.windowStartHour, state.windowEndHour)) return;
    if (Date.now() - monitorLastRunStartedAtMs < state.intervalMs) return;
    monitorLastRunStartedAtMs = Date.now();
    void runModelMonitorFetch().catch((error: unknown) => {
      console.error('[Scheduler] Model monitor error:', error);
    });
  }, MONITOR_TICK_MS);
  monitorSchedulerTimer.unref?.();
  return state;
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
  modelMonitorPricingLoader = fetchModelPricingCatalog;
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
