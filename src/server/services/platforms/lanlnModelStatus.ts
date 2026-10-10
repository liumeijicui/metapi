import { fetch } from 'undici';
import type {
  PerfMetricsModel,
  PerfMetricsOutcome,
  PerfMetricsSample,
  PerfMetricsSummary,
} from './base.js';
import { withSiteProxyRequestInit } from '../siteProxy.js';

/**
 * Lanln（`ai.venlacy.com`）的模型动态指标分支。
 *
 * 这个站点是 new-api，但版本里没有 `/api/perf-metrics`（直接回 404），所以通用
 * 分支只能降级成「仅模型列表」，成功率 / 延迟 / 吞吐一律读不到。它的动态数据挂
 * 在站点自己加的**模型状态页**上，而那个页面把数据做成了公开嵌入接口：
 *
 *   GET /api/enhancements/model-status/embed/config       窗口 / 阈值（config 里 public_embed_enabled: true）
 *   GET /api/enhancements/model-status/embed/status/all   每个模型的成功率 / 首字延迟 / 输出速度 / 半小时格子
 *   GET /api/pricing                                      价格（通用分支已经在读，这里不重复）
 *
 * 前两个不需要凭据，所以这一条既不占账号、也不受令牌过期影响：
 * `modelMonitorService` 跑完通用分支后用它把指标叠加到模型列表上
 * （见那里的 `applySiteModelStatusOverride`）。
 *
 * 站点给的是「每个模型 × 每 30 分钟一格」，页面要的是 24 个整点格子，所以这里
 * 把半小时格折成整点格。和 agentrouter 一样，这是一次刻意的近似。
 */

/** 站点自己的模型状态页（公开嵌入）接口。 */
const MODEL_STATUS_EMBED_PATH = '/api/enhancements/model-status/embed/status/all';
/**
 * 状态页固定给 24 小时窗口，30 分钟一格，一共 48 格。
 *
 * `SECONDS_PER_HOUR` 是这套采样点的单位口径：`PerfMetricsSample.ts` /
 * `windowStart` / `windowEnd` 全部是**秒**（`shared/modelMonitorBars` 用
 * `floor((ts - windowStart) / 3600)` 定位格子）。写成毫秒不会报错，只会让 24 个
 * 格子全空 —— 这里按秒算。
 */
const WINDOW_HOURS = 24;
const SECONDS_PER_HOUR = 3600;
const REQUEST_TIMEOUT_MS = 30_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** 这个分支认的站点主机名。 */
export const LANLN_MODEL_STATUS_HOST = 'ai.venlacy.com';

/**
 * 这个地址是不是走「模型状态页」采集的站点。
 *
 * 按主机名判定（和 agentrouter 按 URL 判定同一个思路）：站点改名 / 换域名时只要
 * 改这一处，不用去动平台识别那条链路 —— 它在其它所有方面都还是标准 new-api。
 */
export function isLanlnModelStatusSite(siteUrl: string): boolean {
  const raw = String(siteUrl || '').trim();
  if (!raw) return false;
  try {
    const host = new URL(raw).host.toLowerCase();
    return host === LANLN_MODEL_STATUS_HOST || host.endsWith(`.${LANLN_MODEL_STATUS_HOST}`);
  } catch {
    return raw.toLowerCase().includes(LANLN_MODEL_STATUS_HOST);
  }
}

type RawRow = Record<string, unknown>;

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number.parseFloat(value) : Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 抹掉名字里的 `-` / `.` / `_`，用来容忍站点两处清单的写法差异。
 *
 * `/` 保留：`nvidia/glm-5.3` 和 `glm-5.3` 是不同的记录，不该混为一谈。
 */
function relaxModelName(modelName: string): string {
  return modelName.trim().toLowerCase().replace(/[-_.]/g, '');
}

function readRows(payload: unknown): RawRow[] | null {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const rawData = record && 'data' in record ? record.data : payload;
  if (!Array.isArray(rawData)) return null;
  return rawData.filter(
    (row): row is RawRow => !!row && typeof row === 'object' && !Array.isArray(row),
  );
}

/**
 * 站点把「一个模型 × 一个分组」各出一行。同一个模型取请求数最多的那一行：分组
 * 之间的格子不能直接相加（同一个时间点会有两份重叠的时间轴），取最忙的那份既
 * 保住了时间轴，又不会把两个分组的请求数算成双份。
 */
function pickBusiestRowPerModel(rows: RawRow[]): Map<string, RawRow> {
  const byModel = new Map<string, RawRow>();
  for (const row of rows) {
    const modelName = typeof row.model_name === 'string' ? row.model_name.trim() : '';
    if (!modelName) continue;
    const key = relaxModelName(modelName);
    const current = byModel.get(key);
    if (
      current === undefined
      || (toFiniteNumber(row.total_requests) ?? 0) > (toFiniteNumber(current.total_requests) ?? 0)
    ) {
      byModel.set(key, row);
    }
  }
  return byModel;
}

