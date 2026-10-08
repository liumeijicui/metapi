import { FastifyInstance } from "fastify";
import { db, schema } from "../../db/index.js";
import { and, eq, gte, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { refreshModelsForAccount } from "../../services/modelService.js";
import { fetchModelPricingCatalog } from "../../services/modelPricingService.js";
import { buildModelAvailabilityProbeTaskDedupeKey, queueModelAvailabilityProbeTask } from "../../services/modelAvailabilityProbeService.js";
import { getUpstreamModelDescriptionsCached } from "../../services/upstreamModelDescriptionService.js";
import { getRunningTaskByDedupeKey, startBackgroundTask, waitForBackgroundTaskCompletion } from "../../services/backgroundTaskService.js";
import { getProxyLogBaseSelectFields } from "../../services/proxyLogStore.js";
import { requiresManagedAccountTokens } from "../../services/accountExtraConfig.js";
import { ACCOUNT_TOKEN_VALUE_STATUS_READY } from "../../services/accountTokenService.js";
import { formatLocalDateTime, getLocalRangeStartDayKey, getLocalRangeStartUtc, parseStoredUtcDateTime } from "../../services/localTimeService.js";
import { createRateLimitGuard } from "../../middleware/requestRateLimit.js";
import { getDashboardInsightsSnapshot, getDashboardSummarySnapshot } from "../../services/dashboardSnapshotService.js";
import { getSiteStatsSnapshot } from "../../services/siteStatsSnapshotService.js";
import { runUsageAggregationProjectionPass } from "../../services/usageAggregationService.js";
import * as routeRefreshWorkflow from "../../services/routeRefreshWorkflow.js";
import type { StoredUtcDateTimeInput } from "../../services/localTimeService.js";
import type { ModelAvailabilityProbeExecutionResult } from "../../services/modelAvailabilityProbeService.js";
import { proxyLogRoutes } from "./proxyLogRoutes.js";

function parseBooleanFlag(raw?: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeDashboardView(raw?: string) {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "summary" || normalized === "insights") {
    return normalized;
  }
  return "full";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const MODELS_MARKETPLACE_BASE_TTL_MS = 15_000;
const MODELS_MARKETPLACE_PRICING_TTL_MS = 90_000;
const limitModelTokenCandidatesRead = createRateLimitGuard({
  bucket: "models-token-candidates-read",
  max: 30,
  windowMs: 60_000,
});

type ModelsMarketplaceCacheEntry = {
  expiresAt: number;
  models: any[];
};

const modelsMarketplaceCache = new Map<
  "base" | "pricing",
  ModelsMarketplaceCacheEntry
>();

function readModelsMarketplaceCache(includePricing: boolean): any[] | null {
  const key = includePricing ? "pricing" : "base";
  const cached = modelsMarketplaceCache.get(key);
  if (!cached) return null;
  if (Date.now() >= cached.expiresAt) {
    modelsMarketplaceCache.delete(key);
    return null;
  }
  return cached.models;
}

function writeModelsMarketplaceCache(
  includePricing: boolean,
  models: any[],
): void {
  const ttl = includePricing
    ? MODELS_MARKETPLACE_PRICING_TTL_MS
    : MODELS_MARKETPLACE_BASE_TTL_MS;
  const key = includePricing ? "pricing" : "base";
  modelsMarketplaceCache.set(key, {
    expiresAt: Date.now() + ttl,
    models,
  });
}

function proxyCostSqlExpression() {
  return sql<number>`
    coalesce(
      ${schema.proxyLogs.estimatedCost},
      case
        when lower(coalesce(${schema.sites.platform}, 'new-api')) = 'veloera'
          then coalesce(${schema.proxyLogs.totalTokens}, 0) / 1000000.0
        else coalesce(${schema.proxyLogs.totalTokens}, 0) / 500000.0
      end
    )
  `;
}

const SITE_AVAILABILITY_BUCKET_COUNT = 24;
const SITE_AVAILABILITY_BUCKET_MS = 60 * 60 * 1000;

type SiteAvailabilitySiteRow = {
  id: number;
  name: string;
  url: string | null;
  platform: string | null;
  sortOrder: number | null;
  isPinned: boolean | null;
};

type SiteAvailabilityLogRow = {
  siteId: number | null;
  createdAt: StoredUtcDateTimeInput;
  status: string | null;
  latencyMs: number | null;
};

type SiteAvailabilityBucketAccumulator = {
  startUtc: string;
  label: string;
  totalRequests: number;
  successCount: number;
  failedCount: number;
  latencyTotalMs: number;
  latencyCount: number;
};

function roundPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function buildSiteAvailabilitySummaries(
  sites: SiteAvailabilitySiteRow[],
  logs: SiteAvailabilityLogRow[],
  now = new Date(),
) {
  const endLocal = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    0,
    0,
    0,
  );
  const startLocal = new Date(
    endLocal.getTime() -
      (SITE_AVAILABILITY_BUCKET_COUNT - 1) * SITE_AVAILABILITY_BUCKET_MS,
  );
  const startMs = startLocal.getTime();
  const rangeMs = SITE_AVAILABILITY_BUCKET_COUNT * SITE_AVAILABILITY_BUCKET_MS;

  const createBucketTemplate = (): SiteAvailabilityBucketAccumulator[] =>
    Array.from({ length: SITE_AVAILABILITY_BUCKET_COUNT }, (_, index) => {
      const bucketStart = new Date(
        startMs + index * SITE_AVAILABILITY_BUCKET_MS,
      );
      return {
        startUtc: bucketStart.toISOString(),
        label: formatLocalDateTime(bucketStart),
        totalRequests: 0,
        successCount: 0,
        failedCount: 0,
        latencyTotalMs: 0,
        latencyCount: 0,
      };
    });

  const siteMap = new Map<
    number,
    {
      site: SiteAvailabilitySiteRow;
      totalRequests: number;
      successCount: number;
      failedCount: number;
      latencyTotalMs: number;
      latencyCount: number;
      buckets: SiteAvailabilityBucketAccumulator[];
    }
  >();

  for (const site of sites) {
    siteMap.set(site.id, {
      site,
      totalRequests: 0,
      successCount: 0,
      failedCount: 0,
      latencyTotalMs: 0,
      latencyCount: 0,
      buckets: createBucketTemplate(),
    });
  }

  for (const log of logs) {
    if (log.siteId == null) continue;
    const target = siteMap.get(log.siteId);
    if (!target) continue;

    const parsed = parseStoredUtcDateTime(log.createdAt);
    if (!parsed) continue;
    const timestampMs = parsed.getTime();
    const diffMs = timestampMs - startMs;
    if (diffMs < 0 || diffMs >= rangeMs) continue;

    const bucketIndex = Math.floor(diffMs / SITE_AVAILABILITY_BUCKET_MS);
    const bucket = target.buckets[bucketIndex];
    const isSuccess = (log.status || "").trim().toLowerCase() === "success";

    target.totalRequests += 1;
    bucket.totalRequests += 1;
    if (isSuccess) {
      target.successCount += 1;
      bucket.successCount += 1;
    } else {
      target.failedCount += 1;
      bucket.failedCount += 1;
    }

    const latencyMs = Number(log.latencyMs);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      target.latencyTotalMs += latencyMs;
      target.latencyCount += 1;
      bucket.latencyTotalMs += latencyMs;
      bucket.latencyCount += 1;
    }
  }

  return sites.map((site) => {
    const aggregate = siteMap.get(site.id)!;
    return {
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      platform: site.platform,
      totalRequests: aggregate.totalRequests,
      successCount: aggregate.successCount,
      failedCount: aggregate.failedCount,
      availabilityPercent:
        aggregate.totalRequests > 0
          ? roundPercent(
              (aggregate.successCount / aggregate.totalRequests) * 100,
            )
          : null,
      averageLatencyMs:
        aggregate.latencyCount > 0
          ? Math.round(aggregate.latencyTotalMs / aggregate.latencyCount)
          : null,
      buckets: aggregate.buckets.map((bucket) => ({
        startUtc: bucket.startUtc,
        label: bucket.label,
        totalRequests: bucket.totalRequests,
        successCount: bucket.successCount,
        failedCount: bucket.failedCount,
        availabilityPercent:
          bucket.totalRequests > 0
            ? roundPercent((bucket.successCount / bucket.totalRequests) * 100)
            : null,
        averageLatencyMs:
          bucket.latencyCount > 0
            ? Math.round(bucket.latencyTotalMs / bucket.latencyCount)
            : null,
      })),
    };
  });
}


