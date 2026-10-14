import { describe, expect, it } from 'vitest';
import { runPipiPointsExchange, type PipiExchangeFetch } from './pipiPointsExchangeService.js';
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici';

const SITE = 'https://img.pipiwangcom.com';

type Stub = {
  url: string;
  init?: UndiciRequestInit;
};

function response(status: number, payload: unknown): UndiciResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  } as unknown as UndiciResponse;
}

/** 记录每次请求，并按调用顺序回答。 */
function createFetchStub(answers: Array<{ status: number; payload: unknown }>) {
  const calls: Stub[] = [];
  const fetchImpl: PipiExchangeFetch = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error(`unexpected request ${calls.length}`);
    return response(answer.status, answer.payload);
  };
  return { calls, fetchImpl };
}

function bodyOf(call: Stub | undefined): any {
  return JSON.parse(String(call?.init?.body || '{}'));
}

describe('runPipiPointsExchange', () => {
  it('does nothing for any other site', async () => {
    expect(await runPipiPointsExchange({ siteUrl: 'https://ai.pipiwangcom.com', accessToken: 'x' })).toBeNull();
  });

  it('stays idle when the points are below the site minimum', async () => {
    const { calls, fetchImpl } = createFetchStub([
      { status: 200, payload: { enabled: true, points: 60, minimumPoints: 100, stepPoints: 20, pointsPerUsd: 20 } },
    ]);
    const outcome = await runPipiPointsExchange({ siteUrl: SITE, accessToken: 't', fetchImpl });
    expect(outcome).toMatchObject({ kind: 'idle', transferred: false, points: 0 });
    expect(outcome?.reason).toContain('60');
    // 没有到起兑线就不该下单，一次 GET 之外不能再发请求。
    expect(calls).toHaveLength(1);
  });

  it('does nothing when the site turned the exchange off', async () => {
    const { fetchImpl } = createFetchStub([{ status: 200, payload: { enabled: false, points: 900 } }]);
    const outcome = await runPipiPointsExchange({ siteUrl: SITE, accessToken: 't', fetchImpl });
    expect(outcome).toMatchObject({ kind: 'idle', transferred: false });
  });

  it('exchanges the largest step-aligned amount and reports the dollars', async () => {
    const { calls, fetchImpl } = createFetchStub([
      { status: 200, payload: { enabled: true, points: 437, minimumPoints: 100, stepPoints: 20, pointsPerUsd: 20 } },
      { status: 200, payload: { status: 'completed' } },
    ]);
    const outcome = await runPipiPointsExchange({ siteUrl: SITE, accessToken: 't', fetchImpl });
    expect(outcome).toMatchObject({ kind: 'transferred', transferred: true, points: 420, usd: 21 });

    const order = bodyOf(calls[1]);
    expect(order.direction).toBe('points_to_api');
    // 437 按 20 取整是 420，越界的零头不换，否则站点直接 400。
    expect(order.points).toBe(420);
    expect(typeof order.request_id).toBe('string');
    expect(order.request_id).toHaveLength(36);
    expect(calls[1]?.url).toBe(`${SITE}/api/v1/pc/newapi/transfer`);
    expect(calls[1]?.init?.method).toBe('POST');
  });

  it('treats a pending order as not-yet-transferred and a rejected one as a failure', async () => {
    const pending = await runPipiPointsExchange({
      siteUrl: SITE,
      accessToken: 't',
      fetchImpl: createFetchStub([
        { status: 200, payload: { enabled: true, points: 300, minimumPoints: 100, stepPoints: 20, pointsPerUsd: 20 } },
        { status: 200, payload: { status: 'pending' } },
      ]).fetchImpl,
    });
    expect(pending).toMatchObject({ kind: 'idle', transferred: false });

    const rejected = await runPipiPointsExchange({
      siteUrl: SITE,
      accessToken: 't',
      fetchImpl: createFetchStub([
        { status: 200, payload: { enabled: true, points: 300, minimumPoints: 100, stepPoints: 20, pointsPerUsd: 20 } },
        { status: 200, payload: { status: 'rejected' } },
      ]).fetchImpl,
    });
    expect(rejected).toMatchObject({ kind: 'failed', transferred: false });
  });

  it('surfaces the site wording when the order is refused outright', async () => {
    const { fetchImpl } = createFetchStub([
      { status: 200, payload: { enabled: true, points: 300, minimumPoints: 100, stepPoints: 20, pointsPerUsd: 20 } },
      { status: 429, payload: { detail: '请求过于频繁' } },
    ]);
    const outcome = await runPipiPointsExchange({ siteUrl: SITE, accessToken: 't', fetchImpl });
    expect(outcome).toMatchObject({ kind: 'failed', transferred: false });
    expect(outcome?.reason).toContain('请求过于频繁');
  });

  it('reports a missing credential instead of sending an anonymous request', async () => {
    const { calls, fetchImpl } = createFetchStub([]);
    const outcome = await runPipiPointsExchange({ siteUrl: SITE, accessToken: '  ', fetchImpl });
    expect(outcome).toMatchObject({ kind: 'failed', transferred: false });
    expect(calls).toHaveLength(0);
  });
});
