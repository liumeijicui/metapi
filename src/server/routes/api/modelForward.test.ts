import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('model forward routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let siteId = 0;
  let accountId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-forward-routes-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./modelForward.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.modelForwardRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();

    const site = await db.insert(schema.sites).values({
      name: '接口测试站',
      url: 'https://forward-api.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'api-user',
      accessToken: 'access-api',
      status: 'active',
    }).returning().get();
    accountId = account.id;
    await db.insert(schema.accountTokens).values({
      accountId,
      name: 'default',
      token: 'token-api',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('创建 / 查询 / 编辑 / 启停 / 删除转发规则', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-forward-rules',
      payload: {
        modelName: 'gpt-6-astra',
        targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const rule = created.json().rule;
    expect(rule.modelName).toBe('gpt-6-astra');
    expect(rule.targets).toHaveLength(1);

    const listed = await app.inject({ method: 'GET', url: '/api/model-forward-rules' });
    expect(listed.json().rules).toHaveLength(1);

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/model-forward-rules/${rule.id}`,
      payload: {
        modelName: 'claude-test-9',
        targets: [{ siteId, accountId, upstreamModel: 'glm-5.3-flash' }],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().rule.modelName).toBe('claude-test-9');
    expect(updated.json().rule.targets[0].upstreamModel).toBe('glm-5.3-flash');

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/model-forward-rules/${rule.id}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.json().rule.enabled).toBe(false);

    const removed = await app.inject({ method: 'DELETE', url: `/api/model-forward-rules/${rule.id}` });
    expect(removed.statusCode).toBe(200);
    const afterDelete = await app.inject({ method: 'GET', url: '/api/model-forward-rules' });
    expect(afterDelete.json().rules).toHaveLength(0);
  });

  it('非法入参返回 400', async () => {
    const noTargets = await app.inject({
      method: 'POST',
      url: '/api/model-forward-rules',
      payload: { modelName: 'x', targets: [] },
    });
    expect(noTargets.statusCode).toBe(400);

    const noName = await app.inject({
      method: 'POST',
      url: '/api/model-forward-rules',
      payload: { modelName: '', targets: [{ siteId, accountId, upstreamModel: 'm' }] },
    });
    expect(noName.statusCode).toBe(400);

    const badId = await app.inject({ method: 'PUT', url: '/api/model-forward-rules/abc', payload: {} });
    expect(badId.statusCode).toBe(400);
  });

  it('对外模型名大小写不敏感，重复会被拒绝', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/model-forward-rules',
      payload: {
        modelName: 'gpt-6-astra',
        targets: [{ siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' }],
      },
    });
    expect(first.statusCode).toBe(201);

    const duplicated = await app.inject({
      method: 'POST',
      url: '/api/model-forward-rules',
      payload: {
        modelName: 'GPT-6-Astra',
        targets: [{ siteId, accountId, upstreamModel: 'kimi-k3' }],
      },
    });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json().message).toContain('已经有转发规则');
  });

  it('转发目标支持置顶 / 上移 / 下移与单独启停', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/model-forward-rules',
      payload: {
        modelName: 'gpt-6-astra',
        targets: [
          { siteId, accountId, upstreamModel: 'model-a' },
          { siteId, accountId, upstreamModel: 'model-b' },
          { siteId, accountId, upstreamModel: 'model-c' },
        ],
      },
    });
    const rule = created.json().rule;
    const targetId = (model: string) =>
      rule.targets.find((target: { upstreamModel: string }) => target.upstreamModel === model).id;
    const order = (body: { rule: { targets: Array<{ upstreamModel: string }> } }) =>
      body.rule.targets.map((target) => target.upstreamModel);

    const movedToTop = await app.inject({
      method: 'POST',
      url: `/api/model-forward-rules/${rule.id}/targets/${targetId('model-c')}/move`,
      payload: { action: 'top' },
    });
    expect(movedToTop.statusCode).toBe(200);
    expect(order(movedToTop.json())).toEqual(['model-c', 'model-a', 'model-b']);

    const movedUp = await app.inject({
      method: 'POST',
      url: `/api/model-forward-rules/${rule.id}/targets/${targetId('model-b')}/move`,
      payload: { action: 'up' },
    });
    expect(order(movedUp.json())).toEqual(['model-c', 'model-b', 'model-a']);

    const movedDown = await app.inject({
      method: 'POST',
      url: `/api/model-forward-rules/${rule.id}/targets/${targetId('model-c')}/move`,
      payload: { action: 'down' },
    });
    expect(order(movedDown.json())).toEqual(['model-b', 'model-c', 'model-a']);

    const disabled = await app.inject({
      method: 'POST',
      url: `/api/model-forward-rules/${rule.id}/targets/${targetId('model-a')}/enabled`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    const disabledTarget = disabled.json().rule.targets
      .find((target: { upstreamModel: string }) => target.upstreamModel === 'model-a');
    expect(disabledTarget.enabled).toBe(false);
    expect(disabledTarget.channelEnabled).toBe(false);

    const badAction = await app.inject({
      method: 'POST',
      url: `/api/model-forward-rules/${rule.id}/targets/${targetId('model-a')}/move`,
      payload: { action: 'sideways' },
    });
    expect(badAction.statusCode).toBe(400);

    const badTarget = await app.inject({
      method: 'POST',
      url: `/api/model-forward-rules/${rule.id}/targets/abc/enabled`,
      payload: { enabled: true },
    });
    expect(badTarget.statusCode).toBe(400);
  });

  it('模型监控一键挂载接口：追加到末尾，重复返回 400', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/model-forward-attach',
      payload: { siteId, upstreamModel: 'gpt-5.5', modelName: 'public-model' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().created).toBe(true);
    expect(first.json().rule.targets).toHaveLength(1);

    const second = await app.inject({
      method: 'POST',
      url: '/api/model-forward-attach',
      payload: { siteId, upstreamModel: 'gpt-6', modelName: 'public-model' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().created).toBe(false);
    expect(second.json().rule.targets.map((target: { upstreamModel: string }) => target.upstreamModel))
      .toEqual(['gpt-5.5', 'gpt-6']);

    const duplicated = await app.inject({
      method: 'POST',
      url: '/api/model-forward-attach',
      payload: { siteId, upstreamModel: 'gpt-5.5', modelName: 'PUBLIC-MODEL' },
    });
    expect(duplicated.statusCode).toBe(400);
    expect(duplicated.json().message).toContain('不能重复添加');

    const missingModel = await app.inject({
      method: 'POST',
      url: '/api/model-forward-attach',
      payload: { siteId, upstreamModel: '', modelName: 'public-model' },
    });
    expect(missingModel.statusCode).toBe(400);
  });

  it('选项中包含站点、账号与站点模型列表', async () => {
    const options = await app.inject({ method: 'GET', url: `/api/model-forward-options?siteId=${siteId}` });
    expect(options.statusCode).toBe(200);
    const body = options.json();
    expect(body.sites.some((site: { id: number }) => site.id === siteId)).toBe(true);
    expect(body.accounts.some((account: { id: number }) => account.id === accountId)).toBe(true);
    expect(Array.isArray(body.models)).toBe(true);
  });
});
