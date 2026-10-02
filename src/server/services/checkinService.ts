import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { isCloudflareChallenge, isTokenExpiredError } from './alertRules.js';
import { reportTokenExpired } from './alertService.js';
import { refreshBalance } from './balanceService.js';
import { parseCheckinRewardAmount } from './checkinRewardParser.js';
import {
  getAutoReloginConfig,
  getPlatformUserIdFromExtraConfig,
  guessPlatformUserIdFromUsername,
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { classifyFailureReason } from './failureReasonService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { withAccountCredentialContext, withAccountProxyOverride } from './siteProxy.js';
import {
  asBrowserSessionCredential,
  runBrowserSessionCheckin,
} from './browserSessionCredential.js';
import { tryAutoRelogin } from './autoRelogin.js';
import { config } from '../config.js';
import type { CheckinResult } from './platforms/base.js';

type CheckinExecutionStatus = 'success' | 'failed' | 'skipped';

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function isAlreadyCheckedInMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.trim();
  if (!text) return false;
  const normalized = text.toLowerCase();
  return (
    normalized.includes('already checked in') ||
    normalized.includes('already signed') ||
    normalized.includes('already sign in') ||
    text.includes('\u4eca\u65e5\u5df2\u7b7e\u5230') ||
    text.includes('\u4eca\u5929\u5df2\u7b7e\u5230') ||
    text.includes('\u4eca\u5929\u5df2\u7ecf\u7b7e\u5230') ||
    text.includes('\u4eca\u65e5\u5df2\u7ecf\u7b7e\u5230') ||
    text.includes('\u5df2\u7ecf\u7b7e\u5230') ||
    text.includes('\u5df2\u7b7e\u5230') ||
    text.includes('\u91cd\u590d\u7b7e\u5230') ||
    text.includes('\u7b7e\u5230\u8fc7')
  );
}

function isUnsupportedCheckinMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('invalid url (post /api/user/checkin)') ||
    (text.includes('http 404') && text.includes('/api/user/checkin')) ||
    text.includes('checkin endpoint not found') ||
    text.includes('check-in is not supported') ||
    text.includes('checkin is not supported') ||
    text.includes('does not support checkin') ||
    text.includes('not support checkin') ||
    // The route exists but the operator turned the feature off. That is a
    // configuration fact, not a broken account, so it belongs with the skips
    // instead of being retried and reported as a failure every day.
    text.includes('签到功能未启用') ||
    text.includes('签到未启用') ||
    text.includes('checkin disabled') ||
    text.includes('check-in disabled') ||
    text.includes('checkin is disabled') ||
    text.includes('check-in is disabled')
  );
}

function isManualVerificationRequiredMessage(message?: string | null): boolean {
  return classifyFailureReason({ message }).code === 'manual_turnstile_required';
}

function shouldAttemptAutoRelogin(message?: string | null): boolean {
  if (!message) return false;
  if (isTokenExpiredError({ message })) return true;

  const text = message.toLowerCase();
  if (text.includes('new-api-user')) return true;
  if (text.includes('access token')) return true;
  return false;
}

function inferRewardFromBalanceDelta(previousBalance: unknown, latestBalance: unknown): number {
  const before = typeof previousBalance === 'number' && Number.isFinite(previousBalance)
    ? previousBalance
    : null;
  const after = typeof latestBalance === 'number' && Number.isFinite(latestBalance)
    ? latestBalance
    : null;
  if (before == null || after == null) return 0;

  const delta = after - before;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta * 1_000_000) / 1_000_000;
}

/**
 * Outcome of a browser check-in: the verdict plus the session it established.
 *
 * The session is what makes the run worth doing even when the site reports the
 * day as already claimed: it is the credential the HTTP path uses from then on.
 */
type BrowserCheckinAttempt = {
  result: CheckinResult;
  accessToken?: string;
};

/**
 * Answers a browser-only check-in challenge.
 *
 * Some New API forks protect the check-in endpoint with Cloudflare Turnstile,
 * which no plain HTTP call can satisfy. Run the same flow a person would drive
 * in a browser on the server whenever the account can reach a signed-in page;
 * otherwise return null so the original verdict (and its "needs manual
 * verification" handling) stands.
 *
 * Two kinds of account can get there, and they seed the browser differently:
 *
 * - one with stored login credentials signs in through the page;
 * - one holding a `new_api_refresh` session (the credential such sites hand out
 *   to a GitHub/OAuth sign-in, and the only one they ever give a token-only
 *   bind) replays that session instead, so a site with no password field to
 *   drive still lands on the check-in card.
 */
