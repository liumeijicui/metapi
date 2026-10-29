import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

/**
 * 模型监控的「最近一次测活结果」。
 *
 * 对话 / 测试 / 批量测试跑完都会把结果落到这里，每个「站点 + 模型」只保留
 * 最新一条（唯一索引 + upsert）。页面直接读这张表展示首字、用时、相对时间
 * 和回答，所以不需要在模型监控的采集流程里再维护一份。
 */

export type ModelProbeSource = 'chat' | 'test' | 'batch';
export type ModelProbeStatus = 'success' | 'failed' | 'cancelled';

export type ModelProbeResultView = {
  siteId: number;
  modelName: string;
  source: ModelProbeSource;
  status: ModelProbeStatus;
  firstByteMs: number | null;
  durationMs: number | null;
  apiMode: string | null;
  reasoningEffort: string | null;
  answer: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export const MODEL_PROBE_SOURCES: readonly ModelProbeSource[] = ['chat', 'test', 'batch'];
export const MODEL_PROBE_STATUSES: readonly ModelProbeStatus[] = ['success', 'failed', 'cancelled'];
/**
 * 回答正文的落库上限。够看清一整段回答，又不会让某个模型的超长输出把
 * 整张表撑起来；页面本身只用图标 + 悬浮展示。
 */
export const MODEL_PROBE_ANSWER_MAX_CHARS = 12_000;

export function normalizeModelProbeSource(value: unknown): ModelProbeSource | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return (MODEL_PROBE_SOURCES as readonly string[]).includes(normalized)
    ? normalized as ModelProbeSource
    : null;
}

export function normalizeModelProbeStatus(value: unknown): ModelProbeStatus | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return (MODEL_PROBE_STATUSES as readonly string[]).includes(normalized)
    ? normalized as ModelProbeStatus
    : null;
}

function normalizeOptionalMs(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(Math.round(parsed), 24 * 60 * 60 * 1000);
}

function truncateAnswer(value: unknown): string | null {
  const text = typeof value === 'string' ? value : '';
  if (!text) return null;
  if (text.length <= MODEL_PROBE_ANSWER_MAX_CHARS) return text;
  return `${text.slice(0, MODEL_PROBE_ANSWER_MAX_CHARS)}\n…（已截断）`;
}

function toView(row: typeof schema.modelProbeResults.$inferSelect): ModelProbeResultView {
  return {
    siteId: row.siteId,
    modelName: row.modelName,
    source: normalizeModelProbeSource(row.source) ?? 'chat',
    status: normalizeModelProbeStatus(row.status) ?? 'failed',
    firstByteMs: row.firstByteMs,
    durationMs: row.durationMs,
    apiMode: row.apiMode,
    reasoningEffort: row.reasoningEffort,
    answer: row.answer,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
  };
}

export function buildModelProbeKey(siteId: number, modelName: string): string {
  return `${Math.trunc(siteId)}:${String(modelName || '').trim()}`;
}

export async function saveModelProbeResult(input: {
  siteId: number;
  modelName: string;
  source: unknown;
  status: unknown;
  firstByteMs?: unknown;
  durationMs?: unknown;
  apiMode?: unknown;
  reasoningEffort?: unknown;
  answer?: unknown;
  errorMessage?: unknown;
  now?: Date;
}): Promise<ModelProbeResultView> {
  const siteId = Math.trunc(Number(input.siteId) || 0);
  const modelName = String(input.modelName || '').trim();
  const source = normalizeModelProbeSource(input.source);
  const status = normalizeModelProbeStatus(input.status);
  if (siteId <= 0) throw new Error('siteId 不合法');
  if (!modelName) throw new Error('模型名不能为空');
  if (!source) throw new Error('来源只支持 chat / test / batch');
  if (!status) throw new Error('状态只支持 success / failed / cancelled');

  const apiModeRaw = String(input.apiMode ?? '').trim().toLowerCase();
  const apiMode = apiModeRaw === 'chat' || apiModeRaw === 'responses' ? apiModeRaw : null;
  const reasoningEffortRaw = String(input.reasoningEffort ?? '').trim().toLowerCase();
  const reasoningEffort = reasoningEffortRaw ? reasoningEffortRaw.slice(0, 32) : null;
  const errorMessageRaw = typeof input.errorMessage === 'string' ? input.errorMessage.trim() : '';
  const now = (input.now ?? new Date()).toISOString();

  const values = {
    siteId,
    modelName,
    source,
    status,
    firstByteMs: normalizeOptionalMs(input.firstByteMs),
    durationMs: normalizeOptionalMs(input.durationMs),
    apiMode,
    reasoningEffort,
    answer: truncateAnswer(input.answer),
    errorMessage: errorMessageRaw ? errorMessageRaw.slice(0, 4000) : null,
    createdAt: now,
  };

  await db
    .insert(schema.modelProbeResults)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.modelProbeResults.siteId, schema.modelProbeResults.modelName],
      set: { ...values },
    })
    .run();

  return {
    siteId,
    modelName,
    source,
    status,
    firstByteMs: values.firstByteMs,
    durationMs: values.durationMs,
    apiMode,
    reasoningEffort,
    answer: values.answer,
    errorMessage: values.errorMessage,
    createdAt: now,
  };
}

/** 取指定站点的最近结果，按 `站点ID:模型名` 建索引，供总览拼装。 */
export async function loadModelProbeResultMap(
  siteIds: number[],
): Promise<Map<string, ModelProbeResultView>> {
  const ids = Array.from(new Set(
    siteIds.map((id) => Math.trunc(Number(id) || 0)).filter((id) => id > 0),
  ));
  const map = new Map<string, ModelProbeResultView>();
  if (!ids.length) return map;

  const rows = await db
    .select()
    .from(schema.modelProbeResults)
    .where(inArray(schema.modelProbeResults.siteId, ids))
    .all();
  for (const row of rows) {
    map.set(buildModelProbeKey(row.siteId, row.modelName), toView(row));
  }
  return map;
}

export async function getModelProbeResult(
  siteId: number,
  modelName: string,
): Promise<ModelProbeResultView | null> {
  const row = await db
    .select()
    .from(schema.modelProbeResults)
    .where(and(
      eq(schema.modelProbeResults.siteId, Math.trunc(siteId)),
      eq(schema.modelProbeResults.modelName, String(modelName || '').trim()),
    ))
    .orderBy(desc(schema.modelProbeResults.createdAt))
    .get();
  return row ? toView(row) : null;
}
