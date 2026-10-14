import { randomUUID } from 'node:crypto';
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici';
import { withSiteProxyRequestInit } from './siteProxy.js';
import { isPipiImageSiteUrl } from './platforms/pipiImage.js';

/**
 * 皮皮智绘的「积分乐园」把图片站积分换回 API 站余额，是签到之后的第二步。
 *
 * 站点自己的前端（`wallet-transfer.js`）已经把契约写死了，这里照着实现：
 *
 *  - `GET  /api/v1/pc/newapi/transfer` 读政策与余额，返回
 *    `{ enabled, pointsPerUsd, minimumPoints, stepPoints, points, apiUsd, items }`；
 *  - `POST /api/v1/pc/newapi/transfer` 用
 *    `{ request_id, direction: 'points_to_api', points }` 下单，返回
 *    `{ status: 'completed' | 'rejected' | 'pending' }`；
 *  - 站点按 `request_id` 幂等：`pending` 表示已受理、可安全重试，不会重复扣款；
 *    `400/401/403/422/429` 是确定性的拒绝，重试没有意义。
 *
 * 兑换比例、下限、步长全部以站点当次的返回为准，不在本地写死——站点调过
 * 参数（比如把 20 积分/美元改成 10）时，本地写死的数字会悄悄换错金额。
 * 这里换出「满足最小额与步长的最大整数积分」，也就是把签到攒下的积分全部
 * 转成 API 余额（站点侧不足最小额时自然什么也不做）。
 */

export type PipiPointsExchangeOutcome = {
  /**
   * 这一轮的结果分类，调用方据此决定要不要写日志：
   * `transferred` 真兑换了；`idle` 是稳态（没到起兑线、站点关了兑换）；
   * `failed` 需要人看一眼。
   */
  kind: 'transferred' | 'idle' | 'failed';
  /** True 表示这一轮真的完成了兑换。 */
  transferred: boolean;
  /** 实际兑换掉的图片站积分。 */
  points: number;
  /** 到账的 API 余额（美元）。 */
  usd: number;
  /** 未兑换时的原因，用于写进签到日志。 */
  reason: string;
};

/** 只取用得到的部分，避免 node/undici 两套 `fetch` 类型在调用点打架。 */
export type PipiExchangeFetch = (
  url: string,
  init?: UndiciRequestInit,
) => Promise<UndiciResponse>;

type TransferPolicy = {
  enabled: boolean;
  points: number;
  pointsPerUsd: number;
  minimumPoints: number;
  stepPoints: number;
};

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function toPositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 站点把确定性的拒绝（重试无用）和暂时性失败用状态码分开。 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422, 429]);

function readPolicy(payload: any): TransferPolicy {
  return {
    enabled: payload?.enabled !== false,
    points: Number(payload?.points) || 0,
    pointsPerUsd: toPositiveNumber(payload?.pointsPerUsd, 20),
    minimumPoints: toPositiveNumber(payload?.minimumPoints, 100),
    stepPoints: toPositiveNumber(payload?.stepPoints, 20),
  };
}

function parseBody(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function describeError(payload: any, fallback: string): string {
  const detail = payload?.detail ?? payload?.message;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
    return detail.message.trim();
  }
  return fallback;
}

export async function runPipiPointsExchange(input: {
  siteUrl: string;
  accessToken: string;
  /** 测试用：注入 fetch，便于在不发真实请求的前提下断言协议形状。 */
  fetchImpl?: PipiExchangeFetch;
}): Promise<PipiPointsExchangeOutcome | null> {
  if (!isPipiImageSiteUrl(input.siteUrl)) return null;

  const token = (input.accessToken || '').trim();
  if (!token) {
    return { kind: 'failed', transferred: false, points: 0, usd: 0, reason: '未持有图片站登录凭证' };
  }

  const base = stripTrailingSlashes((input.siteUrl || '').trim());
  const endpoint = `${base}/api/v1/pc/newapi/transfer`;
  const origin = (() => {
    try {
      return new URL(base).origin;
    } catch {
      return base;
    }
  })();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${token}`,
    Origin: origin,
    Referer: `${origin}/`,
  };
  const fetchImpl: PipiExchangeFetch = input.fetchImpl
    ?? ((await import('undici')).fetch as unknown as PipiExchangeFetch);

  const send = async (method: 'GET' | 'POST', body?: unknown): Promise<
    { ok: true; payload: any } | { ok: false; permanent: boolean; message: string }
  > => {
    const requestInit: UndiciRequestInit = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    };
    let response: UndiciResponse;
    try {
      response = await fetchImpl(endpoint, await withSiteProxyRequestInit(endpoint, requestInit));
    } catch (error) {
      return {
        ok: false,
        permanent: false,
        message: `兑换请求失败：${(error as Error)?.message || '网络错误'}`,
      };
    }
    const raw = await response.text();
    const payload = parseBody(raw);
    if (!response.ok) {
      return {
        ok: false,
        permanent: PERMANENT_STATUSES.has(response.status),
        message: describeError(payload, `HTTP ${response.status}`),
      };
    }
    return { ok: true, payload };
  };

  const policyResult = await send('GET');
  if (!policyResult.ok) {
    return { kind: 'failed', transferred: false, points: 0, usd: 0, reason: `读取兑换政策失败：${policyResult.message}` };
  }
  const policy = readPolicy(policyResult.payload);
  if (!policy.enabled) {
    return { kind: 'idle', transferred: false, points: 0, usd: 0, reason: '站点当前关闭了积分兑换' };
  }

  const transferable = Math.min(
    Math.floor(policy.points / policy.stepPoints) * policy.stepPoints,
    1_000_000,
  );
  if (transferable < policy.minimumPoints) {
    return {
      kind: 'idle',
      transferred: false,
      points: 0,
      usd: 0,
      reason: `积分 ${policy.points} 未达到起兑线 ${policy.minimumPoints}`,
    };
  }

  const order = await send('POST', {
    request_id: randomUUID(),
    direction: 'points_to_api',
    points: transferable,
  });
  if (!order.ok) {
    return {
      kind: 'failed',
      transferred: false,
      points: 0,
      usd: 0,
      reason: `兑换未完成：${order.message}`,
    };
  }

  const status = String(order.payload?.status || '').trim().toLowerCase();
  const usd = Number((transferable / policy.pointsPerUsd).toFixed(4));
  if (status === 'completed') {
    return { kind: 'transferred', transferred: true, points: transferable, usd, reason: '兑换成功' };
  }
  if (status === 'rejected') {
    return { kind: 'failed', transferred: false, points: 0, usd: 0, reason: '站点判定本次兑换无效（余额不足或账户不可用）' };
  }
  if (status === 'pending') {
    return { kind: 'idle', transferred: false, points: 0, usd: 0, reason: '兑换已受理，等待站点确认' };
  }
  return {
    kind: 'failed',
    transferred: false,
    points: 0,
    usd: 0,
    reason: `兑换返回了未知状态：${status || '（空）'}`,
  };
}
