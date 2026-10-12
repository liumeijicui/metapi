import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');
type TokenRouterModule = typeof import('../../services/tokenRouter.js');
type ConfigModule = typeof import('../../config.js');

describe('sites token-router cache invalidation', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let tokenRouter: TokenRouterModule['tokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let config: ConfigModule['config'];
  let originalCacheTtlMs = 0;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-token-router-cache-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    const tokenRouterModule = await import('../../services/tokenRouter.js');
    const configModule = await import('../../config.js');

    db = dbModule.db;
    schema = dbModule.schema;
    tokenRouter = tokenRouterModule.tokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    config = configModule.config;
    originalCacheTtlMs = config.tokenRouterCacheTtlMs;

    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    config.tokenRouterCacheTtlMs = 60_000;
    invalidateTokenRouterCache();
  });

  afterAll(async () => {
    await app.close();
    config.tokenRouterCacheTtlMs = originalCacheTtlMs;
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  it('invalidates the router cache after updating a site', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'cache-target',
      url: 'https://cache-target.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'cache-user',
      accessToken: 'cache-access-token',
      apiToken: 'sk-cache-api-token',
      status: 'active',
    }).returning().get();

    // 派发只认「模型转发」：缓存失效的语义要在转发通道上验证。
    const forwardService = await import('../../services/modelForwardService.js');
    const rule = await forwardService.createModelForwardRule({
      modelName: 'gpt-4o-mini',
      targets: [{ siteId: site.id, accountId: account.id, upstreamModel: 'gpt-4o-mini' }],
    });
    const channelId = rule.targets[0].channelId as number;
    invalidateTokenRouterCache();

    const before = await tokenRouter.explainSelection('gpt-4o-mini');
    expect(before.matched).toBe(true);
    expect(before.candidates.find((candidate) => candidate.channelId === channelId)?.eligible).toBe(true);

    // 站点被停用后必须立刻反映到决策里：缓存在 60s TTL 内也不能把旧结果端出来。
    const response = await app.inject({
      method: 'PUT',
      url: `/api/sites/${site.id}`,
      payload: {
        status: 'disabled',
      },
    });
    expect(response.statusCode).toBe(200);

    const after = await tokenRouter.explainSelection('gpt-4o-mini');
    const candidate = after.candidates.find((item) => item.channelId === channelId);
    expect(candidate?.eligible).toBe(false);
  });

});
