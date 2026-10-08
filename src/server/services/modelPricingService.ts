import type { RequestInit as UndiciRequestInit } from 'undici';
import { withSiteProxyRequestInit } from './siteProxy.js';
import {
  buildNewApiCookieCandidates,
  fetchJsonWithShieldCookieRetry,
} from './platforms/newApiShield.js';
import {
  resolveBillingExpressionPricing,
  type BillingExpressionPricing,
} from './billingExpression.js';

const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;
const PRICE_CACHE_FAILURE_TTL_MS = 60 * 1000;
/**
 * 过期后仍可继续使用的时长。价目表只用来给「端点候选排序」和「成本估算」做
 * 参考，宁可先用旧数据、后台再刷新，也不要在请求路径上等一次网络往返。
 */
const PRICE_CACHE_STALE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_CACHE_FAILURE_STALE_TTL_MS = 5 * 60 * 1000;
const PRICING_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_GROUP = 'default';
const ONE_HUB_PER_CALL_RATIO = 0.002;
const MIN_ROUTING_REFERENCE_COST = 1e-6;
const ROUTING_REFERENCE_USAGE = {
  promptTokens: 500_000,
  completionTokens: 500_000,
  totalTokens: 1_000_000,
};

export interface PricingModel {
  modelName: string;
  quotaType: number;
  modelRatio: number;
  completionRatio: number;
  /** new-api 的计费模式；`tiered_expr` 表示价格写在 billingExpr 里。 */
  billingMode?: string | null;
  /** 表达式计费的价格公式，系数单位是「美元 / 1M tokens」。 */
  billingExpr?: string | null;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  modelPrice: number | { input: number; output: number } | null;
  enableGroups: string[];
  modelDescription?: string | null;
  tags?: string[];
  supportedEndpointTypes?: string[];
  ownerBy?: string | null;
}

interface PricingData {
  models: Map<string, PricingModel>;
  groupRatio: Record<string, number>;
}

export interface ProxyBillingPricingOverride {
  modelRatio: number;
  completionRatio: number;
  cacheRatio?: number;
  cacheCreationRatio?: number;
  groupRatio?: number;
}

interface PricingCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  data: PricingData | null;
}

interface RoutingReferenceCostCacheEntry {
  fetchedAt: number;
  ttlMs: number;
  costs: Map<string, number>;
}

export interface EstimateProxyCostInput {
  site: {
    id: number;
    url: string;
    platform: string;
    apiKey?: string | null;
  };
  account: {
    id: number;
    accessToken?: string | null;
    apiToken?: string | null;
  };
  modelName: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptTokensIncludeCache?: boolean | null;
  billingPricingOverride?: ProxyBillingPricingOverride | null;
}

interface ModelGroupPricing {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
  perCallInput?: number;
  perCallOutput?: number;
  perCallTotal?: number;
}

interface ModelPricingCatalogEntry {
  modelName: string;
  quotaType: number;
  modelDescription: string | null;
  tags: string[];
  supportedEndpointTypes: string[];
  ownerBy: string | null;
  enableGroups: string[];
  groupPricing: Record<string, ModelGroupPricing>;
}

interface ModelPricingCatalog {
  models: ModelPricingCatalogEntry[];
  groupRatio: Record<string, number>;
}

export interface ProxyBillingDetails {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
}

const pricingCache = new Map<string, PricingCacheEntry>();
const routingReferenceCostCache = new Map<string, RoutingReferenceCostCacheEntry>();
/**
 * 同一个站点的价目表抓取只允许一份在飞：启动或缓存同时过期时，并发请求
 * 会同时发现缓存失效，没有这层去重就会打出一串重复的抓取。
 */
const pricingFetchInFlight = new Map<string, Promise<PricingData | null>>();

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function toPositiveInt(value: unknown): number {
  return Math.max(0, Math.round(toNumber(value, 0)));
}

