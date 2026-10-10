import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  ModelForwardError,
  listModelForwardRules,
  type ModelForwardRuleRow,
} from '../services/modelForwardService.js';
import { invalidateTokenRouterCache } from '../services/tokenRouter.js';
import { readEdgeLocalSetting, writeEdgeLocalSetting } from './logArchive.js';

/**
 * 边缘版（exe）本机的转发顺序 / 启停。
 *
 * 服务器仍然是唯一的配置源，但「这台机器先用哪个源」是本机的转发开关：页面上点
 * 置顶 / 上移 / 下移 / 停用之后立即对本机转发生效，不用回服务器。
 *
 * 冲突处理：本机改动记在 `edge_forward_local_edit`，同时记下它基于的服务器快照指纹
 * （`edge_forward_source_hash`，每次成功同步都会刷新）。下次同步发现指纹不一致 =
 * 服务器上的模型转发规则改过 → 本机改动整份作废，永远以服务器为准。
 */

/** 本机顺序 / 启停的存档键（落在数据目录的 edge-logs.db，重启后还在）。 */
const LOCAL_EDIT_SETTING_KEY = 'edge_forward_local_edit';

/** 当前镜像对应的服务器快照指纹。 */
const SOURCE_HASH_SETTING_KEY = 'edge_forward_source_hash';

type LocalRuleEdit = {
  /** 这条规则下目标的完整期望顺序（target id）。 */
  order: number[];
  /** targetId -> enabled，只记被本机改过的目标。 */
  enabled: Record<string, boolean>;
  /** 规则本身的启用状态。 */
  ruleEnabled: boolean;
};

type LocalEditState = { rules: Record<string, LocalRuleEdit> };

function readEditState(): LocalEditState {
  const raw = readEdgeLocalSetting(LOCAL_EDIT_SETTING_KEY);
  if (!raw) return { rules: {} };
  try {
    const parsed = JSON.parse(raw) as { rules?: Record<string, Partial<LocalRuleEdit>> } | null;
    const rules: Record<string, LocalRuleEdit> = {};
    for (const [key, value] of Object.entries(parsed?.rules ?? {})) {
      const order = Array.isArray(value?.order)
        ? value.order
          .map((id) => Number(id))
          .filter((id) => Number.isSafeInteger(id) && id > 0)
        : [];
      const enabled: Record<string, boolean> = {};
      for (const [targetId, flag] of Object.entries(value?.enabled ?? {})) {
        if (typeof flag === 'boolean') enabled[targetId] = flag;
      }
      rules[key] = {
        order,
        enabled,
        ruleEnabled: value?.ruleEnabled !== false,
      };
    }
    return { rules };
  } catch {
    // 存档坏了就当没有本地改动：宁可回到服务器顺序，也不能让页面读不出规则。
    return { rules: {} };
  }
}

function writeEditState(state: LocalEditState): void {
  writeEdgeLocalSetting(LOCAL_EDIT_SETTING_KEY, JSON.stringify(state));
}

async function readRuleTargets(ruleId: number) {
  return await db.select().from(schema.modelForwardTargets)
    .where(eq(schema.modelForwardTargets.ruleId, ruleId))
    .orderBy(asc(schema.modelForwardTargets.sortOrder), asc(schema.modelForwardTargets.id))
    .all();
}

async function requireRuleRow(ruleId: number) {
  const rule = await db.select().from(schema.modelForwardRules)
    .where(eq(schema.modelForwardRules.id, ruleId))
    .get();
  if (!rule) throw new ModelForwardError('本机镜像里没有这条转发规则（服务器上可能已删除），请先「从服务器同步」。');
  return rule;
}

/**
 * 把镜像里的 `model_forward_targets` 顺序 / 启停同步到真正决定派发的两张表：
 * `route_channels`（顺序即 priority，停用即 enabled）与 `token_routes`（规则开关）。
 * 落地后立刻失效路由器缓存，所以点完按钮下一次请求就按新顺序走。
 */
async function syncRuleMirrorToChannels(ruleId: number): Promise<void> {
  const rule = await requireRuleRow(ruleId);
  const targets = await readRuleTargets(ruleId);

  if (rule.routeId != null) {
    await db.update(schema.tokenRoutes).set({ enabled: !!rule.enabled })
      .where(eq(schema.tokenRoutes.id, rule.routeId)).run();
  }

  for (const [index, target] of targets.entries()) {
    if (target.channelId == null) continue;
    await db.update(schema.routeChannels).set({
      priority: index,
      enabled: !!target.enabled && !!rule.enabled,
      // 手动改顺序就是人工拍板：顺手清掉历史降级 / 连续失败状态，
      // 免得页面上的计数和实际派发顺序对不上。
      consecutiveUpstreamFailures: 0,
      autoDemotedAt: null,
      priorityBeforeAutoDemotion: null,
    }).where(eq(schema.routeChannels.id, target.channelId)).run();
  }

  invalidateTokenRouterCache();
}

