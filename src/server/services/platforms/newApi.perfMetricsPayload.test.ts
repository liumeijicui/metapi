import { describe, expect, it } from 'vitest';
import { parsePerfMetricsSummaryPayload } from './newApi.js';

describe('parsePerfMetricsSummaryPayload', () => {
  it('解析新版本的 summary + window + recent_success_series', () => {
    const payload = {
      success: true,
      data: {
        summary: { avg_latency_ms: 29210, success_rate: 45.71, avg_tps: 33.72 },
        window_start: 1791010800,
        window_end: 1791094900,
        models: [
          {
            model_name: 'deepseek-v4-flash',
            avg_latency_ms: 15263,
            success_rate: 14.53,
            avg_tps: 25.73,
            recent_success_series: [
              { ts: 1791010800, success_rate: 100 },
              { ts: 1791014400, success_rate: 34.48 },
            ],
          },
        ],
      },
    };

    expect(parsePerfMetricsSummaryPayload(payload)).toEqual({
      summary: { avgLatencyMs: 29210, successRate: 45.71, avgTps: 33.72 },
      windowStart: 1791010800,
      windowEnd: 1791094900,
      showThroughput: null,
      models: [
        {
          modelName: 'deepseek-v4-flash',
          avgLatencyMs: 15263,
          successRate: 14.53,
          avgTps: 25.73,
          recentSuccess: [{ ts: 1791010800, rate: 100 }, { ts: 1791014400, rate: 34.48 }],
        },
      ],
    });
  });

  it('解析旧版本的 models[] + recent_success_rates（没有时间轴）', () => {
    const parsed = parsePerfMetricsSummaryPayload({
      data: {
        models: [
          { model_name: 'minimax-m3', avg_latency_ms: 14865, success_rate: 100, avg_tps: 97.7, recent_success_rates: [100, 100, 100] },
        ],
      },
      success: true,
    });

    expect(parsed?.summary).toBeNull();
    expect(parsed?.windowStart).toBeNull();
    expect(parsed?.models[0].recentSuccess).toEqual([
      { ts: null, rate: 100 },
      { ts: null, rate: 100 },
      { ts: null, rate: 100 },
    ]);
  });

  it('接受「站点没有数据」的空模型列表，并读得出 show_throughput', () => {
    expect(parsePerfMetricsSummaryPayload({ data: { models: [], show_throughput: false }, success: true }))
      .toEqual({
        summary: null,
        windowStart: null,
        windowEnd: null,
        showThroughput: false,
        models: [],
      });
  });

  it('形状不对时返回 null，交给调用方归类为不可解析', () => {
    expect(parsePerfMetricsSummaryPayload(null)).toBeNull();
    expect(parsePerfMetricsSummaryPayload({ code: 'AUTH_UNAUTHORIZED' })).toBeNull();
    expect(parsePerfMetricsSummaryPayload({ data: { models: 'nope' } })).toBeNull();
  });

  it('跳过没有模型名或速率的脏行', () => {
    const parsed = parsePerfMetricsSummaryPayload({
      data: {
        models: [
          { avg_latency_ms: 1 },
          { model_name: 'ok', success_rate: '88.5' },
        ],
      },
    });
    expect(parsed?.models).toHaveLength(1);
    expect(parsed?.models[0]).toMatchObject({ modelName: 'ok', successRate: 88.5, avgLatencyMs: 0, avgTps: 0 });
  });
});