function buildProxyLogModelAnalysisSelectFields() {
  return {
    createdAt: schema.proxyLogs.createdAt,
    modelActual: schema.proxyLogs.modelActual,
    modelRequested: schema.proxyLogs.modelRequested,
    status: schema.proxyLogs.status,
    latencyMs: schema.proxyLogs.latencyMs,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
  };
}

function buildProxyLogSiteTrendSelectFields() {
  return {
    createdAt: schema.proxyLogs.createdAt,
    estimatedCost: schema.proxyLogs.estimatedCost,
    totalTokens: schema.proxyLogs.totalTokens,
  };
}

export async function statsRoutes(app: FastifyInstance) {
  const proxyLogBaseFields = getProxyLogBaseSelectFields();
  const proxyLogModelAnalysisFields = buildProxyLogModelAnalysisSelectFields();
  const proxyLogSiteTrendFields = buildProxyLogSiteTrendSelectFields();

  // 使用日志与调试追踪的只读接口单独一个模块：边缘实例（exe）只注册这一个，
  // 主服务这里照旧按同样的路径挂在 /api/stats/* 下。
  await app.register(proxyLogRoutes);

  app.get<{ Querystring: { refresh?: string; view?: string } }>(
    "/api/stats/dashboard",
    async (request, reply) => {
      const forceRefresh = parseBooleanFlag(request.query.refresh);
      const view = normalizeDashboardView(request.query.view);
      if (view === "summary") {
        const snapshot = await getDashboardSummarySnapshot({ forceRefresh });
        reply.header("x-dashboard-summary-cache", snapshot.cacheStatus);
        return {
          generatedAt: snapshot.generatedAt,
          ...snapshot.payload,
        };
      }
      if (view === "insights") {
        const snapshot = await getDashboardInsightsSnapshot({ forceRefresh });
        reply.header("x-dashboard-insights-cache", snapshot.cacheStatus);
        return {
          generatedAt: snapshot.generatedAt,
          ...snapshot.payload,
        };
      }

      const [summary, insights] = await Promise.all([
        getDashboardSummarySnapshot({ forceRefresh }),
        getDashboardInsightsSnapshot({ forceRefresh }),
      ]);
      reply.header("x-dashboard-summary-cache", summary.cacheStatus);
      reply.header("x-dashboard-insights-cache", insights.cacheStatus);
      return {
        generatedAt: summary.generatedAt,
        ...summary.payload,
        ...insights.payload,
      };
    },
  );

  // Models marketplace - refresh upstream models and aggregate.
  app.get<{ Querystring: { refresh?: string; includePricing?: string } }>(
    "/api/models/marketplace",
    async (request) => {
      const refreshRequested = parseBooleanFlag(request.query.refresh);
      const includePricing = parseBooleanFlag(request.query.includePricing);

      let refreshQueued = false;
      let refreshReused = false;
      let refreshJobId: string | null = null;

      if (refreshRequested) {
        modelsMarketplaceCache.clear();
        const { task, reused } = startBackgroundTask(
          {
            type: "model",
            title: "刷新模型广场数据",
            dedupeKey: "refresh-models-and-rebuild-routes",
            notifyOnFailure: true,
            successMessage: (currentTask) => {
              const rebuild = (currentTask.result as any)?.rebuild;
              if (!rebuild) return "模型广场刷新已完成";
              return `模型广场刷新完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
            },
            failureMessage: (currentTask) =>
              `模型广场刷新失败：${currentTask.error || "unknown error"}`,
          },
          async () => routeRefreshWorkflow.refreshModelsAndRebuildRoutes(),
        );
        refreshQueued = !reused;
        refreshReused = reused;
        refreshJobId = task.id;
      }
      const runningRefreshTask = getRunningTaskByDedupeKey(
        "refresh-models-and-rebuild-routes",
      );
      if (!refreshJobId && runningRefreshTask)
        refreshJobId = runningRefreshTask.id;

      if (!refreshRequested) {
        const cachedModels = readModelsMarketplaceCache(includePricing);
        if (cachedModels) {
          return {
            models: cachedModels,
            meta: {
              refreshRequested,
              refreshQueued,
              refreshReused,
              refreshRunning: !!runningRefreshTask,
              refreshJobId,
              includePricing,
              cacheHit: true,
            },
          };
        }
      }

      const availability = await db
        .select()
        .from(schema.tokenModelAvailability)
        .innerJoin(
          schema.accountTokens,
          eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
        )
        .innerJoin(
          schema.accounts,
          eq(schema.accountTokens.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.tokenModelAvailability.available, true),
            eq(schema.accountTokens.enabled, true),
            eq(
              schema.accountTokens.valueStatus,
              ACCOUNT_TOKEN_VALUE_STATUS_READY,
            ),
            eq(schema.accounts.status, "active"),
            eq(schema.sites.status, "active"),
          ),
        )
        .all();
      const accountAvailability = await db
        .select()
        .from(schema.modelAvailability)
        .innerJoin(
          schema.accounts,
          eq(schema.modelAvailability.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.modelAvailability.available, true),
            eq(schema.accounts.status, "active"),
            eq(schema.sites.status, "active"),
          ),
        )
        .all();

      const last7d = getLocalRangeStartUtc(7);
      const recentLogs = await db
        .select(proxyLogBaseFields)
        .from(schema.proxyLogs)
        .where(gte(schema.proxyLogs.createdAt, last7d))
        .all();

      const modelLogStats: Record<
        string,
        { success: number; total: number; totalLatency: number }
      > = {};
      for (const log of recentLogs) {
        const model = log.modelActual || log.modelRequested || "";
        if (!modelLogStats[model])
          modelLogStats[model] = { success: 0, total: 0, totalLatency: 0 };
        modelLogStats[model].total++;
        if (log.status === "success") modelLogStats[model].success++;
        modelLogStats[model].totalLatency += log.latencyMs || 0;
      }

      type ModelMetadataAggregate = {
        description: string | null;
        tags: Set<string>;
        supportedEndpointTypes: Set<string>;
        pricingSources: Array<{
          siteId: number;
          siteName: string;
          accountId: number;
          username: string | null;
          ownerBy: string | null;
          enableGroups: string[];
          groupPricing: Record<
            string,
            {
              quotaType: number;
              inputPerMillion?: number;
              outputPerMillion?: number;
              perCallInput?: number;
              perCallOutput?: number;
              perCallTotal?: number;
            }
          >;
        }>;
      };

      const modelMetadataMap = new Map<string, ModelMetadataAggregate>();
      if (includePricing) {
        const activeAccountRows = await db
          .select()
          .from(schema.accounts)
          .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .where(
            and(
              eq(schema.accounts.status, "active"),
              eq(schema.sites.status, "active"),
            ),
          )
          .all();

        const metadataResults = await Promise.all(
          activeAccountRows.map(async (row) => {
            const catalog = await fetchModelPricingCatalog({
              site: {
                id: row.sites.id,
                url: row.sites.url,
                platform: row.sites.platform,
              },
              account: {
                id: row.accounts.id,
                accessToken: row.accounts.accessToken,
                apiToken: row.accounts.apiToken,
              },
              modelName: "__metadata__",
              totalTokens: 0,
            });

            return {
              account: row.accounts,
              site: row.sites,
              catalog,
            };
          }),
        );

        for (const result of metadataResults) {
          if (!result.catalog) continue;

          for (const model of result.catalog.models) {
            const key = model.modelName.toLowerCase();
            if (!modelMetadataMap.has(key)) {
              modelMetadataMap.set(key, {
                description: null,
                tags: new Set<string>(),
                supportedEndpointTypes: new Set<string>(),
                pricingSources: [],
              });
            }

            const aggregate = modelMetadataMap.get(key)!;
            if (!aggregate.description && model.modelDescription) {
              aggregate.description = model.modelDescription;
            }

            for (const tag of model.tags) aggregate.tags.add(tag);
            for (const endpointType of model.supportedEndpointTypes) {
              aggregate.supportedEndpointTypes.add(endpointType);
            }

            aggregate.pricingSources.push({
              siteId: result.site.id,
              siteName: result.site.name,
              accountId: result.account.id,
              username: result.account.username,
              ownerBy: model.ownerBy,
              enableGroups: model.enableGroups,
              groupPricing: model.groupPricing,
            });
          }
        }
      }

      const modelMap: Record<
        string,
        {
          name: string;
          accountsById: Map<
            number,
            {
              id: number;
              site: string;
              username: string | null;
              latency: number | null;
              unitCost: number | null;
              balance: number;
              tokens: Array<{ id: number; name: string; isDefault: boolean }>;
            }
          >;
        }
      > = {};

      for (const row of availability) {
        const m = row.token_model_availability;
        const t = row.account_tokens;
        const a = row.accounts;
        const s = row.sites;
        if (
          !m.available ||
          !t.enabled ||
          a.status !== "active" ||
          s.status !== "active"
        )
          continue;

        if (!modelMap[m.modelName]) {
          modelMap[m.modelName] = {
            name: m.modelName,
            accountsById: new Map(),
          };
        }

        const existingAccount = modelMap[m.modelName].accountsById.get(a.id);
        if (!existingAccount) {
          modelMap[m.modelName].accountsById.set(a.id, {
            id: a.id,
            site: s.name,
            username: a.username,
            latency: m.latencyMs,
            unitCost: a.unitCost,
            balance: a.balance || 0,
            tokens: [{ id: t.id, name: t.name, isDefault: !!t.isDefault }],
          });
        } else {
          const nextLatency = (() => {
            if (existingAccount.latency == null) return m.latencyMs;
            if (m.latencyMs == null) return existingAccount.latency;
            return Math.min(existingAccount.latency, m.latencyMs);
          })();
          existingAccount.latency = nextLatency;
          if (!existingAccount.tokens.some((token) => token.id === t.id)) {
            existingAccount.tokens.push({
              id: t.id,
              name: t.name,
              isDefault: !!t.isDefault,
            });
          }
        }
      }

      for (const row of accountAvailability) {
        const m = row.model_availability;
        const a = row.accounts;
        const s = row.sites;
        if (!m.available || a.status !== "active" || s.status !== "active")
          continue;

        if (!modelMap[m.modelName]) {
          modelMap[m.modelName] = {
            name: m.modelName,
            accountsById: new Map(),
          };
        }

        const existingAccount = modelMap[m.modelName].accountsById.get(a.id);
        if (!existingAccount) {
          modelMap[m.modelName].accountsById.set(a.id, {
            id: a.id,
            site: s.name,
            username: a.username,
            latency: m.latencyMs,
            unitCost: a.unitCost,
            balance: a.balance || 0,
            tokens: [],
          });
          continue;
        }

        const nextLatency = (() => {
          if (existingAccount.latency == null) return m.latencyMs;
          if (m.latencyMs == null) return existingAccount.latency;
          return Math.min(existingAccount.latency, m.latencyMs);
        })();
        existingAccount.latency = nextLatency;
      }

      let upstreamDescriptionMap = new Map<string, string>();
      if (includePricing) {
        const hasMissingDescription = Object.keys(modelMap).some(
          (modelName) => {
            const metadata = modelMetadataMap.get(modelName.toLowerCase());
            return !metadata?.description;
          },
        );
        if (hasMissingDescription) {
          upstreamDescriptionMap = await getUpstreamModelDescriptionsCached();
        }
      }

      const models = Object.values(modelMap).map((m) => {
        const logStats = modelLogStats[m.name];
        const accounts = Array.from(m.accountsById.values());
        const avgLatency =
          accounts.reduce((sum, a) => sum + (a.latency || 0), 0) /
          (accounts.length || 1);
        const metadata = modelMetadataMap.get(m.name.toLowerCase());
        const fallbackDescription = metadata?.description
          ? null
          : upstreamDescriptionMap.get(m.name.toLowerCase()) || null;
        return {
          name: m.name,
          accountCount: accounts.length,
          tokenCount: accounts.reduce(
            (sum, account) => sum + account.tokens.length,
            0,
          ),
          avgLatency: Math.round(avgLatency),
          successRate: logStats
            ? Math.round((logStats.success / logStats.total) * 1000) / 10
            : null,
          description: metadata?.description || fallbackDescription,
          tags: metadata
            ? Array.from(metadata.tags).sort((a, b) => a.localeCompare(b))
            : [],
          supportedEndpointTypes: metadata
            ? Array.from(metadata.supportedEndpointTypes).sort((a, b) =>
                a.localeCompare(b),
              )
            : [],
          pricingSources: metadata?.pricingSources || [],
          accounts,
        };
      });

      models.sort((a, b) => b.accountCount - a.accountCount);
      writeModelsMarketplaceCache(includePricing, models);
      return {
        models,
        meta: {
          refreshRequested,
          refreshQueued,
          refreshReused,
          refreshRunning: !!runningRefreshTask,
          refreshJobId,
          includePricing,
        },
      };
    },
  );

  app.get(
    "/api/models/token-candidates",
    { preHandler: [limitModelTokenCandidatesRead] },
    async () => {
      const resolveTokenGroupLabel = (
        tokenGroup: string | null,
        tokenName: string | null,
      ): string | null => {
        const explicit = (tokenGroup || "").trim();
        if (explicit) return explicit;

        const name = (tokenName || "").trim();
        if (!name) return null;
        const normalized = name.toLowerCase();
        if (
          normalized === "default" ||
          normalized === "默认" ||
          /^default($|[-_\s])/.test(normalized)
        ) {
          return "default";
        }
        if (/^token-\d+$/.test(normalized)) return null;
        return name;
      };

      // Load global allowed models whitelist
      const globalAllowedModels = new Set(
        config.globalAllowedModels
          .map((m) => m.toLowerCase().trim())
          .filter(Boolean),
      );

      const rows = await db
        .select()
        .from(schema.tokenModelAvailability)
        .innerJoin(
          schema.accountTokens,
          eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id),
        )
        .innerJoin(
          schema.accounts,
          eq(schema.accountTokens.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.tokenModelAvailability.available, true),
            eq(schema.accountTokens.enabled, true),
            eq(
              schema.accountTokens.valueStatus,
              ACCOUNT_TOKEN_VALUE_STATUS_READY,
            ),
            eq(schema.accounts.status, "active"),
            eq(schema.sites.status, "active"),
          ),
        )
        .all();
      const availableModelRows = await db
        .select({
          modelName: schema.modelAvailability.modelName,
          accountId: schema.accounts.id,
          username: schema.accounts.username,
          siteId: schema.sites.id,
          siteName: schema.sites.name,
          accessToken: schema.accounts.accessToken,
          apiToken: schema.accounts.apiToken,
          extraConfig: schema.accounts.extraConfig,
        })
        .from(schema.modelAvailability)
        .innerJoin(
          schema.accounts,
          eq(schema.modelAvailability.accountId, schema.accounts.id),
        )
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(
          and(
            eq(schema.modelAvailability.available, true),
            eq(schema.accounts.status, "active"),
            eq(schema.sites.status, "active"),
          ),
        )
        .all();

      const result: Record<
        string,
        Array<{
          accountId: number;
          tokenId: number;
          tokenName: string;
          isDefault: boolean;
          username: string | null;
          siteId: number;
          siteName: string;
        }>
      > = {};
      const coveredAccountModelSet = new Set<string>();
      const coveredGroupsByAccountModel = new Map<
        string,
        Map<string, string>
      >();
      const unknownGroupCoverageByAccountModel = new Set<string>();
      const modelsWithoutToken: Record<
        string,
        Array<{
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
        }>
      > = {};
      const modelsMissingTokenGroups: Record<
        string,
        Array<{
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
          missingGroups: string[];
          requiredGroups: string[];
          availableGroups: string[];
          groupCoverageUncertain?: boolean;
        }>
      > = {};
      let hasAnyTokenGroupSignals = false;

      for (const row of rows) {
        const modelName = (row.token_model_availability.modelName || "").trim();
        if (!modelName) continue;
        const accountModelKey = `${row.accounts.id}::${modelName.toLowerCase()}`;
        coveredAccountModelSet.add(accountModelKey);

        const resolvedTokenGroup = resolveTokenGroupLabel(
          row.account_tokens.tokenGroup,
          row.account_tokens.name,
        );
        if (resolvedTokenGroup) {
          hasAnyTokenGroupSignals = true;
          if (!coveredGroupsByAccountModel.has(accountModelKey)) {
            coveredGroupsByAccountModel.set(
              accountModelKey,
              new Map<string, string>(),
            );
          }
          const groupKey = resolvedTokenGroup.toLowerCase();
          if (
            !coveredGroupsByAccountModel.get(accountModelKey)!.has(groupKey)
          ) {
            coveredGroupsByAccountModel
              .get(accountModelKey)!
              .set(groupKey, resolvedTokenGroup);
          }
        } else {
          unknownGroupCoverageByAccountModel.add(accountModelKey);
        }

        if (!result[modelName]) result[modelName] = [];
        if (
          result[modelName].some(
            (item) => item.tokenId === row.account_tokens.id,
          )
        )
          continue;
        result[modelName].push({
          accountId: row.accounts.id,
          tokenId: row.account_tokens.id,
          tokenName: row.account_tokens.name,
          isDefault: !!row.account_tokens.isDefault,
          username: row.accounts.username,
          siteId: row.sites.id,
          siteName: row.sites.name,
        });
      }

      for (const row of availableModelRows) {
        if (!requiresManagedAccountTokens(row)) continue;
        const modelName = (row.modelName || "").trim();
        if (!modelName) continue;
        const coverageKey = `${row.accountId}::${modelName.toLowerCase()}`;
        if (coveredAccountModelSet.has(coverageKey)) continue;
        if (!modelsWithoutToken[modelName]) modelsWithoutToken[modelName] = [];
        if (
          modelsWithoutToken[modelName].some(
            (item) => item.accountId === row.accountId,
          )
        )
          continue;
        modelsWithoutToken[modelName].push({
          accountId: row.accountId,
          username: row.username,
          siteId: row.siteId,
          siteName: row.siteName,
        });
      }

      const accountIdsForGroupHints = new Set(
        availableModelRows
          .filter((row) => requiresManagedAccountTokens(row))
          .map((row) => row.accountId),
      );
      const requiredGroupsByAccountModel = new Map<
        string,
        Map<string, string>
      >();
      const hasPotentialGroupHints =
        hasAnyTokenGroupSignals || unknownGroupCoverageByAccountModel.size > 0;

      if (hasPotentialGroupHints && accountIdsForGroupHints.size > 0) {
        const accountRows = await db
          .select()
          .from(schema.accounts)
          .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .where(
            and(
              eq(schema.accounts.status, "active"),
              eq(schema.sites.status, "active"),
            ),
          )
          .all();

        const metadataResults = await Promise.all(
          accountRows
            .filter((row) => accountIdsForGroupHints.has(row.accounts.id))
            .map(async (row) => {
              try {
                const catalog = await fetchModelPricingCatalog({
                  site: {
                    id: row.sites.id,
                    url: row.sites.url,
                    platform: row.sites.platform,
                  },
                  account: {
                    id: row.accounts.id,
                    accessToken: row.accounts.accessToken,
                    apiToken: row.accounts.apiToken,
                  },
                  modelName: "__metadata__",
                  totalTokens: 0,
                });
                return { accountId: row.accounts.id, catalog };
              } catch {
                return {
                  accountId: row.accounts.id,
                  catalog: null as Awaited<
                    ReturnType<typeof fetchModelPricingCatalog>
                  >,
                };
              }
            }),
        );

        for (const result of metadataResults) {
          if (!result.catalog) continue;
          for (const model of result.catalog.models) {
            const modelName = (model.modelName || "").trim();
            if (!modelName) continue;
            const groups = new Map<string, string>();
            for (const rawGroup of model.enableGroups || []) {
              const group = String(rawGroup || "").trim();
              if (!group) continue;
              const groupKey = group.toLowerCase();
              if (!groups.has(groupKey)) groups.set(groupKey, group);
            }
            if (groups.size === 0) continue;
            requiredGroupsByAccountModel.set(
              `${result.accountId}::${modelName.toLowerCase()}`,
              groups,
            );
          }
        }
      }

      for (const row of availableModelRows) {
        if (!requiresManagedAccountTokens(row)) continue;
        const modelName = (row.modelName || "").trim();
        if (!modelName) continue;
        const accountModelKey = `${row.accountId}::${modelName.toLowerCase()}`;

        const requiredGroups =
          requiredGroupsByAccountModel.get(accountModelKey);
        if (!requiredGroups || requiredGroups.size === 0) continue;

        const availableGroups =
          coveredGroupsByAccountModel.get(accountModelKey) ||
          new Map<string, string>();
        const missingGroups = Array.from(requiredGroups.entries())
          .filter(([groupKey]) => !availableGroups.has(groupKey))
          .map(([, label]) => label);
        if (missingGroups.length === 0) continue;

        if (!modelsMissingTokenGroups[modelName])
          modelsMissingTokenGroups[modelName] = [];
        if (
          modelsMissingTokenGroups[modelName].some(
            (item) => item.accountId === row.accountId,
          )
        )
          continue;
        const hintRow = {
          accountId: row.accountId,
          username: row.username,
          siteId: row.siteId,
          siteName: row.siteName,
          missingGroups: missingGroups.sort((a, b) => a.localeCompare(b)),
          requiredGroups: Array.from(requiredGroups.values()).sort((a, b) =>
            a.localeCompare(b),
          ),
          availableGroups: Array.from(availableGroups.values()).sort((a, b) =>
            a.localeCompare(b),
          ),
        } as {
          accountId: number;
          username: string | null;
          siteId: number;
          siteName: string;
          missingGroups: string[];
          requiredGroups: string[];
          availableGroups: string[];
          groupCoverageUncertain?: boolean;
        };
        if (unknownGroupCoverageByAccountModel.has(accountModelKey)) {
          hintRow.groupCoverageUncertain = true;
        }
        modelsMissingTokenGroups[modelName].push(hintRow);
      }

      const endpointTypesByModel: Record<string, string[]> = {};
      const cachedPricing = readModelsMarketplaceCache(true);
      const cachedBase = cachedPricing || readModelsMarketplaceCache(false);
      if (cachedBase) {
        for (const model of cachedBase) {
          if (
            Array.isArray(model.supportedEndpointTypes) &&
            model.supportedEndpointTypes.length > 0
          ) {
            endpointTypesByModel[model.name] = model.supportedEndpointTypes;
          }
        }
      }

      // Apply model whitelist filter if configured
      const filteredResult: typeof result = {};
      const filteredModelsWithoutToken: typeof modelsWithoutToken = {};
      const filteredModelsMissingTokenGroups: typeof modelsMissingTokenGroups =
        {};

      if (globalAllowedModels.size > 0) {
        // Filter result
        for (const [modelName, candidates] of Object.entries(result)) {
          if (globalAllowedModels.has(modelName.toLowerCase().trim())) {
            filteredResult[modelName] = candidates;
          }
        }
        // Filter modelsWithoutToken
        for (const [modelName, accounts] of Object.entries(
          modelsWithoutToken,
        )) {
          if (globalAllowedModels.has(modelName.toLowerCase().trim())) {
            filteredModelsWithoutToken[modelName] = accounts;
          }
        }
        // Filter modelsMissingTokenGroups
        for (const [modelName, accounts] of Object.entries(
          modelsMissingTokenGroups,
        )) {
          if (globalAllowedModels.has(modelName.toLowerCase().trim())) {
            filteredModelsMissingTokenGroups[modelName] = accounts;
          }
        }
      } else {
        // No whitelist configured, return all models (backward compatible)
        Object.assign(filteredResult, result);
        Object.assign(filteredModelsWithoutToken, modelsWithoutToken);
        Object.assign(
          filteredModelsMissingTokenGroups,
          modelsMissingTokenGroups,
        );
      }

      return {
        models: filteredResult,
        modelsWithoutToken: filteredModelsWithoutToken,
        modelsMissingTokenGroups: filteredModelsMissingTokenGroups,
        endpointTypesByModel,
      };
    },
  );

  // Refresh models for one account and rebuild routes.
  app.post<{ Params: { accountId: string } }>(
    "/api/models/check/:accountId",
    async (request) => {
      const accountId = Number.parseInt(request.params.accountId, 10);
      if (Number.isNaN(accountId)) {
        return { success: false, error: "Invalid account id" };
      }

      const refresh = await refreshModelsForAccount(accountId);
      const rebuild = await routeRefreshWorkflow.rebuildRoutesOnly();
      return { success: true, refresh, rebuild };
    },
  );

  app.post<{ Body?: { accountId?: number; wait?: boolean } }>(
    "/api/models/probe",
    async (request, reply) => {
      const requestBody = request.body;
      if (requestBody !== undefined && !isRecord(requestBody)) {
        return reply
          .code(400)
          .send({ success: false, message: "请求体必须是对象" });
      }

      const rawAccountId = requestBody?.accountId as unknown;
      const normalizedAccountId =
        rawAccountId === undefined || rawAccountId === null
          ? ""
          : String(rawAccountId).trim();
      const hasAccountId = normalizedAccountId !== "";
      const parsedAccountId =
        hasAccountId && /^[1-9]\d*$/.test(normalizedAccountId)
          ? Number(normalizedAccountId)
          : undefined;
      const accountId =
        parsedAccountId !== undefined && Number.isSafeInteger(parsedAccountId)
          ? parsedAccountId
          : undefined;
      const wait = requestBody?.wait === true;

      if (hasAccountId && accountId === undefined) {
        return reply
          .code(400)
          .send({ success: false, message: "账号 ID 无效" });
      }

      if (wait) {
        const taskTitle = accountId
          ? `探测模型可用性 #${accountId}`
          : "探测全部模型可用性";
        const dedupeKey = buildModelAvailabilityProbeTaskDedupeKey(accountId);
        const runningTask = getRunningTaskByDedupeKey(dedupeKey);
        const { task, reused } = runningTask
          ? { task: runningTask, reused: true }
          : queueModelAvailabilityProbeTask({
              accountId,
              title: taskTitle,
            });
        const completedTask = await waitForBackgroundTaskCompletion(task.id);
        if (!completedTask) {
          return reply
            .code(500)
            .send({
              success: false,
              message: "模型可用性探测任务不存在或已过期",
            });
        }
        if (completedTask.status === "failed") {
          return reply.code(500).send({
            success: false,
            reused,
            jobId: completedTask.id,
            status: completedTask.status,
            message: completedTask.error || "模型可用性探测失败",
          });
        }
        const result =
          completedTask.result as ModelAvailabilityProbeExecutionResult | null;
        if (!result) {
          return reply.code(500).send({
            success: false,
            reused,
            jobId: completedTask.id,
            status: completedTask.status,
            message: "模型可用性探测结果为空",
          });
        }
        if (accountId && result.summary.totalAccounts === 0) {
          return reply
            .code(404)
            .send({ success: false, message: "账号不存在" });
        }
        return {
          success: true,
          reused,
          jobId: completedTask.id,
          status: completedTask.status,
          ...result,
        };
      }

      const taskTitle = accountId
        ? `探测模型可用性 #${accountId}`
        : "探测全部模型可用性";
      const { task, reused } = queueModelAvailabilityProbeTask({
        accountId,
        title: taskTitle,
      });

      return reply.code(202).send({
        success: true,
        queued: true,
        reused,
        jobId: task.id,
        status: task.status,
        message: reused
          ? "模型可用性探测任务进行中，请稍后查看任务列表"
          : "已开始模型可用性探测，请稍后查看任务列表",
      });
    },
  );

  // Site distribution – per-site aggregate data
  app.get<{ Querystring: { days?: string; refresh?: string } }>(
    "/api/stats/site-distribution",
    async (request) => {
      const snapshot = await getSiteStatsSnapshot({
        days: request.query.days ? parseInt(request.query.days, 10) : 7,
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      return { distribution: snapshot.payload.distribution };
    },
  );

  // Site trend – daily spend/calls broken down by site
  app.get<{ Querystring: { days?: string; refresh?: string } }>(
    "/api/stats/site-trend",
    async (request) => {
      const snapshot = await getSiteStatsSnapshot({
        days: request.query.days ? parseInt(request.query.days, 10) : 7,
        forceRefresh: parseBooleanFlag(request.query.refresh),
      });
      return { trend: snapshot.payload.trend };
    },
  );

  // Model stats by site
  app.get<{ Querystring: { siteId?: string; days?: string } }>(
    "/api/stats/model-by-site",
    async (request) => {
      const siteId = request.query.siteId
        ? parseInt(request.query.siteId, 10)
        : null;
      const days = Math.max(1, parseInt(request.query.days || "7", 10));
      await runUsageAggregationProjectionPass();
      const sinceDay = getLocalRangeStartDayKey(days);
      const rows = siteId != null && Number.isFinite(siteId)
        ? await db
            .select()
            .from(schema.modelDayUsage)
            .where(
              and(
                gte(schema.modelDayUsage.localDay, sinceDay),
                eq(schema.modelDayUsage.siteId, siteId),
              ),
            )
            .all()
        : await db
            .select()
            .from(schema.modelDayUsage)
            .where(gte(schema.modelDayUsage.localDay, sinceDay))
            .all();

      const modelMap: Record<
        string,
        { calls: number; spend: number; tokens: number }
      > = {};

      for (const row of rows) {
        const model = row.model || "unknown";

        if (!modelMap[model])
          modelMap[model] = { calls: 0, spend: 0, tokens: 0 };
        modelMap[model].calls += Number(row.totalCalls || 0);
        modelMap[model].tokens += Number(row.totalTokens || 0);
        modelMap[model].spend += Number(row.totalSpend || 0);
      }

      const models = Object.entries(modelMap)
        .map(([model, stats]) => ({
          model,
          calls: stats.calls,
          spend: Math.round(stats.spend * 1_000_000) / 1_000_000,
          tokens: stats.tokens,
        }))
        .sort((a, b) => b.calls - a.calls);

      return { models };
    },
  );
}
