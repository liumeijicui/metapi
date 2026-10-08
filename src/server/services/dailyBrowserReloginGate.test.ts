import { beforeEach, describe, expect, it, vi } from 'vitest';

const { updateSetMock, updateRunMock } = vi.hoisted(() => ({
  updateSetMock: vi.fn(),
  updateRunMock: vi.fn(() => ({})),
}));

vi.mock('../db/index.js', () => {
  const chain = {
    set: (values: unknown) => {
      updateSetMock(values);
      return chain;
    },
    where: () => chain,
    run: () => updateRunMock(),
  };
  return { db: { update: () => chain }, schema: { accounts: { id: 'id' } } };
});

import {
  DAILY_BROWSER_RELOGIN_COOLDOWN_MS,
  DAILY_BROWSER_RELOGIN_KEY,
  createDailyBrowserReloginGate,
} from './dailyBrowserReloginGate.js';
import { siteDayKey } from '../shared/siteDay.js';

const NOW = new Date('2026-10-09T10:00:00.000Z');
const HOUR_MS = 60 * 60_000;

function accountWith(extraConfig?: string | null) {
  return { id: 7, extraConfig: extraConfig ?? null };
}

function stored(state: Record<string, unknown>): string {
  return JSON.stringify({ credentialMode: 'session', [DAILY_BROWSER_RELOGIN_KEY]: state });
}

function lastWrittenExtraConfig(): Record<string, unknown> {
  const calls = updateSetMock.mock.calls as Array<[{ extraConfig?: string }]>;
  const last = calls.length > 0 ? calls[calls.length - 1][0] : undefined;
  return JSON.parse(last?.extraConfig ?? '{}') as Record<string, unknown>;
}

function persistedState(): Record<string, unknown> {
  return lastWrittenExtraConfig()[DAILY_BROWSER_RELOGIN_KEY] as Record<string, unknown>;
}

describe('createDailyBrowserReloginGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateRunMock.mockImplementation(() => ({}));
  });

  it('owes a sign-in on a fresh account', () => {
    const gate = createDailyBrowserReloginGate(accountWith(), NOW);

    expect(gate.isSettledToday()).toBe(false);
    expect(gate.cooldownRemainingMs()).toBe(0);
  });

  it('stays settled for the rest of the site day', () => {
    const gate = createDailyBrowserReloginGate(
      accountWith(stored({ day: siteDayKey(NOW), settled: true, attemptedAt: NOW.toISOString() })),
      NOW,
    );

    expect(gate.isSettledToday()).toBe(true);
  });

  it('forgets a settlement stamped on an earlier day', () => {
    const yesterday = new Date(NOW.getTime() - 24 * HOUR_MS);
    const gate = createDailyBrowserReloginGate(
      accountWith(stored({ day: siteDayKey(yesterday), settled: true, attemptedAt: yesterday.toISOString() })),
      NOW,
    );

    expect(gate.isSettledToday()).toBe(false);
    expect(gate.cooldownRemainingMs()).toBe(0);
  });

  it('holds the cooldown for the full window after an attempt', async () => {
    const gate = createDailyBrowserReloginGate(accountWith(), NOW);

    await gate.recordAttempt();

    expect(gate.cooldownRemainingMs()).toBe(DAILY_BROWSER_RELOGIN_COOLDOWN_MS);
    expect(gate.isSettledToday()).toBe(false);
  });

  it('releases the cooldown once the window has passed', () => {
    const attemptedAt = new Date(NOW.getTime() - 4 * HOUR_MS).toISOString();
    const gate = createDailyBrowserReloginGate(
      accountWith(stored({ day: siteDayKey(NOW), settled: false, attemptedAt })),
      NOW,
    );

    expect(gate.cooldownRemainingMs()).toBe(0);
    expect(gate.isSettledToday()).toBe(false);
  });

  it('does not carry a cooldown spent yesterday into the new day', () => {
    // Armed at 23:30 +08, read at 00:30 +08: the new day's grant is already waiting.
    const armedAt = new Date('2026-10-08T15:30:00.000Z');
    const acrossMidnight = new Date('2026-10-08T16:30:00.000Z');
    const gate = createDailyBrowserReloginGate(
      accountWith(stored({ day: siteDayKey(armedAt), settled: false, attemptedAt: armedAt.toISOString() })),
      acrossMidnight,
    );

    expect(gate.isSettledToday()).toBe(false);
    expect(gate.cooldownRemainingMs()).toBe(0);
  });

  it('writes an attempt back to the account row, and to the row object', async () => {
    const account = accountWith(JSON.stringify({ credentialMode: 'session' }));

    await createDailyBrowserReloginGate(account, NOW).recordAttempt();

    expect(persistedState()).toMatchObject({
      day: siteDayKey(NOW),
      settled: false,
      attemptedAt: NOW.toISOString(),
    });
    // The caller keeps using the same row object within a run, and the later
    // `runCheckin` retry rebuilds the gate from it — so the snapshot has to move.
    const reloaded = createDailyBrowserReloginGate(account, NOW);
    expect(reloaded.cooldownRemainingMs()).toBe(DAILY_BROWSER_RELOGIN_COOLDOWN_MS);
  });

  it('keeps other extraConfig keys intact', async () => {
    await createDailyBrowserReloginGate(
      accountWith(JSON.stringify({ autoRelogin: { username: 'u' } })),
      NOW,
    ).recordAttempt();

    expect(lastWrittenExtraConfig().autoRelogin).toEqual({ username: 'u' });
  });

  it('lets a settlement supersede the cooldown for the rest of the day', async () => {
    const account = accountWith();
    const gate = createDailyBrowserReloginGate(account, NOW);

    await gate.recordAttempt();
    await gate.markSettled();

    expect(gate.isSettledToday()).toBe(true);
    expect(createDailyBrowserReloginGate(account, NOW).isSettledToday()).toBe(true);
    expect(persistedState()).toMatchObject({ settled: true, day: siteDayKey(NOW) });
  });

  it('still enforces the cooldown in memory when the write fails', async () => {
    updateRunMock.mockImplementation(() => {
      throw new Error('database is locked');
    });
    const gate = createDailyBrowserReloginGate(accountWith(), NOW);

    await expect(gate.recordAttempt()).resolves.toBeUndefined();
    expect(gate.cooldownRemainingMs()).toBe(DAILY_BROWSER_RELOGIN_COOLDOWN_MS);
  });

  it('ignores a malformed stored state instead of trusting it', () => {
    const gate = createDailyBrowserReloginGate(
      accountWith(JSON.stringify({ [DAILY_BROWSER_RELOGIN_KEY]: 'yesterday' })),
      NOW,
    );

    expect(gate.isSettledToday()).toBe(false);
    expect(gate.cooldownRemainingMs()).toBe(0);
  });
});
