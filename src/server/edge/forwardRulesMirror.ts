import { db, schema } from '../db/index.js';
import type { ModelForwardSnapshot } from '../services/modelForwardService.js';

/** 只用到规则与目标两段数据，便于直接接住服务器返回的载荷。 */
export type ForwardRulesSnapshot = Pick<ModelForwardSnapshot, 'rules' | 'targets'>;

export type ForwardRulesMirrorResult = { rules: number; targets: number };

/**
 * 把服务器导出的模型转发规则快照写成本地镜像（只读镜像，本地不做编辑）。
 *
 * 两个约束：
 * 1. 必须在 accounts 导入之后调用 —— 导入是清空重建，删除 accounts/sites 会级联删掉
 *    本地的转发目标行（model_forward_targets 的外键带 onDelete cascade）。
 * 2. id 直接沿用服务器值：站点/账号/路由/通道在导入时也是按原 id 写入的，
 *    这样 target.channel_id 和服务器保持一致，页面上看到的顺序与渠道状态都能对上。
 */
export async function applyForwardRulesSnapshot(
  snapshot: ForwardRulesSnapshot,
): Promise<ForwardRulesMirrorResult> {
  await db.transaction(async (tx: typeof db) => {
    // 整表重建：先删目标再删规则，避免留下孤儿规则。
    await tx.delete(schema.modelForwardTargets).run();
    await tx.delete(schema.modelForwardRules).run();

    if (snapshot.rules.length > 0) {
      await tx.insert(schema.modelForwardRules).values(snapshot.rules.map((rule) => ({
        id: rule.id,
        modelName: rule.modelName,
        enabled: rule.enabled,
        routeId: rule.routeId,
        notes: rule.notes,
        createdAt: rule.createdAt,
        updatedAt: rule.updatedAt,
      }))).run();
    }

    if (snapshot.targets.length > 0) {
      await tx.insert(schema.modelForwardTargets).values(snapshot.targets.map((target) => ({
        id: target.id,
        ruleId: target.ruleId,
        siteId: target.siteId,
        accountId: target.accountId,
        tokenId: target.tokenId,
        upstreamModel: target.upstreamModel,
        channelId: target.channelId,
        weight: target.weight,
        enabled: target.enabled,
        sortOrder: target.sortOrder,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
      }))).run();
    }
  });

  return { rules: snapshot.rules.length, targets: snapshot.targets.length };
}
