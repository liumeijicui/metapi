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
  buildProxyBillingDetails,
  estimateProxyCost,
  fetchModelPricingCatalog,
} from './modelPricingService.js';

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

  /**
   * 回归：以前只有「价目表展示」认 billing_expr，真正记账的
   * calculateModelUsageCost / buildProxyBillingDetails 还在读废掉的 model_ratio，
   * 于是同一个模型监控页显示 $0.3、日志按 $75 计费（happycoding 实测）。
   */
  it('记账也认 billing_expr：不再把 $0.3/M 的模型算成 $75/M', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [
        {
          model_name: 'deepseek-v4.1-flash',
          quota_type: 0,
          model_ratio: 37.5,
          completion_ratio: 1,
          model_price: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * 0.3 + c * 1.2 + cr * 0.006)',
          enable_groups: ['default'],
        },
      ],
      group_ratio: { default: 1 },
    }));

    const input = {
      site: { id: 21, url: 'https://billing.example.com', platform: 'new-api' },
      account: { id: 1, accessToken: 'token' },
      modelName: 'deepseek-v4.1-flash',
      promptTokens: 95717,
      completionTokens: 322,
      totalTokens: 96039,
      cacheReadTokens: 95488,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: true,
    };

    const details = await buildProxyBillingDetails(input);
    // 单价必须来自表达式（$0.3 / $1.2 / $0.006），而不是 37.5 * 2 = $75。
    expect(details?.breakdown).toMatchObject({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    });
    // 229 可计费输入 + 95488 缓存 + 322 输出 ≈ $0.001
    expect(details?.breakdown.totalCost).toBeCloseTo(0.001028, 6);
    expect(details?.pricing.billingMode).toBe('tiered_expr');
    expect(await estimateProxyCost(input)).toBeCloseTo(0.001028, 6);

    // self-log 的倍率覆盖（只带得回 model_ratio 37.5）不能把这个价顶回 $75：
    // 缓存里能读到 billing_expr 时以价目表为准。
    const overrideInput = {
      ...input,
      billingPricingOverride: {
        modelRatio: 37.5,
        completionRatio: 1,
        cacheRatio: 1,
        cacheCreationRatio: 1,
        groupRatio: 1,
      },
    };
    expect(await estimateProxyCost(overrideInput)).toBeCloseTo(0.001028, 6);
    expect((await buildProxyBillingDetails(overrideInput))?.breakdown.inputPerMillion).toBe(0.3);
  });

  it('冷缓存 + self-log 倍率覆盖也不该退回 $75（记账路径自己补一次价目表）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [
        {
          model_name: 'deepseek-v4.1-flash',
          quota_type: 0,
          model_ratio: 37.5,
          completion_ratio: 1,
          model_price: 0,
          billing_mode: 'tiered_expr',
          billing_expr: 'tier("base", p * 0.3 + c * 1.2 + cr * 0.006)',
          enable_groups: ['default'],
        },
      ],
      group_ratio: { default: 1 },
    }));

    // 站点 23 在本文件里没被访问过：此时进程内价目表缓存是空的。
    const overrideInput = {
      site: { id: 23, url: 'https://cold-cache.example.com', platform: 'new-api' },
      account: { id: 1, accessToken: 'token' },
      modelName: 'deepseek-v4.1-flash',
      promptTokens: 229,
      completionTokens: 184,
      totalTokens: 413,
      cacheReadTokens: 89600,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: false,
      billingPricingOverride: {
        modelRatio: 37.5,
        completionRatio: 1,
        cacheRatio: 1,
        cacheCreationRatio: 1,
        groupRatio: 1,
      },
    };

    const details = await buildProxyBillingDetails(overrideInput);
    expect(details?.breakdown).toMatchObject({
      inputPerMillion: 0.3,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.006,
    });
    // 用户那笔日志：229 / 89600 / 184，旧的 $75 会算成 $6.750975。
    expect(details?.breakdown.totalCost).toBeCloseTo(0.000828, 6);
    expect(await estimateProxyCost(overrideInput)).toBeCloseTo(0.000828, 6);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('fixed() 表达式按次计费不再算成 0', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      data: [
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
      ],
      group_ratio: { default: 1 },
    }));

    const input = {
      site: { id: 22, url: 'https://percall.example.com', platform: 'new-api' },
      account: { id: 1, accessToken: 'token' },
      modelName: 'gpt-image-2',
      promptTokens: 100,
      completionTokens: 0,
      totalTokens: 100,
    };

    // 以前走 model.modelPrice（0）→ 计费 0；现在必须取表达式里的 $0.6/次。
    expect(await estimateProxyCost(input)).toBeCloseTo(0.6, 6);
    expect(await buildProxyBillingDetails(input)).toBeNull();
  });
});
