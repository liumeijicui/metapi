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
  it('draws the daily maximum by default', () => {
    expect(getLotteryAutoDrawConfig(undefined)).toEqual({ enabled: true, dailyDraws: 10 });
    expect(getLotteryAutoDrawConfig('{}')).toEqual({ enabled: true, dailyDraws: 10 });
  });

  it('honours a per-account switch and target', () => {
    expect(getLotteryAutoDrawConfig(JSON.stringify({
      lottery: { enabled: false, dailyDraws: 3 },
    }))).toEqual({ enabled: false, dailyDraws: 3 });
  });

  it('ignores a nonsensical target instead of refusing to draw', () => {
    expect(getLotteryAutoDrawConfig(JSON.stringify({ lottery: { dailyDraws: 0 } })))
      .toEqual({ enabled: true, dailyDraws: 10 });
    expect(getLotteryAutoDrawConfig(JSON.stringify({ lottery: { dailyDraws: 'lots' } })))
      .toEqual({ enabled: true, dailyDraws: 10 });
  });
});

describe('planLotteryDraws', () => {
  it('spends the bonus draws before any credit is billed', () => {
    const plan = planLotteryDraws(status({ bonusDraws: 2 }), 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches).toEqual([
      { costType: 'bonus', count: 2 },
      { costType: 'free', count: 3 },
      { costType: 'free', count: 3 },
      { costType: 'free', count: 2 },
    ]);
  });

  it('splits the work into batches the site accepts', () => {
    const plan = planLotteryDraws(status({ batchMax: 3 }), 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.map((batch) => batch.count)).toEqual([3, 3, 3, 1]);
  });

  it('draws only what the day has left', () => {
    const plan = planLotteryDraws(status({ todayDraws: 7, todayRemaining: 3 }), 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(3);
  });

  it('never exceeds the daily ceiling the site reports', () => {
    const plan = planLotteryDraws(status({ dailyDrawLimit: 4 }), 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(4);
  });

  it('stops once the daily allowance is spent', () => {
    const plan = planLotteryDraws(status({ todayDraws: 10, todayRemaining: 0 }), 10);
    expect(plan).toEqual({ ok: false, reason: '今日抽奖次数已用完（10/10）' });
  });

  it('buys only as many draws as the free credit covers', () => {
    const plan = planLotteryDraws(status({ freeBalance: 120 }), 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches.reduce((sum, batch) => sum + batch.count, 0)).toBe(2);
  });

  it('does not spend the paid balance when the site closes the free option', () => {
    const plan = planLotteryDraws(status({ freeCost: { enabled: false, amount: 50 } }), 10);
    expect(plan).toEqual({ ok: false, reason: '站点未开放用免费额度抽奖' });
  });

  it('draws the bonus first even when no free credit is left', () => {
    const plan = planLotteryDraws(status({
      bonusDraws: 1,
      freeBalance: 0,
      freeCost: { enabled: true, amount: 50 },
    }), 10);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.batches).toEqual([{ costType: 'bonus', count: 1 }]);
  });

  it('reports a site that has the lottery switched off', () => {
    expect(planLotteryDraws(status({ enabled: false }), 10))
      .toEqual({ ok: false, reason: '站点未开启抽奖' });
    expect(planLotteryDraws(status({ canDraw: false }), 10))
      .toEqual({ ok: false, reason: '站点当前不可抽奖（未到开放时间或已达上限）' });
  });
});