/**
 * 把半小时格子折成整点格子。
 *
 * 两点口径：
 * - 只取「这一格真的有过请求」的。站点对没有流量的格子照报 `success_rate: 100`，
 *   直接采信等于给页面刷满假绿格；上游没给时间轴时也造不出格子，一起丢掉。
 * - 同一整点内按请求数加权平均。站点把分子（success_count）和分母
 *   （total_requests）都给了，没有理由只留一个档位。
 */
export function buildModelStatusSlotSamples(slotData: unknown): PerfMetricsSample[] {
  if (!Array.isArray(slotData)) return [];
  const byHour = new Map<number, { requests: number; rateSum: number }>();
  for (const raw of slotData) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const slot = raw as RawRow;
    const requests = toFiniteNumber(slot.total_requests) ?? 0;
    if (!(requests > 0)) continue;
    const startSeconds = toFiniteNumber(slot.start_time);
    if (startSeconds === null) continue;
    const successCount = toFiniteNumber(slot.success_count);
    const rate = toFiniteNumber(slot.success_rate)
      ?? (successCount === null ? null : (successCount / requests) * 100);
    if (rate === null) continue;
    const hourStart = Math.floor(startSeconds / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
    const bucket = byHour.get(hourStart) ?? { requests: 0, rateSum: 0 };
    bucket.requests += requests;
    bucket.rateSum += rate * requests;
    byHour.set(hourStart, bucket);
  }
  return Array.from(byHour.keys())
    .sort((left, right) => left - right)
    .map((ts) => {
      const bucket = byHour.get(ts) as { requests: number; rateSum: number };
      return { ts, rate: bucket.rateSum / bucket.requests };
    });
}

/**
 * 采样窗口对齐到整点。
 *
 * 页面的 24 个格子是按整点铺的（`shared/modelMonitorBars` 用
 * `floor((ts - windowStart) / 3600)` 定位，两边都是秒），起点不齐会整排错位。这里把窗口
 * 锚在**最后一格数据所在整点的收尾**，往前数 24 小时：最新的一小时一定落在
 * 第 24 格，最老那半小时若被切掉也只是最旧的一端。
 */
function resolveWindow(byModel: Map<string, RawRow>): { windowStart: number | null; windowEnd: number | null } {
  let maxEnd = Number.NEGATIVE_INFINITY;
  for (const row of byModel.values()) {
    if (!Array.isArray(row.slot_data)) continue;
    for (const raw of row.slot_data) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const end = toFiniteNumber((raw as RawRow).end_time);
      if (end !== null && end > maxEnd) maxEnd = end;
    }
  }
  if (!Number.isFinite(maxEnd) || maxEnd <= 0) return { windowStart: null, windowEnd: null };
  const windowEnd = Math.ceil(maxEnd / SECONDS_PER_HOUR) * SECONDS_PER_HOUR;
  return { windowStart: windowEnd - WINDOW_HOURS * SECONDS_PER_HOUR, windowEnd };
}

/**
 * 归一化 `GET /api/enhancements/model-status/embed/status/all`。
 *
 * 字段含义按站点自己页面上的文案对齐：`recent_avg_first_response_time` 是
 * 「近期平均首字延迟」（毫秒），`recent_avg_output_token_speed` 是「近期平均输出
 * 速度」（token/s），正好对上页面的延迟 / 吞吐两列，所以 `showThroughput` 是
 * true —— 这一列有真数，不是拿 0 占位。`avg_use_time`（整段生成耗时，秒）不入表：
 * 页面的「延迟」列要的是首字延迟，混两种口径会让同一个格子前后不可比。
 */
