import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...args),
    validate: (...args: unknown[]) => validateMock(...args),
  },
}));

vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => [],
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      accounts: { checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
}));

describe('checkinScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  it('builds deterministic per-site randomized check-in times', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-10-27T00:00:00.000Z');
    const input = {
      now,
      windowMinutes: 90,
      seed: 'daily-seed',
      targets: [
        { siteId: 1, siteName: 'A', accountIds: [11] },
        { siteId: 2, siteName: 'B', accountIds: [21, 22] },
        { siteId: 3, siteName: 'C', accountIds: [31] },
      ],
    };

    const first = scheduler.buildCheckinDailyPlan(input);
    const second = scheduler.buildCheckinDailyPlan(input);
    expect(second).toEqual(first);
    expect(new Set(first.sites.map((site) => site.scheduledAt)).size).toBeGreaterThan(1);
    for (const site of first.sites) {
      const delayMs = Date.parse(site.scheduledAt) - now.getTime();
      expect(delayMs).toBeGreaterThanOrEqual(0);
      expect(delayMs).toBeLessThanOrEqual(90 * 60 * 1000);
    }
  });

  it('changes each site schedule when the daily seed changes', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-10-27T00:00:00.000Z');
    const targets = [{ siteId: 7, siteName: 'Seven', accountIds: [70] }];

    const dayOne = scheduler.buildCheckinDailyPlan({ now, windowMinutes: 90, seed: 'seed-one', targets });
    const dayTwo = scheduler.buildCheckinDailyPlan({ now, windowMinutes: 90, seed: 'seed-two', targets });
    expect(dayOne.sites[0].scheduledAt).not.toBe(dayTwo.sites[0].scheduledAt);
  });

  it('keeps the legacy immediate behavior when the random window is zero', async () => {
    const scheduler = await import('./checkinScheduler.js');
    expect(scheduler.computeCheckinSiteDelaySeconds(1, '2026-10-27', 'seed', 0)).toBe(0);
  });
});
