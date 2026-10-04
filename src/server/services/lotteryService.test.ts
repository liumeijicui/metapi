import { describe, expect, it } from 'vitest';
import type { LotteryStatus } from './platforms/base.js';
import { getLotteryAutoDrawConfig, planLotteryDraws } from './lotteryService.js';

function status(overrides: Partial<LotteryStatus> = {}): LotteryStatus {
  return {
    enabled: true,
    canDraw: true,
    todayDraws: 0,
    dailyDrawLimit: 10,
    todayRemaining: 10,
    bonusDraws: 0,
    freeBalance: 1_000,
    batchMax: 3,
    freeCost: { enabled: true, amount: 50 },
    ...overrides,
  };
}

describe('getLotteryAutoDrawConfig', () => {
  it('draws the whole allowance by default, whatever its size', () => {
    expect(getLotteryAutoDrawConfig(undefined)).toEqual({ enabled: true, dailyDraws: null });
    expect(getLotteryAutoDrawConfig('{}')).toEqual({ enabled: true, dailyDraws: null });
  });

  it('honours a per-account switch and target', () => {
    expect(getLotteryAutoDrawConfig(JSON.stringify({
      lottery: { enabled: false, dailyDraws: 3 },
    }))).toEqual({ enabled: false, dailyDraws: 3 });
  });

  it('falls back to the whole allowance when the target is nonsense', () => {
    expect(getLotteryAutoDrawConfig(JSON.stringify({ lottery: { dailyDraws: 0 } })))
      .toEqual({ enabled: true, dailyDraws: null });
    expect(getLotteryAutoDrawConfig(JSON.stringify({ lottery: { dailyDraws: 'lots' } })))
      .toEqual({ enabled: true, dailyDraws: null });
  });
});

describe('planLotteryDraws', () => {
  it('spends the bonus draws before any credit is billed', () => {
    const plan = planLotteryDraws(status({ bonusDraws: 2 }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const bonusCount = plan.batches
      .filter((batch) => batch.costType === 'bonus')
      .reduce((sum, batch) => sum + batch.count, 0);
    expect(bonusCount).toBe(2);
    expect(plan.batches.findIndex((batch) => batch.costType === 'free')).toBeGreaterThanOrEqual(bonusCount);
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(10);
  });

  it('splits the work into batches the site accepts', () => {
    const plan = planLotteryDraws(status({ batchMax: 3 }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.map((batch) => batch.count)).toEqual([3, 3, 3, 1]);
  });

  it('draws the leftover of an uneven day one at a time', () => {
    // Ten draws at three per batch is 3 + 3 + 3 + 1. The site refuses a short
    // batch, so the tenth draw has to be asked for as a single draw; sending it
    // as `count: 1` to the batch route is what used to lose the day's last draw.
    const plan = planLotteryDraws(status({ todayDraws: 9, todayRemaining: 1 }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches).toEqual([{ costType: 'free', count: 1 }]);
  });

  it('never asks for a batch smaller than the site sells', () => {
    for (const remaining of [1, 2, 4, 5, 7, 8]) {
      const plan = planLotteryDraws(status({ todayDraws: 10 - remaining, todayRemaining: remaining }), null);
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;
      expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(remaining);
      expect(plan.batches.every((batch) => batch.count === 1 || batch.count === 3)).toBe(true);
    }
  });

  it('draws only what the day has left', () => {
    const plan = planLotteryDraws(status({ todayDraws: 7, todayRemaining: 3 }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(3);
  });

  it('draws the site ceiling itself when nothing caps it', () => {
    const plan = planLotteryDraws(status({ dailyDrawLimit: 20, todayRemaining: 20 }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(20);
  });

  it('honours a target below the ceiling', () => {
    const plan = planLotteryDraws(status({ dailyDrawLimit: 20, todayRemaining: 20 }), 4);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(4);
  });

  it('uses the day\'s remaining count when the site reports no ceiling', () => {
    const plan = planLotteryDraws(status({ dailyDrawLimit: 0, todayDraws: 3, todayRemaining: 2 }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(2);
  });

  it('stops once the daily allowance is spent', () => {
    const plan = planLotteryDraws(status({ todayDraws: 10, todayRemaining: 0 }), null);
    expect(plan).toEqual({ ok: false, reason: '今日抽奖次数已用完（10/10）' });
  });

  it('buys only as many draws as the free credit covers', () => {
    const plan = planLotteryDraws(status({ freeBalance: 120 }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(2);
  });

  it('does not spend the paid balance when the site closes the free option', () => {
    const plan = planLotteryDraws(status({ freeCost: { enabled: false, amount: 50 } }), null);
    expect(plan).toEqual({ ok: false, reason: '站点未开放用免费额度抽奖' });
  });

  it('draws the bonus first even when no free credit is left', () => {
    const plan = planLotteryDraws(status({
      bonusDraws: 1,
      freeBalance: 0,
      freeCost: { enabled: true, amount: 50 },
    }), null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches).toEqual([{ costType: 'bonus', count: 1 }]);
  });

  it('reports a site that has the lottery switched off', () => {
    expect(planLotteryDraws(status({ enabled: false }), null))
      .toEqual({ ok: false, reason: '站点未开启抽奖' });
  });

  it('says the allowance is spent rather than blaming the site flag', () => {
    // The site sets `can_draw` false once the day's quota is gone, so the
    // counter has to be read first or every finished day reads as "window not
    // open" and the real reason never shows up.
    expect(planLotteryDraws(status({ canDraw: false, todayDraws: 10, todayRemaining: 0 }), null))
      .toEqual({ ok: false, reason: '今日抽奖次数已用完（10/10）' });
  });

  it('blames the window only when the day really has draws left', () => {
    expect(planLotteryDraws(status({ canDraw: false }), null))
      .toEqual({ ok: false, reason: '站点当前不可抽奖（未到开放时间或额度未发放）' });
  });
});
