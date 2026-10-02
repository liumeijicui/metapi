/**
 * Signs an account back in when its stored credential has died.
 *
 * Every session-cookie bind eventually goes stale: the refresh cookie a site
 * hands out rolls, and one day the exchange comes back 401. The account is then
 * reported as failed on every balance and check-in run until someone signs in
 * again by hand. This module is the one place that knows the three ways a
 * sign-in can be replayed, in the order they are worth trying:
 *
 * 1. the login credentials the operator stored (`autoRelogin`), over plain HTTP;
 * 2. the OAuth handshake the account was originally bound with — a site whose
 *    sign-in is a GitHub redirect has no password field to drive, so replaying
 *    the provider handshake is the only HTTP way back in;
 * 3. the headed browser, which is the only thing that can answer the Cloudflare
 *    Turnstile widget such sites put in front of the same login form.
 *
 * Step 3 runs a real Chromium on the X display and takes minutes, so callers
 * that refresh balances keep it off: a check-in run restores the session and
 * the balance that follows is then fine.
 */
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import {
  getAutoReloginConfig,
  getOauthProviderFromExtraConfig,
  getPlatformUserIdFromExtraConfig,
  mergeAccountExtraConfig,
  parseExtraConfig,
  resolveProxyUrlFromExtraConfig,
  shouldPruneOtherSessions,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { asBrowserSessionCredential, runBrowserSessionCheckin } from './browserSessionCredential.js';
import { classifyFailureReason } from './failureReasonService.js';
import { isBotShieldChallenge } from './alertRules.js';
import { pruneOtherSessions } from './sessionHygiene.js';

/**
 * Result of a successful automatic sign-in.
 *
 * The access token alone is not enough: the sign-in may also have reported the
 * authoritative `platformUserId`. Callers need it for the retry that follows,
 * and they need the merged `extraConfig` so their own later
 * `mergeAccountExtraConfig(account.extraConfig, ...)` writes do not put the
 * pre-login copy back and undo what was just persisted.
 */
export type AutoReloginResult = {
  accessToken: string;
  platformUserId?: number;
  extraConfig?: string;
};

export type AutoReloginOptions = {
  /**
   * Allow the headed-browser fallback. Off by default: a browser run takes
   * minutes, and the callers that refresh balances on a schedule cannot afford
   * to wait for one.
   */
  allowBrowserFallback?: boolean;
  /**
   * Only run that browser when the site itself asked for a human check.
   *
   * The balance refresh passes this because the alternative is worse than the
   * wait: an account whose sign-in is Turnstile-gated can never be restored over
   * HTTP, and a refresh that gives up marks it `expired` — which is what took it
   * out of the daily check-in in the first place. Accounts with no password on
   * file are excluded, so a session-only account does not cost a browser run
   * that would end exactly where it started.
   */
  browserFallbackRequiresHumanCheck?: boolean;
  /**
   * Reports a refusal that no retry can clear, so the caller can record it
   * instead of the generic verdict its own failed request produced.
   *
   * The site's answer is strictly more specific than "401 Unauthorized": a
   * session cap means the password was accepted and the operator has to sign out
   * other sessions. Without this the caller overwrites that with "token
   * expired" and sends them hunting for a credential problem that does not
   * exist. Callbacks fire after the caller's own error handling, so the reason
   * survives.
   */
  onRefusal?: (refusal: { code: string; reason: string }) => void;
};

/**
 * Platforms whose dead credential can only be replaced by the headed browser.
 *
 * Such a site gates every password login behind a human check, so the HTTP
 * replays above can never succeed, and the browser driver they need is their
 * own: nothing about the shared new-api script fits them.
 */
function isBrowserOnlyReloginPlatform(platform?: string | null): boolean {
  return (platform || '').trim().toLowerCase() === 'gwrelay';
}

/**
 * Writes a freshly earned credential to the account row.
 *
 * The row is re-read before the merge: account settings may have changed while
 * the sign-in was in flight, and merging into the original snapshot would
 * overwrite those newer fields when the whole extraConfig value is persisted.
 */
async function persistCredential(
  account: any,
  credential: { accessToken: string; platformUserId?: number; extraFields?: Record<string, unknown> },
): Promise<AutoReloginResult> {
  const patch: Record<string, unknown> = { ...(credential.extraFields || {}) };
  if (credential.platformUserId) patch.platformUserId = credential.platformUserId;
  const latestAccount = Object.keys(patch).length > 0
    ? await db.select({ extraConfig: schema.accounts.extraConfig })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get()
    : undefined;
  const extraConfig = Object.keys(patch).length > 0
    ? mergeAccountExtraConfig(
      latestAccount ? latestAccount.extraConfig : account.extraConfig,
      patch,
    )
    : undefined;

  await db.update(schema.accounts)
    .set({
      accessToken: credential.accessToken,
      ...(extraConfig ? { extraConfig } : {}),
      status: account.status === 'expired' ? 'active' : account.status,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, account.id))
    .run();

  return {
    accessToken: credential.accessToken,
    platformUserId: credential.platformUserId,
    extraConfig,
  };
}

/** True when the site refused the password login until a human check is passed. */
function isHumanCheckRefusal(message?: string | null): boolean {
  if (classifyFailureReason({ message }).code === 'manual_turnstile_required') return true;
  // A shield challenge is the same situation with different wording: the site
  // answered the login POST with a challenge page instead of a verdict, which
  // is exactly the refusal a browser can clear and an HTTP client cannot.
  return isBotShieldChallenge(message);
}

/**
 * Replays the stored username/password over HTTP.
 *
 * `blocked` separates "the site wants a human check" — which the browser can
 * answer — from "the credentials were refused", which it cannot.
 */
async function tryPasswordRelogin(
  account: any,
  site: any,
  reportRefusal?: (refusal: { code: string; reason: string }) => void,
): Promise<{ result: AutoReloginResult | null; blockedByHumanCheck: boolean }> {
  const adapter = getAdapter(site.platform);
  if (!adapter) return { result: null, blockedByHumanCheck: false };

  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!relogin) return { result: null, blockedByHumanCheck: false };

  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return { result: null, blockedByHumanCheck: false };

  const login = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => adapter.login(site.url, relogin.username, password),
  );
  if (!login.success || !login.accessToken) {
    // A session cap is worth naming on the account itself. The caller keeps its
    // own "token expired" verdict from the failed request, which points the
    // operator at a credential problem that does not exist here: the password
    // was accepted and only the site's concurrent-session limit refused it.
    const refusal = classifyFailureReason({ message: login.message });
    if (refusal.code === 'session_limit' || refusal.code === 'invalid_credentials') {
      reportRefusal?.({
        code: refusal.code,
        reason: `${refusal.title}：${refusal.actionHint}`,
      });
    }
    return { result: null, blockedByHumanCheck: isHumanCheckRefusal(login.message) };
  }
  const platformUserId = login.platformUserId ?? getPlatformUserIdFromExtraConfig(account.extraConfig);

  // The site has just minted this session, so every other entry in its list is
  // one the running system does not hold. On a fork that caps concurrent
  // sessions those leftovers are exactly what refuses the *next* re-login, so
  // this is the moment to retire them. Best-effort: a site without the API, or
  // one that refuses the deletes, leaves the sign-in itself untouched.
  // The prune runs against the token this sign-in just minted rather than the
  // stored credential: on a site that keeps the rotatable refresh cookie as the
  // credential, spending it here would roll the secret one step ahead of the
  // value `persistCredential` is about to write back.
  const prune = await pruneOtherSessions({
    adapter,
    siteUrl: site.url,
    accessToken: login.bearerToken || login.accessToken,
    platformUserId,
    enabled: shouldPruneOtherSessions(account.extraConfig),
  });

  const extraFields: Record<string, unknown> = {
    sessionHygiene: {
      outcome: prune.status === 'skipped' ? prune.reason : prune.status,
      ...(prune.status === 'pruned' ? { removed: prune.removed, kept: prune.kept } : {}),
      updatedAt: new Date().toISOString(),
    },
  };

  return {
    result: await persistCredential(account, {
      accessToken: login.accessToken,
      platformUserId: login.platformUserId,
      extraFields,
    }),
    blockedByHumanCheck: false,
  };
}

