import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../siteProxy.js', () => ({
  UNLIMITED_BODY_TIMEOUT: { bodyTimeout: 0 },
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
}));

import {
  buildModelStatusSlotSamples,
  fetchLanlnModelStatus,
  isLanlnModelStatusSite,
  mergeModelStatusMetrics,
  parseLanlnModelStatusPayload,
} from './lanlnModelStatus.js';
import type { PerfMetricsModel, PerfMetricsSummary } from './base.js';
import { buildModelMonitorSlots } from '../../../shared/modelMonitorBars.js';

const BASE_URL = 'https://ai.venlacy.com';
/** 站点返回的时间轴从某个整点开始，30 分钟一格，一共 48 格（24 小时）。 */
const SLOT_SECONDS = 1800;
const SLOT_START = 1_800_000_000;

function slots(counts: Array<[number, number, number]>): unknown[] {
  // [请求数, 成功数, 成功率]，没给到的格子按站点的写法报「0 次请求 + 100%」。
  return Array.from({ length: 48 }, (_value, index) => {
    const entry = counts[index];
    const [total, success, rate] = entry ?? [0, 0, 100];
    return {
      slot: index,
      start_time: SLOT_START + index * SLOT_SECONDS,
      end_time: SLOT_START + (index + 1) * SLOT_SECONDS,
      total_requests: total,
      success_count: success,
      error_count: total - success,
      success_rate: rate,
      status: rate >= 95 ? 'green' : rate >= 80 ? 'yellow' : 'red',
    };
  });
}

/** 真实响应形状（站点把自己那套 model-status 结构直接序列化）。 */
function modelStatusPayload(rows?: unknown[]) {
  return {
    success: true,
    message: '',
    data: rows ?? [
      {
        model_name: 'gpt-5.5',
        group: 'default',
        display_name: 'gpt-5.5',
        time_window: '24h',
        time_window_minutes: 1440,
        total_requests: 97,
        success_count: 97,
        error_count: 0,
        success_rate: 100,
        current_status: 'green',
        slot_data: slots([[4, 4, 100], [6, 6, 100]]),
        generated_at: SLOT_START + 48 * SLOT_SECONDS,
        recent_avg_first_response_time: 7373.2,
        recent_avg_output_token_speed: 3639.02,
      },
      {
        model_name: 'gpt-6-sol',
        group: 'default',
        total_requests: 40,
        success_count: 30,
        success_rate: 75,
        slot_data: slots([[10, 10, 100], [30, 20, 66.67]]),
        recent_avg_first_response_time: 1200,
        recent_avg_output_token_speed: 10,
      },
    ],
  };
}

describe('isLanlnModelStatusSite', () => {
  it('只认这个站点的主机名（含子域），别的站点不动', () => {
    expect(isLanlnModelStatusSite('https://ai.venlacy.com')).toBe(true);
    expect(isLanlnModelStatusSite('https://ai.venlacy.com/console/personal')).toBe(true);
    expect(isLanlnModelStatusSite('https://API.ai.venlacy.com')).toBe(true);
    expect(isLanlnModelStatusSite('https://happycoding.xyz')).toBe(false);
    expect(isLanlnModelStatusSite('https://venlacy.com')).toBe(false);
    expect(isLanlnModelStatusSite('')).toBe(false);
  });
});

