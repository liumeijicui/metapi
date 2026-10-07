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

import { fetchModelPricingCatalog } from './modelPricingService.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

describe('modelPricingService tiered_expr 价格', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    withSiteProxyRequestInitMock.mockReset();
    withSiteProxyRequestInitMock.mockImplementation(async (_url: string, init: Record<string, unknown>) => init);
  });

  it('表达式计费站点按 billing_expr 出价，不再读废掉的 model_ratio', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [
        {
          model_name: 'deepseek-v4.1-flash',
          quota_type: 0,
          // 这些站点会把 model_ratio 固定成 37.5（旧逻辑算出 $75/$75）。
          model_ratio: 37.5,
          completion_ratio: 1,
          model_price: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * 0.3 + c * 1.2 + cr * 0.006)',
          enable_groups: ['default'],
        },
        {
          model_name: 'kimi-k3',
          quota_type: 0,
          model_ratio: 37.5,
          completion_ratio: 1,
          model_price: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * 3 + c * 15 + cr * 0.3)',
          enable_groups: ['default'],
        },
        {
          model_name: 'gpt-image-2',
          quota_type: 0,
          model_ratio: 37.5,
          completion_ratio: 1,
          model_price: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", fixed(0.6))',
          enable_groups: ['default'],
        },
        {
          model_name: 'plain-ratio-model',
          quota_type: 0,
          model_ratio: 2.5,
          completion_ratio: 5,
          model_price: 0,
          enable_groups: ['default'],
        },
      ],
      group_ratio: { default: 2 },
    }));

    const catalog = await fetchModelPricingCatalog({
      site: { id: 19, url: 'https://happycoding.example.com', platform: 'new-api' },
      account: { id: 1, accessToken: 'token' },
    });

    const byName = new Map(catalog?.models.map((model) => [model.modelName, model]));
    // 表达式价 × 分组倍率(2)。
    expect(byName.get('deepseek-v4.1-flash')?.groupPricing.default).toMatchObject({
      quotaType: 0,
      inputPerMillion: 0.6,
      outputPerMillion: 2.4,
    });
    expect(byName.get('kimi-k3')?.groupPricing.default).toMatchObject({
      inputPerMillion: 6,
      outputPerMillion: 30,
    });
    // fixed() 走按次计费。
    expect(byName.get('gpt-image-2')?.groupPricing.default).toMatchObject({
      quotaType: 1,
      perCallTotal: 1.2,
    });
    expect(byName.get('gpt-image-2')?.quotaType).toBe(1);
    // 普通倍率模型不受影响。
    expect(byName.get('plain-ratio-model')?.groupPricing.default).toMatchObject({
      quotaType: 0,
      inputPerMillion: 10,
      outputPerMillion: 50,
    });
  });

  it('表达式解析不了时不给假价（宁缺勿错）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [
        {
          model_name: 'broken-expr-model',
          quota_type: 0,
          model_ratio: 37.5,
          completion_ratio: 1,
          model_price: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * )',
          enable_groups: ['default'],
        },
      ],
      group_ratio: { default: 1 },
    }));

    const catalog = await fetchModelPricingCatalog({
      site: { id: 20, url: 'https://broken.example.com', platform: 'new-api' },
      account: { id: 1, accessToken: 'token' },
    });

    expect(catalog?.models[0]?.groupPricing.default).toMatchObject({
      quotaType: 0,
      inputPerMillion: undefined,
      outputPerMillion: undefined,
    });
  });
});
