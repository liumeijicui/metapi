import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../siteProxy.js', () => ({
  UNLIMITED_BODY_TIMEOUT: { bodyTimeout: 0 },
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
}));

import {
  AgentRouterAdapter,
  buildModelStatusHeartbeatSamples,
  parseAgentRouterModelStatusPayload,
} from './agentRouter.js';

const BASE_URL = 'https://agentrouter.org';

/** 真实响应形状（站点把 Go 结构体直接序列化，字段名首字母大写）。 */
function modelStatusPayload(overrides: Record<string, unknown> = {}) {
  const bucketSeconds = 1200;
  // 从某个整点开始，24 小时 = 72 粒，最后一粒落在 23 小时处。
  const heartbeatStart = 1_800_000_000;
  return {
    success: true,
    data: {
      generated_at: '2026-10-08T11:18:54+08:00',
      window_hours: 24,
      bucket_seconds: bucketSeconds,
      banner: { Level: 'warn', Text: '1 个模型降级，其余正常' },
      tiles: { success_rate_24h: 97.01626508264393, models_up: 7, models_total: 7 },
      models: [
        {
          name: 'deepseek-v4-flash',
          status: 'operational',
          current_tier: 'ok',
          apis: ['chat', 'responses'],
          heartbeat: Array.from({ length: 72 }, () => 'ok'),
          heartbeat_start: heartbeatStart,
          ttft_p90_ms_24h: 3063,
          avg_latency_ms: 6111,
          success_rate_24h: 96.80205005792115,
        },
        {
          name: 'glm-5.3',
          status: 'degraded',
          current_tier: 'degraded',
          heartbeat: ['bad', 'severe', ...Array.from({ length: 70 }, () => 'none')],
          heartbeat_start: heartbeatStart,
          avg_latency_ms: 1234.5,
          success_rate_24h: 80,
        },
      ],
      ...overrides,
    },
  };
}

describe('parseAgentRouterModelStatusPayload', () => {
  it('把模型状态接口映射成 PerfMetricsSummary', () => {
    const parsed = parseAgentRouterModelStatusPayload(modelStatusPayload());
    expect(parsed).not.toBeNull();
    expect(parsed!.models.map((model) => model.modelName)).toEqual(['deepseek-v4-flash', 'glm-5.3']);
    expect(parsed!.models[0]).toMatchObject({ avgLatencyMs: 6111, successRate: 96.80205005792115 });
    // 站点不报吞吐：整列在页面上隐藏，而不是显示一堆 0。
    expect(parsed!.showThroughput).toBe(false);
    expect(parsed!.models.every((model) => model.avgTps === 0)).toBe(true);
    // 站点级概览优先用 tiles 的 24 小时可用率。
    expect(parsed!.summary?.successRate).toBeCloseTo(97.01626508264393, 6);
    expect(parsed!.summary?.avgLatencyMs).toBeCloseTo((6111 + 1234.5) / 2, 6);
  });

  it('把档位心跳折成整点采样点，无调用的整点不产出采样点', () => {
    const parsed = parseAgentRouterModelStatusPayload(modelStatusPayload());
    const degraded = parsed!.models.find((model) => model.modelName === 'glm-5.3')!;
    // 第一粒 bad 落在起始整点，第二粒 severe 仍在同一小时内 → 取最差档（0）。
    expect(degraded.recentSuccess).toEqual([{ ts: 1_800_000_000_000, rate: 0 }]);
    const healthy = parsed!.models.find((model) => model.modelName === 'deepseek-v4-flash')!;
    // 24 小时 × 每小时 1 个槽位，且全部为 ok（100）。
    expect(healthy.recentSuccess).toHaveLength(24);
    expect(healthy.recentSuccess.every((sample) => sample.rate === 100)).toBe(true);
    expect(parsed!.windowStart).toBe(1_800_000_000_000);
    expect(parsed!.windowEnd).toBe(1_800_000_000_000 + 23 * 3_600_000 + 3_600_000);
  });

  it('拿不到 data / models 时返回 null，不编造空结果', () => {
    expect(parseAgentRouterModelStatusPayload(null)).toBeNull();
    expect(parseAgentRouterModelStatusPayload({ success: false, message: 'nope' })).toBeNull();
    expect(parseAgentRouterModelStatusPayload({ data: { models: [] } })).toBeNull();
  });

  it('缺字段的模型行按「读不到」处理，不编造 0', () => {
    const parsed = parseAgentRouterModelStatusPayload({
      data: { models: [{ name: ' mystery-model ' }] },
    });
    expect(parsed!.models).toHaveLength(1);
    expect(parsed!.models[0]).toMatchObject({
      modelName: 'mystery-model',
      avgLatencyMs: null,
      successRate: null,
    });
    expect(parsed!.models[0].recentSuccess).toEqual([]);
  });

  it('没有时间轴时丢掉 ts，并按整点取最差档', () => {
    // 三粒各 20 分钟，同属一个整点 → 折成一个槽位，取最差档 warn（90）。
    const samples = buildModelStatusHeartbeatSamples(['ok', 'warn', 'ok'], 0, 1200);
    expect(samples).toEqual([{ ts: null, rate: 90 }]);
  });

  it('整点聚合取最差档：一小时里的 bad 不会被后面的 ok 覆盖', () => {
    const start = 1_800_000_000; // 整点，20 分钟一粒
    const samples = buildModelStatusHeartbeatSamples(['ok', 'ok', 'bad', 'ok'], start, 1200);
    // 第 4 粒（下标 3）跨进下一个整点，单列一个槽位。
    expect(samples).toEqual([
      { ts: start * 1000, rate: 0 },
      { ts: start * 1000 + 3_600_000, rate: 100 },
    ]);
  });
});

describe('AgentRouterAdapter.getPerfMetricsSummary', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('读 /api/user/model-status 并带上 New-Api-User', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(modelStatusPayload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const adapter = new AgentRouterAdapter();
    const outcome = await adapter.getPerfMetricsSummary(BASE_URL, 'session-token', 99102);

    expect(outcome.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe(`${BASE_URL}/api/user/model-status`);
    expect(init.headers.Authorization).toBe('Bearer session-token');
    // 少了这个头站点会直接回 401「未提供 New-Api-User」。
    expect(init.headers['New-Api-User']).toBe('99102');
  });

  it('401 时说清是会话失效，而不是笼统的解析失败', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ message: '无权进行此操作，未提供 New-Api-User', success: false }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ));

    const outcome = await new AgentRouterAdapter().getPerfMetricsSummary(BASE_URL, 'expired-token', 99102);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.unsupported).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain('HTTP 401');
  });

  it('404 归为「站点不支持」，而不是采集中断', async () => {
    fetchMock.mockImplementation(async () => new Response('not found', { status: 404 }));

    const outcome = await new AgentRouterAdapter().getPerfMetricsSummary(BASE_URL, 'token', 1);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.unsupported).toBe(true);
  });
});
