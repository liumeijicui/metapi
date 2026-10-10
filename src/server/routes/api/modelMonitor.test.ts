import Fastify, { type FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const requestSiteDirectChatMock = vi.hoisted(() => vi.fn());

// 只替换「发请求」那一步：凭据解析等仍走真实实现。
vi.mock('../../services/siteDirectChatService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/siteDirectChatService.js')>();
  return { ...actual, requestSiteDirectChat: requestSiteDirectChatMock };
});
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

  it('默认排序先看绿格数，再看平均成功率', async () => {
    const [site] = await db.select().from(schema.sites).all();
    await db.insert(schema.siteModelMonitorModels).values([
      {
        siteId: site.id,
        modelName: 'steady',
        successRate: 80,
        avgLatencyMs: 100,
        avgTps: 10,
        recentSuccess: JSON.stringify([{ ts: null, rate: 95 }, { ts: null, rate: 96 }]),
        fetchedAt: '2026-10-04T03:00:00.000Z',
      },
      {
        siteId: site.id,
        modelName: 'spiky',
        successRate: 99.9,
        avgLatencyMs: 100,
        avgTps: 10,
        recentSuccess: JSON.stringify([{ ts: null, rate: 100 }]),
        fetchedAt: '2026-10-04T03:00:00.000Z',
      },
    ]).run();

    const body = (await app.inject({ method: 'GET', url: '/api/model-monitor/overview' })).json();
    // steady 的平均成功率更低，但两颗绿格比 spiky 的一颗多，所以排在前面；
    // 后面两个一格采样都没有，回到按成功率排（99 > 40）。
    expect(body.models.map((row: any) => row.modelName)).toEqual(['steady', 'spiky', 'gpt-5.5', 'grok-4.5']);
  });

  it('支持按输入价从低到高排序，没标价的排最后', async () => {
    const [site] = await db.select().from(schema.sites).all();
    await db.update(schema.siteModelMonitorModels)
      .set({ pricingUnit: 'token', inputPrice: 75, outputPrice: 150 })
      .where(eq(schema.siteModelMonitorModels.modelName, 'gpt-5.5'))
      .run();
    await db.insert(schema.siteModelMonitorModels).values({
      siteId: site.id,
      modelName: 'cheap-model',
      successRate: 90,
      avgLatencyMs: 100,
      avgTps: 10,
      pricingUnit: 'token',
      inputPrice: 0.3,
      outputPrice: 1.2,
      fetchedAt: '2026-10-04T03:00:00.000Z',
    }).run();

    const body = (await app.inject({ method: 'GET', url: '/api/model-monitor/overview?sort=price' })).json();
    // grok-4.5 没有标价：既不算免费也不算最便宜，压到最后。
    expect(body.models.map((row: any) => row.modelName)).toEqual(['cheap-model', 'gpt-5.5', 'grok-4.5']);
    expect(body.models[0]).toMatchObject({ inputPrice: 0.3, outputPrice: 1.2 });
  });

  it('支持按模型家族筛选：模型候选跟着收窄，家族候选不受自己影响', async () => {
    const [site] = await db.select().from(schema.sites).all();
    await db.insert(schema.siteModelMonitorModels).values({
      siteId: site.id,
      modelName: 'deepseek-v4.1-flash',
      successRate: 98,
      avgLatencyMs: 100,
      avgTps: 10,
      fetchedAt: '2026-10-04T03:00:00.000Z',
    }).run();

    const all = (await app.inject({ method: 'GET', url: '/api/model-monitor/overview' })).json();
    const byValue = new Map(all.families.map((family: any) => [family.value, family]));
    expect(byValue.get('deepseek')).toMatchObject({ label: 'DeepSeek', count: 1 });
    expect(byValue.get('openai')).toMatchObject({ label: 'OpenAI', count: 1 });
    expect(byValue.get('grok')).toMatchObject({ label: 'Grok', count: 1 });
    expect(byValue.has('mistral')).toBe(false);

    const filtered = (await app.inject({ method: 'GET', url: '/api/model-monitor/overview?family=deepseek' })).json();
    expect(filtered.models.map((row: any) => row.modelName)).toEqual(['deepseek-v4.1-flash']);
    expect(filtered.modelOptions.map((row: any) => row.modelName)).toEqual(['deepseek-v4.1-flash']);
    // 家族下拉要留着别的类别：不然选完就换不回去了。
    expect(filtered.families).toEqual(all.families);

    // 非法家族名当「不筛」，不用 400 打断页面。
    const bogus = (await app.inject({ method: 'GET', url: '/api/model-monitor/overview?family=bogus' })).json();
    expect(bogus.models).toHaveLength(3);
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

  it('上游回 401 时，接口回 502 而不是 401（否则前端会把用户踢下线）', async () => {
    const [site] = await db.select().from(schema.sites).all();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'agentrouter-like',
      accessToken: 'jwt-token',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'EPejiq-not-a-real-secret',
      valueStatus: 'ready',
      enabled: true,
    }).returning().get();

    requestSiteDirectChatMock.mockReset();
    requestSiteDirectChatMock.mockResolvedValue({
      ok: false,
      status: 401,
      message: '{"error":{"message":"unauthorized client detected"}}',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/model-monitor/chat/stream',
      payload: {
        siteId: site.id,
        accountId: account.id,
        tokenId: null,
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    // 关键：绝不能是 401/403 —— 前端对这两个码会 clearAuthSession + reload。
    expect(response.statusCode).toBe(502);
    const body = response.json();
    expect(body.error.message).toContain('HTTP 401');
    expect(body.error.message).toContain('unauthorized client detected');
  });

  it('普通上游错误（如 503）原样返回，方便看到真实原因', async () => {
    const [site] = await db.select().from(schema.sites).all();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'busy-site',
      accessToken: 'jwt-token',
      status: 'active',
    }).returning().get();

    requestSiteDirectChatMock.mockReset();
    requestSiteDirectChatMock.mockResolvedValue({
      ok: false,
      status: 503,
      message: 'No available channel for model gpt-5 under group default',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/model-monitor/chat/stream',
      payload: {
        siteId: site.id,
        accountId: account.id,
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.message).toContain('No available channel');
  });

  /** 直连对话写进 proxy_logs 的那一行（按 client_app_name 认，避免误伤网关日志）。 */
  async function latestDirectChatLog() {
    const rows = await db.select().from(schema.proxyLogs).all();
    return rows
      .filter((row) => row.clientAppName === '模型测试')
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
      .at(-1);
  }

  it('成功对话的日志带上首字耗时', async () => {
    const [site] = await db.select().from(schema.sites).all();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'first-byte',
      accessToken: 'jwt-token',
      status: 'active',
    }).returning().get();

    const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    requestSiteDirectChatMock.mockReset();
    requestSiteDirectChatMock.mockResolvedValue({
      ok: true,
      response: new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      latencyMs: 1234,
      firstByteLatencyMs: 420,
      touch: () => {},
      timeoutReason: () => null,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/model-monitor/chat/stream',
      payload: {
        siteId: site.id,
        accountId: account.id,
        model: 'glm-4.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(response.statusCode).toBe(200);

    const log = await latestDirectChatLog();
    expect(log).toMatchObject({
      accountId: account.id,
      modelRequested: 'glm-4.5-flash',
      status: 'success',
      isStream: true,
      firstByteLatencyMs: 420,
    });
  });

  it('上游失败（还没出字）时首字留空，不拿总耗时冒充', async () => {
    const [site] = await db.select().from(schema.sites).all();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'no-first-byte',
      accessToken: 'jwt-token',
      status: 'active',
    }).returning().get();

    requestSiteDirectChatMock.mockReset();
    requestSiteDirectChatMock.mockResolvedValue({
      ok: false,
      status: 503,
      message: 'No available channel',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/model-monitor/chat/stream',
      payload: {
        siteId: site.id,
        accountId: account.id,
        model: 'glm-4.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(response.statusCode).toBe(503);

    const log = await latestDirectChatLog();
    expect(log).toMatchObject({ status: 'failed', firstByteLatencyMs: null });
  });

  it('queues a collection run when refresh is requested', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/model-monitor/refresh' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(typeof body.taskId).toBe('string');
  });
});
