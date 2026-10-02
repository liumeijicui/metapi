import { randomUUID } from 'node:crypto';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { getAdapter } from './platforms/index.js';
import type { LotteryDraw, LotteryStatus, PlatformAdapter } from './platforms/base.js';
import { mergeAccountExtraConfig, parseExtraConfig } from './accountExtraConfig.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

/**
 * Site lottery: the second half of a New-API-style "welfare" daily routine.
 *
 * Several relays (100xlabs, 林夕/k40) pay out twice a day — once as a check-in
 * reward and once as a lottery the account draws after signing in. The lottery
 * spends *free* credit, and a site hands out a limited number of draws per day,
 * so an account that only checks in leaves most of the day's allowance unused.
 * The site's counter is authoritative and resets on its own schedule, which is
 * what makes this safe to run on every check-in pass: a pass that finds the
 * day's draws already spent does nothing.
 *
 * Two rules come from how the sites price a draw, and both are deliberate:
 *
 * - Credit handed out as a draw bonus is spent first. It exists only for this
 *   and does not roll over in any useful way.
 * - The draw never pays with the *paid* balance and never spends activity
 *   score. Paid balance is the operator's money, and activity score buys a
 *   better rate on the site's models; neither is this routine's to spend. A
 *   site that prices draws only that way is left alone and says so.
 */

export const DEFAULT_DAILY_DRAWS = 10;

export type LotteryAutoDrawConfig = {
  enabled: boolean;
  /** How many draws to make per day, capped by the site's own limit. */
  dailyDraws: number;
};

export type LotteryBatch = {
  costType: 'bonus' | 'free';
  count: number;
};

export type LotteryPlan =
  | { ok: true; batches: LotteryBatch[]; reason: string }
  | { ok: false; reason: string };

export type LotteryRunOutcome = {
  /** True when at least one draw was made. */
  drawn: number;
  wins: number;
  /** Free credit won, in the site's USD unit. */
  reward: number;
  reason: string;
};

/**
 * Per-account switch. Defaults to on with the daily maximum, because the whole
 * point of the routine is that the operator does not have to remember it; an
 * account that should be left alone turns it off.
 */
export function getLotteryAutoDrawConfig(extraConfig?: string | null): LotteryAutoDrawConfig {
  const parsed = parseExtraConfig(extraConfig) as Record<string, unknown>;
  const raw = parsed.lottery;
  const config = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as { enabled?: unknown; dailyDraws?: unknown })
    : {};
  const requested = typeof config.dailyDraws === 'number' && Number.isFinite(config.dailyDraws)
    ? Math.trunc(config.dailyDraws)
    : DEFAULT_DAILY_DRAWS;
  return {
    enabled: config.enabled !== false,
    dailyDraws: requested > 0 ? requested : DEFAULT_DAILY_DRAWS,
  };
}

/**
 * Decides the day's remaining draws without touching the network.
 *
 * Split out so the rules above are testable on their own: the batches this
 * returns are what the caller then executes, and every refusal carries the
 * reason the operator would want to read in the log.
 */
export function planLotteryDraws(status: LotteryStatus, dailyDraws: number): LotteryPlan {
  if (!status.enabled) return { ok: false, reason: '站点未开启抽奖' };

  // The site's own ceiling for the day is a hard cap; the configured target
  // only ever lowers it.
  const goal = status.dailyDrawLimit > 0
    ? Math.min(dailyDraws, status.dailyDrawLimit)
    : dailyDraws;
  let remaining = goal - status.todayDraws;
  // The counter is checked before the site's `can_draw` flag because the flag
  // goes false for two different reasons — the day's quota or a window that has
  // not opened — and only the counter says which one this is.
  if (remaining <= 0) return { ok: false, reason: `今日抽奖次数已用完（${status.todayDraws}/${goal}）` };
  if (!status.canDraw) return { ok: false, reason: '站点当前不可抽奖（未到开放时间或额度未发放）' };

  const batches: LotteryBatch[] = [];
  const batchMax = status.batchMax > 0 ? status.batchMax : 1;

  // Bonus draws first: they are the site's own gift for checking in and the
  // only thing they can be spent on.
  const bonus = Math.min(status.bonusDraws, remaining);
  for (let left = bonus; left > 0; left -= batchMax) {
    const count = Math.min(batchMax, left);
    batches.push({ costType: 'bonus', count });
  }
  remaining -= bonus;

  if (remaining > 0) {
    const price = status.freeCost.amount;
    if (!status.freeCost.enabled || price <= 0) {
      return batches.length > 0
        ? { ok: true, batches, reason: '' }
        : { ok: false, reason: '站点未开放用免费额度抽奖' };
    }
    const affordable = Math.floor((status.freeBalance + 1e-9) / price);
    const payable = Math.min(remaining, affordable);
    for (let left = payable; left > 0; left -= batchMax) {
      const count = Math.min(batchMax, left);
      batches.push({ costType: 'free', count });
    }
    if (batches.length === 0) {
      return { ok: false, reason: `免费额度不足（$${status.freeBalance.toFixed(2)}，每次需 $${price}）` };
    }
  }

  if (batches.length === 0) return { ok: false, reason: '今日无需抽奖' };
  return { ok: true, batches, reason: '' };
}

function summarize(draws: readonly LotteryDraw[]): { wins: number; reward: number } {
  let wins = 0;
  let reward = 0;
  for (const draw of draws) {
    if (draw.status === 'win') wins += 1;
    if (draw.prizeType === 'free' && Number.isFinite(draw.prizeAmount)) reward += draw.prizeAmount;
  }
  return { wins, reward: Math.round(reward * 1_000_000) / 1_000_000 };
}