async function tryBrowserCheckin(site: any, account: any): Promise<BrowserCheckinAttempt | null> {
  if ((site.platform || '').toLowerCase() !== 'new-api') return null;

  const relogin = getAutoReloginConfig(account.extraConfig);
  const password = relogin ? decryptAccountPassword(relogin.passwordCipher) : null;
  // The HTTP check-in above exchanges a rolling credential, and that exchange
  // retires the value this run started with. Re-read the row so the browser is
  // handed the secret that is actually live right now: a spent one only opens
  // the site signed out.
  const live = await db
    .select({ accessToken: schema.accounts.accessToken })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, account.id))
    .get();
  const storedToken = live?.accessToken ?? account.accessToken;
  const sessionCredential = asBrowserSessionCredential(storedToken);
  // A stored login and a live session are each sufficient; without either the
  // browser would only ever see the site's sign-in form.
  if (!password && !sessionCredential) return null;

  const { outcome, accessToken } = await runBrowserSessionCheckin({
    site,
    username: relogin?.username || account.username,
    password: password || '',
    accountExtraConfig: account.extraConfig,
    sessionCredential,
  });

  // The browser signs in with credentials the HTTP path cannot use, so the
  // session it just created is the account's live credential. Keeping it stops
  // the account from reading as expired: balance, model and probe calls work
  // again, and the next run only needs the browser for the check-in itself.
  if (accessToken && accessToken !== storedToken) {
    await db.update(schema.accounts)
      .set({
        accessToken,
        status: account.status === 'expired' ? 'active' : account.status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.accounts.id, account.id))
      .run();
  }

  if (outcome.kind !== 'result') return null;
  return { result: outcome.result, accessToken: accessToken || undefined };
}

