import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type AnyRecord = Record<string, any>;

describe('边缘实例本地只读接口（模型转发 + 使用日志）', () => {
  let dataDir = '';
  let app: FastifyInstance;
  let db: AnyRecord;
  let schema: AnyRecord;
  let logId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-edge-local-api-'));
    process.env.DATA_DIR = dataDir;
    process.env.METAPI_EDGE_MODE = '1';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '30086';
    process.env.DB_URL = ':memory:';

    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    const migrateModule = await import('../db/migrate.js');
    migrateModule.runSqliteMigrationsOn(dbModule.getSqliteConnection());
    await dbModule.ensureSiteCompatibilityColumns();
    await dbModule.ensureRouteGroupingCompatibilityColumns();
    await dbModule.ensureProxyLogStreamTimingColumns();
    await dbModule.ensureProxyLogClientColumns();
    await dbModule.ensureProxyLogDownstreamApiKeyIdColumn();
    await dbModule.ensureProxyLogBillingDetailsColumn();

    // 内存镜像里的一份服务器配置：站点 + 账号 + 一条转发规则。
    const site = await db.insert(schema.sites).values({
      name: '边缘镜像站',
      url: 'https://edge-mirror.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get() as AnyRecord;
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'mirror-user',
      accessToken: 'mirror-access',
      status: 'active',
    }).returning().get() as AnyRecord;
    const rule = await db.insert(schema.modelForwardRules).values({
      modelName: 'gpt-6-astra',
      enabled: true,
    }).returning().get() as AnyRecord;
    await db.insert(schema.modelForwardTargets).values({
      ruleId: rule.id,
      siteId: site.id,
      accountId: account.id,
      upstreamModel: 'deepseek-v4-flash',
      weight: 10,
      enabled: true,
      sortOrder: 0,
    }).run();
    const log = await db.insert(schema.proxyLogs).values({
      accountId: account.id,
      modelRequested: 'gpt-6-astra',
      status: 'success',
      totalTokens: 42,
      createdAt: '2026-10-08 02:00:00',
    }).returning().get() as AnyRecord;
    logId = log.id;

    app = Fastify();
    await app.register((await import('./localApiRoutes.js')).edgeLocalApiRoutes);
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    delete process.env.DATA_DIR;
    delete process.env.METAPI_EDGE_MODE;
    delete process.env.DB_URL;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('模型转发页拿得到镜像下来的规则与选项', async () => {
    const rules = await app.inject({ method: 'GET', url: '/api/model-forward-rules' });
    expect(rules.statusCode).toBe(200);
    expect(JSON.parse(rules.body).rules).toHaveLength(1);
    expect(JSON.parse(rules.body).rules[0].modelName).toBe('gpt-6-astra');

    const options = await app.inject({ method: 'GET', url: '/api/model-forward-options' });
    expect(options.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(options.body).sites)).toBe(true);
  });

  it('使用日志页拿得到列表、汇总与详情', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/stats/proxy-logs?view=query&limit=10' });
    expect(list.statusCode).toBe(200);
    const listBody = JSON.parse(list.body);
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].modelRequested).toBe('gpt-6-astra');

    const meta = await app.inject({ method: 'GET', url: '/api/stats/proxy-logs?view=meta' });
    expect(meta.statusCode).toBe(200);
    expect(JSON.parse(meta.body).summary.totalCount).toBe(1);

    const detail = await app.inject({ method: 'GET', url: `/api/stats/proxy-logs/${logId}` });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body).modelRequested).toBe('gpt-6-astra');
  });

  it('日志页调试面板要的运行设置能读到', async () => {
    const runtime = await app.inject({ method: 'GET', url: '/api/settings/runtime' });
    expect(runtime.statusCode).toBe(200);
    expect(typeof JSON.parse(runtime.body).proxyDebugTraceEnabled).toBe('boolean');
  });

  it('调试面板保存只接受调试项，其他运行设置一概不写', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        proxyDebugTraceEnabled: true,
        proxyDebugRetentionHours: 6,
        webhookUrl: 'https://not-allowed.example.com',
      },
    });
    expect(saved.statusCode).toBe(200);
    const savedBody = JSON.parse(saved.body);
    expect(savedBody.proxyDebugTraceEnabled).toBe(true);
    expect(savedBody.proxyDebugRetentionHours).toBe(6);

    const rejected = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, 'webhook_url')).get();
    expect(rejected).toBeUndefined();

    const invalid = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: { proxyDebugRetentionHours: 'abc' },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
