import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./modelForwardService.js');

describe('modelForwardService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let siteId = 0;
  let accountId = 0;
  let tokenId = 0;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-model-forward-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./modelForwardService.js');
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  beforeEach(async () => {
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: '测试站',
      url: 'https://forward.example.com',
      platform: 'new-api',
    }).run();
    siteId = Number(site.lastInsertRowid);
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'tester',
      accessToken: 'session-token',
      status: 'active',
    }).run();
    accountId = Number(account.lastInsertRowid);
    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'default',
      token: 'sk-test',
      isDefault: true,
      valueStatus: 'ready',
      enabled: true,
    }).run();
    tokenId = Number(token.lastInsertRowid);
  });

  it('创建规则会同步出带 forward: 前缀的路由与 manual_override 通道', async () => {
    const rule = await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });

    expect(rule.modelName).toBe('gpt-6-astra');
    expect(rule.targets).toHaveLength(1);
    expect(rule.targets[0].tokenId).toBe(tokenId);
    expect(rule.targets[0].channelId).toBeTruthy();

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, rule.routeId as number))
      .get();
    expect(route?.modelPattern).toBe('forward:gpt-6-astra');
    expect(route?.displayName).toBe('gpt-6-astra');
    expect(service.isForwardRoutePattern(route?.modelPattern)).toBe(true);

    const channel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, rule.targets[0].channelId as number))
      .get();
    expect(channel?.sourceModel).toBe('deepseek-v4.1-flash');
    expect(channel?.manualOverride).toBe(true);
    expect(channel?.enabled).toBe(true);
  });

  it('停用规则会把通道一起停用，重新启用后恢复', async () => {
    const rule = await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    const channelId = rule.targets[0].channelId as number;

    const disabled = await service.setModelForwardRuleEnabled(rule.id, false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.targets[0].channelEnabled).toBe(false);

    const enabled = await service.setModelForwardRuleEnabled(rule.id, true);
    expect(enabled.enabled).toBe(true);
    expect(enabled.targets[0].channelEnabled).toBe(true);
    expect(channelId).toBe(enabled.targets[0].channelId);
  });

  it('同一账号可以挂多个上游模型，各自生成独立通道', async () => {
    const rule = await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.3-flash' },
      ],
    });
    expect(rule.targets).toHaveLength(2);
    const channelIds = rule.targets.map((target) => target.channelId);
    expect(new Set(channelIds).size).toBe(2);
  });

  it('重复的对外模型名会被拒绝', async () => {
    await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    await expect(service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'kimi-k3' }],
    })).rejects.toThrow(/已经有转发规则/);
  });

  it('对外模型名按大小写不敏感查重，新建与编辑都挡得住', async () => {
    await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });

    await expect(service.createModelForwardRule({
      modelName: 'GPT-6-ASTRA',
      targets: [{ siteId, accountId, upstreamModel: 'kimi-k3' }],
    })).rejects.toThrow(/已经有转发规则/);

    await expect(service.createModelForwardRule({
      modelName: '  gpt-6-astra  ',
      targets: [{ siteId, accountId, upstreamModel: 'kimi-k3' }],
    })).rejects.toThrow(/已经有转发规则/);

    const other = await service.createModelForwardRule({
      modelName: 'claude-test-9',
      targets: [{ siteId, accountId, upstreamModel: 'glm-5.3-flash' }],
    });
    await expect(service.updateModelForwardRule(other.id, {
      modelName: 'Gpt-6-Astra',
      targets: [{ siteId, accountId, upstreamModel: 'glm-5.3-flash' }],
    })).rejects.toThrow(/已经有转发规则/);
  });

  it('转发目标支持上移 / 下移 / 置顶，顺序会同步到通道 priority', async () => {
    const rule = await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'model-a' },
        { siteId, accountId, upstreamModel: 'model-b' },
        { siteId, accountId, upstreamModel: 'model-c' },
      ],
    });
    const readOrder = (row: typeof rule) => row.targets.map((target) => target.upstreamModel);
    const targetsByModel = new Map(rule.targets.map((target) => [target.upstreamModel, target]));

    expect(readOrder(rule)).toEqual(['model-a', 'model-b', 'model-c']);

    const topC = await service.moveModelForwardTarget(rule.id, targetsByModel.get('model-c')!.id, 'top');
    expect(readOrder(topC)).toEqual(['model-c', 'model-a', 'model-b']);

    const upB = await service.moveModelForwardTarget(rule.id, targetsByModel.get('model-b')!.id, 'up');
    expect(readOrder(upB)).toEqual(['model-c', 'model-b', 'model-a']);

    const downC = await service.moveModelForwardTarget(rule.id, targetsByModel.get('model-c')!.id, 'down');
    expect(readOrder(downC)).toEqual(['model-b', 'model-c', 'model-a']);

    // 越界的上移 / 下移是空操作，不会报错也不会打乱顺序。
    const topB = await service.moveModelForwardTarget(rule.id, targetsByModel.get('model-b')!.id, 'up');
    expect(readOrder(topB)).toEqual(['model-b', 'model-c', 'model-a']);

    const priorities = new Map(downC.targets.map((target) => [target.upstreamModel, target.sortOrder]));
    const channels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, rule.routeId as number))
      .all();
    const channelById = new Map(channels.map((channel) => [channel.id, channel]));
    for (const target of downC.targets) {
      const channel = channelById.get(target.channelId as number);
      expect(channel?.priority).toBe(target.sortOrder);
    }
    expect(priorities.get('model-b')).toBe(0);
  });

  it('转发目标可以单独启用 / 停用，不影响同规则下其它目标', async () => {
    const rule = await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'model-a' },
        { siteId, accountId, upstreamModel: 'model-b' },
      ],
    });
    const [first, second] = rule.targets;

    const disabled = await service.setModelForwardTargetEnabled(rule.id, second.id, false);
    const disabledSecond = disabled.targets.find((target) => target.id === second.id);
    const disabledFirst = disabled.targets.find((target) => target.id === first.id);
    expect(disabledSecond?.enabled).toBe(false);
    expect(disabledSecond?.channelEnabled).toBe(false);
    expect(disabledFirst?.enabled).toBe(true);
    expect(disabledFirst?.channelEnabled).toBe(true);

    const enabled = await service.setModelForwardTargetEnabled(rule.id, second.id, true);
    expect(enabled.targets.find((target) => target.id === second.id)?.channelEnabled).toBe(true);

    await expect(service.setModelForwardTargetEnabled(rule.id, 999_999, true))
      .rejects.toThrow(/转发目标不存在/);
    await expect(service.moveModelForwardTarget(rule.id, 999_999, 'top'))
      .rejects.toThrow(/转发目标不存在/);
  });

  it('缺少账号或模型名会被拒绝', async () => {
    await expect(service.createModelForwardRule({ modelName: 'x', targets: [] }))
      .rejects.toThrow(/至少需要一个转发目标/);
    await expect(service.createModelForwardRule({
      modelName: 'x',
      targets: [{ siteId, accountId, upstreamModel: '  ' }],
    })).rejects.toThrow(/上游模型名/);
    await expect(service.createModelForwardRule({ modelName: '  ', targets: [{ siteId, accountId, upstreamModel: 'm' }] }))
      .rejects.toThrow(/对外模型名不能为空/);
  });

  it('删除规则会一并清掉同步出来的路由与通道', async () => {
    const rule = await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    const routeId = rule.routeId as number;
    const channelId = rule.targets[0].channelId as number;

    await service.deleteModelForwardRule(rule.id);

    expect(await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get()).toBeUndefined();
    expect(await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get()).toBeUndefined();
    expect(await service.listModelForwardRules()).toHaveLength(0);
  });

  it('编辑规则时移除账号会删掉对应通道，保留的通道 id 不变', async () => {
    const second = await db.insert(schema.accounts).values({
      siteId,
      username: 'tester-2',
      accessToken: 'session-token-2',
      status: 'active',
    }).run();
    const secondAccountId = Number(second.lastInsertRowid);

    const rule = await service.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId: secondAccountId, upstreamModel: 'deepseek-v4.1-flash' },
      ],
    });
    const keptChannelId = rule.targets.find((t) => t.accountId === accountId)?.channelId;
    const removedChannelId = rule.targets.find((t) => t.accountId === secondAccountId)?.channelId;

    const updated = await service.updateModelForwardRule(rule.id, {
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });

    expect(updated.targets).toHaveLength(1);
    expect(updated.targets[0].channelId).toBe(keptChannelId);
    expect(await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, removedChannelId as number)).get()).toBeUndefined();
  });
});