/**
 * Replays the OAuth handshake the account was bound with.
 *
 * Only the sites that expose such a handshake over plain HTTP are listed, and
 * the account has to carry the provider it used, so a GitHub-bound account is
 * never asked for a Linux.do login.
 */
async function tryOauthRelogin(account: any, site: any): Promise<AutoReloginResult | null> {
  if (getOauthProviderFromExtraConfig(account.extraConfig) !== 'github') return null;

  // Imported lazily: the site modules pull in the browser/HTTP stacks, and only
  // accounts bound through OAuth ever need them.
  const { captureHyperGithubCredentials, supportsHyperGithubLogin } =
    await import('./assistedLogin/sites/hyper.js');
  if (!supportsHyperGithubLogin(site.url, 'github')) return null;

  const captured = await captureHyperGithubCredentials();
  if (captured.status !== 'captured' || !captured.credentials?.accessToken) return null;

  return persistCredential(account, {
    accessToken: captured.credentials.accessToken,
    platformUserId: captured.credentials.platformUserId ?? undefined,
  });
}

/**
 * How long to wait before spending another headed-browser run on one account.
 *
 * A browser run takes minutes and the sites that need it also rate-limit hard
 * (JustDoWork answers a burst with `429` on its own auth routes). The hourly
 * balance refresh and the daily check-in would otherwise each start a run, and
 * the retries would keep the account throttled rather than revive it.
 */
