import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ForwardModule = typeof import('../services/modelForwardService.js');
type ChannelSelectionModule = typeof import('./channelSelection.js');
type CoordinatorModule = typeof import('../services/proxyChannelCoordinator.js');

vi.mock('../services/modelPricingService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/modelPricingService.js')>('../services/modelPricingService.js');
  return { ...actual, getCachedModelRoutingReferenceCost: () => null };
});

const EMPTY_POLICY = {
  supportedModels: [],
  allowedRouteIds: [],
  siteWeightMultipliers: {},
  excludedSiteIds: [],
  excludedCredentialRefs: [],
};

describe('模型转发路由忽略会话粘滞', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let forwardService: ForwardModule;
  let channelSelection: ChannelSelectionModule;
  let coordinator: CoordinatorModule['proxyChannelCoordinator'];
  let siteId = 0;
  let accountId = 0;
  let tokenId = 0;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-forward-sticky-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    forwardService = await import('../services/modelForwardService.js');
    channelSelection = await import('./channelSelection.js');
    coordinator = (await import('../services/proxyChannelCoordinator.js')).proxyChannelCoordinator;
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
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    const tokenRouterModule = await import('../services/tokenRouter.js');
    tokenRouterModule.invalidateTokenRouterCache();
    tokenRouterModule.resetSiteRuntimeHealthState();

    const site = await db.insert(schema.sites).values({
      name: '粘滞测试站',
      url: 'https://forward-sticky.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'sticky-user',
      accessToken: 'access-sticky',
      apiToken: 'sk-sticky',
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'session' }),
    }).returning().get();
    accountId = account.id;
    const token = await db.insert(schema.accountTokens).values({
      accountId,
      name: 'default',
      token: 'token-sticky',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();
    tokenId = token.id;
  });

  it('顺序调整后，老会话不会被粘滞钉在原来那条通道上', async () => {
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-6-astra',
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    const firstChannelId = rule.targets[0].channelId as number;
    const secondChannelId = rule.targets[1].channelId as number;
    expect(firstChannelId).not.toBe(secondChannelId);

    (await import('../services/tokenRouter.js')).invalidateTokenRouterCache();

    // 会话被钉在「顺序 2」上（例如它上次成功时顺序 2 还排在前面）。
    const stickySessionKey = 'key:1|codex|/v1/chat/completions|gpt-6-astra|session-1';
    coordinator.bindStickyChannel(stickySessionKey, secondChannelId, { extraConfig: JSON.stringify({ credentialMode: 'session' }) });
    expect(coordinator.getStickyChannelId(stickySessionKey)).toBe(secondChannelId);

    // 转发路由：粘滞不生效，永远按人工顺序选第一个启用目标。
    const selected = await channelSelection.selectProxyChannelForAttempt({
      requestedModel: 'gpt-6-astra',
      downstreamPolicy: EMPTY_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey,
    });
    expect(selected?.channel.id).toBe(firstChannelId);

    // 把顺序 2 置顶 → 老会话立即跟到新顺序，不用等 30 分钟 TTL。
    await forwardService.moveModelForwardTarget(rule.id, rule.targets[1].id, 'top');
    const afterReorder = await channelSelection.selectProxyChannelForAttempt({
      requestedModel: 'gpt-6-astra',
      downstreamPolicy: EMPTY_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey,
    });
    expect(afterReorder?.channel.id).toBe(secondChannelId);
  });

  it('普通（非转发）路由的会话粘滞仍然生效', async () => {
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-4o-mini',
      modelMapping: JSON.stringify({ 'gpt-4o-mini': 'gpt-4o-mini' }),
      enabled: true,
    }).returning().get();
    const first = await db.insert(schema.routeChannels).values({
      routeId: route.id, accountId, tokenId, priority: 0, weight: 10, enabled: true, manualOverride: true,
    }).returning().get();
    const second = await db.insert(schema.routeChannels).values({
      routeId: route.id, accountId, tokenId, priority: 1, weight: 10, enabled: true, manualOverride: true,
    }).returning().get();
    (await import('../services/tokenRouter.js')).invalidateTokenRouterCache();

    const stickySessionKey = 'key:1|codex|/v1/chat/completions|gpt-4o-mini|session-2';
    coordinator.bindStickyChannel(stickySessionKey, second.id, { extraConfig: JSON.stringify({ credentialMode: 'session' }) });

    const selected = await channelSelection.selectProxyChannelForAttempt({
      requestedModel: 'gpt-4o-mini',
      downstreamPolicy: EMPTY_POLICY,
      excludeChannelIds: [],
      retryCount: 0,
      stickySessionKey,
    });
    expect(selected?.channel.id).toBe(second.id);
    expect(selected?.channel.id).not.toBe(first.id);
  });

});