describe('buildModelStatusSlotSamples', () => {
  it('半小时格折成整点格，按请求数加权', () => {
    // 前两格同属第一个整点：4 次 100% + 6 次 0% → 40%。
    const samples = buildModelStatusSlotSamples(slots([[4, 4, 100], [6, 0, 0]]));
    expect(samples).toEqual([{ ts: SLOT_START, rate: 40 }]);
  });

  it('没有请求的格子不产采样点（站点对它照报 100%）', () => {
    // 48 格里只有最后一格有请求，其余都是「0 次请求 + 100%」。
    const only = slots([]);
    (only[47] as any).total_requests = 3;
    (only[47] as any).success_count = 3;
    const samples = buildModelStatusSlotSamples(only);
    // 时间戳按秒、落在整点上（页面按整点铺格），所以最后一格归到 23:00 那一格。
    const hourStart = Math.floor((SLOT_START + 47 * SLOT_SECONDS) / 3_600) * 3_600;
    expect(samples).toEqual([{ ts: hourStart, rate: 100 }]);
  });

  it('没有成功率时用成功数 / 请求数折算；时间轴缺失的格子丢掉', () => {
    const samples = buildModelStatusSlotSamples([
      { start_time: SLOT_START, total_requests: 4, success_count: 3 },
      { total_requests: 10, success_count: 10, success_rate: 100 },
      { start_time: SLOT_START + SLOT_SECONDS, total_requests: 0, success_rate: 100 },
    ]);
    expect(samples).toEqual([{ ts: SLOT_START, rate: 75 }]);
  });
});

describe('parseLanlnModelStatusPayload', () => {
  it('把模型状态页映射成 PerfMetricsSummary', () => {
    const parsed = parseLanlnModelStatusPayload(modelStatusPayload());
    expect(parsed).not.toBeNull();
    const models = parsed!.models;
    expect(models.map((model) => model.modelName)).toEqual(['gpt-5.5', 'gpt-6-sol']);
    // 首字延迟（毫秒）与输出速度（token/s）直接对上页面的延迟 / 吞吐两列。
    expect(models[0]).toMatchObject({
      avgLatencyMs: 7373.2,
      successRate: 100,
      avgTps: 3639.02,
    });
    expect(models[1].successRate).toBe(75);
    // 这一列有真数，不是拿 0 占位。
    expect(parsed!.showThroughput).toBe(true);
  });

  it('窗口对齐到整点、锚在最后一格数据所在整点的收尾', () => {
    const parsed = parseLanlnModelStatusPayload(modelStatusPayload())!;
    const endSeconds = SLOT_START + 48 * SLOT_SECONDS;
    expect(parsed.windowEnd).toBe(Math.ceil(endSeconds / 3_600) * 3_600);
    expect(parsed.windowStart).toBe(parsed.windowEnd! - 24 * 3_600);
    // 最新一格落在第 23 个整点槽位里（页面按整点铺 24 格）。
    const newest = parsed.models[0].recentSuccess.slice(-1)[0];
    expect(Math.floor((newest.ts! - parsed.windowStart!) / 3_600)).toBeLessThan(24);
  });

  it('采样点落在页面那 24 个整点格子里', () => {
    const parsed = parseLanlnModelStatusPayload(modelStatusPayload())!;
    const slots = buildModelMonitorSlots(parsed.models[0].recentSuccess, parsed.windowStart);
    // 前两格（同一整点内的两个半小时格）折成一格，落在窗口的第 1 个槽位。
    expect(slots.filter((rate) => rate !== null)).toHaveLength(1);
    expect(slots[0]).toBe(100);
  });

  it('站点级成功率按请求数加权，而不是各模型取平均', () => {
    const parsed = parseLanlnModelStatusPayload(modelStatusPayload())!;
    // (100 × 97 + 75 × 40) / 137，算术平均会是 87.5。
    expect(parsed.summary!.successRate).toBeCloseTo((100 * 97 + 75 * 40) / 137, 6);
    expect(parsed.summary!.avgLatencyMs).toBeCloseTo((7373.2 + 1200) / 2, 5);
    expect(parsed.summary!.avgTps).toBeCloseTo((3639.02 + 10) / 2, 5);
  });

  it('同一模型的多个分组只取请求数最多的那一行', () => {
    const rows = [
      { model_name: 'gpt-5.5', group: 'default', total_requests: 10, success_rate: 100, slot_data: [] },
      { model_name: 'gpt-5.5', group: 'vip', total_requests: 900, success_rate: 42, slot_data: [] },
    ];
    const parsed = parseLanlnModelStatusPayload(modelStatusPayload(rows))!;
    expect(parsed.models).toHaveLength(1);
    expect(parsed.models[0].successRate).toBe(42);
  });

  it('读不出东西时返回 null，调用方保持原来那一轮的结果', () => {
    expect(parseLanlnModelStatusPayload(null)).toBeNull();
    expect(parseLanlnModelStatusPayload({ success: false, message: 'nope' })).toBeNull();
    expect(parseLanlnModelStatusPayload({ data: [] })).toBeNull();
  });
});