function roundCost(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

function normalizeModelPrice(value: unknown): number | { input: number; output: number } | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return null;

  const input = toNumber((value as any).input, Number.NaN);
  const output = toNumber((value as any).output, Number.NaN);
  if (Number.isNaN(input) && Number.isNaN(output)) return null;

  return {
    input: Number.isNaN(input) ? 0 : input,
    output: Number.isNaN(output) ? 0 : output,
  };
}

function normalizeGroupRatio(raw: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const ratio = toNumber(value, 1);
      if (ratio > 0) result[key] = ratio;
    }
  }

  if (Object.keys(result).length === 0) {
    result[DEFAULT_GROUP] = 1;
  } else if (!(DEFAULT_GROUP in result)) {
    result[DEFAULT_GROUP] = 1;
  }

  return result;
}

function normalizeStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function normalizeRatio(value: unknown, fallback: number): number {
  const ratio = toNumber(value, Number.NaN);
  if (Number.isFinite(ratio) && ratio >= 0) return ratio;
  return fallback;
}

function normalizePricingModels(rawModels: unknown[]): Map<string, PricingModel> {
  const models = new Map<string, PricingModel>();

  for (const raw of rawModels) {
    if (!raw || typeof raw !== 'object') continue;

    const modelName = String((raw as any).model_name || '').trim();
    if (!modelName) continue;

    const quotaType = toPositiveInt((raw as any).quota_type);
    const modelRatio = toNumber((raw as any).model_ratio, 1);
    const completionRatio = toNumber((raw as any).completion_ratio, 1);
    const cacheRatio = normalizeRatio(
      (raw as any).cache_ratio ?? (raw as any).cacheRatio,
      1,
    );
    const cacheCreationRatio = normalizeRatio(
      (raw as any).cache_creation_ratio
        ?? (raw as any).cacheCreationRatio
        ?? (raw as any).create_cache_ratio
        ?? (raw as any).createCacheRatio,
      1,
    );
    const enableGroupsRaw = (raw as any).enable_groups;
    const enableGroups = Array.isArray(enableGroupsRaw)
      ? enableGroupsRaw.map((item: unknown) => String(item || '').trim()).filter(Boolean)
      : [DEFAULT_GROUP];
    const modelDescriptionRaw = (raw as any).model_description;
    const modelDescription = typeof modelDescriptionRaw === 'string'
      ? (modelDescriptionRaw.trim() || null)
      : null;
    const tags = normalizeStringArray((raw as any).tags);
    const supportedEndpointTypes = normalizeStringArray((raw as any).supported_endpoint_types);
    const ownerByRaw = (raw as any).owner_by;
    const ownerBy = typeof ownerByRaw === 'string' ? (ownerByRaw.trim() || null) : null;
    const billingModeRaw = (raw as any).billing_mode ?? (raw as any).billingMode;
    const billingMode = typeof billingModeRaw === 'string' ? (billingModeRaw.trim() || null) : null;
    const billingExprRaw = (raw as any).billing_expr ?? (raw as any).billingExpr;
    const billingExpr = typeof billingExprRaw === 'string' ? (billingExprRaw.trim() || null) : null;

    models.set(modelName, {
      modelName,
      quotaType,
      modelRatio: modelRatio > 0 ? modelRatio : 1,
      completionRatio: completionRatio > 0 ? completionRatio : 1,
      billingMode,
      billingExpr,
      cacheRatio,
      cacheCreationRatio,
      modelPrice: normalizeModelPrice((raw as any).model_price),
      enableGroups: enableGroups.length > 0 ? enableGroups : [DEFAULT_GROUP],
      modelDescription,
      tags,
      supportedEndpointTypes,
      ownerBy,
    });
  }

  return models;
}

function unwrapPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  if ('data' in (payload as any)) return (payload as any).data;
  return payload;
}

function normalizeCommonPricingPayload(payload: unknown): PricingData | null {
  const maybeData = unwrapPayload(payload);
  if (!Array.isArray(maybeData)) return null;

  const models = normalizePricingModels(maybeData);
  if (models.size === 0) return null;

  const groupRatio = normalizeGroupRatio((payload as any)?.group_ratio);
  return { models, groupRatio };
}

