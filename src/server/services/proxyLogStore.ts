import {
  db,
  schema,
  hasProxyLogBillingDetailsColumn,
  hasProxyLogClientColumns,
  hasProxyLogDownstreamApiKeyIdColumn,
  hasProxyLogStreamTimingColumns,
  hasProxyLogReasoningEffortColumn,
} from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

export type ProxyLogInsertInput = {
  routeId?: number | null;
  channelId?: number | null;
  accountId?: number | null;
  downstreamApiKeyId?: number | null;
  modelRequested?: string | null;
  modelActual?: string | null;
  status?: string | null;
  httpStatus?: number | null;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  latencyMs?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCost?: number | null;
  billingDetails?: unknown;
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: string | null;
  /** 客户端请求的思考强度（reasoning_effort / reasoning.effort），原样入库。 */
  reasoningEffort?: string | null;
  errorMessage?: string | null;
  retryCount?: number | null;
  createdAt?: string | null;
};

function buildProxyLogCoreSelectFields() {
  return {
    id: schema.proxyLogs.id,
    routeId: schema.proxyLogs.routeId,
    channelId: schema.proxyLogs.channelId,
    accountId: schema.proxyLogs.accountId,
    downstreamApiKeyId: schema.proxyLogs.downstreamApiKeyId,
    modelRequested: schema.proxyLogs.modelRequested,
    modelActual: schema.proxyLogs.modelActual,
    status: schema.proxyLogs.status,
    httpStatus: schema.proxyLogs.httpStatus,
    latencyMs: schema.proxyLogs.latencyMs,
    promptTokens: schema.proxyLogs.promptTokens,
    completionTokens: schema.proxyLogs.completionTokens,
    totalTokens: schema.proxyLogs.totalTokens,
    estimatedCost: schema.proxyLogs.estimatedCost,
    errorMessage: schema.proxyLogs.errorMessage,
    retryCount: schema.proxyLogs.retryCount,
    createdAt: schema.proxyLogs.createdAt,
  };
}

function buildProxyLogClientSelectFields() {
  return {
    clientFamily: schema.proxyLogs.clientFamily,
    clientAppId: schema.proxyLogs.clientAppId,
    clientAppName: schema.proxyLogs.clientAppName,
    clientConfidence: schema.proxyLogs.clientConfidence,
  };
}

function buildProxyLogStreamTimingSelectFields() {
  return {
    isStream: schema.proxyLogs.isStream,
    firstByteLatencyMs: schema.proxyLogs.firstByteLatencyMs,
  };
}

function buildProxyLogReasoningEffortSelectFields() {
  return {
    reasoningEffort: schema.proxyLogs.reasoningEffort,
  };
}

function buildProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
  includeReasoningEffort?: boolean;
}) {
  return {
    ...buildProxyLogCoreSelectFields(),
    ...(options?.includeStreamTimingFields ? buildProxyLogStreamTimingSelectFields() : {}),
    ...(options?.includeClientFields ? buildProxyLogClientSelectFields() : {}),
    ...(options?.includeReasoningEffort ? buildProxyLogReasoningEffortSelectFields() : {}),
    ...(options?.includeBillingDetails ? { billingDetails: schema.proxyLogs.billingDetails } : {}),
  };
}

export function getProxyLogBaseSelectFields() {
  return buildProxyLogCoreSelectFields();
}

export type ProxyLogSelectFields = ReturnType<typeof buildProxyLogSelectFields>;

export type ResolvedProxyLogSelectFields = {
  includeBillingDetails: boolean;
  includeClientFields: boolean;
  includeStreamTimingFields: boolean;
  includeReasoningEffort: boolean;
  fields: ProxyLogSelectFields;
};

