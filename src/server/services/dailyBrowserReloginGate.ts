import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { mergeAccountExtraConfig, parseExtraConfig } from './accountExtraConfig.js';
import { siteDayKey } from '../shared/siteDay.js';
import type { BrowserReloginGate } from './platforms/base.js';

/**
 * How long to wait after a sign-in that did not settle the day.
 *
 * These relays pay their daily grant inside the login handler, so one sign-in a
 * day is the whole requirement — but the attempt can also fail for reasons that
 * clear on their own (the edge is throttling, the consent page 502s). Backing
 * off for hours rather than re-trying on the next hourly tick keeps the day's
 * attempt budget available without turning the schedule into a login flood,
 * and it leaves room to still collect the grant if it only becomes available
 * later in the day.
 *
 * The back-off is scoped to the site day it was spent in: a grant that becomes
 * available at 00:00 must not wait out a cooldown armed at 23:30, so a stamped
 * day that is no longer today releases the attempt immediately.
 */
export const DAILY_BROWSER_RELOGIN_COOLDOWN_MS = 3 * 60 * 60_000;

/** Where the gate keeps its state on the account row. */
export const DAILY_BROWSER_RELOGIN_KEY = 'dailyBrowserRelogin';

type StoredGateState = {
  /** Site day (`YYYY-MM-DD`, +08:00) the other two fields describe. */
  day?: string;
  /** Nothing left to collect on `day`. */
  settled?: boolean;
  /** When the last sign-in was spent, on any day. */
  attemptedAt?: string;
};

function readState(extraConfig?: string | null): StoredGateState {
  const raw = (parseExtraConfig(extraConfig) as Record<string, unknown>)[DAILY_BROWSER_RELOGIN_KEY];
  if (!raw || typeof raw !== 'object') return {};
  const record = raw as Record<string, unknown>;
  return {
    day: typeof record.day === 'string' ? record.day : undefined,
    settled: record.settled === true,
    attemptedAt: typeof record.attemptedAt === 'string' ? record.attemptedAt : undefined,
  };
}

function lastAttemptMs(state: StoredGateState): number {
  const parsed = state.attemptedAt ? Date.parse(state.attemptedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Builds the once-a-day sign-in gate for one account.
 *
 * The gate is a view over `extraConfig.dailyBrowserRelogin`, armed by the caller
 * that owns the row — adapters never touch the database. Writes are best-effort:
 * losing the cooldown costs an extra sign-in, which is not worth failing a
 * check-in over.
 */
export function createDailyBrowserReloginGate(
  account: { id: number; extraConfig?: string | null },
  now: Date = new Date(),
): BrowserReloginGate {
  const state = readState(account.extraConfig);
  const today = siteDayKey(now);

  const persist = async (next: StoredGateState): Promise<void> => {
    const extraConfig = mergeAccountExtraConfig(account.extraConfig, {
      [DAILY_BROWSER_RELOGIN_KEY]: next,
    });
    account.extraConfig = extraConfig;
    try {
      await db.update(schema.accounts)
        .set({ extraConfig, updatedAt: new Date().toISOString() })
        .where(eq(schema.accounts.id, account.id))
        .run();
    } catch {
      // See above: the cooldown is a courtesy, not a correctness requirement.
    }
  };

  return {
    // Read live rather than snapshot at construction: the adapter checks before
    // it spends an attempt, but a caller that checks afterwards must not be told
    // the day is still open.
    isSettledToday: () => state.day === today && state.settled === true,
    cooldownRemainingMs: () => {
      // Another day's attempt says nothing about today's grant.
      if (state.day !== today) return 0;
      const elapsed = now.getTime() - lastAttemptMs(state);
      const remaining = DAILY_BROWSER_RELOGIN_COOLDOWN_MS - elapsed;
      return remaining > 0 ? remaining : 0;
    },
    recordAttempt: async () => {
      state.attemptedAt = now.toISOString();
      state.day = today;
      state.settled = false;
      await persist({ day: today, settled: false, attemptedAt: state.attemptedAt });
    },
    markSettled: async () => {
      state.day = today;
      state.settled = true;
      state.attemptedAt = now.toISOString();
      await persist({ day: today, settled: true, attemptedAt: state.attemptedAt });
    },
  };
}
