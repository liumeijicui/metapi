import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('model monitor routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-monitor-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./modelMonitor.js');
    const serviceModule = await import('../../services/modelMonitorService.js');
    // refresh 会真的跑一轮采集，价格那步换成桩，别让测试去打网络。
    serviceModule.__setModelMonitorPricingLoaderForTests(async () => null);
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.modelMonitorRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.siteModelMonitorModels).run();
    await db.delete(schema.siteModelMonitorSites).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: 'Demo',
      url: 'https://demo.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.siteModelMonitorModels).values([
      { siteId: site.id, modelName: 'gpt-5.5', successRate: 99, avgLatencyMs: 700, avgTps: 60, fetchedAt: '2026-10-04T03:00:00.000Z' },
      { siteId: site.id, modelName: 'grok-4.5', successRate: 40, avgLatencyMs: 9000, avgTps: 5, fetchedAt: '2026-10-04T03:00:00.000Z' },
    ]).run();
    await db.insert(schema.siteModelMonitorSites).values({
      siteId: site.id,
      status: 'ok',
      modelsCount: 2,
      fetchedAt: '2026-10-04T03:00:00.000Z',
    }).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('returns the overview with server-side filters and last update time', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/model-monitor/overview' });
    expect(all.statusCode).toBe(200);
    const allBody = all.json();
    expect(allBody.updatedAt).toBe('2026-10-04T03:00:00.000Z');
    expect(allBody.models.map((row: any) => row.modelName)).toEqual(['gpt-5.5', 'grok-4.5']);
    expect(allBody.sites).toHaveLength(1);

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/model-monitor/overview?model=grok-4.5&minSuccessRate=90',
    });
    expect(filtered.json().models).toHaveLength(0);

    const matched = await app.inject({ method: 'GET', url: '/api/model-monitor/overview?model=grok-4.5' });
    expect(matched.json().models.map((row: any) => row.modelName)).toEqual(['grok-4.5']);
    // 选中某个模型后，下拉清单里仍然列着其它模型，方便直接换。
    expect(matched.json().modelOptions.map((row: any) => row.modelName)).toEqual(['gpt-5.5', 'grok-4.5']);
  });

  it('rejects unknown sort keys by falling back to success rate', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/model-monitor/overview?sort=drop%20table',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().models[0].modelName).toBe('gpt-5.5');
  });

  it('returns chat channels for a site+model, validating params', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/model-monitor/chat-channels?siteId=1' });
    expect(missing.statusCode).toBe(400);

    const [site] = await db.select().from(schema.sites).all();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'demo',
      accessToken: 'jwt-token',
      status: 'active',
    }).returning().get();
    const route = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'gpt-5.5',
      routeMode: 'pattern',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: route.id,
      accountId: account.id,
      sourceModel: 'gpt-5.5',
      enabled: true,
    }).run();

    const ok = await app.inject({
      method: 'GET',
      url: `/api/model-monitor/chat-channels?siteId=${site.id}&model=gpt-5.5`,
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.success).toBe(true);
    expect(body.channels).toHaveLength(1);
    expect(body.channels[0]).toMatchObject({ accountName: 'demo', upstreamModel: 'gpt-5.5' });
    // 对话只做直连：模型名就是页面点中的那个，不解析任何对外模型。
    expect(body.direct).toBe(true);
    expect(body.requestedModel).toBe('gpt-5.5');
  });

  it('对话只依赖站点自己的凭据，没有路由也能直连', async () => {
    const [site] = await db.select().from(schema.sites).all();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'direct-account',
      accessToken: 'jwt-token',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: '默认令牌',
      token: 'sk-direct-123456',
      valueStatus: 'ready',
      enabled: true,
    }).run();

    // 特意不建任何 token_routes / route_channels：路由配置与直连无关。
    const response = await app.inject({
      method: 'GET',
      url: `/api/model-monitor/chat-channels?siteId=${site.id}&model=any-model-at-all`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.direct).toBe(true);
    expect(body.channels).toEqual([]);
    expect(body.credentials).toHaveLength(1);
    expect(body.credentials[0]).toMatchObject({
      accountId: account.id,
      accountName: 'direct-account',
      tokenName: '默认令牌',
      credential: 'api_token',
    });
    expect(typeof body.credentials[0].tokenId).toBe('number');
    // 绝不能把令牌明文带出来。
    expect(JSON.stringify(body)).not.toContain('sk-direct-123456');
  });

  it('站点模型即使被对外模型转发当成目标，对话也只直连该站点', async () => {
    const [site] = await db.select().from(schema.sites).all();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'forwarded',
      accessToken: 'jwt-token',
      status: 'active',
    }).returning().get();
    const rule = await db.insert(schema.modelForwardRules).values({
      modelName: 'gpt-6-astra',
      enabled: true,
    }).returning().get();
    const forwardRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: 'forward:gpt-6-astra',
      displayName: 'gpt-6-astra',
      routeMode: 'pattern',
      enabled: true,
    }).returning().get();
    await db.insert(schema.routeChannels).values({
      routeId: forwardRoute.id,
      accountId: account.id,
      sourceModel: 'deepseek-v4.1-flash',
      enabled: true,
      manualOverride: true,
    }).run();
    await db.insert(schema.modelForwardTargets).values({
      ruleId: rule.id,
      siteId: site.id,
      accountId: account.id,
      upstreamModel: 'deepseek-v4.1-flash',
      sortOrder: 0,
      enabled: true,
    }).run();

    const ok = await app.inject({
      method: 'GET',
      url: `/api/model-monitor/chat-channels?siteId=${site.id}&model=deepseek-v4.1-flash`,
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    // 关键：不能被转发规则带跑。模型名仍然是直连的那个上游模型名，
    // 也不会把对外模型名 / 转发通道塞进可选项，避免对话被转发到别的站点。
    expect(body.direct).toBe(true);
    expect(body.requestedModel).toBe('deepseek-v4.1-flash');
    expect(JSON.stringify(body)).not.toContain('gpt-6-astra');
    expect(body.channels).toEqual([]);
  });

  it('queues a collection run when refresh is requested', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/model-monitor/refresh' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(typeof body.taskId).toBe('string');
  });
});