export async function resolveProxyLogSelectFields(options?: {
  includeBillingDetails?: boolean;
  includeClientFields?: boolean;
  includeStreamTimingFields?: boolean;
  includeReasoningEffort?: boolean;
}) {
  const includeBillingDetails = options?.includeBillingDetails === true
    && await hasProxyLogBillingDetailsColumn();
  const includeClientFields = options?.includeClientFields !== false
    && await hasProxyLogClientColumns();
  const includeStreamTimingFields = options?.includeStreamTimingFields !== false
    && await hasProxyLogStreamTimingColumns();
  const includeReasoningEffort = options?.includeReasoningEffort !== false
    && await hasProxyLogReasoningEffortColumn();

  return {
    includeBillingDetails,
    includeClientFields,
    includeStreamTimingFields,
    includeReasoningEffort,
    fields: buildProxyLogSelectFields({
      includeBillingDetails,
      includeClientFields,
      includeStreamTimingFields,
      includeReasoningEffort,
    }),
  };
}

export async function withProxyLogSelectFields<T>(
  runner: (selection: ResolvedProxyLogSelectFields) => Promise<T>,
  options?: {
    includeBillingDetails?: boolean;
    includeClientFields?: boolean;
    includeStreamTimingFields?: boolean;
    includeReasoningEffort?: boolean;
  },
): Promise<T> {
  let selection = await resolveProxyLogSelectFields(options);

  // 旧库缺列时逐项退让；用统一的 rebuild 保证每次退让都不会漏掉其它开关。
  const rebuild = (
    overrides: Partial<Omit<ResolvedProxyLogSelectFields, 'fields'>>,
  ): ResolvedProxyLogSelectFields => {
    const next = { ...selection, ...overrides };
    return {
      ...next,
      fields: buildProxyLogSelectFields({
        includeBillingDetails: next.includeBillingDetails,
        includeClientFields: next.includeClientFields,
        includeStreamTimingFields: next.includeStreamTimingFields,
        includeReasoningEffort: next.includeReasoningEffort,
      }),
    };
  };

  while (true) {
    try {
      return await runner(selection);
    } catch (error) {
      if (selection.includeBillingDetails && isMissingBillingDetailsColumnError(error)) {
        selection = rebuild({ includeBillingDetails: false });
        continue;
      }

      if (selection.includeClientFields && isMissingProxyLogClientColumnsError(error)) {
        selection = rebuild({ includeClientFields: false });
        continue;
      }

      if (selection.includeStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        selection = rebuild({ includeStreamTimingFields: false });
        continue;
      }

      if (selection.includeReasoningEffort && isMissingReasoningEffortColumnError(error)) {
        selection = rebuild({ includeReasoningEffort: false });
        continue;
      }

      throw error;
    }
  }
}

