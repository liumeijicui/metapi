import { and, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';

/**
 * 批量测试的历史结果。
 *
 * model_probe_results 只保存每个「站点 + 模型」最新一条，够页面展示，但没法
 * 回答「上一轮批量测试里哪些站点 401 / 429」。这张表是追加式的：每测完一个
 * 模型写一条，带 HTTP 状态码，结果集页面按状态码、站点、模型筛选，也能按
 * runId 回看单次批量测试的完整结果。
 */

export const MODEL_BATCH_TEST_STATUSES = ['success', 'failed', 'cancelled'] as const;
export type ModelBatchTestStatus = (typeof MODEL_BATCH_TEST_STATUSES)[number];

/** 回答正文落库上限：结果集只看结论，正文截断即可。 */
const ANSWER_MAX_CHARS = 8_000;
const ERROR_MAX_CHARS = 2_000;

export type ModelBatchTestResultRow = {
  id: number;
  runId: string;
  siteId: number;
  siteName: string;
  modelName: string;
  status: ModelBatchTestStatus;
  /** 上游 HTTP 状态码；网络层失败（没拿到响应）时为 null。 */
  httpStatus: number | null;
  firstByteMs: number | null;
  durationMs: number | null;
  apiMode: string | null;
  reasoningEffort: string | null;
  promptTitle: string | null;
  answer: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export type ModelBatchTestResultFilter = {
  runId?: string | null;
  siteId?: number | null;
  model?: string | null;
  status?: string | null;
  /** 页面上的「200 / 401 / 429 …」多选。 */
  httpStatuses?: number[] | null;
  /** ISO 时间下界（含）。 */
  since?: string | null;
  limit?: number | null;
};

function normalizeStatus(value: unknown): ModelBatchTestStatus | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return (MODEL_BATCH_TEST_STATUSES as readonly string[]).includes(normalized)
    ? normalized as ModelBatchTestStatus
    : null;
}

function normalizeOptionalMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(Math.round(parsed), 24 * 60 * 60 * 1000);
}

function normalizeHttpStatus(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 100 || parsed > 599) return null;
  return Math.trunc(parsed);
}

function truncate(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…（已截断）`;
}

function normalizeRunId(value: unknown): string {
  return String(value ?? '').trim().slice(0, 64);
}

export async function saveModelBatchTestResult(input: {
  runId: unknown;
  siteId: unknown;
  modelName: unknown;
  status: unknown;
  httpStatus?: unknown;
  firstByteMs?: unknown;
  durationMs?: unknown;
  apiMode?: unknown;
  reasoningEffort?: unknown;
  promptTitle?: unknown;
  answer?: unknown;
  errorMessage?: unknown;
  now?: Date;
}): Promise<ModelBatchTestResultRow> {
  const runId = normalizeRunId(input.runId);
  const siteId = Math.trunc(Number(input.siteId) || 0);
  const modelName = String(input.modelName ?? '').trim();
  const status = normalizeStatus(input.status);
  if (!runId) throw new Error('缺少 runId');
  if (siteId <= 0) throw new Error('siteId 不合法');
  if (!modelName) throw new Error('模型名不能为空');
  if (!status) throw new Error('状态只支持 success / failed / cancelled');

  const apiModeRaw = String(input.apiMode ?? '').trim().toLowerCase();
  const apiMode = apiModeRaw === 'chat' || apiModeRaw === 'responses' ? apiModeRaw : null;
  const reasoningRaw = String(input.reasoningEffort ?? '').trim().toLowerCase();
  const createdAt = (input.now ?? new Date()).toISOString();

  const values = {
    runId,
    siteId,
    modelName,
    status,
    httpStatus: normalizeHttpStatus(input.httpStatus),
    firstByteMs: normalizeOptionalMs(input.firstByteMs),
    durationMs: normalizeOptionalMs(input.durationMs),
    apiMode,
    reasoningEffort: reasoningRaw ? reasoningRaw.slice(0, 32) : null,
    promptTitle: truncate(input.promptTitle, 200),
    answer: truncate(input.answer, ANSWER_MAX_CHARS),
    errorMessage: truncate(input.errorMessage, ERROR_MAX_CHARS),
    createdAt,
  };

  // 自增 id 统一走 insertHelpers：三种方言拿法不同，服务层不自己拼。
  const inserted = await insertAndGetById<{ id: number }>({
    table: schema.modelBatchTestResults,
    idColumn: schema.modelBatchTestResults.id,
    values,
    insertErrorMessage: '保存批量测试结果失败',
  });
  const siteRow = await db.select({ name: schema.sites.name })
    .from(schema.sites)
    .where(eq(schema.sites.id, siteId))
    .get();

  return {
    ...values,
    id: Number(inserted.id),
    siteName: siteRow?.name || `#${siteId}`,
  };
}

