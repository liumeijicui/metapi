import { and, asc, desc, eq, gte, inArray, like, sql, type SQL } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import { isReadyAccountToken } from './accountTokenService.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
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

export type ModelMonitorModelView = {
  siteId: number;
  siteName: string;
  platform: string;
  modelName: string;
  avgLatencyMs: number | null;
  successRate: number | null;
  avgTps: number | null;
  recentSuccess: Array<{ ts: number | null; rate: number }>;
  windowStart: number | null;
  windowEnd: number | null;
  showThroughput: boolean | null;
  fetchedAt: string | null;
};

export type ModelMonitorOverview = {
  updatedAt: string | null;
  running: boolean;
  windowStartHour: number;
  windowEndHour: number;
  intervalMs: number;
  sites: Array<{
    siteId: number;
    siteName: string;
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

async function fetchSiteMetrics(
  site: SiteRow,
  preferredKind: string | null,
  preferredId: number | null,
): Promise<{ status: ModelMonitorSiteStatus; message: string | null; credential: MonitorCredential | null; data: PerfMetricsSummary | null }> {
  const adapter = getAdapter(String(site.platform || ''));
  if (!adapter || typeof adapter.getPerfMetricsSummary !== 'function') {
    return { status: 'unsupported', message: '该平台没有模型监控接口', credential: null, data: null };
  }

  const credentials = await listSiteCredentials(site.id, preferredKind, preferredId);
  if (!credentials.length) {
    return { status: 'error', message: '站点下没有可用凭据（缺少账号或密钥）', credential: null, data: null };
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
      return {
        status: outcome.data.models.length ? 'ok' : 'empty',
        message: null,
        credential,
        data: outcome.data,
      };
    }
    lastMessage = outcome.message;
    if (outcome.unsupported) {
      return { status: 'unsupported', message: outcome.message, credential: null, data: null };
    }
  }

  return { status: 'error', message: lastMessage || '读取上游模型监控失败', credential: null, data: null };
}

async function persistSiteResult(
  site: SiteRow,
  result: { status: ModelMonitorSiteStatus; message: string | null; credential: MonitorCredential | null; data: PerfMetricsSummary | null },
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
}

export async function loadModelMonitorOverview(filter: ModelMonitorFilter = {}): Promise<ModelMonitorOverview> {
  const conditions: SQL[] = [];
  const siteId = toNullableNumber(filter.siteId);
  if (siteId !== null && siteId > 0) {
    conditions.push(eq(schema.siteModelMonitorModels.siteId, Math.trunc(siteId)));
  }
  const model = String(filter.model || '').trim();
  if (model) {
    conditions.push(like(schema.siteModelMonitorModels.modelName, `%${model}%`));
  }
  const minSuccessRate = toNullableNumber(filter.minSuccessRate);
  if (minSuccessRate !== null) {
    conditions.push(gte(schema.siteModelMonitorModels.successRate, minSuccessRate));
  }

  const siteRows: Array<typeof schema.siteModelMonitorSites.$inferSelect> = await db
    .select()
    .from(schema.siteModelMonitorSites)
    .all();
  const siteNameById = new Map<number, { name: string; platform: string }>();
  const allSites: Array<{ id: number; name: string; platform: string }> = await db.select({
    id: schema.sites.id,
    name: schema.sites.name,
    platform: schema.sites.platform,
  }).from(schema.sites).all();
  for (const site of allSites) {
    siteNameById.set(site.id, { name: site.name, platform: String(site.platform || '') });
  }

  const modelQuery = db.select().from(schema.siteModelMonitorModels);
  const modelRows: Array<typeof schema.siteModelMonitorModels.$inferSelect> = conditions.length
    ? await modelQuery.where(and(...conditions)).all()
    : await modelQuery.all();

  const models: ModelMonitorModelView[] = modelRows.map((row) => ({
    siteId: row.siteId,
    siteName: siteNameById.get(row.siteId)?.name || `#${row.siteId}`,
    platform: siteNameById.get(row.siteId)?.platform || '',
    modelName: row.modelName,
    avgLatencyMs: row.avgLatencyMs,
    successRate: row.successRate,
    avgTps: row.avgTps,
    recentSuccess: parseStoredRecentSuccess(row.recentSuccess),
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    showThroughput: row.showThroughput,
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
    sites: siteRows
      .map((row) => ({
        siteId: row.siteId,
        siteName: siteNameById.get(row.siteId)?.name || `#${row.siteId}`,
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
