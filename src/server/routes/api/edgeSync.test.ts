import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('edge relay 同步接口', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let siteId = 0;
  let accountId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-edge-sync-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./edgeSync.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.edgeSyncRoutes);
    // 首次运行要跑完整迁移并加载整个转发链路，比默认 10s 的钩子超时更久。
  }, 60_000);

  beforeEach(async () => {
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: '边缘同步测试站',
      url: 'https://edge-sync.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'edge-user',
      accessToken: 'edge-access',
      status: 'active',
    }).returning().get();
    accountId = account.id;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('没有转发规则时返回空快照', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/edge/model-forward-rules' });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    expect(payload.success).toBe(true);
    expect(payload.version).toBe(1);
    expect(typeof payload.generatedAt).toBe('string');
    expect(payload.rules).toEqual([]);
    expect(payload.targets).toEqual([]);
  });

  it('导出规则与目标，目标按 sortOrder 排序且不改动任何数据', async () => {
    const rule = await db.insert(schema.modelForwardRules).values({
      modelName: 'gpt-6-astra',
      enabled: true,
      routeId: 12,
      notes: '主线路',
    }).returning().get();
    await db.insert(schema.modelForwardTargets).values([
      {
        ruleId: rule.id,
        siteId,
        accountId,
        upstreamModel: 'deepseek-v4-flash',
        channelId: 7,
        weight: 20,
        enabled: true,
        sortOrder: 1,
      },
      {
        ruleId: rule.id,
        siteId,
        accountId,
        upstreamModel: 'gpt-6-astra',
        weight: 10,
        enabled: false,
        sortOrder: 0,
      },
    ]).run();

    const response = await app.inject({ method: 'GET', url: '/api/edge/model-forward-rules' });
    expect(response.statusCode).toBe(200);
    const payload = response.json();

    expect(payload.rules).toHaveLength(1);
    expect(payload.rules[0]).toMatchObject({
      id: rule.id,
      modelName: 'gpt-6-astra',
      enabled: true,
      routeId: 12,
      notes: '主线路',
    });

    // 顺序即调用优先级，边缘端镜像时必须保持。
    expect(payload.targets).toHaveLength(2);
    expect(payload.targets.map((target: { upstreamModel: string }) => target.upstreamModel))
      .toEqual(['gpt-6-astra', 'deepseek-v4-flash']);
    expect(payload.targets[1]).toMatchObject({
      ruleId: rule.id,
      siteId,
      accountId,
      upstreamModel: 'deepseek-v4-flash',
      channelId: 7,
      weight: 20,
      enabled: true,
      sortOrder: 1,
    });
    expect(payload.targets[0].channelId).toBeNull();
    expect(payload.targets[0].enabled).toBe(false);

    // 只读接口：导出不得改动规则表。
    const ruleCount = await db.select().from(schema.modelForwardRules).all();
    const targetCount = await db.select().from(schema.modelForwardTargets).all();
    expect(ruleCount).toHaveLength(1);
    expect(targetCount).toHaveLength(2);
  });
});