export async function checkinAccount(accountId: number, options?: { skipEvent?: boolean; scheduleMode?: 'cron' | 'interval' }) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .all();

  if (rows.length === 0) return { success: false, message: 'account not found' };

  const account = rows[0].accounts;
  const site = rows[0].sites;

  if (isSiteDisabled(site.status)) {
    const createdAt = formatUtcSqlDateTime(new Date());
    setAccountRuntimeHealth(account.id, {
      state: 'disabled',
      reason: '\u7ad9\u70b9\u5df2\u7981\u7528',
      source: 'checkin',
    });
    await db.insert(schema.checkinLogs).values({
      accountId: account.id,
      status: 'skipped',
      message: 'site disabled',
      createdAt,
    }).run();

    if (!options?.skipEvent) {
      await db.insert(schema.events).values({
        type: 'checkin',
        title: 'checkin skipped',
        message: `${account.username || 'ID:' + accountId} @ ${site.name}: site disabled`,
        level: 'info',
        relatedId: accountId,
        relatedType: 'account',
        createdAt,
      }).run();
    }

    return {
      success: true,
      status: 'skipped' as const,
      skipped: true,
      reason: 'site_disabled',
      message: 'site disabled',
    };
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) return { success: false, status: 'failed' as const, message: `unsupported platform: ${site.platform}` };

  const storedPlatformUserId = getPlatformUserIdFromExtraConfig(account.extraConfig);
  const guessedPlatformUserId = storedPlatformUserId
    ? undefined
    : guessPlatformUserIdFromUsername(account.username);
  let platformUserId = resolvePlatformUserId(account.extraConfig, account.username);

  const accountProxyUrl = resolveProxyUrlFromExtraConfig(account.extraConfig);
  let activeAccessToken = account.accessToken;
  // Set when a sign-in handed this run a credential the account did not have.
  // Only then may an `expired` account be marked active again: an account whose
  // credentials are all dead would otherwise be flipped back on every run, and
  // the next balance refresh would flip it straight back to expired.
  let sessionRestored = false;
  const runCheckin = (token: string) => withAccountProxyOverride(accountProxyUrl,
    () => withAccountCredentialContext({ accountId: account.id, siteId: site.id },
      () => adapter.checkin(site.url, token, platformUserId, {
        externalCheckinUrl: site.externalCheckinUrl,
        extraConfig: account.extraConfig,
      })));

  let result = await runCheckin(activeAccessToken);

  // A refusal the site stated outright outranks the generic failure that
  // triggered this retry, so it is captured here and written once the verdict
  // below has been recorded.
  let reloginRefusal: { code: string; reason: string } | null = null;

  if (!result.success && shouldAttemptAutoRelogin(result.message)) {
    // This is the one caller that may spend a headed browser run: it restores
    // the account's session, and the balance runs that follow are then fine.
    const relogin = await tryAutoRelogin(account, site, {
      allowBrowserFallback: true,
      onRefusal: (refusal) => { reloginRefusal = refusal; },
    });
    if (relogin) {
      activeAccessToken = relogin.accessToken;
      sessionRestored = true;
      // Adopt whatever the re-login reported before retrying, and refresh our
      // in-memory copy of extraConfig — the merge writes further down start from
      // `account.extraConfig`, so leaving the stale copy here would overwrite the
      // id tryAutoRelogin() just persisted.
      if (relogin.platformUserId) platformUserId = relogin.platformUserId;
      if (relogin.extraConfig) account.extraConfig = relogin.extraConfig;
      result = await runCheckin(activeAccessToken);
    }
  }

  // A Turnstile-gated check-in cannot be answered over HTTP; when the account
  // carries login credentials, retry it in a real browser on this machine.
  if (isManualVerificationRequiredMessage(result.message)) {
    const browserAttempt = await tryBrowserCheckin(site, account);
    if (browserAttempt) {
      result = browserAttempt.result;
      if (browserAttempt.accessToken) {
        activeAccessToken = browserAttempt.accessToken;
        sessionRestored = true;
      }
    }
  }

  const isCloudflare = isCloudflareChallenge(result.message);
  const alreadyCheckedIn = isAlreadyCheckedInMessage(result.message);
  const unsupportedCheckin = isUnsupportedCheckinMessage(result.message);
  const manualVerificationRequired = isManualVerificationRequiredMessage(result.message);
  const manualVerificationMessage = '\u7ad9\u70b9\u5f00\u542f\u4e86 Turnstile \u6821\u9a8c\uff0c\u9700\u8981\u4eba\u5de5\u7b7e\u5230';
  const logMessage = manualVerificationRequired ? manualVerificationMessage : result.message;
  const effectiveSuccess = result.success || alreadyCheckedIn || unsupportedCheckin || manualVerificationRequired;
  const shouldRefreshBalance = result.success || alreadyCheckedIn;
  const directCheckinSuccess = result.success && !alreadyCheckedIn && !unsupportedCheckin;
  const shouldAdvanceLastCheckinAt = directCheckinSuccess || (alreadyCheckedIn && options?.scheduleMode !== 'interval');
  const normalizedStatus: CheckinExecutionStatus = effectiveSuccess
    ? ((unsupportedCheckin || manualVerificationRequired) ? 'skipped' : 'success')
    : 'failed';
  let logReward = result.reward;
  let refreshedBalanceInfo: Awaited<ReturnType<typeof refreshBalance>> | null = null;

  if (effectiveSuccess) {
    const healthState = (unsupportedCheckin || manualVerificationRequired) ? 'degraded' : 'healthy';
    const healthReason = unsupportedCheckin
      ? '\u7ad9\u70b9\u4e0d\u652f\u6301\u7b7e\u5230\u63a5\u53e3'
      : manualVerificationRequired
        ? manualVerificationMessage
      : (alreadyCheckedIn ? '\u4eca\u65e5\u5df2\u7b7e\u5230' : (result.message || '\u7b7e\u5230\u6210\u529f'));
    setAccountRuntimeHealth(account.id, {
      state: healthState,
      reason: healthReason,
      source: 'checkin',
    });

    const updates: Record<string, unknown> = {};
    if (shouldAdvanceLastCheckinAt) {
      updates.lastCheckinAt = new Date().toISOString();
    }
    // Both ids above were computed before any re-login. If a re-login has since
    // reported the authoritative one, `account.extraConfig` already carries it,
    // and persisting the guess here would replace a known-good id with digits
    // scraped off the end of the username. Check the current config, not the
    // pre-login snapshot. (`guessedPlatformUserId` is only set when
    // `storedPlatformUserId` was empty, so this stays equivalent otherwise.)
    if (guessedPlatformUserId && !getPlatformUserIdFromExtraConfig(account.extraConfig)) {
      updates.extraConfig = mergeAccountExtraConfig(account.extraConfig, {
        platformUserId: guessedPlatformUserId,
      });
    }
    if (account.status === 'expired' && sessionRestored) {
      updates.status = 'active';
      updates.updatedAt = new Date().toISOString();
    }

    if (Object.keys(updates).length > 0) {
      await db.update(schema.accounts)
        .set(updates)
        .where(eq(schema.accounts.id, accountId))
        .run();
    }

    if (shouldRefreshBalance) {
      try {
        refreshedBalanceInfo = await refreshBalance(account.id);
      } catch {}
    }

    const parsedReward = parseCheckinRewardAmount(logReward) || parseCheckinRewardAmount(result.message);
    if (directCheckinSuccess && parsedReward <= 0) {
      const inferredReward = inferRewardFromBalanceDelta(account.balance, refreshedBalanceInfo?.balance);
      if (inferredReward > 0) {
        logReward = inferredReward.toString();
      }
    }
  }

  const createdAt = formatUtcSqlDateTime(new Date());
  await db.insert(schema.checkinLogs).values({
    accountId: account.id,
    status: normalizedStatus,
    message: logMessage,
    reward: logReward,
    createdAt,
  }).run();

  if (!options?.skipEvent) {
    await db.insert(schema.events).values({
      type: 'checkin',
      title: effectiveSuccess
        ? (normalizedStatus === 'skipped' ? 'checkin skipped' : 'checkin success')
        : (isCloudflare ? 'checkin failed (cloudflare challenge)' : 'checkin failed'),
      message: `${account.username || 'ID:' + accountId} @ ${site.name}: ${logMessage}`,
      level: effectiveSuccess ? 'info' : 'error',
      relatedId: accountId,
      relatedType: 'account',
      createdAt,
    }).run();
  }

  if (!effectiveSuccess) {
    // The operator-facing reason: when the site refused for a cause they have to
    // clear themselves (a session cap, a dead password), that is more useful
    // than the token verdict the failed request produced.
    await setAccountRuntimeHealth(account.id, {
      state: 'unhealthy',
      reason: reloginRefusal
        ? (reloginRefusal as { code: string; reason: string }).reason
        : (result.message || '\u7b7e\u5230\u5931\u8d25'),
      source: 'checkin',
    });
    if (isTokenExpiredError({ message: result.message })) {
      await reportTokenExpired({
        accountId: account.id,
        username: account.username,
        siteName: site.name,
        detail: result.message,
      });
    }

    if (isCloudflare) {
      await sendNotification(
        'Cloudflare challenge',
        `${account.username || 'ID:' + accountId} @ ${site.name}: ${result.message}`,
        'warning',
      );
    }

    if (!unsupportedCheckin && !manualVerificationRequired) {
      await sendNotification(
        'checkin failed',
        `${account.username || 'ID:' + accountId} @ ${site.name}: ${result.message}`,
        'error',
      );
    }
  }


  return {
    ...result,
    success: effectiveSuccess,
    status: normalizedStatus,
    ...(normalizedStatus === 'skipped' ? { skipped: true } : {}),
  };
}