function buildConditions(filter: ModelBatchTestResultFilter): SQL[] {
  const conditions: SQL[] = [];
  const runId = normalizeRunId(filter.runId);
  if (runId) conditions.push(eq(schema.modelBatchTestResults.runId, runId));

  const siteId = Math.trunc(Number(filter.siteId) || 0);
  if (siteId > 0) conditions.push(eq(schema.modelBatchTestResults.siteId, siteId));

  const model = String(filter.model ?? '').trim().toLowerCase();
  if (model) {
    // 模型名是长串，页面上的筛选按「包含」处理，比精确匹配好用。
    conditions.push(sql`lower(${schema.modelBatchTestResults.modelName}) like ${'%' + model + '%'}`);
  }

  const status = normalizeStatus(filter.status);
  if (status) conditions.push(eq(schema.modelBatchTestResults.status, status));

  const httpStatuses = (filter.httpStatuses ?? [])
    .map((value) => normalizeHttpStatus(value))
    .filter((value): value is number => value !== null);
  if (httpStatuses.length) {
    conditions.push(inArray(schema.modelBatchTestResults.httpStatus, httpStatuses));
  }

  const since = String(filter.since ?? '').trim();
  if (since) conditions.push(gte(schema.modelBatchTestResults.createdAt, since));

  return conditions;
}

export async function listModelBatchTestResults(filter: ModelBatchTestResultFilter = {}): Promise<{
  results: ModelBatchTestResultRow[];
  total: number;
  /** 状态码分布，用来渲染「200 / 401 / 429 …」筛选标签上的计数。 */
  httpStatusCounts: Array<{ httpStatus: number | null; count: number }>;
}> {
  const conditions = buildConditions(filter);
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(Math.trunc(Number(filter.limit) || 300), 1), 2000);

  const rows = await db.select({
    id: schema.modelBatchTestResults.id,
    runId: schema.modelBatchTestResults.runId,
    siteId: schema.modelBatchTestResults.siteId,
    siteName: schema.sites.name,
    modelName: schema.modelBatchTestResults.modelName,
    status: schema.modelBatchTestResults.status,
    httpStatus: schema.modelBatchTestResults.httpStatus,
    firstByteMs: schema.modelBatchTestResults.firstByteMs,
    durationMs: schema.modelBatchTestResults.durationMs,
    apiMode: schema.modelBatchTestResults.apiMode,
    reasoningEffort: schema.modelBatchTestResults.reasoningEffort,
    promptTitle: schema.modelBatchTestResults.promptTitle,
    answer: schema.modelBatchTestResults.answer,
    errorMessage: schema.modelBatchTestResults.errorMessage,
    createdAt: schema.modelBatchTestResults.createdAt,
  })
    .from(schema.modelBatchTestResults)
    .leftJoin(schema.sites, eq(schema.sites.id, schema.modelBatchTestResults.siteId))
    .where(where)
    .orderBy(desc(schema.modelBatchTestResults.id))
    .limit(limit)
    .all();

  const totalRow = await db.select({ total: sql`count(*)` })
    .from(schema.modelBatchTestResults)
    .where(where)
    .get();

  // 状态码分布跟着「除状态码以外」的筛选走：否则勾了 401 之后下拉里只剩 401，
  // 就没法再切到 429。
  const facetConditions = buildConditions({ ...filter, httpStatuses: null });
  const facetRows = await db.select({
    httpStatus: schema.modelBatchTestResults.httpStatus,
    count: sql`count(*)`,
  })
    .from(schema.modelBatchTestResults)
    .where(facetConditions.length ? and(...facetConditions) : undefined)
    .groupBy(schema.modelBatchTestResults.httpStatus)
    .orderBy(desc(sql`count(*)`))
    .all();

  return {
    results: rows.map((row) => ({
      ...row,
      siteName: row.siteName || `#${row.siteId}`,
      status: normalizeStatus(row.status) ?? 'failed',
    })),
    total: Math.trunc(Number(totalRow?.total) || 0),
    httpStatusCounts: facetRows.map((row) => ({
      httpStatus: row.httpStatus ?? null,
      count: Math.trunc(Number(row.count) || 0),
    })),
  };
}

/** 批量测试弹窗左侧的站点余额：按站点汇总其下所有账号的余额。 */
export async function loadSiteBalances(siteIds: number[]): Promise<Record<number, number>> {
  const ids = Array.from(new Set(
    siteIds.map((id) => Math.trunc(Number(id) || 0)).filter((id) => id > 0),
  ));
  if (!ids.length) return {};
  const rows = await db.select({
    siteId: schema.accounts.siteId,
    balance: schema.accounts.balance,
  })
    .from(schema.accounts)
    .where(inArray(schema.accounts.siteId, ids))
    .all();
  const totals: Record<number, number> = {};
  for (const row of rows) {
    totals[row.siteId] = Math.round(((totals[row.siteId] ?? 0) + Number(row.balance || 0)) * 1_000_000) / 1_000_000;
  }
  return totals;
}