export function parseLanlnModelStatusPayload(payload: unknown): PerfMetricsSummary | null {
  const rows = readRows(payload);
  if (!rows || !rows.length) return null;
  const byModel = pickBusiestRowPerModel(rows);
  if (!byModel.size) return null;

  const { windowStart, windowEnd } = resolveWindow(byModel);
  const models: PerfMetricsModel[] = [];
  const latencies: number[] = [];
  const throughputs: number[] = [];
  let rateWeight = 0;
  let weightedRateSum = 0;
  let plainRateSum = 0;
  let plainRateCount = 0;

  for (const row of byModel.values()) {
    const modelName = String(row.model_name).trim();
    const requests = toFiniteNumber(row.total_requests) ?? 0;
    const successRate = toFiniteNumber(row.success_rate);
    const avgLatencyMs = toFiniteNumber(row.recent_avg_first_response_time);
    const avgTps = toFiniteNumber(row.recent_avg_output_token_speed);

    models.push({
      modelName,
      avgLatencyMs,
      successRate,
      avgTps,
      recentSuccess: buildModelStatusSlotSamples(row.slot_data),
    });

    if (successRate !== null) {
      plainRateSum += successRate;
      plainRateCount += 1;
      if (requests > 0) {
        weightedRateSum += successRate * requests;
        rateWeight += requests;
      }
    }
    if (avgLatencyMs !== null) latencies.push(avgLatencyMs);
    if (avgTps !== null) throughputs.push(avgTps);
  }
  if (!models.length) return null;

  // 站点级成功率优先按请求数加权（站点把分子分母都给了）；一个请求都没有时退回
  // 各模型的算术平均。两边都空着就留 0，页面显示「—」，不编造一个好看的数。
  const successRate = rateWeight > 0
    ? weightedRateSum / rateWeight
    : (plainRateCount ? plainRateSum / plainRateCount : 0);
  const average = (values: number[]) => (
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  );

  return {
    summary: {
      avgLatencyMs: average(latencies),
      successRate,
      avgTps: average(throughputs),
    },
    windowStart,
    windowEnd,
    showThroughput: true,
    models,
  };
}

/**
 * 把状态页指标按模型名叠加到已有的模型列表上。
 *
 * 站点真清单（`/v1/models`）才是「在卖什么」的依据，状态页只报「最近 24 小时有
 * 过流量的模型」。所以这里只覆盖、不新增：清单里有而状态页没报的模型原样保留
 * （指标留空、页面显示「—」），状态页里多出来的模型直接忽略。一个都没对上时返回
 * null，调用方保持原来那一轮的结果，不用一份对不上的指标盖掉模型列表。
 */
export function mergeModelStatusMetrics(
  base: PerfMetricsSummary,
  metrics: PerfMetricsSummary,
): PerfMetricsSummary | null {
  const exact = new Map<string, PerfMetricsModel>();
  const relaxed = new Map<string, PerfMetricsModel>();
  for (const model of metrics.models) {
    exact.set(model.modelName.trim().toLowerCase(), model);
    const key = relaxModelName(model.modelName);
    if (!relaxed.has(key)) relaxed.set(key, model);
  }

  let matched = 0;
  const models = base.models.map((model) => {
    // 先精确匹配（大小写不敏感），再退回「抹掉 - . _」的宽松匹配：两处清单偶尔
    // 会把同一个模型写成 `claude-sonnet-4-5` / `claude-sonnet-4.5`。
    const hit = exact.get(model.modelName.trim().toLowerCase())
      ?? relaxed.get(relaxModelName(model.modelName));
    if (!hit) return model;
    matched += 1;
    return {
      ...model,
      avgLatencyMs: hit.avgLatencyMs,
      successRate: hit.successRate,
      avgTps: hit.avgTps,
      recentSuccess: hit.recentSuccess,
    };
  });
  if (!matched) return null;

  return {
    ...base,
    summary: metrics.summary,
    windowStart: metrics.windowStart,
    windowEnd: metrics.windowEnd,
    showThroughput: true,
    models,
  };
}

/**
 * 读站点的模型状态页数据。公开接口，不需要凭据。
 *
 * 失败时把「站点没这个接口」和「这次没读到」分开，调用方才能把真实原因写进页面
 * （见 `applySiteModelStatusOverride`）。
 */
export async function fetchLanlnModelStatus(baseUrl: string): Promise<PerfMetricsOutcome> {
  const root = (baseUrl || '').replace(/\/+$/, '');
  if (!root) return { ok: false, unsupported: true, message: '站点地址为空' };

  const url = `${root}${MODEL_STATUS_EMBED_PATH}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': BROWSER_USER_AGENT,
    Referer: `${root}/model-status`,
  };

  let status = 0;
  let payload: unknown = null;
  try {
    const response = await fetch(url, await withSiteProxyRequestInit(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    status = response.status;
    const text = await response.text();
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
  } catch (error) {
    return {
      ok: false,
      unsupported: false,
      message: `请求上游失败：${(error as Error)?.message || 'unknown error'}`,
    };
  }

  if (status === 404) {
    return { ok: false, unsupported: true, message: '站点没有模型状态页接口（版本较旧）' };
  }
  if (status !== 200) {
    return { ok: false, unsupported: false, message: `HTTP ${status}：模型状态接口未返回可用数据` };
  }

  const parsed = parseLanlnModelStatusPayload(payload);
  if (!parsed) {
    return { ok: false, unsupported: false, message: '上游返回的模型状态数据无法解析' };
  }
  return { ok: true, data: parsed };
}
