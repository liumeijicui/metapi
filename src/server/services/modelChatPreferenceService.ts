import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';

/**
 * 「模型监控 → 对话」的每站点、每模型偏好。
 *
 * 同一个模型在不同站点上可能只认 Chat Completions，也可能只认 Responses；
 * 思考强度的可用档位同样随站点/模型而变。把这两项按 `siteId:model` 记住，
 * 下次打开同一个模型时直接沿用，不需要每次都重新选。
 */

export type ModelChatApiMode = 'chat' | 'responses';

export type ModelChatPreference = {
  apiMode: ModelChatApiMode;
  reasoningEffort: string | null;
};

export const MODEL_CHAT_PREFERENCES_SETTING_KEY = 'model_chat_preferences_v1';
export const MODEL_CHAT_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'max'] as const;

type PreferenceStore = Record<string, ModelChatPreference>;

function buildPreferenceKey(siteId: number, model: string): string {
  return `${Math.trunc(siteId)}:${String(model || '').trim()}`;
}

export function normalizeModelChatApiMode(value: unknown): ModelChatApiMode | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'chat' || normalized === 'responses') return normalized;
  return null;
}

export function normalizeModelChatReasoningEffort(value: unknown): string | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return null;
  return (MODEL_CHAT_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? normalized
    : null;
}

function normalizeStoredPreference(value: unknown): ModelChatPreference | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const apiMode = normalizeModelChatApiMode(record.apiMode);
  if (!apiMode) return null;
  return {
    apiMode,
    reasoningEffort: normalizeModelChatReasoningEffort(record.reasoningEffort),
  };
}

async function readStore(): Promise<PreferenceStore> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, MODEL_CHAT_PREFERENCES_SETTING_KEY))
    .get();
  if (!row?.value) return {};
  try {
    const parsed = JSON.parse(String(row.value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const store: PreferenceStore = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeStoredPreference(value);
      if (normalized) store[key] = normalized;
    }
    return store;
  } catch {
    return {};
  }
}

export async function getModelChatPreference(
  siteId: number,
  model: string,
): Promise<ModelChatPreference | null> {
  if (!Number.isFinite(siteId) || siteId <= 0 || !String(model || '').trim()) return null;
  const store = await readStore();
  return store[buildPreferenceKey(siteId, model)] ?? null;
}

export async function saveModelChatPreference(input: {
  siteId: number;
  model: string;
  apiMode: unknown;
  reasoningEffort?: unknown;
}): Promise<ModelChatPreference> {
  const siteId = Math.trunc(Number(input.siteId));
  const model = String(input.model || '').trim();
  if (!Number.isFinite(siteId) || siteId <= 0) {
    throw new Error('siteId 不合法');
  }
  if (!model) {
    throw new Error('model 不能为空');
  }
  const apiMode = normalizeModelChatApiMode(input.apiMode);
  if (!apiMode) {
    throw new Error('接口协议不合法，只支持 chat / responses');
  }
  const preference: ModelChatPreference = {
    apiMode,
    reasoningEffort: normalizeModelChatReasoningEffort(input.reasoningEffort),
  };
  const store = await readStore();
  store[buildPreferenceKey(siteId, model)] = preference;
  await upsertSetting(MODEL_CHAT_PREFERENCES_SETTING_KEY, store);
  return preference;
}