export function parseProxyLogBillingDetails(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeProxyLogStoreErrorMessage(error: unknown): string {
  const message = typeof error === 'object' && error && 'message' in error
    ? String((error as { message?: unknown }).message || '')
    : String(error || '');
  return message.toLowerCase();
}

export function isMissingBillingDetailsColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('billing_details')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingDownstreamApiKeyIdColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('downstream_api_key_id')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogClientColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasClientColumnReference = [
    'client_family',
    'client_app_id',
    'client_app_name',
    'client_confidence',
  ].some((columnName) => lowered.includes(columnName));

  return hasClientColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingProxyLogStreamTimingColumnsError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  const hasStreamTimingColumnReference = [
    'is_stream',
    'first_byte_latency_ms',
  ].some((columnName) => lowered.includes(columnName));

  return hasStreamTimingColumnReference
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export function isMissingReasoningEffortColumnError(error: unknown): boolean {
  const lowered = normalizeProxyLogStoreErrorMessage(error);
  return lowered.includes('reasoning_effort')
    && (
      lowered.includes('does not exist')
      || lowered.includes('unknown column')
      || lowered.includes('no such column')
      || lowered.includes('has no column named')
    );
}

export async function insertProxyLog(input: ProxyLogInsertInput): Promise<void> {
  const baseValues = {
    routeId: input.routeId ?? null,
    channelId: input.channelId ?? null,
    accountId: input.accountId ?? null,
    modelRequested: input.modelRequested ?? null,
    modelActual: input.modelActual ?? null,
    status: input.status ?? null,
    httpStatus: input.httpStatus ?? null,
    latencyMs: input.latencyMs ?? null,
    promptTokens: input.promptTokens ?? null,
    completionTokens: input.completionTokens ?? null,
    totalTokens: input.totalTokens ?? null,
    estimatedCost: input.estimatedCost ?? 0,
    errorMessage: input.errorMessage ?? null,
    retryCount: input.retryCount ?? 0,
    // 日志列表按 created_at 倒序分页；漏写时间戳会让这条日志排到列表最末尾，
    // 看起来就像「没进日志」。这里统一兜底成当前 UTC 时间。
    createdAt: input.createdAt ?? formatUtcSqlDateTime(new Date()),
  };
  const serializedBillingDetails = input.billingDetails == null
    ? null
    : JSON.stringify(input.billingDetails);
  const includeBillingDetails = serializedBillingDetails !== null
    && await hasProxyLogBillingDetailsColumn();
  const includeDownstreamApiKeyId = input.downstreamApiKeyId != null
    && await hasProxyLogDownstreamApiKeyIdColumn();
  const requestedClientFields = [
    input.clientFamily,
    input.clientAppId,
    input.clientAppName,
    input.clientConfidence,
  ].some((value) => value != null && String(value).trim().length > 0);
  const includeClientFields = requestedClientFields
    && await hasProxyLogClientColumns();
  const requestedStreamTimingFields = input.isStream != null || input.firstByteLatencyMs != null;
  const includeStreamTimingFields = requestedStreamTimingFields
    && await hasProxyLogStreamTimingColumns();
  const normalizedReasoningEffort = typeof input.reasoningEffort === 'string'
    ? input.reasoningEffort.trim()
    : '';
  const includeReasoningEffort = normalizedReasoningEffort.length > 0
    && await hasProxyLogReasoningEffortColumn();

  let allowBillingDetails = includeBillingDetails;
  let allowDownstreamApiKeyId = includeDownstreamApiKeyId;
  let allowClientFields = includeClientFields;
  let allowStreamTimingFields = includeStreamTimingFields;
  let allowReasoningEffort = includeReasoningEffort;

  while (true) {
    const values = {
      ...baseValues,
      ...(allowStreamTimingFields
        ? {
          isStream: input.isStream ?? null,
          firstByteLatencyMs: input.firstByteLatencyMs ?? null,
        }
        : {}),
      ...(allowBillingDetails ? { billingDetails: serializedBillingDetails } : {}),
      ...(allowDownstreamApiKeyId ? { downstreamApiKeyId: input.downstreamApiKeyId } : {}),
      ...(allowClientFields
        ? {
          clientFamily: input.clientFamily ?? null,
          clientAppId: input.clientAppId ?? null,
          clientAppName: input.clientAppName ?? null,
          clientConfidence: input.clientConfidence ?? null,
        }
        : {}),
      ...(allowReasoningEffort ? { reasoningEffort: normalizedReasoningEffort || null } : {}),
    };

    try {
      await db.insert(schema.proxyLogs).values(values).run();
      return;
    } catch (error) {
      if (allowBillingDetails && isMissingBillingDetailsColumnError(error)) {
        allowBillingDetails = false;
        continue;
      }

      if (allowDownstreamApiKeyId && isMissingDownstreamApiKeyIdColumnError(error)) {
        allowDownstreamApiKeyId = false;
        continue;
      }

      if (allowClientFields && isMissingProxyLogClientColumnsError(error)) {
        allowClientFields = false;
        continue;
      }

      if (allowStreamTimingFields && isMissingProxyLogStreamTimingColumnsError(error)) {
        allowStreamTimingFields = false;
        continue;
      }

      if (allowReasoningEffort && isMissingReasoningEffortColumnError(error)) {
        allowReasoningEffort = false;
        continue;
      }

      throw error;
    }
  }
}
