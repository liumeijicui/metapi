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

describe('连续上游失败自动降级', () => {
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

  it('连续 10 次上游故障后降到最低优先级，后续请求自动切到别的源', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const secondChannelId = rule.targets[1].channelId as number;

    // 降级前：顺序 1 才是首选。
    expect(await selectForwardedChannelId()).toBe(firstChannelId);

    const router = new TokenRouter();
    for (let attempt = 1; attempt <= config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(firstChannelId, { status: 503, errorText: 'upstream boom' });
    }

    const demoted = await readChannel(firstChannelId);
    expect(demoted.autoDemotedAt).toBeTruthy();
    expect(demoted.consecutiveUpstreamFailures).toBe(config.proxyAutoDemoteFailureThreshold);
    // 降级后它不再是首选，调用自动落到第二个源上。
    expect(demoted.priority).toBeGreaterThan((await readChannel(secondChannelId)).priority ?? 0);
    expect(await selectForwardedChannelId()).toBe(secondChannelId);
  });

  it('「类似 400」的错误同样计入：哪怕报错文案像请求错误，连续 10 次也降级', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    const channelId = rule.targets[0].channelId as number;
    const router = new TokenRouter();

    // 9 次还不够。
    for (let attempt = 1; attempt < config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(channelId, { status: 400, errorText: 'invalid request body' });
    }
    expect((await readChannel(channelId)).autoDemotedAt).toBeNull();

    // 第 10 次到阈值，降级。
    await router.recordFailure(channelId, { status: 400, errorText: 'invalid request body' });
    const channel = await readChannel(channelId);
    expect(channel.autoDemotedAt).toBeTruthy();
    expect(channel.consecutiveUpstreamFailures).toBe(config.proxyAutoDemoteFailureThreshold);
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

  it('成功一次就恢复原来的顺序', async () => {
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
    expect((await readChannel(firstChannelId)).priority).not.toBe(priorityBefore);

    await router.recordSuccess(firstChannelId, 120, 0, 'deepseek-v4.1-flash');

    const restored = await readChannel(firstChannelId);
    expect(restored.priority).toBe(priorityBefore);
    expect(restored.autoDemotedAt).toBeNull();
    expect(restored.priorityBeforeAutoDemotion).toBeNull();
    expect(restored.consecutiveUpstreamFailures).toBe(0);
  });

  it('降级不会把通道踢出局：其他源都不可用时仍然会被选中', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const secondChannelId = rule.targets[1].channelId as number;

    const router = new TokenRouter();
    for (let attempt = 0; attempt < config.proxyAutoDemoteFailureThreshold; attempt += 1) {
      await router.recordFailure(firstChannelId, { status: 502, errorText: 'bad gateway' });
    }

    // 冷却和降级是两件事：这里只验证「降级」不会把通道踢出候选池。
    // 先让冷却过去（上游连续失败本来就会被冷却，那是另一套机制），
    // 再把第二个源停用 —— 只剩下被降级的那个源时，它仍然会被选中。
    await db.update(schema.routeChannels).set({ cooldownUntil: null })
      .where(eq(schema.routeChannels.id, firstChannelId)).run();
    await db.update(schema.routeChannels).set({ enabled: false })
      .where(eq(schema.routeChannels.id, secondChannelId)).run();
    expect(await selectForwardedChannelId()).toBe(firstChannelId);
  });

  it('手动保存转发顺序即复位自动降级', async () => {
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
    expect((await readChannel(firstChannelId)).autoDemotedAt).toBeTruthy();

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

  it('转发列表把降级状态透出给页面', async () => {
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
    expect(listed?.targets[0].autoDemotedAt).toBeTruthy();
    expect(listed?.targets[0].consecutiveUpstreamFailures).toBe(config.proxyAutoDemoteFailureThreshold);
  });

  // 老路由的通道直接用 recordFailure 走一遍，确认降级不只对转发通道生效。
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
