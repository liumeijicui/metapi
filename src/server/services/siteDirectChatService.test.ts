import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const undiciFetchMock = vi.hoisted(() => vi.fn());

// 服务里用的是 `import { fetch } from 'undici'`，所以不能只 spy 全局 fetch。
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: undiciFetchMock };
});

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./siteDirectChatService.js');

describe('siteDirectChatService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-direct-chat-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./siteDirectChatService.js');
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function seed(input: {
    withToken?: boolean;
    tokenReady?: boolean;
    accountStatus?: string;
  } = {}) {
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'Direct Site',
      url: 'https://direct.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'direct-user',
      accessToken: 'jwt-token',
      status: input.accountStatus ?? 'active',
    }).returning().get();
    let tokenId: number | null = null;
    if (input.withToken !== false) {
      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: '默认令牌',
        token: 'sk-direct-secret',
        valueStatus: input.tokenReady === false ? 'masked_pending' : 'ready',
        enabled: true,
      }).returning().get();
      tokenId = token.id;
    }
    return { site, account, tokenId };
  }

  it('站点只有账号和 sk 密钥、完全没有路由时也能直连', async () => {
    const { site, account, tokenId } = await seed();
    // 特意不建任何 token_routes / route_channels。
    const targets = await service.listSiteDirectChatTargets(site.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      accountId: account.id,
      tokenId,
      accountName: 'direct-user',
      tokenName: '默认令牌',
      credential: 'api_token',
    });
    // 只暴露令牌 id，不带明文。
    expect(JSON.stringify(targets)).not.toContain('sk-direct-secret');

    const resolved = await service.resolveSiteDirectChat({ siteId: site.id, accountId: account.id, tokenId });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.tokenValue).toBe('sk-direct-secret');
  });

  it('账号没有 sk 令牌时退回账号凭据', async () => {
    const { site, account } = await seed({ withToken: false });
    const targets = await service.listSiteDirectChatTargets(site.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ accountId: account.id, tokenId: null, credential: 'account' });
  });

  it('令牌没就绪时不当作可用凭据，也不带出明文', async () => {
    const { site, account, tokenId } = await seed({ tokenReady: false });
    const targets = await service.listSiteDirectChatTargets(site.id);
    // 令牌不可用时退回账号凭据，而不是把未就绪的密钥拿来用。
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ accountId: account.id, tokenId: null, credential: 'account' });

    const resolved = await service.resolveSiteDirectChat({ siteId: site.id, accountId: account.id, tokenId });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain('不可用');
  });

  /** 用假的 undici fetch 接住直连请求，返回捕获到的报文，方便断言真实请求。 */
  function mockUpstreamFetch() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    undiciFetchMock.mockReset();
    undiciFetchMock.mockImplementation((async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init || {}) as RequestInit });
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as never);
    // 端点推导可能会顺带拉一次上游客单价（GET /api/pricing），
    // 这里只挑出发给 /v1/chat/completions 的对话请求来断言。
    const chatCalls = () => calls.filter((item) => item.init.method === 'POST');
    return { calls, chatCalls };
  }

  it('思考强度等额外字段原样透传，并且固定走 OpenAI 协议的 /v1/chat/completions', async () => {
    const { site, account, tokenId } = await seed();
    const { chatCalls } = mockUpstreamFetch();
    const outcome = await service.requestSiteDirectChat({
      siteId: site.id,
      accountId: account.id,
      tokenId,
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 30_000,
      extraBody: { reasoning_effort: 'high' },
    });

    if (!outcome.ok) throw new Error(`直连失败：${outcome.message}`);
    expect(chatCalls()).toHaveLength(1);
    expect(chatCalls()[0].url).toBe('https://direct.example.com/v1/chat/completions');
    const body = JSON.parse(String(chatCalls()[0].init.body));
    expect(body.reasoning_effort).toBe('high');
    expect(body.model).toBe('kimi-k3');
    expect(body.stream).toBe(true);
  });

  it('不传思考强度时不会凭空造出 reasoning_effort', async () => {
    const { site, account, tokenId } = await seed();
    const { chatCalls } = mockUpstreamFetch();
    const outcome = await service.requestSiteDirectChat({
      siteId: site.id,
      accountId: account.id,
      tokenId,
      model: 'kimi-k3',
      messages: [{ role: 'user', content: 'hi' }],
      timeoutMs: 30_000,
    });

    if (!outcome.ok) throw new Error(`直连失败：${outcome.message}`);
    expect('reasoning_effort' in JSON.parse(String(chatCalls()[0].init.body))).toBe(false);
  });

  it('流式对话：只要还在吐字就不会被空闲超时打断，真卡死了才断', async () => {
    const { site, account, tokenId } = await seed();
    const { chatCalls } = mockUpstreamFetch();
    vi.useFakeTimers();
    try {
      const outcome = await service.requestSiteDirectChat({
        siteId: site.id,
        accountId: account.id,
        tokenId,
        model: 'kimi-k3',
        messages: [{ role: 'user', content: 'hi' }],
        timeoutMs: 300_000,
        idleTimeoutMs: 60_000,
      });
      if (!outcome.ok) throw new Error(`直连失败：${outcome.message}`);
      // 正常流式过程中不该报超时。
      expect(outcome.timeoutReason()).toBe(null);
      const requestSignal = chatCalls()[0].init.signal as AbortSignal;
      // 55s 时来了一块数据（touch），再等 55s 也不该被判定为空闲超时。
      await vi.advanceTimersByTimeAsync(55_000);
      outcome.touch();
      await vi.advanceTimersByTimeAsync(55_000);
      expect(requestSignal.aborted).toBe(false);
      // 之后一直没数据，超过空闲上限就该断，并且要说清楚是「多久没数据」。
      await vi.advanceTimersByTimeAsync(61_000);
      expect(requestSignal.aborted).toBe(true);
      expect(outcome.timeoutReason()).toContain('没有返回任何新数据');
    } finally {
      vi.useRealTimers();
    }
  });

  it('上游的 401 / 403 会被改写成 502，避免前端当成自己的登录失效', () => {
    // agentrouter 就是这么回：{"error":{"message":"unauthorized client detected"}}
    const rejected = service.toClientFacingDirectChatFailure({
      status: 401,
      message: '{"error":{"message":"unauthorized client detected"}}',
    });
    expect(rejected.status).toBe(502);
    expect(rejected.message).toContain('HTTP 401');
    expect(rejected.message).toContain('unauthorized client detected');

    expect(service.toClientFacingDirectChatFailure({ status: 403, message: 'forbidden' }).status).toBe(502);
    // 其它状态码原样保留，真实原因不能被抹掉。
    expect(service.toClientFacingDirectChatFailure({ status: 503, message: 'upstream busy' })).toEqual({
      status: 503,
      message: 'upstream busy',
    });
    // 上游给的怪状态码不能直接塞给 Fastify。
    expect(service.toClientFacingDirectChatFailure({ status: 0, message: 'x' }).status).toBe(502);
    expect(service.toClientFacingDirectChatFailure({ status: 999, message: 'x' }).status).toBe(502);
  });

  it('跨站点取账号会被拒绝', async () => {
    const { site, account } = await seed();
    const other = await db.insert(schema.sites).values({
      name: 'Other Site',
      url: 'https://other.example.com',
      platform: 'new-api',
    }).returning().get();
    const resolved = await service.resolveSiteDirectChat({
      siteId: other.id,
      accountId: account.id,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain('不属于该站点');

    expect(await service.listSiteDirectChatTargets(other.id)).toEqual([]);
    expect(await service.listSiteDirectChatTargets(site.id)).toHaveLength(1);
  });
});