export async function checkinAll(options?: { accountIds?: number[]; scheduleMode?: 'cron' | 'interval' }) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.accounts.checkinEnabled, true),
        // An expired account is deliberately *included*: this job is the only
        // one that may run the headed browser, and the browser is the only thing
        // that can sign a Turnstile-gated site back in. `reportTokenExpired()`
        // flips the account to `expired` on the hourly balance refresh, so
        // filtering it out here would lock it away from the one job that could
        // ever revive it — the revival below would never be reached.
        inArray(schema.accounts.status, ['active', 'expired']),
      ),
    )
    .all();

  const scopedAccountIds = options?.accountIds ? new Set(options.accountIds) : null;
  const results: Array<{ accountId: number; username: string | null; site: string; result: any }> = [];

  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    if (scopedAccountIds && !scopedAccountIds.has(row.accounts.id)) continue;
    const siteId = row.sites.id;
    if (!grouped.has(siteId)) grouped.set(siteId, []);
    grouped.get(siteId)!.push(row);
  }

  const promises = Array.from(grouped.entries()).map(async ([_, siteRows]) => {
    for (const row of siteRows) {
      const r = await checkinAccount(row.accounts.id, {
        skipEvent: true,
        scheduleMode: options?.scheduleMode,
      });
      results.push({
        accountId: row.accounts.id,
        username: row.accounts.username,
        site: row.sites.name,
        result: r,
      });
    }
  });

  await Promise.all(promises);
  return results;
}