/** 按本地记录把某条规则的顺序 / 启停写回镜像，再对齐通道。 */
async function applyLocalEditForRule(ruleId: number, edit: LocalRuleEdit): Promise<void> {
  const targets = await readRuleTargets(ruleId);

  const orderIndex = new Map<number, number>();
  edit.order.forEach((targetId, index) => {
    if (!orderIndex.has(targetId)) orderIndex.set(targetId, index);
  });
  const ordered = [...targets].sort((left, right) => {
    const leftIndex = orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
    return left.id - right.id;
  });

  await db.update(schema.modelForwardRules).set({ enabled: edit.ruleEnabled })
    .where(eq(schema.modelForwardRules.id, ruleId)).run();

  const nowIso = new Date().toISOString();
  for (const [index, target] of ordered.entries()) {
    await db.update(schema.modelForwardTargets).set({
      sortOrder: index,
      enabled: edit.enabled[String(target.id)] ?? !!target.enabled,
      updatedAt: nowIso,
    }).where(eq(schema.modelForwardTargets.id, target.id)).run();
  }

  await syncRuleMirrorToChannels(ruleId);
}

async function saveRuleEdit(ruleId: number, edit: LocalRuleEdit): Promise<ModelForwardRuleRow> {
  const state = readEditState();
  state.rules[String(ruleId)] = edit;
  writeEditState(state);
  await applyLocalEditForRule(ruleId, edit);

  const updated = (await listModelForwardRules()).find((item) => item.id === ruleId);
  if (!updated) throw new ModelForwardError('本机镜像里没有这条转发规则，请先「从服务器同步」。');
  return updated;
}

/** 这条规则当前的期望状态（本机改过的部分 + 镜像里的现状）。 */
async function buildRuleEdit(ruleId: number): Promise<LocalRuleEdit> {
  const rule = await requireRuleRow(ruleId);
  const targets = await readRuleTargets(ruleId);
  const recorded = readEditState().rules[String(ruleId)];
  return {
    order: targets.map((target) => target.id),
    enabled: recorded?.enabled ?? {},
    ruleEnabled: !!rule.enabled,
  };
}

export async function moveLocalForwardTarget(
  ruleId: number,
  targetId: number,
  action: 'up' | 'down' | 'top',
): Promise<ModelForwardRuleRow> {
  const targets = await readRuleTargets(ruleId);
  const index = targets.findIndex((target) => target.id === targetId);
  if (index < 0) throw new ModelForwardError('本机镜像里没有这个转发目标，请先「从服务器同步」。');

  const nextIndex = action === 'top'
    ? 0
    : action === 'up'
      ? Math.max(0, index - 1)
      : Math.min(targets.length - 1, index + 1);
  const reordered = [...targets];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(nextIndex, 0, moved);

  const edit = await buildRuleEdit(ruleId);
  edit.order = reordered.map((target) => target.id);
  return await saveRuleEdit(ruleId, edit);
}

export async function setLocalForwardTargetEnabled(
  ruleId: number,
  targetId: number,
  enabled: boolean,
): Promise<ModelForwardRuleRow> {
  const targets = await readRuleTargets(ruleId);
  if (!targets.some((target) => target.id === targetId)) {
    throw new ModelForwardError('本机镜像里没有这个转发目标，请先「从服务器同步」。');
  }

  const edit = await buildRuleEdit(ruleId);
  edit.enabled[String(targetId)] = enabled;
  return await saveRuleEdit(ruleId, edit);
}

export async function setLocalForwardRuleEnabled(
  ruleId: number,
  enabled: boolean,
): Promise<ModelForwardRuleRow> {
  const edit = await buildRuleEdit(ruleId);
  edit.ruleEnabled = enabled;
  return await saveRuleEdit(ruleId, edit);
}

/** 「恢复服务器顺序」：丢掉本机改动；具体重新拉取由调用方负责。 */
export async function resetLocalForwardEdits(): Promise<void> {
  writeEditState({ rules: {} });
  invalidateTokenRouterCache();
}

/**
 * 服务器快照落库后调用：指纹没变就把本机改动重新盖回镜像并重排通道；
 * 指纹变了（服务器改过规则）则整份作废 —— 永远以服务器为准。
 *
 * 不管有没有本机改动，最后都会把镜像顺序对齐到通道：快照导入只写
 * `model_forward_targets`，`route_channels` 的 priority / enabled 得在这里补齐，
 * 否则「恢复服务器顺序」之后派发还在用旧顺序。
 */
export async function reapplyLocalForwardEditsAfterSync(sourceHash: string): Promise<void> {
  const state = readEditState();
  const storedHash = readEdgeLocalSetting(SOURCE_HASH_SETTING_KEY);
  const ruleIds = Object.keys(state.rules)
    .map((key) => Number(key))
    .filter((ruleId) => Number.isSafeInteger(ruleId) && ruleId > 0);

  const serverChanged = storedHash !== sourceHash;
  if (serverChanged && ruleIds.length > 0) {
    writeEditState({ rules: {} });
  }

  if (!serverChanged) {
    for (const ruleId of ruleIds) {
      const exists = await db.select({ id: schema.modelForwardRules.id }).from(schema.modelForwardRules)
        .where(eq(schema.modelForwardRules.id, ruleId))
        .get();
      if (!exists) continue;
      await applyLocalEditForRule(ruleId, state.rules[String(ruleId)]);
    }
  }

  const mirrorRules = await db.select({ id: schema.modelForwardRules.id }).from(schema.modelForwardRules).all();
  for (const row of mirrorRules) {
    await syncRuleMirrorToChannels(row.id);
  }

  writeEdgeLocalSetting(SOURCE_HASH_SETTING_KEY, sourceHash);
  invalidateTokenRouterCache();
}

