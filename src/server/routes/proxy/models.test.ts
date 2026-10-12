import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type ProxyRouterModule = typeof import('./router.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');
type TokensRoutesModule = typeof import('../api/tokens.js');
type ConfigModule = typeof import('../../config.js');

describe('/v1/models route', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let proxyRoutes: ProxyRouterModule['proxyRoutes'];
  let tokensRoutes: TokensRoutesModule['tokensRoutes'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let config: ConfigModule['config'];
  let app: FastifyInstance;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-models-route-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const proxyRouterModule = await import('./router.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const tokensRoutesModule = await import('../api/tokens.js');
    const configModule = await import('../../config.js');

    db = dbModule.db;
    schema = dbModule.schema;
    proxyRoutes = proxyRouterModule.proxyRoutes;
    tokensRoutes = tokensRoutesModule.tokensRoutes;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    config = configModule.config;
    config.proxyToken = 'sk-global-proxy-token';

    app = Fastify();
    await app.register(tokensRoutes);
    await app.register(proxyRoutes);
  });

  beforeEach(async () => {
    invalidateTokenRouterCache();
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.downstreamApiKeys).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });


  /**
   * 造一条「模型转发」规则（A → B）并返回它的 routeId。
   *
   * /v1/models 现在只列「模型转发」声明的对外模型名：老路由已经不再参与派发，把它们
   * 列出来只会让下游看到一个「列得出来、调不通」的清单。
   */
  async function seedForwardRule(input: {
    modelName: string;
    siteId: number;
    accountId: number;
    upstreamModel?: string;
  }) {
    const service = await import('../../services/modelForwardService.js');
    const rule = await service.createModelForwardRule({
      modelName: input.modelName,
      targets: [{
        siteId: input.siteId,
        accountId: input.accountId,
        upstreamModel: input.upstreamModel ?? `${input.modelName}-upstream`,
      }],
    });
    invalidateTokenRouterCache();
    return rule;
  }

  async function seedSiteWithAccount(name: string) {
    const site = await db.insert(schema.sites).values({
      name,
      url: `https://${name}.example.com`,
      platform: 'openai',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      accessToken: `${name}-access-token`,
      status: 'active',
    }).returning().get();
    const token = await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: `${name}-api-token`,
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).returning().get();
    return { site, account, token };
  }

  function readModelIds(payload: unknown): string[] {
    const body = payload as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((item) => item.id);
  }

  it('hides models that have no routable channel even if model availability contains them', async () => {
    const { site, account } = await seedSiteWithAccount('routable');

    await db.insert(schema.modelAvailability).values([
      { accountId: account.id, modelName: 'routable-model', available: true },
      { accountId: account.id, modelName: 'orphan-model', available: true },
    ]).run();

    await seedForwardRule({ modelName: 'routable-model', siteId: site.id, accountId: account.id });

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key',
      key: 'sk-managed-models',
      enabled: true,
      supportedModels: JSON.stringify(['routable-model']),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-managed-models' },
    });

    expect(response.statusCode).toBe(200);
    const ids = readModelIds(response.json());
    expect(ids).toContain('routable-model');
    expect(ids).not.toContain('orphan-model');
  });

  it('keeps global proxy token unrestricted when no managed key matches', async () => {
    const { site, account } = await seedSiteWithAccount('global');
    await seedForwardRule({ modelName: 'global-routable-model', siteId: site.id, accountId: account.id });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-global-proxy-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(readModelIds(response.json())).toContain('global-routable-model');
  });

  it('returns only whitelist models for managed key with supportedModels policy', async () => {
    const { site, account } = await seedSiteWithAccount('whitelist');
    await seedForwardRule({ modelName: 'allowed-model', siteId: site.id, accountId: account.id });
    await seedForwardRule({ modelName: 'blocked-model', siteId: site.id, accountId: account.id });

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key',
      key: 'sk-managed-whitelist',
      enabled: true,
      supportedModels: JSON.stringify(['allowed-model']),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-managed-whitelist' },
    });

    expect(response.statusCode).toBe(200);
    const ids = readModelIds(response.json());
    expect(ids).toContain('allowed-model');
    expect(ids).not.toContain('blocked-model');
  });

  it('returns only the models bound by allowedRouteIds policy', async () => {
    const { site, account } = await seedSiteWithAccount('allowed-routes');
    const allowedRule = await seedForwardRule({
      modelName: 'claude-opus-4-6',
      siteId: site.id,
      accountId: account.id,
    });
    await seedForwardRule({ modelName: 'claude-sonnet-4-5', siteId: site.id, accountId: account.id });

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key',
      key: 'sk-managed-group-only',
      enabled: true,
      allowedRouteIds: JSON.stringify([allowedRule.routeId]),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-managed-group-only' },
    });

    expect(response.statusCode).toBe(200);
    const ids = readModelIds(response.json());
    expect(ids).toEqual(['claude-opus-4-6']);
  });

  it('returns all forwarded models for managed key with empty model and group selections', async () => {
    const { site, account } = await seedSiteWithAccount('deny-all');
    await seedForwardRule({ modelName: 'gpt-4o-mini', siteId: site.id, accountId: account.id });
    await seedForwardRule({ modelName: 'claude-opus-4-6', siteId: site.id, accountId: account.id });

    await db.insert(schema.downstreamApiKeys).values({
      name: 'managed-key-deny-all',
      key: 'sk-managed-deny-all',
      enabled: true,
      supportedModels: JSON.stringify([]),
      allowedRouteIds: JSON.stringify([]),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-managed-deny-all' },
    });

    expect(response.statusCode).toBe(200);
    expect(readModelIds(response.json()).sort()).toEqual([
      'claude-opus-4-6',
      'gpt-4o-mini',
    ]);
  });

  it('hides models whose forward rule is disabled', async () => {
    const { site, account } = await seedSiteWithAccount('disabled-rule');
    const rule = await seedForwardRule({
      modelName: 'enabled-model',
      siteId: site.id,
      accountId: account.id,
    });
    const disabledRule = await seedForwardRule({
      modelName: 'disabled-model',
      siteId: site.id,
      accountId: account.id,
    });
    const service = await import('../../services/modelForwardService.js');
    await service.setModelForwardRuleEnabled(disabledRule.id, false);
    invalidateTokenRouterCache();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-global-proxy-token' },
    });

    expect(response.statusCode).toBe(200);
    const ids = readModelIds(response.json());
    expect(ids).toContain('enabled-model');
    expect(ids).not.toContain('disabled-model');
    expect(rule.routeId).toBeTruthy();
  });

  it('filters search pseudo models out of /v1/models', async () => {
    const { site, account } = await seedSiteWithAccount('search');
    await seedForwardRule({ modelName: '__search', siteId: site.id, accountId: account.id });
    await seedForwardRule({ modelName: 'gpt-4.1', siteId: site.id, accountId: account.id });

    await db.insert(schema.downstreamApiKeys).values({
      name: 'search-key',
      key: 'sk-search-key',
      enabled: true,
      supportedModels: JSON.stringify(['gpt-4.1']),
    }).run();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: 'Bearer sk-search-key' },
    });

    expect(response.statusCode).toBe(200);
    const ids = readModelIds(response.json());
    expect(ids).toContain('gpt-4.1');
    expect(ids).not.toContain('__search');
  });

});
