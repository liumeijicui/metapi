import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ForwardModule = typeof import('./modelForwardService.js');
type ConfigModule = typeof import('../config.js');

vi.mock('./modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelPricingService.js')>('./modelPricingService.js');
  return { ...actual, getCachedModelRoutingReferenceCost: () => null };
});

describe('模型转发不做自动降级与冷却换源', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let config: ConfigModule['config'];
  let forwardService: ForwardModule;
  let siteId = 0;
  let accountId = 0;
  let tokenId = 0;
  let oldChannelId = 0;

  const selectForwardedChannelId = async () => {
    invalidateTokenRouterCache();
    const selected = await new TokenRouter().selectChannel('gpt-6-astra');
    return selected?.channel.id ?? null;
  };

  const readChannel = async (id: number) => {
    const row = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, id)).get();
    if (!row) throw new Error(`channel ${id} missing`);
    return row;
  };

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-token-router-demote-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
    config = (await import('../config.js')).config;
    forwardService = await import('./modelForwardService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();

    const site = await db.insert(schema.sites).values({
      name: '降级测试站',
      url: 'https://auto-demote.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'demote-user',
      accessToken: 'access-demote',
      apiToken: 'sk-demote',
      status: 'active',
    }).returning().get();
    accountId = account.id;
    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'default',
      token: 'token-demote',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();
    tokenId = token.id;

    // 老路由是两个普通通道：P0 与 P1，老路由正常时优先 P0。
    const oldRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-6-astra',
      modelMapping: JSON.stringify({ 'gpt-6-astra': 'old-upstream-model' }),
      enabled: true,
    }).returning().get();
    const lowPriorityChannel = await db.insert(schema.routeChannels).values({
      routeId: oldRoute.id,
      accountId,
      tokenId,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).returning().get();
    oldChannelId = lowPriorityChannel.id;
    await db.insert(schema.routeChannels).values({
      routeId: oldRoute.id,
      accountId,
      tokenId,
      priority: 1,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('转发通道连续 10 次上游故障也不降级，仍然只走顺序 1', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const priorityBefore = (await readChannel(firstChannelId)).priority ?? 0;
    expect(await selectForwardedChannelId()).toBe(firstChannelId);

    const router = new TokenRouter();
    for (let attempt = 1; attempt <= config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(firstChannelId, { status: 503, errorText: 'upstream boom' });
    }

    const channel = await readChannel(firstChannelId);
    // 失败次数照记，但顺序不会被系统改掉，也不会出现「已降级」状态。
    expect(channel.consecutiveUpstreamFailures).toBe(config.proxyAutoDemoteFailureThreshold);
    expect(channel.autoDemotedAt).toBeNull();
    expect(channel.priority).toBe(priorityBefore);
    // 顺序 1 永远是首选，不会自动切到顺序 2。
    expect(await selectForwardedChannelId()).toBe(firstChannelId);
  });

  it('「类似 400」的错误同样计入连续计数，但转发通道仍不降级', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    const channelId = rule.targets[0].channelId as number;
    const router = new TokenRouter();

    for (let attempt = 1; attempt <= config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(channelId, { status: 400, errorText: 'invalid request body' });
    }
    const channel = await readChannel(channelId);
    expect(channel.consecutiveUpstreamFailures).toBe(config.proxyAutoDemoteFailureThreshold);
    expect(channel.autoDemotedAt).toBeNull();
  });

  it('中间成功一次就把连续计数清零，不会攒到阈值', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    const channelId = rule.targets[0].channelId as number;
    const router = new TokenRouter();

    for (let round = 0; round < 3; round += 1) {
      for (let attempt = 1; attempt < config.proxyAutoDemoteFailureThreshold; attempt += 1) {
        await router.recordFailure(channelId, { status: 503, errorText: 'upstream boom' });
      }
      await router.recordSuccess(channelId, 100, 0, 'deepseek-v4.1-flash');
    }

    const channel = await readChannel(channelId);
    expect(channel.autoDemotedAt).toBeNull();
    expect(channel.consecutiveUpstreamFailures).toBe(0);
  });

  it('转发通道不产生降级状态，成功一次也只是清零计数', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const priorityBefore = (await readChannel(firstChannelId)).priority ?? 0;

    const router = new TokenRouter();
    for (let attempt = 0; attempt < config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(firstChannelId, { status: 500, errorText: 'upstream boom' });
    }
    const afterFailures = await readChannel(firstChannelId);
    expect(afterFailures.priority).toBe(priorityBefore);
    expect(afterFailures.autoDemotedAt).toBeNull();

    await router.recordSuccess(firstChannelId, 120, 0, 'deepseek-v4.1-flash');

    const restored = await readChannel(firstChannelId);
    expect(restored.priority).toBe(priorityBefore);
    expect(restored.autoDemotedAt).toBeNull();
    expect(restored.priorityBeforeAutoDemotion).toBeNull();
    expect(restored.consecutiveUpstreamFailures).toBe(0);
  });

  it('转发通道冷却中也不会被跳过：顺序 1 永远是首选', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const secondChannelId = rule.targets[1].channelId as number;

    // 模拟顺序 1 因为上游失败正在冷却：它仍然是每次被调用的那个。
    await db.update(schema.routeChannels).set({
      cooldownUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      cooldownLevel: 1,
      failCount: 3,
      lastFailAt: new Date().toISOString(),
    }).where(eq(schema.routeChannels.id, firstChannelId)).run();

    expect(await selectForwardedChannelId()).toBe(firstChannelId);

    // 只有把它停用，才轮到顺序 2。
    await db.update(schema.routeChannels).set({ enabled: false })
      .where(eq(schema.routeChannels.id, firstChannelId)).run();
    expect(await selectForwardedChannelId()).toBe(secondChannelId);
  });

  it('手动保存转发顺序即复位通道优先级与失败状态', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const router = new TokenRouter();
    for (let attempt = 0; attempt < config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(firstChannelId, { status: 503, errorText: 'upstream boom' });
    }
    expect((await readChannel(firstChannelId)).autoDemotedAt).toBeNull();

    const detail = (await forwardService.listModelForwardRules()).find((item) => item.id === rule.id);
    await forwardService.updateModelForwardRule(rule.id, {
      modelName: 'gpt-6-astra',
      enabled: true,
      targets: detail!.targets.map((target) => ({
        id: target.id,
        siteId: target.siteId,
        accountId: target.accountId,
        tokenId: target.tokenId,
        upstreamModel: target.upstreamModel,
        weight: target.weight,
        enabled: target.enabled,
      })),
    });

    const after = await readChannel(firstChannelId);
    expect(after.autoDemotedAt).toBeNull();
    expect(after.priority).toBe(0);
  });

  it('转发列表不再透出降级状态', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    const channelId = rule.targets[0].channelId as number;
    const router = new TokenRouter();
    for (let attempt = 0; attempt < config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(channelId, { status: 503, errorText: 'upstream boom' });
    }

    const listed = (await forwardService.listModelForwardRules()).find((item) => item.id === rule.id);
    expect(listed?.targets[0].autoDemotedAt).toBeNull();
    expect(listed?.targets[0].consecutiveUpstreamFailures).toBe(config.proxyAutoDemoteFailureThreshold);
  });

  // 老路由（自动路由）的通道仍然保留自动降级：被降级后顺序让位给其它源。
  it('老路由通道同样会降级', async () => {
    const router = new TokenRouter();
    for (let attempt = 0; attempt < config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(oldChannelId, { status: 500, errorText: 'upstream boom' });
    }
    const demoted = await readChannel(oldChannelId);
    expect(demoted.autoDemotedAt).toBeTruthy();
    expect(demoted.priorityBeforeAutoDemotion).toBe(0);
    expect(demoted.priority).toBeGreaterThan(0);
  });
});