describe('mergeModelStatusMetrics', () => {
  function base(): PerfMetricsSummary {
    const model = (modelName: string): PerfMetricsModel => ({
      modelName,
      avgLatencyMs: null,
      successRate: null,
      avgTps: null,
      recentSuccess: [],
    });
    return {
      summary: null,
      windowStart: null,
      windowEnd: null,
      showThroughput: false,
      models: [model('gpt-5.5'), model('claude-opus-5'), model('dall-e-3')],
    };
  }

  it('按模型名覆盖指标，清单里没被报到的模型原样保留', () => {
    const metrics = parseLanlnModelStatusPayload(modelStatusPayload())!;
    const merged = mergeModelStatusMetrics(base(), metrics)!;
    expect(merged.models.map((model) => model.modelName))
      .toEqual(['gpt-5.5', 'claude-opus-5', 'dall-e-3']);
    expect(merged.models[0].avgLatencyMs).toBe(7373.2);
    // 最近 24 小时没流量的模型指标留空，页面显示「—」，不是 0。
    expect(merged.models[1]).toMatchObject({ avgLatencyMs: null, successRate: null, recentSuccess: [] });
    expect(merged.showThroughput).toBe(true);
    expect(merged.summary).toEqual(metrics.summary);
    expect(merged.windowStart).toBe(metrics.windowStart);
  });

  it('容忍 - . _ 的写法差异', () => {
    const metrics = parseLanlnModelStatusPayload(modelStatusPayload([
      { model_name: 'claude-sonnet-4-5', total_requests: 5, success_rate: 80, slot_data: [] },
    ]))!;
    const source = base();
    source.models = [{
      modelName: 'claude-sonnet-4_5',
      avgLatencyMs: null,
      successRate: null,
      avgTps: null,
      recentSuccess: [],
    }];
    const merged = mergeModelStatusMetrics(source, metrics)!;
    expect(merged.models[0].successRate).toBe(80);
  });

  it('一个模型都没对上时返回 null，不用对不上的指标盖掉模型列表', () => {
    const metrics = parseLanlnModelStatusPayload(modelStatusPayload([
      { model_name: 'some-other-model', total_requests: 5, success_rate: 80, slot_data: [] },
    ]))!;
    expect(mergeModelStatusMetrics(base(), metrics)).toBeNull();
  });
});

describe('fetchLanlnModelStatus', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('读公开的模型状态页接口', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(modelStatusPayload()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const outcome = await fetchLanlnModelStatus(BASE_URL);
    expect(outcome.ok).toBe(true);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`${BASE_URL}/api/enhancements/model-status/embed/status/all`);
    expect(outcome.ok === true && outcome.data.models).toHaveLength(2);
  });

  it('404 归为「站点不支持」，而不是采集中断', async () => {
    fetchMock.mockImplementation(async () => new Response('not found', { status: 404 }));
    const outcome = await fetchLanlnModelStatus(BASE_URL);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.unsupported).toBe(true);
  });

  it('别的失败带上真实状态码，供页面写清原因', async () => {
    fetchMock.mockImplementation(async () => new Response('boom', { status: 502 }));
    const outcome = await fetchLanlnModelStatus(BASE_URL);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.unsupported).toBe(false);
    expect(outcome.ok === false && outcome.message).toContain('HTTP 502');
  });

  it('网络异常不抛到调用方', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('ECONNRESET'); });
    const outcome = await fetchLanlnModelStatus(BASE_URL);
    expect(outcome.ok === false && outcome.message).toContain('ECONNRESET');
  });
});
