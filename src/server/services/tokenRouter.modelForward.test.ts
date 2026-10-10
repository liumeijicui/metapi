import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');
type ForwardModule = typeof import('./modelForwardService.js');

vi.mock('./modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('./modelPricingService.js')>('./modelPricingService.js');
  return { ...actual, getCachedModelRoutingReferenceCost: () => null };
});

describe('模型转发路由优先级', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let resetSiteRuntimeHealthState: TokenRouterModule['resetSiteRuntimeHealthState'];
  let forwardService: ForwardModule;
  let siteId = 0;
  let accountId = 0;
  let tokenId = 0;
  let oldChannelId = 0;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-token-router-forward-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    resetSiteRuntimeHealthState = tokenRouterModule.resetSiteRuntimeHealthState;
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
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.settings).run();
    invalidateTokenRouterCache();
    resetSiteRuntimeHealthState();

    const site = await db.insert(schema.sites).values({
      name: '转发测试站',
      url: 'https://forward-route.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'forward-user',
      accessToken: 'access-forward',
      apiToken: 'sk-forward',
      status: 'active',
    }).returning().get();
    accountId = account.id;
    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'default',
      token: 'token-forward',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();
    tokenId = token.id;

    // 老路由：同名模型，走一个普通通道
    const oldRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-6-astra',
      modelMapping: JSON.stringify({ 'gpt-6-astra': 'old-upstream-model' }),
      enabled: true,
    }).returning().get();
    const oldChannel = await db.insert(schema.routeChannels).values({
      routeId: oldRoute.id,
      accountId,
      tokenId,
      priority: 0,
      weight: 10,
      enabled: true,
      manualOverride: true,
    }).returning().get();
    oldChannelId = oldChannel.id;
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('模型刷新重建路由时不会把转发路由清理掉', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    const routeId = rule.routeId as number;
    const channelId = rule.targets[0].channelId as number;
    invalidateTokenRouterCache();

    const modelService = await import('./modelService.js');
    await modelService.rebuildTokenRoutesFromAvailability();

    const route = await db.select().from(schema.tokenRoutes)
      .where(eq(schema.tokenRoutes.id, routeId)).get();
    expect(route?.modelPattern).toBe('forward:gpt-6-astra');
    const channel = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channelId)).get();
    expect(channel?.manualOverride).toBe(true);

    invalidateTokenRouterCache();
    const selected = await new TokenRouter().selectChannel('gpt-6-astra');
    expect(selected?.channel.id).toBe(channelId);
  });

  it('转发规则一旦声明该模型，就只走新转发通道；停用后不再回落老路由', async () => {
    const router = new TokenRouter();
    // 规则还没建之前，模型仍按老路由派发（新老并存只发生在「没被规则声明」的模型上）。
    const before = await router.selectChannel('gpt-6-astra');
    expect(before?.channel.id).toBe(oldChannelId);

    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    invalidateTokenRouterCache();

    const forwardChannelId = rule.targets[0].channelId as number;
    expect(forwardChannelId).not.toBe(oldChannelId);

    const selected = await router.selectChannel('gpt-6-astra');
    expect(selected?.channel.id).toBe(forwardChannelId);
    expect(selected?.actualModel).toBe('deepseek-v4.1-flash');

    // 停用规则 → 该模型没有可派发通道 → 如实报不可用，不回落到老路由。
    await forwardService.setModelForwardRuleEnabled(rule.id, false);
    invalidateTokenRouterCache();
    const disabled = await router.selectChannel('gpt-6-astra');
    expect(disabled).toBeNull();

    // 重新启用 → 又回到新转发通道
    await forwardService.setModelForwardRuleEnabled(rule.id, true);
    invalidateTokenRouterCache();
    const again = await router.selectChannel('gpt-6-astra');
    expect(again?.channel.id).toBe(forwardChannelId);
  });

  it('顺序调整后立即生效：永远走第一个启用目标', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstTarget = rule.targets[0];
    const secondTarget = rule.targets[1];
    const firstChannelId = firstTarget.channelId as number;
    const secondChannelId = secondTarget.channelId as number;

    const router = new TokenRouter();
    expect((await router.selectChannel('gpt-6-astra'))?.channel.id).toBe(firstChannelId);

    // 把顺序 2 置顶 → 无需重启或等待缓存过期，下一次选路就换到它。
    await forwardService.moveModelForwardTarget(rule.id, secondTarget.id, 'top');
    expect((await router.selectChannel('gpt-6-astra'))?.channel.id).toBe(secondChannelId);

    // 顺序 1 再置顶 → 立刻切回去。
    await forwardService.moveModelForwardTarget(rule.id, firstTarget.id, 'top');
    expect((await router.selectChannel('gpt-6-astra'))?.channel.id).toBe(firstChannelId);

    // 顺序 1 停用 → 落到顺序 2。
    await forwardService.setModelForwardTargetEnabled(rule.id, firstTarget.id, false);
    expect((await router.selectChannel('gpt-6-astra'))?.channel.id).toBe(secondChannelId);
  });

  it('转发通道冷却中仍然选中它自己，不回落到老路由', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    invalidateTokenRouterCache();
    const forwardChannelId = rule.targets[0].channelId as number;

    await db.update(schema.routeChannels).set({
      cooldownUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      cooldownLevel: 1,
    }).where(eq(schema.routeChannels.id, forwardChannelId)).run();
    invalidateTokenRouterCache();

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-6-astra');
    // 冷却只是记账：手动排的顺序 1 照样是每次被调用的那个。
    expect(selected?.channel.id).toBe(forwardChannelId);
  });

  it('账号会话过期时转发通道仍按 SK 正常派发', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    invalidateTokenRouterCache();
    const forwardChannelId = rule.targets[0].channelId as number;

    // 登录态掉了（expired），但账号上的 SK 还能用 → 转发必须照常工作。
    await db.update(schema.accounts).set({ status: 'expired' })
      .where(eq(schema.accounts.id, accountId)).run();
    invalidateTokenRouterCache();

    const selected = await new TokenRouter().selectChannel('gpt-6-astra');
    expect(selected?.channel.id).toBe(forwardChannelId);
    expect(selected?.tokenValue).toBe('token-forward');
  });

  it('令牌行不可用时转发通道退回账号 SK', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
    });
    invalidateTokenRouterCache();
    const forwardChannelId = rule.targets[0].channelId as number;

    // 令牌行被标记为待补全 / 停用（会话刷新失败是常见原因），只要账号还有 SK
    // 就仍然可以派发，不该整条通道判死。
    await db.update(schema.accountTokens).set({ valueStatus: 'masked_pending', enabled: false })
      .where(eq(schema.accountTokens.id, tokenId)).run();
    invalidateTokenRouterCache();

    const selected = await new TokenRouter().selectChannel('gpt-6-astra');
    expect(selected?.channel.id).toBe(forwardChannelId);
    expect(selected?.tokenValue).toBe('sk-forward');
  });

  it('站点运行时熔断中，转发路由仍走顺序 1；非转发路由照旧避让', async () => {
    // 第二个站点，充当「顺序 2」
    const siteB = await db.insert(schema.sites).values({
      name: '转发测试站B',
      url: 'https://forward-route-b.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const accountB = await db.insert(schema.accounts).values({
      siteId: siteB.id,
      username: 'forward-user-b',
      accessToken: 'access-forward-b',
      apiToken: 'sk-forward-b',
      status: 'active',
    }).returning().get();
    const tokenB = await db.insert(schema.accountTokens).values({
      accountId: accountB.id,
      name: 'default',
      token: 'token-forward-b',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();

    // 对照用的非转发路由：同样横跨两个站点，用来证明熔断这次确实开了
    const legacyRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'forward-breaker-legacy',
      modelMapping: JSON.stringify({ 'forward-breaker-legacy': 'legacy-breaker-model' }),
      enabled: true,
    }).returning().get();
    const legacyChannelA = await db.insert(schema.routeChannels).values({
      routeId: legacyRoute.id,
      accountId,
      tokenId,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();
    const legacyChannelB = await db.insert(schema.routeChannels).values({
      routeId: legacyRoute.id,
      accountId: accountB.id,
      tokenId: tokenB.id,
      priority: 0,
      weight: 10,
      enabled: true,
    }).returning().get();

    const rule = await forwardService.createModelForwardRule({
      modelName: 'forward-breaker',
      targets: [
        { siteId, accountId, upstreamModel: 'breaker-upstream-1' },
        { siteId: siteB.id, accountId: accountB.id, upstreamModel: 'breaker-upstream-2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const secondChannelId = rule.targets[1].channelId as number;
    expect(firstChannelId).not.toBe(secondChannelId);
    invalidateTokenRouterCache();

    // 站点 A 连续 3 次瞬时失败 → 开站点级运行时熔断（60s 档）
    const router = new TokenRouter();
    for (let index = 0; index < 3; index += 1) {
      await router.recordFailure(legacyChannelA.id, {
        status: 502,
        errorText: 'Gateway timeout',
      });
    }
    await db.update(schema.routeChannels).set({
      cooldownUntil: null,
      lastFailAt: null,
      failCount: 0,
    }).where(eq(schema.routeChannels.id, legacyChannelA.id)).run();
    invalidateTokenRouterCache();

    // 先证明熔断真的开了：非转发路由避让站点 A，落到站点 B。
    const legacySelected = await router.selectChannel('forward-breaker-legacy');
    expect(legacySelected?.channel.id).toBe(legacyChannelB.id);

    // 转发路由只认顺序与启用状态：熔断窗口内照样走顺序 1（站点 A）。
    const selected = await router.selectChannel('forward-breaker');
    expect(selected?.channel.id).toBe(firstChannelId);
  });
});
