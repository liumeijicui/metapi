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
  mergeAccountExtraConfig,
  resolveProxyUrlFromExtraConfig,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { asBrowserSessionCredential, runBrowserSessionCheckin } from './browserSessionCredential.js';
import { classifyFailureReason } from './failureReasonService.js';

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
};

/**
 * Platforms whose dead credential can only be replaced by the headed browser.
 *
 * Such a site gates every password login behind a human check, so the HTTP
 * replays above can never succeed. Balance refreshes normally keep the browser
 * off, but for these platforms that is not an option: the failed refresh flips
 * the account to `expired`, and the daily check-in set is selected on
 * `status = 'active'` — the account would drop out of it and never come back.
 */
export function isBrowserOnlyReloginPlatform(platform?: string | null): boolean {
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
  credential: { accessToken: string; platformUserId?: number },
): Promise<AutoReloginResult> {
  const latestAccount = credential.platformUserId
    ? await db.select({ extraConfig: schema.accounts.extraConfig })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get()
    : undefined;
  const extraConfig = credential.platformUserId
    ? mergeAccountExtraConfig(
      latestAccount ? latestAccount.extraConfig : account.extraConfig,
      { platformUserId: credential.platformUserId },
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
  return classifyFailureReason({ message }).code === 'manual_turnstile_required';
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
    return { result: null, blockedByHumanCheck: isHumanCheckRefusal(login.message) };
  }
  return {
    result: await persistCredential(account, {
      accessToken: login.accessToken,
      platformUserId: login.platformUserId,
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
  const passwordAttempt = await tryPasswordRelogin(account, site);
  if (passwordAttempt.result) return passwordAttempt.result;

  const oauth = await tryOauthRelogin(account, site);
  if (oauth) return oauth;

  if (!options?.allowBrowserFallback) return null;
  // A refused password is a wrong password; only a human-check refusal, or an
  // account with no password field at all, can be answered by a browser.
  if (!passwordAttempt.blockedByHumanCheck && getAutoReloginConfig(account.extraConfig)) return null;
  return tryBrowserRelogin(account, site);
}