/** The last run kept on the account, so a repeat of it need not be written again. */
export function readStoredLotteryOutcome(extraConfig?: string | null): LotteryRunOutcome | null {
  const parsed = parseExtraConfig(extraConfig) as Record<string, unknown>;
  const raw = parsed.lottery;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const stored = raw as { drawn?: unknown; wins?: unknown; reward?: unknown; reason?: unknown };
  return {
    drawn: typeof stored.drawn === 'number' ? stored.drawn : 0,
    wins: typeof stored.wins === 'number' ? stored.wins : 0,
    reward: typeof stored.reward === 'number' ? stored.reward : 0,
    reason: typeof stored.reason === 'string' ? stored.reason : '',
  };
}

/**
 * Draws the day's remaining allowance and records what it got.
 *
 * Never throws and never fails a check-in: a lottery the site refuses is a
 * sentence in the log, not a broken account.
 */
export async function runDailyLottery(params: {
  accountId: number;
  accountUsername?: string | null;
  accountExtraConfig?: string | null;
  siteName: string;
  siteUrl: string;
  platform: string;
  accessToken: string;
}): Promise<LotteryRunOutcome> {
  const config = getLotteryAutoDrawConfig(params.accountExtraConfig);
  const previousReason = readStoredLotteryOutcome(params.accountExtraConfig)?.reason ?? null;
  /**
   * A pass that draws nothing is the normal case (the day's allowance is spent
   * after the first pass), so it is not an event. Two refusals are still worth
   * keeping on the account: one the site answered (`note`), and one that says
   * the lottery does not apply here at all (`skip`) — the second is not an
   * answer about this account, and writing it would touch every account on
   * every pass. Both are only written when the reason changes, because a site
   * that stops paying draws is exactly what used to go unnoticed and one row
   * per hour is not worth writing to say the same thing twice.
   */
  const skip = (reason: string): LotteryRunOutcome => ({ drawn: 0, wins: 0, reward: 0, reason });
  const note = async (reason: string): Promise<LotteryRunOutcome> => {
    const outcome = skip(reason);
    if (previousReason !== reason) await recordLotteryOutcome(params, outcome, { emitEvent: false });
    return outcome;
  };
  if (!config.enabled) return skip('抽奖已关闭');
  if (!params.accessToken) return skip('缺少可用凭证');

  // Not every platform ships a lottery; `getLotteryStatus` is the capability
  // probe, so an adapter without one is simply skipped.
  const adapter = getAdapter(params.platform) as PlatformAdapter | undefined;
  if (!adapter?.getLotteryStatus || !adapter.drawLottery) return skip('该平台没有抽奖接口');

  let status: LotteryStatus | null;
  try {
    status = await adapter.getLotteryStatus(params.siteUrl, params.accessToken);
  } catch (error) {
    return note(`读取抽奖状态失败：${describe(error)}`);
  }
  if (!status) return skip('该站点没有抽奖功能');

  const plan = planLotteryDraws(status, config.dailyDraws);
  if (!plan.ok) return note(plan.reason);

  const drawn: LotteryDraw[] = [];
  for (const batch of plan.batches) {
    try {
      const outcome = await adapter.drawLottery(params.siteUrl, params.accessToken, {
        costType: batch.costType,
        count: batch.count,
        idempotencyKey: randomUUID(),
      });
      drawn.push(...outcome.draws);
    } catch (error) {
      // Stop at the first refusal: the remaining batches would be refused for
      // the same reason, and the totals below still report what did land.
      const partial = summarize(drawn);
      const reason = `抽奖中断：${describe(error)}`;
      await recordLotteryOutcome(params, { drawn: drawn.length, ...partial, reason }, { emitEvent: true });
      return { drawn: drawn.length, ...partial, reason };
    }
  }

  const summary = summarize(drawn);
  const reason = `已抽 ${drawn.length} 次（${plan.batches.map((b) => b.costType).join('/')}），中奖 ${summary.wins} 次`;
  const outcome: LotteryRunOutcome = { drawn: drawn.length, ...summary, reason };
  await recordLotteryOutcome(params, outcome, { emitEvent: true });
  return outcome;
}

async function recordLotteryOutcome(
  params: { accountId: number; accountUsername?: string | null; accountExtraConfig?: string | null; siteName: string },
  outcome: LotteryRunOutcome,
  options: { emitEvent: boolean },
): Promise<void> {
  const createdAt = formatUtcSqlDateTime(new Date());
  const summary = `抽奖 ${outcome.drawn} 次，中奖 ${outcome.wins} 次`
    + (outcome.reward > 0 ? `，免费额度 +$${outcome.reward}` : '');
  if (options.emitEvent) {
    try {
      await db.insert(schema.events).values({
        type: 'lottery',
        title: 'lottery draw',
        message: `${params.accountUsername || `ID:${params.accountId}`} @ ${params.siteName}: ${summary}`,
        level: 'info',
        relatedId: params.accountId,
        relatedType: 'account',
        createdAt,
      }).run();
    } catch {
      // The draw already happened; failing to note it must not undo that.
    }
  }
  // Kept on the account so the last run is readable without walking the event
  // log, and so a day that drew nothing says why.
  const extraConfig = mergeAccountExtraConfig(params.accountExtraConfig, {
    lottery: {
      lastRunAt: createdAt,
      drawn: outcome.drawn,
      wins: outcome.wins,
      reward: outcome.reward,
      reason: outcome.reason,
    },
  });
  try {
    await db.update(schema.accounts)
      .set({ extraConfig, updatedAt: new Date().toISOString() })
      .where(eq(schema.accounts.id, params.accountId))
      .run();
  } catch {
    // Same reasoning as the event insert above.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
