import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import { ACCOUNT_TOKEN_VALUE_STATUS_READY, isUsableAccountToken } from './accountTokenService.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';

export class ModelForwardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelForwardError';
  }
}

/**
 * 转发规则生成的 token_routes 使用保留前缀作为 model_pattern，避免与「路由」页面里的
 * 普通路由（含同名老路由）发生精确匹配冲突；对外暴露的模型名放在 display_name 上。
 * 前缀同时保证 patternRouteChannelSyncService 不会把其它路由的通道复制进来。
 */
export const FORWARD_ROUTE_PATTERN_PREFIX = 'forward:';

export function buildForwardRoutePattern(modelName: string): string {
  return `${FORWARD_ROUTE_PATTERN_PREFIX}${modelName.trim()}`;
}

export function isForwardRoutePattern(modelPattern: string | null | undefined): boolean {
  return (modelPattern || '').trim().toLowerCase().startsWith(FORWARD_ROUTE_PATTERN_PREFIX);
}

export type ModelForwardTargetInput = {
  siteId: number;
  accountId: number;
  upstreamModel: string;
  tokenId?: number | null;
  weight?: number | null;
  enabled?: boolean | null;
};

export type ModelForwardRuleInput = {
  modelName: string;
  enabled?: boolean | null;
  notes?: string | null;
  targets: ModelForwardTargetInput[];
};

export type ModelForwardTargetRow = {
  id: number;
  ruleId: number;
  siteId: number;
  siteName: string | null;
  accountId: number;
  accountUsername: string | null;
  accountStatus: string | null;
  tokenId: number | null;
  tokenName: string | null;
  upstreamModel: string;
  channelId: number | null;
  weight: number;
  enabled: boolean;
  sortOrder: number;
  channelEnabled: boolean | null;
  cooldownUntil: string | null;
  successCount: number | null;
  failCount: number | null;
  lastUsedAt: string | null;
};

export type ModelForwardRuleRow = {
  id: number;
  modelName: string;
  enabled: boolean;
  notes: string | null;
  routeId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  targets: ModelForwardTargetRow[];
};