const BROWSER_RELOGIN_COOLDOWN_MS = 15 * 60_000;

function lastBrowserReloginAt(extraConfig?: string | null): number {
  const value = (parseExtraConfig(extraConfig) as Record<string, unknown>).browserRelogin;
  const at = value && typeof value === 'object'
    ? (value as Record<string, unknown>).attemptedAt
    : null;
  const parsed = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function isBrowserReloginCoolingDown(extraConfig?: string | null): boolean {
  const last = lastBrowserReloginAt(extraConfig);
  return last > 0 && Date.now() - last < BROWSER_RELOGIN_COOLDOWN_MS;
}

/** Records the attempt up front, so a run that never returns still counts. */
async function recordBrowserReloginAttempt(account: any): Promise<void> {
  const extraConfig = mergeAccountExtraConfig(account.extraConfig, {
    browserRelogin: { attemptedAt: new Date().toISOString() },
  });
  account.extraConfig = extraConfig;
  try {
    await db.update(schema.accounts)
      .set({ extraConfig, updatedAt: new Date().toISOString() })
      .where(eq(schema.accounts.id, account.id))
      .run();
  } catch {
    // The cooldown is a courtesy, not a correctness requirement: a write that
    // fails must not stop the sign-in the caller actually asked for.
  }
}

/**
 * Signs in through the headed browser and keeps the session it stores.
 *
 * Sites that answer every password login with "Turnstile token 为空" only give
 * a session to a browser, so the run is what restores the credential. When a
 * password is on file the script types it — seeding the stale cookie instead
 * would make the script skip the login form and land back on a signed-out page.
 * A password-less account is the opposite case: the stored session is the only
 * credential it has, so seeding it is the only way in.
 */
async function tryBrowserRelogin(account: any, site: any): Promise<AutoReloginResult | null> {
  const platform = (site.platform || '').toLowerCase();
  const relogin = getAutoReloginConfig(account.extraConfig);
  const password = relogin ? decryptAccountPassword(relogin.passwordCipher) : null;

  if (isBrowserReloginCoolingDown(account.extraConfig)) {
    return null;
  }
  await recordBrowserReloginAttempt(account);

  // The 辉哥中转 PHP panel is the mirror image of the new-api forks below: its
  // sign-in form is the *only* way in (Turnstile gates it), and its session is a
  // short-lived `ut-…` token instead of a refresh cookie. Nothing about the
  // new-api browser script fits it, so it gets its own driver.
  if (isBrowserOnlyReloginPlatform(platform)) {
    if (!password) return null;
    const { loginGwRelayInBrowser } = await import('./assistedLogin/sites/gwRelay.js');
    const outcome = await loginGwRelayInBrowser({
      baseUrl: site.url,
      username: relogin?.username || account.username,
      password,
    });
    if (!outcome.ok || !outcome.accessToken) return null;
    return persistCredential(account, { accessToken: outcome.accessToken });
  }

  if (platform !== 'new-api') return null;

  const sessionCredential = password ? null : asBrowserSessionCredential(account.accessToken);
  if (!password && !sessionCredential) return null;

  const { outcome, accessToken } = await runBrowserSessionCheckin({
    site,
    username: relogin?.username || account.username,
    password: password || '',
    accountExtraConfig: account.extraConfig,
    sessionCredential,
  });
  if (outcome.kind !== 'result' || !accessToken) return null;

  return persistCredential(account, { accessToken });
}

/**
 * Replaces the account's dead credential, or returns null when the sign-in was
 * refused (in which case the caller keeps its original failure verdict).
 */
export async function tryAutoRelogin(
  account: any,
  site: any,
  options?: AutoReloginOptions,
): Promise<AutoReloginResult | null> {
  const passwordAttempt = await tryPasswordRelogin(account, site, options?.onRefusal);
  if (passwordAttempt.result) return passwordAttempt.result;

  const oauth = await tryOauthRelogin(account, site);
  if (oauth) return oauth;

  if (!options?.allowBrowserFallback) return null;
  // A refused password is a wrong password; only a human-check refusal, or an
  // account with no password field at all, can be answered by a browser.
  if (!passwordAttempt.blockedByHumanCheck && getAutoReloginConfig(account.extraConfig)) return null;
  if (options.browserFallbackRequiresHumanCheck && !passwordAttempt.blockedByHumanCheck) return null;
  return tryBrowserRelogin(account, site);
}