function normalizeOneHubPricingPayload(availablePayload: unknown, groupPayload: unknown): PricingData | null {
  const available = unwrapPayload(availablePayload);
  if (!available || typeof available !== 'object') return null;

  const transformed: unknown[] = [];
  for (const [modelName, rawValue] of Object.entries(available as Record<string, unknown>)) {
    const item = rawValue as any;
    const price = item?.price || {};
    const input = toNumber(price.input, 0);
    const output = toNumber(price.output, input);
    const cacheRead = toNumber(
      price.input_cache_read ?? price.inputCacheRead ?? price.cache_read ?? price.cacheRead,
      Number.NaN,
    );
    const cacheWrite = toNumber(
      price.input_cache_write ?? price.inputCacheWrite ?? price.cache_write ?? price.cacheWrite,
      Number.NaN,
    );
    const isTokenType = String(price.type || '').toLowerCase() === 'tokens';

    transformed.push({
      model_name: modelName,
      model_description: item?.description || item?.desc || '',
      quota_type: isTokenType ? 0 : 1,
      model_ratio: 1,
      completion_ratio: input > 0 ? output / input : 1,
      cache_ratio: input > 0 && Number.isFinite(cacheRead) && cacheRead >= 0 ? (cacheRead / input) : 1,
      cache_creation_ratio: input > 0 && Number.isFinite(cacheWrite) && cacheWrite >= 0 ? (cacheWrite / input) : 1,
      model_price: { input, output },
      enable_groups: Array.isArray(item?.groups) && item.groups.length > 0 ? item.groups : [DEFAULT_GROUP],
      supported_endpoint_types: Array.isArray(item?.supported_endpoint_types) ? item.supported_endpoint_types : [],
      tags: Array.isArray(item?.tags) ? item.tags : [],
      owner_by: item?.owned_by || item?.provider || null,
    });
  }

  const models = normalizePricingModels(transformed);
  if (models.size === 0) return null;

  const groupMap = unwrapPayload(groupPayload);
  const groupRatioSource: Record<string, number> = {};
  if (groupMap && typeof groupMap === 'object') {
    for (const [key, group] of Object.entries(groupMap as Record<string, any>)) {
      groupRatioSource[key] = toNumber(group?.ratio, 1);
    }
  }

  const groupRatio = normalizeGroupRatio(groupRatioSource);
  return { models, groupRatio };
}