function normalizeModelName(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 对外模型名按大小写不敏感查重：`gpt-6-astra` 与 `GPT-6-Astra` 视为同一个对外模型，
 * 避免出现两条规则抢同一个模型名（数据库唯一索引只按原始大小写比较，挡不住这种情况）。
 */
async function findRuleByModelName(modelName: string): Promise<{ id: number; modelName: string } | null> {
  const normalized = modelName.trim().toLowerCase();
  if (!normalized) return null;
  const row = await db.select({ id: schema.modelForwardRules.id, modelName: schema.modelForwardRules.modelName })
    .from(schema.modelForwardRules)
    .where(sql`lower(${schema.modelForwardRules.modelName}) = ${normalized}`)
    .get();
  return row ?? null;
}

function normalizePositiveInt(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function normalizeWeight(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 10;
  return Math.min(10000, Math.max(1, Math.round(numeric)));
}

function normalizeTargets(raw: unknown): ModelForwardTargetInput[] {
  if (!Array.isArray(raw)) throw new ModelForwardError('转发目标必须是数组');
  const normalized: ModelForwardTargetInput[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = (item ?? {}) as Record<string, unknown>;
    const siteId = normalizePositiveInt(entry.siteId);
    const accountId = normalizePositiveInt(entry.accountId);
    const upstreamModel = normalizeModelName(entry.upstreamModel);
    if (!siteId) throw new ModelForwardError('转发目标缺少站点');
    if (!accountId) throw new ModelForwardError('转发目标缺少账号');
    if (!upstreamModel) throw new ModelForwardError('转发目标缺少上游模型名');
    const tokenId = entry.tokenId === null || entry.tokenId === undefined
      ? null
      : normalizePositiveInt(entry.tokenId);
    const key = `${accountId}::${upstreamModel.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      siteId,
      accountId,
      tokenId,
      upstreamModel,
      weight: normalizeWeight(entry.weight),
      enabled: entry.enabled === undefined || entry.enabled === null ? true : !!entry.enabled,
    });
  }
  if (normalized.length === 0) throw new ModelForwardError('至少需要一个转发目标');
  return normalized;
}

export function normalizeModelForwardRuleInput(raw: unknown): ModelForwardRuleInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const modelName = normalizeModelName(body.modelName);
  if (!modelName) throw new ModelForwardError('对外模型名不能为空');
  if (/\s/.test(modelName)) throw new ModelForwardError('对外模型名不能包含空格');
  return {
    modelName,
    enabled: body.enabled === undefined || body.enabled === null ? true : !!body.enabled,
    notes: typeof body.notes === 'string' ? body.notes.trim() || null : null,
    targets: normalizeTargets(body.targets),
  };
}

/** 为账号挑一个可用令牌：优先默认令牌，其次支持该上游模型的令牌。 */
async function resolveAccountTokenId(accountId: number, upstreamModel: string): Promise<number | null> {
  const tokens = await db.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .all();
  const usable = tokens.filter((token) => isUsableAccountToken(token));
  if (usable.length === 0) {
    const fallback = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.accountId, accountId))
      .all();
    return fallback.find((token) => token.isDefault)?.id ?? fallback[0]?.id ?? null;
  }
  if (usable.length === 1) return usable[0].id;

  const availability = await db.select().from(schema.tokenModelAvailability)
    .where(and(
      inArray(schema.tokenModelAvailability.tokenId, usable.map((token) => token.id)),
      eq(schema.tokenModelAvailability.available, true),
    ))
    .all();
  const supportsModel = new Set(
    availability
      .filter((row) => row.modelName.trim().toLowerCase() === upstreamModel.trim().toLowerCase())
      .map((row) => row.tokenId),
  );
  return usable.find((token) => supportsModel.has(token.id) && token.isDefault)?.id
    ?? usable.find((token) => supportsModel.has(token.id))?.id
    ?? usable.find((token) => token.isDefault)?.id
    ?? usable[0].id;
}

async function ensureForwardRoute(input: {
  ruleId: number;
  modelName: string;
  enabled: boolean;
  fallbackUpstreamModel: string;
}): Promise<number> {
  const modelPattern = buildForwardRoutePattern(input.modelName);
  const modelMapping = JSON.stringify({ [input.modelName]: input.fallbackUpstreamModel });
  const existing = await db.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.modelPattern, modelPattern))
    .get();
  const nowIso = new Date().toISOString();
  if (existing) {
    await db.update(schema.tokenRoutes).set({
      displayName: input.modelName,
      modelMapping,
      enabled: input.enabled,
      routeMode: 'pattern',
      routingStrategy: 'weighted',
      updatedAt: nowIso,
    }).where(eq(schema.tokenRoutes.id, existing.id)).run();
    return existing.id;
  }
  const inserted = await db.insert(schema.tokenRoutes).values({
    modelPattern,
    displayName: input.modelName,
    modelMapping,
    routeMode: 'pattern',
    routingStrategy: 'weighted',
    enabled: input.enabled,
  }).run();
  return requireInsertedRowId(inserted, '创建转发路由失败');
}

/**
 * 把一条转发规则同步成 routing 层可用的 token_routes + route_channels。
 * 通道一律 manual_override=1，自动重建不会删除或覆盖它们。
 */
export async function syncModelForwardRule(ruleId: number): Promise<void> {
  const rule = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, ruleId))
    .get();
  if (!rule) throw new ModelForwardError('转发规则不存在');

  const targetRows = await db.select().from(schema.modelForwardTargets)
    .where(eq(schema.modelForwardTargets.ruleId, ruleId))
    .orderBy(asc(schema.modelForwardTargets.sortOrder), asc(schema.modelForwardTargets.id))
    .all();

  const enabledTargets = targetRows.filter((target) => target.enabled);
  const fallbackUpstreamModel = (enabledTargets[0] ?? targetRows[0])?.upstreamModel || rule.modelName;
  const routeId = await ensureForwardRoute({
    ruleId,
    modelName: rule.modelName,
    enabled: !!rule.enabled,
    fallbackUpstreamModel,
  });

  if (rule.routeId !== routeId) {
    await db.update(schema.modelForwardRules).set({ routeId }).where(eq(schema.modelForwardRules.id, ruleId)).run();
  }

  const existingChannels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();
  const channelById = new Map(existingChannels.map((channel) => [channel.id, channel]));
  const nowIso = new Date().toISOString();
  const keptChannelIds = new Set<number>();

  for (const [index, target] of targetRows.entries()) {
    const tokenId = target.tokenId ?? await resolveAccountTokenId(target.accountId, target.upstreamModel);
    const enabled = !!target.enabled && !!rule.enabled;
    // 排序即优先级：列表越靠前的目标越先被选中，靠前目标不可用（停用/冷却/失败）时才落到下一个。
    const priority = index;
    if (target.channelId && channelById.has(target.channelId)) {
      const channelId = target.channelId;
      keptChannelIds.add(channelId);
      await db.update(schema.routeChannels).set({
        accountId: target.accountId,
        tokenId,
        sourceModel: target.upstreamModel,
        priority,
        weight: target.weight ?? 10,
        enabled,
        manualOverride: true,
      }).where(eq(schema.routeChannels.id, channelId)).run();
      if (target.tokenId !== tokenId) {
        await db.update(schema.modelForwardTargets).set({ tokenId, updatedAt: nowIso })
          .where(eq(schema.modelForwardTargets.id, target.id)).run();
      }
      continue;
    }
    const inserted = await db.insert(schema.routeChannels).values({
      routeId,
      accountId: target.accountId,
      tokenId,
      sourceModel: target.upstreamModel,
      priority,
      weight: target.weight ?? 10,
      enabled,
      manualOverride: true,
    }).run();
    const channelId = requireInsertedRowId(inserted, '创建转发通道失败');
    keptChannelIds.add(channelId);
    await db.update(schema.modelForwardTargets).set({ channelId, tokenId, updatedAt: nowIso })
      .where(eq(schema.modelForwardTargets.id, target.id)).run();
  }

  // 清理已不再使用的通道（只删本规则自己创建的 manual_override 通道）
  for (const channel of existingChannels) {
    if (keptChannelIds.has(channel.id)) continue;
    if (!channel.manualOverride) continue;
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
  }

  // 顺序即调用顺序：刚改完 priority / 启停用就要立即生效，
  // 不能等路由器那份 1.5s 的进程内缓存自己过期。
  invalidateTokenRouterCache();
}

export async function listModelForwardRules(): Promise<ModelForwardRuleRow[]> {
  const rules = await db.select().from(schema.modelForwardRules)
    .orderBy(asc(schema.modelForwardRules.id))
    .all();
  if (rules.length === 0) return [];

  const targets = await db.select({
    target: schema.modelForwardTargets,
    site: schema.sites,
    account: schema.accounts,
    token: schema.accountTokens,
    channel: schema.routeChannels,
  }).from(schema.modelForwardTargets)
    .innerJoin(schema.sites, eq(schema.modelForwardTargets.siteId, schema.sites.id))
    .innerJoin(schema.accounts, eq(schema.modelForwardTargets.accountId, schema.accounts.id))
    .leftJoin(schema.accountTokens, eq(schema.modelForwardTargets.tokenId, schema.accountTokens.id))
    .leftJoin(schema.routeChannels, eq(schema.modelForwardTargets.channelId, schema.routeChannels.id))
    .where(inArray(schema.modelForwardTargets.ruleId, rules.map((rule) => rule.id)))
    .orderBy(asc(schema.modelForwardTargets.sortOrder), asc(schema.modelForwardTargets.id))
    .all();

  const targetsByRuleId = new Map<number, ModelForwardTargetRow[]>();
  for (const row of targets) {
    const list = targetsByRuleId.get(row.target.ruleId) ?? [];
    list.push({
      id: row.target.id,
      ruleId: row.target.ruleId,
      siteId: row.target.siteId,
      siteName: row.site?.name ?? null,
      accountId: row.target.accountId,
      accountUsername: row.account?.username ?? null,
      accountStatus: row.account?.status ?? null,
      tokenId: row.target.tokenId ?? null,
      tokenName: row.token?.name ?? null,
      upstreamModel: row.target.upstreamModel,
      channelId: row.target.channelId ?? null,
      weight: row.target.weight ?? 10,
      enabled: !!row.target.enabled,
      sortOrder: row.target.sortOrder ?? 0,
      channelEnabled: row.channel ? !!row.channel.enabled : null,
      cooldownUntil: row.channel?.cooldownUntil ?? null,
      successCount: row.channel?.successCount ?? null,
      failCount: row.channel?.failCount ?? null,
      lastUsedAt: row.channel?.lastUsedAt ?? null,
    });
    targetsByRuleId.set(row.target.ruleId, list);
  }

  return rules.map((rule) => ({
    id: rule.id,
    modelName: rule.modelName,
    enabled: !!rule.enabled,
    notes: rule.notes ?? null,
    routeId: rule.routeId ?? null,
    createdAt: rule.createdAt ?? null,
    updatedAt: rule.updatedAt ?? null,
    targets: targetsByRuleId.get(rule.id) ?? [],
  }));
}

export async function createModelForwardRule(raw: unknown): Promise<ModelForwardRuleRow> {
  const input = normalizeModelForwardRuleInput(raw);
  const existing = await findRuleByModelName(input.modelName);
  if (existing) {
    throw new ModelForwardError(`对外模型 ${existing.modelName} 已经有转发规则，模型名不能重复`);
  }

  const inserted = await db.insert(schema.modelForwardRules).values({
    modelName: input.modelName,
    enabled: input.enabled ?? true,
    notes: input.notes ?? null,
  }).run();
  const ruleId = requireInsertedRowId(inserted, '创建转发规则失败');

  await db.insert(schema.modelForwardTargets).values(input.targets.map((target, index) => ({
    ruleId,
    siteId: target.siteId,
    accountId: target.accountId,
    tokenId: target.tokenId ?? null,
    upstreamModel: target.upstreamModel,
    weight: target.weight ?? 10,
    enabled: target.enabled ?? true,
    sortOrder: index,
  }))).run();

  await syncModelForwardRule(ruleId);
  const created = (await listModelForwardRules()).find((rule) => rule.id === ruleId);
  if (!created) throw new ModelForwardError('创建转发规则失败');
  return created;
}

export async function updateModelForwardRule(id: number, raw: unknown): Promise<ModelForwardRuleRow> {
  const existing = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, id))
    .get();
  if (!existing) throw new ModelForwardError('转发规则不存在');
  const input = normalizeModelForwardRuleInput(raw);
  const duplicated = await findRuleByModelName(input.modelName);
  if (duplicated && duplicated.id !== id) {
    throw new ModelForwardError(`对外模型 ${duplicated.modelName} 已经有转发规则，模型名不能重复`);
  }

  await db.update(schema.modelForwardRules).set({
    modelName: input.modelName,
    enabled: input.enabled ?? true,
    notes: input.notes ?? null,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.modelForwardRules.id, id)).run();

  const previousTargets = await db.select().from(schema.modelForwardTargets)
    .where(eq(schema.modelForwardTargets.ruleId, id))
    .all();
  const reusable = new Map<string, typeof previousTargets[number]>(
    previousTargets.map((target) => [
      `${target.accountId}::${target.upstreamModel.trim().toLowerCase()}`,
      target,
    ] as [string, typeof previousTargets[number]]),
  );
  const nextKeys = new Set(input.targets.map((target) => `${target.accountId}::${target.upstreamModel.toLowerCase()}`));

  for (const target of previousTargets) {
    const key = `${target.accountId}::${target.upstreamModel.trim().toLowerCase()}`;
    if (nextKeys.has(key)) continue;
    if (target.channelId) {
      await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, target.channelId)).run();
    }
    await db.delete(schema.modelForwardTargets).where(eq(schema.modelForwardTargets.id, target.id)).run();
  }

  for (const [index, target] of input.targets.entries()) {
    const key = `${target.accountId}::${target.upstreamModel.toLowerCase()}`;
    const matched = reusable.get(key);
    if (matched) {
      await db.update(schema.modelForwardTargets).set({
        siteId: target.siteId,
        tokenId: target.tokenId ?? null,
        weight: target.weight ?? 10,
        enabled: target.enabled ?? true,
        sortOrder: index,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.modelForwardTargets.id, matched.id)).run();
      continue;
    }
    await db.insert(schema.modelForwardTargets).values({
      ruleId: id,
      siteId: target.siteId,
      accountId: target.accountId,
      tokenId: target.tokenId ?? null,
      upstreamModel: target.upstreamModel,
      weight: target.weight ?? 10,
      enabled: target.enabled ?? true,
      sortOrder: index,
    }).run();
  }

  await syncModelForwardRule(id);
  const updated = (await listModelForwardRules()).find((rule) => rule.id === id);
  if (!updated) throw new ModelForwardError('更新转发规则失败');
  return updated;
}

export type ModelForwardTargetMoveAction = 'up' | 'down' | 'top';

/** 站点里挑一个可用账号：优先 active + 有可用令牌的，其次第一个 active。 */
async function pickSiteAccountId(siteId: number): Promise<number | null> {
  const rows = await db.select({ account: schema.accounts, token: schema.accountTokens })
    .from(schema.accounts)
    .leftJoin(schema.accountTokens, and(
      eq(schema.accountTokens.accountId, schema.accounts.id),
      eq(schema.accountTokens.isDefault, true),
    ))
    .where(eq(schema.accounts.siteId, siteId))
    .orderBy(asc(schema.accounts.id))
    .all();
  const active = rows.filter((row) => row.account.status === 'active');
  const pool = active.length > 0 ? active : rows;
  const usable = pool.find((row) => row.token && isUsableAccountToken(row.token));
  return (usable ?? pool[0])?.account.id ?? null;
}

export type ModelForwardAttachInput = {
  siteId: number;
  upstreamModel: string;
  modelName: string;
  accountId?: number | null;
};

export type ModelForwardAttachResult = {
  created: boolean;
  rule: ModelForwardRuleRow;
};

/**
 * 把「某个站点的某个模型」挂到对外模型转发的末尾（模型监控页的一键操作）。
 * - 对外模型已有规则 → 追加一个目标，sortOrder 放到最后（优先级最低，兜底用）；
 * - 对外模型还没有规则 → 顺手建一条，只有这一个目标；
 * - 同一个账号 + 同一个上游模型已经在规则里 → 直接报错，不重复挂。
 */
export async function attachModelForwardTarget(raw: unknown): Promise<ModelForwardAttachResult> {
  const body = (raw ?? {}) as Record<string, unknown>;
  const siteId = normalizePositiveInt(body.siteId);
  const upstreamModel = normalizeModelName(body.upstreamModel);
  const modelName = normalizeModelName(body.modelName);
  if (!siteId) throw new ModelForwardError('缺少站点');
  if (!upstreamModel) throw new ModelForwardError('缺少要挂载的模型名');
  if (!modelName) throw new ModelForwardError('请选择或填写要挂到的对外模型名');

  const requestedAccountId = normalizePositiveInt(body.accountId);
  const accountId = requestedAccountId ?? await pickSiteAccountId(siteId);
  if (!accountId) throw new ModelForwardError('该站点下没有可用账号，先在「账号」页面添加');
  const account = await db.select().from(schema.accounts)
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!account) throw new ModelForwardError('账号不存在');
  if (account.siteId !== siteId) throw new ModelForwardError('账号不属于该站点');

  const existingRule = await findRuleByModelName(modelName);
  if (!existingRule) {
    const created = await createModelForwardRule({
      modelName,
      enabled: true,
      targets: [{ siteId, accountId, upstreamModel }],
    });
    return { created: true, rule: created };
  }

  const rule = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, existingRule.id))
    .get();
  if (!rule) throw new ModelForwardError('转发规则不存在');

  const targets = await db.select().from(schema.modelForwardTargets)
    .where(eq(schema.modelForwardTargets.ruleId, rule.id))
    .orderBy(asc(schema.modelForwardTargets.sortOrder), asc(schema.modelForwardTargets.id))
    .all();
  const normalizedUpstream = upstreamModel.toLowerCase();
  const duplicated = targets.find((target) => (
    target.accountId === accountId
    && target.upstreamModel.trim().toLowerCase() === normalizedUpstream
  ));
  if (duplicated) {
    throw new ModelForwardError(`「${rule.modelName}」下已经有 ${upstreamModel} 这个转发目标了，不能重复添加`);
  }

  const nextSortOrder = targets.reduce((max, target) => Math.max(max, target.sortOrder ?? 0), -1) + 1;
  await db.insert(schema.modelForwardTargets).values({
    ruleId: rule.id,
    siteId,
    accountId,
    tokenId: null,
    upstreamModel,
    weight: 10,
    enabled: true,
    sortOrder: nextSortOrder,
  }).run();

  await syncModelForwardRule(rule.id);
  const updated = (await listModelForwardRules()).find((item) => item.id === rule.id);
  if (!updated) throw new ModelForwardError('挂载转发目标失败');
  return { created: false, rule: updated };
}

/** 按当前顺序重排 sortOrder，保证是 0..n-1 的连续整数。 */
async function renumberTargetSortOrders(ruleId: number): Promise<void> {
  const rows = await db.select({ id: schema.modelForwardTargets.id })
    .from(schema.modelForwardTargets)
    .where(eq(schema.modelForwardTargets.ruleId, ruleId))
    .orderBy(asc(schema.modelForwardTargets.sortOrder), asc(schema.modelForwardTargets.id))
    .all();
  const nowIso = new Date().toISOString();
  for (const [index, row] of rows.entries()) {
    await db.update(schema.modelForwardTargets)
      .set({ sortOrder: index, updatedAt: nowIso })
      .where(eq(schema.modelForwardTargets.id, row.id))
      .run();
  }
}

/**
 * 调整某个转发目标的位置：上移 / 下移 / 置顶。
 * 顺序会同步到通道的 priority，列表越靠前越先被选中。
 */
export async function moveModelForwardTarget(
  ruleId: number,
  targetId: number,
  action: ModelForwardTargetMoveAction,
): Promise<ModelForwardRuleRow> {
  const rule = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, ruleId))
    .get();
  if (!rule) throw new ModelForwardError('转发规则不存在');

  const targets = await db.select().from(schema.modelForwardTargets)
    .where(eq(schema.modelForwardTargets.ruleId, ruleId))
    .orderBy(asc(schema.modelForwardTargets.sortOrder), asc(schema.modelForwardTargets.id))
    .all();
  const index = targets.findIndex((target) => target.id === targetId);
  if (index < 0) throw new ModelForwardError('转发目标不存在');

  const nextIndex = action === 'top' ? 0 : action === 'up' ? Math.max(0, index - 1) : Math.min(targets.length - 1, index + 1);
  if (nextIndex !== index) {
    const reordered = [...targets];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(nextIndex, 0, moved);
    const nowIso = new Date().toISOString();
    for (const [order, target] of reordered.entries()) {
      await db.update(schema.modelForwardTargets)
        .set({ sortOrder: order, updatedAt: nowIso })
        .where(eq(schema.modelForwardTargets.id, target.id))
        .run();
    }
  }

  await renumberTargetSortOrders(ruleId);
  await syncModelForwardRule(ruleId);
  const updated = (await listModelForwardRules()).find((item) => item.id === ruleId);
  if (!updated) throw new ModelForwardError('更新转发目标失败');
  return updated;
}

/** 单独启用 / 停用某个转发目标（不影响同规则下的其它目标）。 */
export async function setModelForwardTargetEnabled(
  ruleId: number,
  targetId: number,
  enabled: boolean,
): Promise<ModelForwardRuleRow> {
  const rule = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, ruleId))
    .get();
  if (!rule) throw new ModelForwardError('转发规则不存在');
  const target = await db.select().from(schema.modelForwardTargets)
    .where(and(
      eq(schema.modelForwardTargets.id, targetId),
      eq(schema.modelForwardTargets.ruleId, ruleId),
    ))
    .get();
  if (!target) throw new ModelForwardError('转发目标不存在');
  await db.update(schema.modelForwardTargets).set({
    enabled,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.modelForwardTargets.id, targetId)).run();
  await syncModelForwardRule(ruleId);
  const updated = (await listModelForwardRules()).find((item) => item.id === ruleId);
  if (!updated) throw new ModelForwardError('更新转发目标失败');
  return updated;
}

export async function setModelForwardRuleEnabled(id: number, enabled: boolean): Promise<ModelForwardRuleRow> {
  const existing = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, id))
    .get();
  if (!existing) throw new ModelForwardError('转发规则不存在');
  await db.update(schema.modelForwardRules).set({
    enabled,
    updatedAt: new Date().toISOString(),
  }).where(eq(schema.modelForwardRules.id, id)).run();
  await syncModelForwardRule(id);
  const updated = (await listModelForwardRules()).find((rule) => rule.id === id);
  if (!updated) throw new ModelForwardError('更新转发规则失败');
  return updated;
}

export async function deleteModelForwardRule(id: number): Promise<void> {
  const existing = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, id))
    .get();
  if (!existing) throw new ModelForwardError('转发规则不存在');
  const targets = await db.select().from(schema.modelForwardTargets)
    .where(eq(schema.modelForwardTargets.ruleId, id))
    .all();
  const channelIds = targets
    .map((target) => target.channelId)
    .filter((channelId): channelId is number => typeof channelId === 'number' && channelId > 0);
  if (channelIds.length > 0) {
    await db.delete(schema.routeChannels).where(inArray(schema.routeChannels.id, channelIds)).run();
  }
  const routeId = existing.routeId;
  await db.delete(schema.modelForwardRules).where(eq(schema.modelForwardRules.id, id)).run();
  if (routeId) {
    const remainingTargets = await db.select().from(schema.modelForwardTargets)
      .where(eq(schema.modelForwardTargets.ruleId, id))
      .all();
    if (remainingTargets.length === 0) {
      await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).run();
    }
  }
  // 通道被删掉了，进程内的路由快照也必须一并丢。
  invalidateTokenRouterCache();
}

/** 站点下的账号与可用模型，供新页面下拉选择。 */
export async function listModelForwardOptions(siteId?: number | null): Promise<{
  sites: Array<{ id: number; name: string; url: string; status: string }>;
  accounts: Array<{ id: number; siteId: number; username: string | null; status: string; tokenId: number | null; tokenName: string | null }>;
  models: string[];
}> {
  const sites = await db.select().from(schema.sites).orderBy(asc(schema.sites.sortOrder), asc(schema.sites.id)).all();
  const accountQuery = db.select({
    account: schema.accounts,
    token: schema.accountTokens,
  }).from(schema.accounts)
    .leftJoin(schema.accountTokens, and(
      eq(schema.accountTokens.accountId, schema.accounts.id),
      eq(schema.accountTokens.isDefault, true),
    ));
  const accountRows = await (siteId
    ? accountQuery.where(eq(schema.accounts.siteId, siteId))
    : accountQuery)
    .orderBy(asc(schema.accounts.id))
    .all();

  let models: string[] = [];
  if (siteId) {
    const modelRows = await db.select({ modelName: schema.tokenModelAvailability.modelName })
      .from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .where(and(
        eq(schema.accounts.siteId, siteId),
        eq(schema.tokenModelAvailability.available, true),
      ))
      .all();
    const uniqueModels = new Set<string>();
    for (const row of modelRows) {
      const modelName = String(row.modelName ?? '').trim();
      if (modelName) uniqueModels.add(modelName);
    }
    models = Array.from(uniqueModels).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  return {
    sites: sites.map((site) => ({ id: site.id, name: site.name, url: site.url, status: site.status })),
    accounts: accountRows.map((row) => ({
      id: row.account.id,
      siteId: row.account.siteId,
      username: row.account.username ?? null,
      status: row.account.status,
      tokenId: row.token?.id ?? null,
      tokenName: row.token?.name ?? null,
    })),
    models,
  };
}
