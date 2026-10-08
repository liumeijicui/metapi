import { db, schema } from "../../db/index.js";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { parseProxyLogBillingDetails, withProxyLogSelectFields } from "../../services/proxyLogStore.js";
import { getProxyDebugTraceDetail, listProxyDebugTraces } from "../../services/proxyDebugTraceStore.js";
import { parseProxyLogMessageMeta } from "../../services/proxyLogMessage.js";
import { isForwardRoutePattern } from "../../services/modelForwardService.js";
import { formatUtcSqlDateTime } from "../../services/localTimeService.js";
import { FastifyInstance } from "fastify";

function normalizeProxyLogsView(raw?: string) {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "query" || normalized === "meta") {
    return normalized;
  }
  return "full";
}


type ProxyLogStatusFilter = "all" | "success" | "failed";
type ProxyLogClientFilter = {
  kind: "app" | "family";
  value: string;
} | null;

type ProxyLogClientOption = {
  value: string;
  label: string;
};

const PROXY_LOG_CLIENT_FAMILY_LABELS: Record<string, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  gemini_cli: "Gemini CLI",
  generic: "通用",
};

function normalizeProxyLogPageSize(raw?: string): number {
  const parsed = Number.parseInt(raw || "50", 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.max(1, Math.min(100, parsed));
}

function normalizeProxyLogOffset(raw?: string): number {
  const parsed = Number.parseInt(raw || "0", 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function normalizeProxyLogStatusFilter(raw?: string): ProxyLogStatusFilter {
  const normalized = (raw || "").trim().toLowerCase();
  if (normalized === "success") return "success";
  if (normalized === "failed") return "failed";
  return "all";
}

function normalizeProxyLogSearch(raw?: string): string {
  return (raw || "").trim().toLowerCase();
}

function normalizeProxyLogSiteId(raw?: string): number | null {
  const parsed = Number.parseInt(raw || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeProxyLogClientFilter(raw?: string): ProxyLogClientFilter {
  const text = (raw || "").trim();
  if (!text) return null;
  const separatorIndex = text.indexOf(":");
  if (separatorIndex <= 0) return null;
  const kind = text.slice(0, separatorIndex).trim().toLowerCase();
  const value = text
    .slice(separatorIndex + 1)
    .trim()
    .toLowerCase();
  if (!value) return null;
  if (kind === "app" || kind === "family") {
    return { kind, value };
  }
  return null;
}

function normalizeProxyLogTimeBoundary(raw?: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatUtcSqlDateTime(parsed);
}

function parseDownstreamKeyTags(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of parsed) {
      const text = String(value || "").trim();
      if (!text) continue;
      const dedupeKey = text.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      result.push(text);
    }
    return result;
  } catch {
    return [];
  }
}

function buildProxyLogSearchCondition(search: string) {
  if (!search) return null;
  const likeTerm = `%${search}%`;
  return sql<boolean>`(
    lower(coalesce(${schema.proxyLogs.modelRequested}, '')) like ${likeTerm}
    or lower(coalesce(${schema.proxyLogs.modelActual}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.name}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.groupName}, '')) like ${likeTerm}
    or lower(coalesce(${schema.downstreamApiKeys.tags}, '')) like ${likeTerm}
  )`;
}

function buildProxyLogStatusCondition(status: ProxyLogStatusFilter) {
  if (status === "success") {
    return eq(schema.proxyLogs.status, "success");
  }
  if (status === "failed") {
    return sql<boolean>`coalesce(${schema.proxyLogs.status}, '') <> 'success'`;
  }
  return null;
}

function buildProxyLogClientCondition(client: ProxyLogClientFilter) {
  if (!client) return null;
  if (client.kind === "app") {
    return eq(schema.proxyLogs.clientAppId, client.value);
  }
  return eq(schema.proxyLogs.clientFamily, client.value);
}

function buildProxyLogWhereClause(params: {
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: ProxyLogClientFilter;
  siteId?: number | null;
  fromUtc?: string | null;
  toUtc?: string | null;
}) {
  const conditions = [
    params.status ? buildProxyLogStatusCondition(params.status) : null,
    params.search ? buildProxyLogSearchCondition(params.search) : null,
    params.client ? buildProxyLogClientCondition(params.client) : null,
    params.siteId ? eq(schema.sites.id, params.siteId) : null,
    params.fromUtc ? gte(schema.proxyLogs.createdAt, params.fromUtc) : null,
    params.toUtc ? lt(schema.proxyLogs.createdAt, params.toUtc) : null,
  ].filter(
    (condition): condition is NonNullable<typeof condition> =>
      condition !== null,
  );

  if (conditions.length === 0) return undefined;
  return conditions.length === 1 ? conditions[0] : and(...conditions);
}

function toRoundedMicroNumber(value: number | null | undefined): number {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function normalizeNullableText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeClientConfidence(value: unknown): string | null {
  const normalized = normalizeNullableText(value)?.toLowerCase() || null;
  if (
    normalized === "exact" ||
    normalized === "heuristic" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return null;
}

function displayProxyLogClientFamily(value: string | null): string | null {
  if (!value) return null;
  return PROXY_LOG_CLIENT_FAMILY_LABELS[value] || value;
}

function resolveProxyLogClientMeta(proxyLog: Record<string, unknown>) {
  const clientFamily =
    normalizeNullableText(proxyLog.clientFamily)?.toLowerCase() || null;
  const clientAppId =
    normalizeNullableText(proxyLog.clientAppId)?.toLowerCase() || null;
  const clientAppName = normalizeNullableText(proxyLog.clientAppName) || null;
  const clientConfidence = normalizeClientConfidence(proxyLog.clientConfidence);

  if (clientFamily || clientAppId || clientAppName || clientConfidence) {
    return {
      clientFamily,
      clientAppId,
      clientAppName,
      clientConfidence,
    };
  }

  const legacyMeta = parseProxyLogMessageMeta(
    typeof proxyLog.errorMessage === "string" ? proxyLog.errorMessage : "",
  );
  return {
    clientFamily:
      normalizeNullableText(legacyMeta.clientKind)?.toLowerCase() || null,
    clientAppId: null,
    clientAppName: null,
    clientConfidence: null,
  };
}

function normalizeProxyLogUsageSource(
  value: unknown,
): "upstream" | "self-log" | "unknown" | null {
  const normalized = normalizeNullableText(value)?.toLowerCase() || null;
  if (
    normalized === "upstream" ||
    normalized === "self-log" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  return null;
}

function buildProxyLogClientOptions(
  rows: Array<{
    clientFamily?: string | null;
    clientAppId?: string | null;
    clientAppName?: string | null;
  }>,
): ProxyLogClientOption[] {
  const appOptions = new Map<string, ProxyLogClientOption>();
  const familyOptions = new Map<string, ProxyLogClientOption>();

  for (const row of rows) {
    const clientAppId =
      normalizeNullableText(row.clientAppId)?.toLowerCase() || null;
    const clientAppName = normalizeNullableText(row.clientAppName) || null;
    const clientFamily =
      normalizeNullableText(row.clientFamily)?.toLowerCase() || null;

    if (clientAppId && clientAppName && !appOptions.has(clientAppId)) {
      appOptions.set(clientAppId, {
        value: `app:${clientAppId}`,
        label: `应用 · ${clientAppName}`,
      });
    }

    if (
      clientFamily &&
      clientFamily !== "generic" &&
      !familyOptions.has(clientFamily)
    ) {
      familyOptions.set(clientFamily, {
        value: `family:${clientFamily}`,
        label: `协议 · ${displayProxyLogClientFamily(clientFamily) || clientFamily}`,
      });
    }
  }

  return [
    ...Array.from(appOptions.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "zh-CN"),
    ),
    ...Array.from(familyOptions.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "zh-CN"),
    ),
  ];
}
function mapProxyLogRow(
  row: {
    proxy_logs: Record<string, unknown> & { billingDetails?: string | null };
    accounts: { username?: string | null } | null;
    sites: {
      id?: number | null;
      name?: string | null;
      url?: string | null;
    } | null;
    downstream_api_keys: {
      id?: number | null;
      name?: string | null;
      groupName?: string | null;
      tags?: string | null;
    } | null;
    token_routes?: { modelPattern?: string | null } | null;
  },
  options?: { includeBillingDetails?: boolean },
) {
  const clientMeta = resolveProxyLogClientMeta(row.proxy_logs);
  const legacyMeta = parseProxyLogMessageMeta(
    typeof row.proxy_logs.errorMessage === "string"
      ? row.proxy_logs.errorMessage
      : "",
  );
  const routeModelPattern = typeof row.token_routes?.modelPattern === "string"
    ? row.token_routes.modelPattern.trim()
    : "";
  // 区分「模型转发」新路由与老路由；routeId 为空表示请求没有经过路由（或路由已删）。
  const routeKind = routeModelPattern
    ? (isForwardRoutePattern(routeModelPattern) ? "forward" : "legacy")
    : (row.proxy_logs.routeId == null ? null : "legacy");

  return {
    ...row.proxy_logs,
    routeKind,
    isStream:
      row.proxy_logs.isStream == null ? null : Boolean(row.proxy_logs.isStream),
    firstByteLatencyMs:
      typeof row.proxy_logs.firstByteLatencyMs === "number"
        ? row.proxy_logs.firstByteLatencyMs
        : null,
    ...(options?.includeBillingDetails
      ? {
          billingDetails: parseProxyLogBillingDetails(
            row.proxy_logs.billingDetails,
          ),
        }
      : {}),
    clientFamily: clientMeta.clientFamily,
    clientAppId: clientMeta.clientAppId,
    clientAppName: clientMeta.clientAppName,
    clientConfidence: clientMeta.clientConfidence,
    usageSource: normalizeProxyLogUsageSource(legacyMeta.usageSource),
    username: row.accounts?.username || null,
    siteId: row.sites?.id || null,
    siteName: row.sites?.name || null,
    siteUrl: row.sites?.url || null,
    downstreamKeyId: row.downstream_api_keys?.id || null,
    downstreamKeyName: row.downstream_api_keys?.name || null,
    downstreamKeyGroupName: row.downstream_api_keys?.groupName || null,
    downstreamKeyTags: parseDownstreamKeyTags(row.downstream_api_keys?.tags),
  };
}

/**
 * 使用日志（proxy_logs）与代理调试追踪的只读接口。
 * 主服务与边缘实例（exe）注册同一份：接口全是 GET，没有写入口。
 */
export async function proxyLogRoutes(app: FastifyInstance) {
  async function loadProxyLogsQueryPayload(params: {
    limit?: string;
    offset?: string;
    status?: string;
    search?: string;
    client?: string;
    siteId?: string;
    from?: string;
    to?: string;
  }) {
    const limit = normalizeProxyLogPageSize(params.limit);
    const offset = normalizeProxyLogOffset(params.offset);
    const status = normalizeProxyLogStatusFilter(params.status);
    const search = normalizeProxyLogSearch(params.search);
    const client = normalizeProxyLogClientFilter(params.client);
    const siteId = normalizeProxyLogSiteId(params.siteId);
    const fromUtc = normalizeProxyLogTimeBoundary(params.from);
    const toUtc = normalizeProxyLogTimeBoundary(params.to);
    const listWhere = buildProxyLogWhereClause({
      status,
      search,
      client,
      siteId,
      fromUtc,
      toUtc,
    });

    const listRows = (await withProxyLogSelectFields(
      ({ fields }) => {
        let query = db
          .select({
            proxy_logs: fields,
            accounts: {
              username: schema.accounts.username,
            },
            token_routes: {
              modelPattern: schema.tokenRoutes.modelPattern,
            },
            sites: {
              id: schema.sites.id,
              name: schema.sites.name,
              url: schema.sites.url,
            },
            downstream_api_keys: {
              id: schema.downstreamApiKeys.id,
              name: schema.downstreamApiKeys.name,
              groupName: schema.downstreamApiKeys.groupName,
              tags: schema.downstreamApiKeys.tags,
            },
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.tokenRoutes,
            eq(schema.proxyLogs.routeId, schema.tokenRoutes.id),
          )
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );

        if (listWhere) {
          query = query.where(listWhere) as typeof query;
        }

        return query
          .orderBy(desc(schema.proxyLogs.createdAt))
          .limit(limit)
          .offset(offset)
          .all();
      },
      { includeBillingDetails: false },
    )) as Array<{
      proxy_logs: Record<string, unknown> & { billingDetails?: string | null };
      accounts: { username?: string | null } | null;
      sites: {
        id?: number | null;
        name?: string | null;
        url?: string | null;
      } | null;
      downstream_api_keys: {
        id?: number | null;
        name?: string | null;
        groupName?: string | null;
        tags?: string | null;
      } | null;
      token_routes?: { modelPattern?: string | null } | null;
    }>;

    let totalQuery = db
      .select({
        total: sql<number>`count(*)`,
      })
      .from(schema.proxyLogs)
      .leftJoin(
        schema.accounts,
        eq(schema.proxyLogs.accountId, schema.accounts.id),
      )
      .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .leftJoin(
        schema.downstreamApiKeys,
        eq(schema.proxyLogs.downstreamApiKeyId, schema.downstreamApiKeys.id),
      );
    if (listWhere) {
      totalQuery = totalQuery.where(listWhere) as typeof totalQuery;
    }
    const totalRow = await totalQuery.get();

    return {
      items: listRows.map((row) => mapProxyLogRow(row)),
      total: Number(totalRow?.total || 0),
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    };
  }

  async function loadProxyLogsMetaPayload(params: {
    status?: string;
    search?: string;
    client?: string;
    siteId?: string;
    from?: string;
    to?: string;
  }) {
    const status = normalizeProxyLogStatusFilter(params.status);
    const search = normalizeProxyLogSearch(params.search);
    const client = normalizeProxyLogClientFilter(params.client);
    const siteId = normalizeProxyLogSiteId(params.siteId);
    const fromUtc = normalizeProxyLogTimeBoundary(params.from);
    const toUtc = normalizeProxyLogTimeBoundary(params.to);
    const summaryWhere = buildProxyLogWhereClause({
      search,
      client,
      siteId,
      fromUtc,
      toUtc,
    });
    const clientOptionsWhere = buildProxyLogWhereClause({
      status,
      search,
      siteId,
      fromUtc,
      toUtc,
    });

    const clientOptionRowsPromise = withProxyLogSelectFields(
      ({ fields, includeClientFields }) => {
        if (!includeClientFields) {
          return Promise.resolve([]);
        }

        let query = db
          .select({
            clientFamily: fields.clientFamily!,
            clientAppId: fields.clientAppId!,
            clientAppName: fields.clientAppName!,
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );

        if (clientOptionsWhere) {
          query = query.where(clientOptionsWhere) as typeof query;
        }

        return query
          .groupBy(
            fields.clientFamily!,
            fields.clientAppId!,
            fields.clientAppName!,
          )
          .all();
      },
      { includeBillingDetails: false, includeClientFields: true },
    ) as Promise<
      Array<{
        clientFamily?: string | null;
        clientAppId?: string | null;
        clientAppName?: string | null;
      }>
    >;

    const [clientOptionRows, summaryRow, siteRows] = await Promise.all([
      clientOptionRowsPromise,
      (async () => {
        let summaryQuery = db
          .select({
            totalCount: sql<number>`count(*)`,
            successCount: sql<number>`coalesce(sum(case when ${schema.proxyLogs.status} = 'success' then 1 else 0 end), 0)`,
            failedCount: sql<number>`coalesce(sum(case when coalesce(${schema.proxyLogs.status}, '') <> 'success' then 1 else 0 end), 0)`,
            totalCost: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.estimatedCost}, 0)), 0)`,
            totalTokensAll: sql<number>`coalesce(sum(coalesce(${schema.proxyLogs.totalTokens}, 0)), 0)`,
          })
          .from(schema.proxyLogs)
          .leftJoin(
            schema.accounts,
            eq(schema.proxyLogs.accountId, schema.accounts.id),
          )
          .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
          .leftJoin(
            schema.downstreamApiKeys,
            eq(
              schema.proxyLogs.downstreamApiKeyId,
              schema.downstreamApiKeys.id,
            ),
          );
        if (summaryWhere) {
          summaryQuery = summaryQuery.where(
            summaryWhere,
          ) as typeof summaryQuery;
        }
        return summaryQuery.get();
      })(),
      db
        .select({
          id: schema.sites.id,
          name: schema.sites.name,
          status: schema.sites.status,
        })
        .from(schema.sites)
        .all(),
    ]);

    return {
      clientOptions: buildProxyLogClientOptions(clientOptionRows),
      summary: {
        totalCount: Number(summaryRow?.totalCount || 0),
        successCount: Number(summaryRow?.successCount || 0),
        failedCount: Number(summaryRow?.failedCount || 0),
        totalCost: toRoundedMicroNumber(summaryRow?.totalCost),
        totalTokensAll: Number(summaryRow?.totalTokensAll || 0),
      },
      sites: siteRows,
    };
  }

  // Proxy logs
  app.get<{
    Querystring: {
      limit?: string;
      offset?: string;
      status?: string;
      search?: string;
      client?: string;
      siteId?: string;
      from?: string;
      to?: string;
      view?: string;
    };
  }>("/api/stats/proxy-logs", async (request, reply) => {
    const view = normalizeProxyLogsView(request.query.view);
    if (view === "query") {
      return loadProxyLogsQueryPayload(request.query);
    }
    if (view === "meta") {
      return loadProxyLogsMetaPayload(request.query);
    }
    const [queryPayload, metaPayload] = await Promise.all([
      loadProxyLogsQueryPayload(request.query),
      loadProxyLogsMetaPayload(request.query),
    ]);
    return {
      ...queryPayload,
      clientOptions: metaPayload.clientOptions,
      summary: metaPayload.summary,
      sites: metaPayload.sites,
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/stats/proxy-logs/:id",
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ message: "proxy log id is invalid" });
      }

      const row = (await withProxyLogSelectFields(
        ({ fields }) =>
          db
            .select({
              proxy_logs: fields,
              accounts: schema.accounts,
              sites: schema.sites,
              token_routes: {
                modelPattern: schema.tokenRoutes.modelPattern,
              },
              downstream_api_keys: {
                id: schema.downstreamApiKeys.id,
                name: schema.downstreamApiKeys.name,
                groupName: schema.downstreamApiKeys.groupName,
                tags: schema.downstreamApiKeys.tags,
              },
            })
            .from(schema.proxyLogs)
            .leftJoin(
              schema.accounts,
              eq(schema.proxyLogs.accountId, schema.accounts.id),
            )
            .leftJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
            .leftJoin(
              schema.tokenRoutes,
              eq(schema.proxyLogs.routeId, schema.tokenRoutes.id),
            )
            .leftJoin(
              schema.downstreamApiKeys,
              eq(
                schema.proxyLogs.downstreamApiKeyId,
                schema.downstreamApiKeys.id,
              ),
            )
            .where(eq(schema.proxyLogs.id, id))
            .get(),
        { includeBillingDetails: true },
      )) as
        | {
            proxy_logs: Record<string, unknown> & {
              billingDetails?: string | null;
            };
            accounts: { username?: string | null } | null;
            sites: {
              id?: number | null;
              name?: string | null;
              url?: string | null;
            } | null;
            downstream_api_keys: {
              id?: number | null;
              name?: string | null;
              groupName?: string | null;
              tags?: string | null;
            } | null;
            token_routes?: { modelPattern?: string | null } | null;
          }
        | undefined;

      if (!row) {
        return reply.code(404).send({ message: "proxy log not found" });
      }

      return mapProxyLogRow(row, { includeBillingDetails: true });
    },
  );

  app.get<{ Querystring: { limit?: string } }>(
    "/api/stats/proxy-debug/traces",
    async (request) => {
      const limit = normalizeProxyLogPageSize(request.query.limit);
      const items = await listProxyDebugTraces({ limit });
      return { items };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/stats/proxy-debug/traces/:id",
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply
          .code(400)
          .send({ message: "proxy debug trace id is invalid" });
      }

      const detail = await getProxyDebugTraceDetail(id);
      if (!detail) {
        return reply.code(404).send({ message: "proxy debug trace not found" });
      }

      return detail;
    },
  );
}
