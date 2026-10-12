import { FastifyInstance, type FastifyReply } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { db, schema } from '../../db/index.js';
import * as routeRefreshWorkflow from '../../services/routeRefreshWorkflow.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { appendBackgroundTaskLog, startBackgroundTask } from '../../services/backgroundTaskService.js';
import { parseRouteDecisionSnapshot } from '../../services/routeDecisionSnapshotStore.js';
import {
  listOauthRouteUnitMembersByUnitIds,
  loadOauthRouteUnitSummariesByIds,
} from '../../services/oauth/routeUnitService.js';
import { normalizeTokenRouteMode, type RouteMode } from '../../../shared/tokenRouteContract.js';
import { parseRouteRebuildPayload } from '../../contracts/tokenRoutePayloads.js';
import { isForwardRoutePattern } from '../../services/modelForwardService.js';

function createTokenRouteReadLimiter(keyPrefix: string, points = 60) {
  return new RateLimiterMemory({
    keyPrefix,
    points,
    duration: 60,
  });
}

let routeListReadLimiter = createTokenRouteReadLimiter('token-routes-list-read');

export function resetTokenRouteReadLimitersForTests(options: {
  listPoints?: number;
} = {}): void {
  routeListReadLimiter = createTokenRouteReadLimiter('token-routes-list-read', options.listPoints ?? 60);
}

function sendTokenRouteRateLimit(reply: FastifyReply, error: unknown): void {
  const retryState = error instanceof RateLimiterRes ? error : null;
  const retryAfterSec = Math.max(1, Math.ceil((retryState?.msBeforeNext ?? 60_000) / 1000));
  reply.code(429).header('retry-after', String(retryAfterSec))
    .send({ success: false, message: '请求过于频繁，请稍后再试' });
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};

function normalizeRouteMode(routeMode: unknown): RouteMode {
  return normalizeTokenRouteMode(routeMode);
}

function isExplicitGroupRoute(route: Pick<RouteRow, 'routeMode'> | Pick<typeof schema.tokenRoutes.$inferSelect, 'routeMode'>): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

async function loadRouteSourceIdsMap(routeIds: number[]): Promise<Map<number, number[]>> {
  const normalizedRouteIds = Array.from(new Set(routeIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
  if (normalizedRouteIds.length === 0) return new Map();

  const rows = await db.select().from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.groupRouteId, normalizedRouteIds))
    .all();
  const sourceRouteIdsByRouteId = new Map<number, number[]>();
  for (const row of rows) {
    if (!sourceRouteIdsByRouteId.has(row.groupRouteId)) {
      sourceRouteIdsByRouteId.set(row.groupRouteId, []);
    }
    sourceRouteIdsByRouteId.get(row.groupRouteId)!.push(row.sourceRouteId);
  }
  for (const [routeId, sourceRouteIds] of sourceRouteIdsByRouteId.entries()) {
    sourceRouteIdsByRouteId.set(routeId, Array.from(new Set(sourceRouteIds)));
  }
  return sourceRouteIdsByRouteId;
}

function decorateRoutesWithSources(
  routes: Array<typeof schema.tokenRoutes.$inferSelect>,
  sourceRouteIdsByRouteId: Map<number, number[]>,
): RouteRow[] {
  return routes.map((route) => ({
    ...route,
    routeMode: normalizeRouteMode(route.routeMode),
    sourceRouteIds: sourceRouteIdsByRouteId.get(route.id) ?? [],
  }));
}

async function listRoutesWithSources(): Promise<RouteRow[]> {
  // 「模型转发」规则生成的 token_routes 由 /model-forwarding 页面管理，不在路由页面展示。
  const routes = (await db.select().from(schema.tokenRoutes).all())
    .filter((route) => !isForwardRoutePattern(route.modelPattern));
  const sourceRouteIdsByRouteId = await loadRouteSourceIdsMap(routes.map((route) => route.id));
  return decorateRoutesWithSources(routes, sourceRouteIdsByRouteId);
}

