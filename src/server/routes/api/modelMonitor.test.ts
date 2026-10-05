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
  });

  it('queues a collection run when refresh is requested', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/model-monitor/refresh' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(typeof body.taskId).toBe('string');
  });
});
