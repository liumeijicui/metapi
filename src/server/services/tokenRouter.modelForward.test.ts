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

  it('启用转发规则时优先走新转发通道，停用后回落老路由', async () => {
    const router = new TokenRouter();
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

    // 停用规则 → 通道不可用 → 回落老路由
    await forwardService.setModelForwardRuleEnabled(rule.id, false);
    invalidateTokenRouterCache();
    const fallback = await router.selectChannel('gpt-6-astra');
    expect(fallback?.channel.id).toBe(oldChannelId);

    // 重新启用 → 再次优先新转发通道
    await forwardService.setModelForwardRuleEnabled(rule.id, true);
    invalidateTokenRouterCache();
    const again = await router.selectChannel('gpt-6-astra');
    expect(again?.channel.id).toBe(forwardChannelId);
  });

  it('转发通道全部冷却时回落老路由', async () => {
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
    expect(selected?.channel.id).toBe(oldChannelId);
  });
});