async function fetchChannelsForRouteRows(
  routes: RouteRow[],
  options: {
    includeRouteUnitDetails?: boolean;
  } = {},
): Promise<Map<number, any[]>> {
  if (routes.length === 0) return new Map();
  const includeRouteUnitDetails = options.includeRouteUnitDetails !== false;

  const explicitSourceRouteIds = Array.from(new Set(routes
    .filter((route) => isExplicitGroupRoute(route))
    .flatMap((route) => route.sourceRouteIds)));
  const explicitSourceRoutes = explicitSourceRouteIds.length > 0
    ? (await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, explicitSourceRouteIds))
      .all())
    : [];
  const enabledExplicitSourceRouteIds = explicitSourceRoutes
    .filter((route) => route.enabled && !isExplicitGroupRoute(route) && isExactModelPattern(route.modelPattern))
    .map((route) => route.id);
  const actualRouteIds = Array.from(new Set([
    ...routes.filter((route) => !isExplicitGroupRoute(route)).map((route) => route.id),
    ...enabledExplicitSourceRouteIds,
  ]));
  if (actualRouteIds.length === 0) {
    return new Map(routes.map((route) => [route.id, []]));
  }

  const actualRouteById = new Map<number, { modelPattern: string; routeMode: string | null }>();
  for (const route of routes.filter((item) => !isExplicitGroupRoute(item))) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }
  for (const route of explicitSourceRoutes) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }

  const channelRows = await db.select().from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(inArray(schema.routeChannels.routeId, actualRouteIds))
    .all();

  const oauthRouteUnitIds: number[] = Array.from(new Set<number>(
    channelRows
      .map((row) => Number(row.route_channels.oauthRouteUnitId))
      .filter((id): id is number => Number.isFinite(id) && id > 0),
  ));
  const routeUnitSummaries = includeRouteUnitDetails
    ? await loadOauthRouteUnitSummariesByIds(oauthRouteUnitIds)
    : new Map();
  const routeUnitMembersByUnitId = includeRouteUnitDetails
    ? await listOauthRouteUnitMembersByUnitIds(oauthRouteUnitIds)
    : new Map();

  const channelsByActualRouteId = new Map<number, any[]>();

  for (const row of channelRows) {
    const routeId = row.route_channels.routeId;
    const actualRoute = actualRouteById.get(routeId);
    const fallbackSourceModel = actualRoute && !isExplicitGroupRoute(actualRoute) && isExactModelPattern(actualRoute.modelPattern)
      ? actualRoute.modelPattern
      : null;
    const resolvedSourceModel = (row.route_channels.sourceModel || fallbackSourceModel || '').trim();
    if (!channelsByActualRouteId.has(routeId)) channelsByActualRouteId.set(routeId, []);
    const routeUnit = row.route_channels.oauthRouteUnitId
      ? routeUnitSummaries.get(row.route_channels.oauthRouteUnitId) || null
      : null;
    channelsByActualRouteId.get(routeId)!.push({
      ...row.route_channels,
      sourceModel: resolvedSourceModel || null,
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens
        ? {
          id: row.account_tokens.id,
          name: row.account_tokens.name,
          accountId: row.account_tokens.accountId,
          enabled: row.account_tokens.enabled,
          isDefault: row.account_tokens.isDefault,
        }
        : null,
      routeUnit: includeRouteUnitDetails && routeUnit
        ? {
          id: routeUnit.id,
          name: routeUnit.name,
          strategy: routeUnit.strategy,
          memberCount: routeUnit.memberCount,
          members: (routeUnitMembersByUnitId.get(routeUnit.id) || []).map((member) => ({
            accountId: member.account.id,
            username: member.account.username,
            siteName: member.site.name,
          })),
        }
        : null,
    });
  }

  // API 返回顺序与优先级一致，避免数据库默认行顺序掩盖拖拽后的 P 值。
  for (const channels of channelsByActualRouteId.values()) {
    channels.sort((left, right) => {
      const priorityDiff = (left.priority ?? 0) - (right.priority ?? 0);
      return priorityDiff !== 0 ? priorityDiff : (left.id ?? 0) - (right.id ?? 0);
    });
  }

  const channelsByRoute = new Map<number, any[]>();
  for (const route of routes) {
    if (isExplicitGroupRoute(route)) {
      const channels = route.sourceRouteIds.flatMap((sourceRouteId) => channelsByActualRouteId.get(sourceRouteId) || []);
      channels.sort((left, right) => {
        const priorityDiff = (left.priority ?? 0) - (right.priority ?? 0);
        return priorityDiff !== 0 ? priorityDiff : (left.id ?? 0) - (right.id ?? 0);
      });
      channelsByRoute.set(route.id, channels);
      continue;
    }
    channelsByRoute.set(route.id, channelsByActualRouteId.get(route.id) || []);
  }

  return channelsByRoute;
}

export async function tokensRoutes(app: FastifyInstance) {
  // List routes with basic info only (lightweight for selectors)
  app.get('/api/routes/lite', async () => {
    return (await listRoutesWithSources()).map((route) => ({
      id: route.id,
      modelPattern: route.modelPattern,
      displayName: route.displayName,
      displayIcon: route.displayIcon,
      routeMode: route.routeMode,
      sourceRouteIds: route.sourceRouteIds,
      routingStrategy: route.routingStrategy,
      enabled: route.enabled,
    }));
  });

  // List all routes
  app.get('/api/routes', async (request, reply) => {
    try {
      await routeListReadLimiter.consume(request.ip);
    } catch (error) {
      sendTokenRouteRateLimit(reply, error);
      return;
    }
    const routes = await listRoutesWithSources();
    if (routes.length === 0) return [];

    const channelsByRoute = await fetchChannelsForRouteRows(routes);

    return routes.map((route) => ({
      ...route,
      decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
      decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      channels: channelsByRoute.get(route.id) || [],
    }));
  });

  app.get<{ Querystring: { model?: string } }>('/api/routes/decision', async (request, reply) => {
    const model = (request.query.model || '').trim();
    if (!model) {
      return reply.code(400).send({ success: false, message: 'model 不能为空' });
    }

    const decision = await tokenRouter.explainSelection(model);
    return { success: true, decision };
  });

  // Rebuild routes/channels from model availability.
  app.post<{ Body: unknown }>('/api/routes/rebuild', async (request, reply) => {
    const parsedBody = parseRouteRebuildPayload(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({ success: false, message: parsedBody.error });
    }

    const body = parsedBody.data;
    if (body.refreshModels === false) {
      const rebuild = await routeRefreshWorkflow.rebuildRoutesOnly({ rebuildPatternRoutes: true });
      return { success: true, rebuild };
    }

    if (body.wait) {
      const result = await routeRefreshWorkflow.refreshModelsAndRebuildRoutes({ rebuildPatternRoutes: true });
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'route',
        title: '刷新模型并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '刷新模型并重建路由已完成';
          return `刷新模型并重建路由完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `刷新模型并重建路由失败：${currentTask.error || 'unknown error'}`,
      },
      async () => routeRefreshWorkflow.refreshModelsAndRebuildRoutes({ rebuildPatternRoutes: true }),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '路由重建任务执行中，请稍后查看程序日志'
        : '已开始路由重建，请稍后查看程序日志',
    });
  });
}