async function fetchJson(url: string, options?: UndiciRequestInit): Promise<unknown> {
  const { fetch } = await import('undici');
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, PRICING_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...(await withSiteProxyRequestInit(url, {
        ...options,
        signal: controller.signal,
        body: options?.body ?? undefined,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
      })),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`pricing fetch timeout (${Math.round(PRICING_FETCH_TIMEOUT_MS / 1000)}s)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }
}

function normalizeUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildTokenCandidates(input: EstimateProxyCostInput): string[] {
  const candidates = [
    input.account.accessToken,
    input.account.apiToken,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  return Array.from(new Set(candidates));
}

async function fetchCommonPricing(baseUrl: string, token?: string, sitePlatform?: string): Promise<PricingData | null> {
  const normalizedPlatform = (sitePlatform || '').trim().toLowerCase();
  const shouldTryShieldCookie = !!token && (normalizedPlatform === 'anyrouter' || token.includes('='));
  if (shouldTryShieldCookie) {
    const payload = await fetchJsonViaNewApiShield(`${baseUrl}/api/pricing`, token!);
    const data = normalizeCommonPricingPayload(payload);
    if (data) return data;
  }

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const payload = await fetchJson(`${baseUrl}/api/pricing`, { headers });
  return normalizeCommonPricingPayload(payload);
}

async function fetchOneHubPricing(baseUrl: string, token?: string): Promise<PricingData | null> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const [availablePayload, groupPayload] = await Promise.all([
    fetchJson(`${baseUrl}/api/available_model`, { headers }),
    fetchJson(`${baseUrl}/api/user_group_map`, { headers }),
  ]);

  return normalizeOneHubPricingPayload(availablePayload, groupPayload);
}

function getCacheKey(input: EstimateProxyCostInput): string {
  return `${input.site.id}:${input.account.id}`;
}

function normalizeModelKey(modelName: string): string {
  return modelName.trim().toLowerCase();
}

function buildRoutingReferenceCostMap(data: PricingData): Map<string, number> {
  const costs = new Map<string, number>();
  for (const model of data.models.values()) {
    const cost = calculateModelUsageCost(model, ROUTING_REFERENCE_USAGE, data.groupRatio);
    if (!Number.isFinite(cost)) continue;
    costs.set(normalizeModelKey(model.modelName), Math.max(cost, MIN_ROUTING_REFERENCE_COST));
  }
  return costs;
}

function syncRoutingReferenceCostCache(
  key: string,
  fetchedAt: number,
  ttlMs: number,
  data: PricingData | null,
): void {
  if (!data) {
    routingReferenceCostCache.delete(key);
    return;
  }

  routingReferenceCostCache.set(key, {
    fetchedAt,
    ttlMs,
    costs: buildRoutingReferenceCostMap(data),
  });
}

async function fetchPricingData(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const baseUrl = normalizeUrl(input.site.url);
  const tokenCandidates = buildTokenCandidates(input);

  const fetcher = input.site.platform === 'one-hub' || input.site.platform === 'done-hub'
    ? (baseUrl: string, token?: string) => fetchOneHubPricing(baseUrl, token)
    : (baseUrl: string, token?: string) => fetchCommonPricing(baseUrl, token, input.site.platform);

  for (const token of tokenCandidates) {
    try {
      const data = await fetcher(baseUrl, token);
      if (data && data.models.size > 0) return data;
    } catch {}
  }

  // Some sites expose pricing publicly.
  try {
    const data = await fetcher(baseUrl, undefined);
    if (data && data.models.size > 0) return data;
  } catch {}

  return null;
}

async function getPricingDataCached(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const cached = pricingCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) {
    if (cached.data && !routingReferenceCostCache.has(key)) {
      syncRoutingReferenceCostCache(key, cached.fetchedAt, cached.ttlMs, cached.data);
    }
    return cached.data;
  }

  return fetchPricingDataDeduped(input);
}

async function refreshPricingDataCache(input: EstimateProxyCostInput): Promise<PricingData | null> {
  return fetchPricingDataDeduped(input);
}

function storePricingDataCacheEntry(key: string, data: PricingData | null): void {
  const fetchedAt = Date.now();
  const ttlMs = data ? PRICE_CACHE_TTL_MS : PRICE_CACHE_FAILURE_TTL_MS;
  pricingCache.set(key, {
    fetchedAt,
    ttlMs,
    data,
  });
  syncRoutingReferenceCostCache(key, fetchedAt, ttlMs, data);
}

function fetchPricingDataDeduped(input: EstimateProxyCostInput): Promise<PricingData | null> {
  const key = getCacheKey(input);
  const inFlight = pricingFetchInFlight.get(key);
  if (inFlight) return inFlight;

  const task = (async () => {
    const data = await fetchPricingData(input);
    storePricingDataCacheEntry(key, data);
    return data;
  })();
  pricingFetchInFlight.set(key, task);
  const release = () => {
    if (pricingFetchInFlight.get(key) === task) pricingFetchInFlight.delete(key);
  };
  task.then(release, release);
  return task;
}

function pricingCacheStaleTtlMs(data: PricingData | null): number {
  return data ? PRICE_CACHE_STALE_TTL_MS : PRICE_CACHE_FAILURE_STALE_TTL_MS;
}

/**
 * 只读缓存、绝不发网络请求。给请求路径用：拿到旧数据也比卡一次网络往返强。
 */
export function peekPricingDataCache(input: EstimateProxyCostInput): {
  data: PricingData | null;
  /** 缓存里是否还有可用条目（可能是已过期数据）。 */
  present: boolean;
  /** 条目是否仍在 TTL 内。 */
  fresh: boolean;
} {
  const key = getCacheKey(input);
  const cached = pricingCache.get(key);
  if (!cached) return { data: null, present: false, fresh: false };

  const age = Date.now() - cached.fetchedAt;
  if (age >= pricingCacheStaleTtlMs(cached.data)) {
    return { data: null, present: false, fresh: false };
  }
  if (cached.data && !routingReferenceCostCache.has(key)) {
    syncRoutingReferenceCostCache(key, cached.fetchedAt, cached.ttlMs, cached.data);
  }
  return {
    data: cached.data,
    present: true,
    fresh: age < cached.ttlMs,
  };
}

/**
 * 后台补一次缓存，不等结果。缓存仍新鲜或已有在飞请求时直接返回。
 */
export function schedulePricingDataRefresh(input: EstimateProxyCostInput): void {
  const key = getCacheKey(input);
  const cached = pricingCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < cached.ttlMs) return;
  if (pricingFetchInFlight.has(key)) return;

  void fetchPricingDataDeduped(input).catch(() => {});
}

export function getCachedModelRoutingReferenceCost(input: {
  siteId: number;
  accountId: number;
  modelName: string;
}): number | null {
  const key = `${input.siteId}:${input.accountId}`;
  const cached = routingReferenceCostCache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.fetchedAt >= cached.ttlMs) {
    return null;
  }

  const cost = cached.costs.get(normalizeModelKey(input.modelName));
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0) {
    return null;
  }

  return cost;
}

function resolveModel(modelName: string, data: PricingData): PricingModel | null {
  const exact = data.models.get(modelName);
  if (exact) return exact;

  const lower = modelName.toLowerCase();
  for (const [name, model] of data.models.entries()) {
    if (name.toLowerCase() === lower) return model;
  }

  return null;
}

function resolveGroupMultiplier(model: PricingModel, groupRatio: Record<string, number>): number {
  if (model.enableGroups.includes(DEFAULT_GROUP) && groupRatio[DEFAULT_GROUP]) {
    return groupRatio[DEFAULT_GROUP];
  }

  for (const group of model.enableGroups) {
    if (groupRatio[group]) return groupRatio[group];
  }

  const first = Object.values(groupRatio).find((ratio) => ratio > 0);
  return first || 1;
}

function calculatePerCallCost(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): number {
  if (typeof modelPrice === 'number') {
    return modelPrice * multiplier;
  }

  if (modelPrice && typeof modelPrice === 'object') {
    // done-hub/one-hub times pricing follows input ratio only.
    return toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO;
  }

  return 0;
}

function calculatePerCallPricing(
  modelPrice: number | { input: number; output: number } | null,
  multiplier: number,
): { input?: number; output?: number; total: number } {
  if (typeof modelPrice === 'number') {
    const total = roundCost(modelPrice * multiplier);
    return { total };
  }

  if (modelPrice && typeof modelPrice === 'object') {
    const input = roundCost(toNumber(modelPrice.input, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    const output = roundCost(toNumber(modelPrice.output, 0) * multiplier * ONE_HUB_PER_CALL_RATIO);
    return {
      input,
      output,
      total: input,
    };
  }

  return { total: 0 };
}

function buildPricingOverrideModel(
  modelName: string,
  pricingOverride: ProxyBillingPricingOverride,
): { model: PricingModel; groupRatio: Record<string, number> } {
  const groupRatio = normalizeRatio(pricingOverride.groupRatio, 1);
  return {
    model: {
      modelName,
      quotaType: 0,
      modelRatio: normalizeRatio(pricingOverride.modelRatio, 1),
      completionRatio: normalizeRatio(pricingOverride.completionRatio, 1),
      cacheRatio: normalizeRatio(pricingOverride.cacheRatio, 1),
      cacheCreationRatio: normalizeRatio(pricingOverride.cacheCreationRatio, 1),
      modelPrice: null,
      enableGroups: [DEFAULT_GROUP],
    },
    groupRatio: { [DEFAULT_GROUP]: groupRatio },
  };
}

function normalizeUsageBreakdownInput(usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptTokensIncludeCache?: boolean | null;
}) {
  const promptTokens = toPositiveInt(usage.promptTokens);
  const completionTokens = toPositiveInt(usage.completionTokens);
  const totalTokensRaw = toPositiveInt(usage.totalTokens);
  const totalTokens = Math.max(totalTokensRaw, promptTokens + completionTokens);
  const cacheReadTokens = toPositiveInt(usage.cacheReadTokens);
  const cacheCreationTokens = toPositiveInt(usage.cacheCreationTokens);
  const promptTokensIncludeCache = usage.promptTokensIncludeCache ?? null;
  const hasSplit = promptTokens > 0 || completionTokens > 0;
  const effectivePromptTokens = hasSplit ? promptTokens : totalTokens;
  const billablePromptTokens = promptTokensIncludeCache === false
    ? effectivePromptTokens
    : Math.max(0, effectivePromptTokens - cacheReadTokens - cacheCreationTokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens,
    cacheCreationTokens,
    billablePromptTokens,
    promptTokensIncludeCache,
  };
}

export function calculateModelUsageBreakdown(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
): ProxyBillingDetails | null {
  if (model.quotaType === 1) {
    return null;
  }

  const multiplier = resolveGroupMultiplier(model, groupRatio);
  const normalizedUsage = normalizeUsageBreakdownInput(usage);
  const cacheRatio = model.cacheRatio ?? 1;
  const cacheCreationRatio = model.cacheCreationRatio ?? 1;
  const inputPerMillion = roundCost(model.modelRatio * 2 * multiplier);
  const outputPerMillion = roundCost(model.modelRatio * model.completionRatio * 2 * multiplier);
  const cacheReadPerMillion = roundCost(model.modelRatio * cacheRatio * 2 * multiplier);
  const cacheCreationPerMillion = roundCost(model.modelRatio * cacheCreationRatio * 2 * multiplier);
  const inputCost = roundCost((normalizedUsage.billablePromptTokens / 1_000_000) * inputPerMillion);
  const outputCost = roundCost((normalizedUsage.completionTokens / 1_000_000) * outputPerMillion);
  const cacheReadCost = roundCost((normalizedUsage.cacheReadTokens / 1_000_000) * cacheReadPerMillion);
  const cacheCreationCost = roundCost((normalizedUsage.cacheCreationTokens / 1_000_000) * cacheCreationPerMillion);
  const totalCost = roundCost(inputCost + outputCost + cacheReadCost + cacheCreationCost);

  return {
    quotaType: model.quotaType,
    usage: normalizedUsage,
    pricing: {
      modelRatio: model.modelRatio,
      completionRatio: model.completionRatio,
      cacheRatio,
      cacheCreationRatio,
      groupRatio: multiplier,
    },
    breakdown: {
      inputPerMillion,
      outputPerMillion,
      cacheReadPerMillion,
      cacheCreationPerMillion,
      inputCost,
      outputCost,
      cacheReadCost,
      cacheCreationCost,
      totalCost,
    },
  };
}

export function calculateModelUsageCost(
  model: PricingModel,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    promptTokensIncludeCache?: boolean | null;
  },
  groupRatio: Record<string, number>,
): number {
  const multiplier = resolveGroupMultiplier(model, groupRatio);

  if (model.quotaType === 1) {
    return roundCost(calculatePerCallCost(model.modelPrice, multiplier));
  }

  return calculateModelUsageBreakdown(model, usage, groupRatio)?.breakdown.totalCost ?? 0;
}

/**
 * 解析表达式计费模型的价格。返回 `null` 表示「不是表达式计费」，调用方继续走
 * 倍率逻辑；返回结果里价格为 `null` 表示「是表达式计费但没解析出来」，这时
 * 宁可显示「无价格」也不要用废掉的 model_ratio 编一个假价。
 */
function resolveModelExpressionPricing(model: PricingModel): BillingExpressionPricing | null {
  const expression = model.billingExpr?.trim();
  if (!expression) return null;
  const mode = model.billingMode?.trim();
  if (mode && mode !== 'tiered_expr') return null;

  const resolved = resolveBillingExpressionPricing(expression);
  if (resolved) return resolved;
  return {
    unit: 'token',
    inputPerMillion: null,
    outputPerMillion: null,
    perRequestUsd: null,
    matchedTier: null,
  };
}

function buildExpressionGroupPricing(
  pricing: BillingExpressionPricing,
  multiplier: number,
): ModelGroupPricing {
  if (pricing.unit === 'request') {
    return {
      quotaType: 1,
      perCallTotal: pricing.perRequestUsd === null
        ? undefined
        : roundCost(pricing.perRequestUsd * multiplier),
    };
  }

  return {
    quotaType: 0,
    inputPerMillion: pricing.inputPerMillion === null
      ? undefined
      : roundCost(pricing.inputPerMillion * multiplier),
    outputPerMillion: pricing.outputPerMillion === null
      ? undefined
      : roundCost(pricing.outputPerMillion * multiplier),
  };
}

function buildModelPricingCatalogFromData(pricingData: PricingData): ModelPricingCatalog {
  const groups = Array.from(new Set([DEFAULT_GROUP, ...Object.keys(pricingData.groupRatio)]));
  const defaultMultiplier = pricingData.groupRatio[DEFAULT_GROUP] || 1;

  const models: ModelPricingCatalogEntry[] = Array.from(pricingData.models.values())
    .map((model) => {
      const allowedGroups = Array.from(new Set([...(model.enableGroups || []), DEFAULT_GROUP]));
      const modelGroups = groups.filter((group) => allowedGroups.includes(group));
      const effectiveGroups = modelGroups.length > 0 ? modelGroups : [DEFAULT_GROUP];
      // 表达式计费（tiered_expr）的站点里 model_ratio 是废字段，价格只认
      // billing_expr。整站共用同一份公式，所以每个模型只解一次。
      const expressionPricing = resolveModelExpressionPricing(model);

      const groupPricing = effectiveGroups.reduce<Record<string, ModelGroupPricing>>((acc, group) => {
        const multiplier = pricingData.groupRatio[group] || defaultMultiplier;
        if (expressionPricing) {
          acc[group] = buildExpressionGroupPricing(expressionPricing, multiplier);
          return acc;
        }
        if (model.quotaType === 1) {
          const perCall = calculatePerCallPricing(model.modelPrice, multiplier);
          acc[group] = {
            quotaType: 1,
            perCallInput: perCall.input,
            perCallOutput: perCall.output,
            perCallTotal: perCall.total,
          };
          return acc;
        }

        acc[group] = {
          quotaType: 0,
          inputPerMillion: roundCost(model.modelRatio * 2 * multiplier),
          outputPerMillion: roundCost(model.modelRatio * model.completionRatio * 2 * multiplier),
          cacheReadPerMillion: roundCost(model.modelRatio * (model.cacheRatio ?? 1) * 2 * multiplier),
          cacheCreationPerMillion: roundCost(model.modelRatio * (model.cacheCreationRatio ?? 1) * 2 * multiplier),
        };
        return acc;
      }, {});

      return {
        modelName: model.modelName,
        // 表达式计费可能是「按次」（fixed），这时对外的 quotaType 也要跟着变。
        quotaType: expressionPricing?.unit === 'request' ? 1 : model.quotaType,
        modelDescription: model.modelDescription || null,
        tags: model.tags || [],
        supportedEndpointTypes: model.supportedEndpointTypes || [],
        ownerBy: model.ownerBy || null,
        enableGroups: model.enableGroups || [DEFAULT_GROUP],
        groupPricing,
      };
    })
    .sort((a, b) => a.modelName.localeCompare(b.modelName));

  return {
    models,
    groupRatio: pricingData.groupRatio,
  };
}

/**
 * 读整个站点的价目表只需要「哪一站 + 用哪份凭据 + 什么平台」；模型名只有
 * 在估算某一次调用的成本时才用得上，所以这里不强制要求。
 */
export type ModelPricingCatalogInput = Omit<EstimateProxyCostInput, 'modelName'> & {
  /** 只有估算单次调用成本时才用得上；读整站价目表时可以不给。 */
  modelName?: string;
};

export type ModelPricingCatalogOptions = {
  /**
   * 只读内存缓存、绝不发网络请求。代理请求路径上判断端点顺序时用它：
   * 缓存缺失或过期就先按默认顺序走，同时在后台补一次。
   * 默认（false）会等待一次抓取，适合响应结束后的成本估算。
   */
  cacheOnly?: boolean;
};

export async function fetchModelPricingCatalog(
  input: ModelPricingCatalogInput,
  options: ModelPricingCatalogOptions = {},
): Promise<ModelPricingCatalog | null> {
  const pricingInput = { ...input, modelName: '' };
  if (options.cacheOnly) {
    const peeked = peekPricingDataCache(pricingInput);
    if (!peeked.fresh) schedulePricingDataRefresh(pricingInput);
    return peeked.data ? buildModelPricingCatalogFromData(peeked.data) : null;
  }

  const pricingData = await getPricingDataCached(pricingInput);
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

export async function refreshModelPricingCatalog(input: ModelPricingCatalogInput): Promise<ModelPricingCatalog | null> {
  const pricingData = await refreshPricingDataCache({ ...input, modelName: '' });
  if (!pricingData) return null;
  return buildModelPricingCatalogFromData(pricingData);
}

export function fallbackTokenCost(totalTokens: number, platform: string): number {
  const divisor = platform === 'veloera' ? 1_000_000 : 500_000;
  return roundCost(toPositiveInt(totalTokens) / divisor);
}

export async function estimateProxyCost(input: EstimateProxyCostInput): Promise<number> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      return calculateModelUsageCost(pricingOverride.model, usage, pricingOverride.groupRatio);
    }

    const pricingData = await getPricingDataCached(input);
    if (!pricingData) {
      return fallbackTokenCost(totalTokens, input.site.platform);
    }

    const model = resolveModel(input.modelName, pricingData);
    if (!model) {
      return fallbackTokenCost(totalTokens, input.site.platform);
    }

    return calculateModelUsageCost(model, usage, pricingData.groupRatio);
  } catch {
    return fallbackTokenCost(totalTokens, input.site.platform);
  }
}

async function fetchJsonViaNewApiShield(url: string, token: string): Promise<unknown> {
  for (const cookie of buildNewApiCookieCandidates(token)) {
    const result = await fetchJsonWithShieldCookieRetry(url, {
      headers: { Cookie: cookie },
    });
    if (result.data) return result.data;
  }

  return null;
}

export async function buildProxyBillingDetails(input: EstimateProxyCostInput): Promise<ProxyBillingDetails | null> {
  const promptTokens = toPositiveInt(input.promptTokens);
  const completionTokens = toPositiveInt(input.completionTokens);
  const totalTokens = toPositiveInt(input.totalTokens || (promptTokens + completionTokens));
  const usage = {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheCreationTokens: input.cacheCreationTokens,
    promptTokensIncludeCache: input.promptTokensIncludeCache,
  };

  try {
    if (input.billingPricingOverride) {
      const pricingOverride = buildPricingOverrideModel(input.modelName, input.billingPricingOverride);
      return calculateModelUsageBreakdown(pricingOverride.model, usage, pricingOverride.groupRatio);
    }

    const pricingData = await getPricingDataCached(input);
    if (!pricingData) return null;

    const model = resolveModel(input.modelName, pricingData);
    if (!model || model.quotaType === 1) return null;

    return calculateModelUsageBreakdown(model, usage, pricingData.groupRatio);
  } catch {
    return null;
  }
}
