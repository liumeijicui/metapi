import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, withSiteProxyRequestInitMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  withSiteProxyRequestInitMock: vi.fn(),
}));

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  UNLIMITED_BODY_TIMEOUT: { bodyTimeout: 0 },
  withSiteProxyRequestInit: (...args: unknown[]) => withSiteProxyRequestInitMock(...args),
}));

import {
  fetchModelPricingCatalog,
  peekPricingDataCache,
} from './modelPricingService.js';

function pricingResponse() {
  return new Response(JSON.stringify({
    data: [{
      model_name: 'gpt-6-astra',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 1,
      enable_groups: ['default'],
    }],
    group_ratio: { default: 1 },
  }), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function pricingUrl(siteId: number): string {
  return `https://pricing-cache-${siteId}.example.com/api/pricing`;
}

// 每个用例一个独立站点，避免共享的模块级缓存互相干扰。
function inputFor(siteId: number) {
  return {
    site: { id: siteId, url: `https://pricing-cache-${siteId}.example.com`, platform: 'new-api' },
    account: { id: 601, accessToken: 'token-a' },
    modelName: '',
    totalTokens: 0,
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitUntil timed out');
}

/** 让 fetch 挂起，直到测试显式放行对应 URL。 */
function stubPendingFetchByUrl(): Map<string, (value: Response) => void> {
  const resolvers = new Map<string, (value: Response) => void>();
  fetchMock.mockImplementation((url: unknown) => new Promise<Response>((resolve) => {
    resolvers.set(String(url), resolve);
  }));
  return resolvers;
}

describe('modelPricingService pricing cache', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(
      async (_url: string, init: Record<string, unknown>) => init,
    );
  });

  it('returns nothing on a cacheOnly miss and never waits for the network', async () => {
    // fetch 永不返回：只要实现还在请求路径上等它，这个用例就会超时。
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));

    const catalog = await fetchModelPricingCatalog(inputFor(501) as any, { cacheOnly: true });

    expect(catalog).toBeNull();
    expect(peekPricingDataCache(inputFor(501) as any).present).toBe(false);
    // fetchJson 内部是 `await import('undici')`，真正的 fetch 要到微任务才发起；
    // 这里等它落地，否则它会算进下一个用例的 mock 计数（跨用例串扰）。
    await waitUntil(() => fetchMock.mock.calls.length === 1);
  });

  it('warms the cache in the background so a later request hits it', async () => {
    const resolvers = stubPendingFetchByUrl();
    const input = inputFor(502);

    expect(await fetchModelPricingCatalog(input as any, { cacheOnly: true })).toBeNull();
    await waitUntil(() => resolvers.has(pricingUrl(502)));

    resolvers.get(pricingUrl(502))!(pricingResponse());
    await waitUntil(() => peekPricingDataCache(input as any).fresh);

    const warm = await fetchModelPricingCatalog(input as any, { cacheOnly: true });
    expect(warm?.models.map((model) => model.modelName)).toEqual(['gpt-6-astra']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still fetches on demand when cacheOnly is not requested', async () => {
    fetchMock.mockResolvedValue(pricingResponse());

    const catalog = await fetchModelPricingCatalog(inputFor(503) as any);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(catalog?.models.map((model) => model.modelName)).toEqual(['gpt-6-astra']);
  });

  it('deduplicates concurrent cache misses for the same site', async () => {
    const resolvers = stubPendingFetchByUrl();
    const input = inputFor(504);

    await Promise.all([
      fetchModelPricingCatalog(input as any, { cacheOnly: true }),
      fetchModelPricingCatalog(input as any, { cacheOnly: true }),
      fetchModelPricingCatalog(input as any, { cacheOnly: true }),
    ]);

    await waitUntil(() => resolvers.has(pricingUrl(504)));
    // 再放几轮事件循环，确认没有重复抓取。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolvers.get(pricingUrl(504))!(pricingResponse());
    await waitUntil(() => peekPricingDataCache(input as any).fresh);
  });
});
