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
import { browserLane } from '../shared/browserLane.js';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import {
  buildReloginMarkerPatch,
  getAgentRouterProvider,
  getAutoReloginConfig,
  getOauthProviderFromExtraConfig,
  getPlatformUserIdFromExtraConfig,
  getReloginProviderFromExtraConfig,
  mergeAccountExtraConfig,
  parseExtraConfig,
  resolveProxyUrlFromExtraConfig,
  shouldPruneOtherSessions,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { getAccountCredentialContext, withAccountCredentialContext, withAccountProxyOverride } from './siteProxy.js';
import { applyRotatedCredentialIfCarried } from './accountCredentialRotation.js';
import { asBrowserSessionCredential, runBrowserSessionCheckin } from './browserSessionCredential.js';
import { classifyFailureReason } from './failureReasonService.js';
import { isBotShieldChallenge } from './alertRules.js';
import { pruneOtherSessions } from './sessionHygiene.js';
import { isSub2ApiPlatform } from './sub2apiManagedAuth.js';

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
  const prune = await pruneAfterSignIn({
    account,
    site,
    accessToken: login.bearerToken || login.accessToken,
    platformUserId,
  });

  return {
    result: await persistCredential(account, {
      // The prune may have spent the cookie this sign-in minted, in which case
      // the row has already been handed the replacement; writing the value
      // captured before it would put the retired secret back.
      accessToken: applyRotatedCredentialIfCarried(login.accessToken, prune.rotated),
      platformUserId: login.platformUserId,
      extraFields: {
        ...prune.extraFields,
        // A Sub2API sign-in answers with a rotating pair, and the access half
        // only lives for hours. Keeping the refresh half is what turns this
        // re-login into the last one: from here on the session renews over
        // HTTP. Losing it costs another sign-in on every expiry, and on a
        // deployment whose login form is Turnstile-gated there is no second
        // sign-in to have.
        ...(isSub2ApiPlatform(site.platform) && login.refreshToken
          ? {
            sub2apiAuth: {
              refreshToken: login.refreshToken,
              ...(login.tokenExpiresAt ? { tokenExpiresAt: login.tokenExpiresAt } : {}),
            },
          }
          : {}),
      },
    }),
    blockedByHumanCheck: false,
  };
}

/**
 * Writes bookkeeping fields without touching the credential column.
 *
 * Used after a prune: the prune may have rotated the stored cookie, and
 * rewriting the value captured before it would put the spent secret back.
 */
async function persistExtraFields(
  account: any,
  extraFields: Record<string, unknown>,
): Promise<string> {
  const latest = await db.select({ extraConfig: schema.accounts.extraConfig })
    .from(schema.accounts)
    .where(eq(schema.accounts.id, account.id))
    .get();
  const extraConfig = mergeAccountExtraConfig(latest?.extraConfig ?? account.extraConfig, extraFields);
  await db.update(schema.accounts)
    .set({ extraConfig, updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, account.id))
    .run();
  return extraConfig;
}

/**
 * Retires the sessions a fresh sign-in just superseded.
 *
 * Every sign-in mints another server-side session, and on a fork that caps
 * concurrent sessions the leftovers are what eventually refuse the *next*
 * one. Doing this right after a sign-in is what keeps an account from slowly
 * locking itself out.
 */
async function pruneAfterSignIn(params: {
  account: any;
  site: any;
  accessToken: string;
  platformUserId?: number;
}): Promise<{
  extraFields: Record<string, unknown>;
  rotated?: { cookieName: string; value: string };
}> {
  const { account, site, accessToken, platformUserId } = params;
  const adapter = getAdapter(site.platform);
  // The prune exchanges the credential it is handed, and that exchange retires
  // the secret it spends. Running inside the account's credential scope is what
  // lets the replacement land on the row; outside it the exchange would leave
  // the account holding the value the site just retired.
  const prune = await withAccountCredentialContext(
    { accountId: account.id, siteId: site.id },
    async () => {
      const outcome = await pruneOtherSessions({
        adapter,
        siteUrl: site.url,
        accessToken,
        platformUserId,
        enabled: shouldPruneOtherSessions(account.extraConfig),
      });
      return { outcome, rotated: getAccountCredentialContext()?.rotated };
    },
  );
  return {
    extraFields: {
      sessionHygiene: {
        outcome: prune.outcome.status === 'skipped' ? prune.outcome.reason : prune.outcome.status,
        ...(prune.outcome.status === 'pruned'
          ? { removed: prune.outcome.removed, kept: prune.outcome.kept }
          : {}),
        updatedAt: new Date().toISOString(),
      },
    },
    rotated: prune.rotated,
  };
}

/**
 * Replays the OAuth handshake the account was bound with.
 *
 * Only the sites that expose such a handshake over plain HTTP are listed, and
 * the account has to carry the provider it used, so a GitHub-bound account is
 * never asked for a Linux.do login.
 *
 * The provider may sit under `oauth` or under the routing-neutral `relogin`
 * marker; `getReloginProviderFromExtraConfig` documents why a Linux.do link is
 * recorded in the second slot.
 */
async function tryOauthRelogin(
  account: any,
  site: any,
  options?: AutoReloginOptions,
): Promise<AutoReloginResult | null> {
  // Agent Router is its own case, and it is answered first: nothing on the
  // account says "OAuth" in the generic sense — the binding lives under the
  // site's own marker, because the flow is the deployment's login handler
  // rather than a provider session the router can replay by itself.
  const agentRouterProvider = getAgentRouterProvider(account.extraConfig);
  if (agentRouterProvider) {
    return tryAgentRouterRelogin(account, site, agentRouterProvider, options);
  }

  const provider = getOauthProviderFromExtraConfig(account.extraConfig)
    ?? getReloginProviderFromExtraConfig(account.extraConfig);
  if (provider === 'linuxdo') {
    // Same provider, two protocols. A Sub2API fork answers no `/api/status` and
    // has no `/api/oauth/state`, so the new-api driver below cannot even find
    // its client id there; it starts the flow on
    // `/api/v1/auth/oauth/linuxdo/start` and returns its tokens in a URL
    // fragment instead. The platform decides which driver gets to speak.
    return isSub2ApiPlatform(site.platform)
      ? trySub2ApiLinuxDoRelogin(account, site, options)
      : tryLinuxDoRelogin(account, site);
  }
  if (provider !== 'github') return null;

  // Imported lazily: the site modules pull in the browser/HTTP stacks, and only
  // accounts bound through OAuth ever need them.
  const { captureHyperGithubCredentials, supportsHyperGithubLogin } =
    await import('./assistedLogin/sites/hyper.js');
  let captured;
  if (supportsHyperGithubLogin(site.url, 'github')) {
    captured = await captureHyperGithubCredentials();
  } else {
    // Every other New API build that signs in through GitHub answers the same
    // standardized flow (`/api/oauth/state` + `/oauth/github`), so a
    // GitHub-bound account is not limited to the one site the handshake was
    // first written for. Sites without that flow report it themselves and the
    // caller falls through to the browser, as before.
    const { captureNewApiGithubCredentials, supportsNewApiGithubOauth } =
      await import('./assistedLogin/sites/newApiGithubOauthRelogin.js');
    if (!supportsNewApiGithubOauth(site.url, 'github')) return null;
    captured = await captureNewApiGithubCredentials(site.url);
  }
  if (captured.status !== 'captured' || !captured.credentials?.accessToken) return null;

  // Persist before pruning, for the same reason as the browser path: the prune
  // exchanges a rotatable cookie, and the row has to hold that value already or
  // the rotated replacement is dropped as stale.
  const persisted = await persistCredential(account, {
    accessToken: captured.credentials.accessToken,
    platformUserId: captured.credentials.platformUserId ?? undefined,
    // The marker, not `oauth`: the captured value is the site's own refresh
    // cookie, and routing must keep using the managed token. Recording it also
    // keeps the account retryable on the next expiry.
    extraFields: buildReloginMarkerPatch(account.extraConfig, 'github', new Date().toISOString()),
  });
  const prune = await pruneAfterSignIn({
    account,
    site,
    accessToken: persisted.accessToken,
    platformUserId: persisted.platformUserId,
  });
  return {
    ...persisted,
    accessToken: applyRotatedCredentialIfCarried(persisted.accessToken, prune.rotated),
    extraConfig: await persistExtraFields(account, prune.extraFields),
  };
}

/** Default callback route new-api forks answer the Linux.do handshake on. */
const LINUXDO_CALLBACK_PATH = '/api/oauth/linuxdo';

/**
 * Signs an Agent Router account back in through the provider it was bound with.
 *
 * The deployment has no password form: accounts are created through GitHub or
 * Linux.do, and the binding is recorded on `extraConfig.agentRouter.provider`
 * because the account record itself does not say which one it was. Both routes
 * end the same way — the sign-in leaves a session cookie on the deployment —
 * and both need that cookie turned back into the account's bearer before it is
 * worth writing down (see `issueAccessTokenFromSession`), so the renewal ends
 * with the credential shape every other call on this account already uses.
 *
 * GitHub replays over plain HTTP with the imported GitHub session. Linux.do
 * cannot: its consent page is behind Cloudflare and the OAuth state is bound to
 * the browsing session, so it runs in the managed browser — the same handshake
 * the check-in uses, which is also why the cooldown below matters: that site
 * grants its daily quota inside the login handler, so every renewal is a login
 * and a burst of them is what gets the account throttled.
 */
async function tryAgentRouterRelogin(
  account: any,
  site: any,
  provider: 'github' | 'linuxdo',
  options?: AutoReloginOptions,
): Promise<AutoReloginResult | null> {
  const { isAgentRouterSite, loginAgentRouterWithGitHub, loginAgentRouterWithLinuxDo } =
    await import('./assistedLogin/sites/agentRouter.js');
  if (!isAgentRouterSite(site.url)) return null;

  const expectedUserId = getPlatformUserIdFromExtraConfig(account.extraConfig);
  let login;
  if (provider === 'github') {
    // A refused GitHub reply (a retired imported session) is the provider's
    // verdict, and reporting it verbatim is what stops the operator from hunting
    // the site for a problem that lives on GitHub.
    login = await loginAgentRouterWithGitHub({ baseUrl: site.url });
  } else {
    if (isBrowserReloginCoolingDown(account.extraConfig)) return null;
    await recordBrowserReloginAttempt(account);
    const clientId = await readLinuxDoClientId(site.url);
    login = await browserLane.run(() => loginAgentRouterWithLinuxDo({
      baseUrl: site.url,
      clientId,
      expectedUserId,
    }));
  }

  if (!login.ok || !login.sessionCookie) {
    if (login.message) options?.onRefusal?.({ code: 'relogin_refused', reason: login.message });
    return null;
  }

  // The exchange runs under the account's proxy: it is part of the site
  // conversation, and agentrouter is only reachable through the system proxy.
  const adapter = getAdapter(site.platform);
  const bearer = adapter?.issueAccessTokenFromSession
    ? await withAccountProxyOverride(
      resolveProxyUrlFromExtraConfig(account.extraConfig),
      () => adapter.issueAccessTokenFromSession!(
        site.url,
        login.sessionCookie as string,
        login.platformUserId ?? expectedUserId,
      ),
    ).catch(() => null)
    : null;

  const persisted = await persistCredential(account, {
    accessToken: bearer || login.sessionCookie,
    platformUserId: login.platformUserId ?? expectedUserId,
  });
  const prune = await pruneAfterSignIn({
    account,
    site,
    accessToken: persisted.accessToken,
    platformUserId: persisted.platformUserId,
  });
  return {
    ...persisted,
    accessToken: applyRotatedCredentialIfCarried(persisted.accessToken, prune.rotated),
    extraConfig: await persistExtraFields(account, prune.extraFields),
  };
}

/**
 * Signs the account back in through Linux.do.
 *
 * An account bound with 快捷登录 has no password and no GitHub binding, so the
 * only way back in is the handshake the operator performed by hand: sign out of
 * the site, then authorize again. `connect.linux.do` refuses plain HTTP clients
 * (the state is bound to a browsing session and the consent page is behind
 * Cloudflare), so this runs in the managed browser.
 *
 * Two steps, and both matter: the driver performs the handshake and proves the
 * right account landed, and the harvest turns the browser session it created
 * into a credential the row can actually send. Skipping the harvest would leave
 * a signed-in browser with a dead row, which is the state this exists to fix.
 */
async function tryLinuxDoRelogin(account: any, site: any): Promise<AutoReloginResult | null> {
  let host = '';
  try {
    host = new URL(site.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  // The handshake runs a real browser and takes minutes, and the relays that
  // need it also throttle hard. Without this, every failed balance refresh would
  // start another run and keep the account rate-limited instead of reviving it.
  if (isBrowserReloginCoolingDown(account.extraConfig)) return null;
  await recordBrowserReloginAttempt(account);

  const clientId = await readLinuxDoClientId(site.url);
  const expectedUserId = getPlatformUserIdFromExtraConfig(account.extraConfig);

  // Imported lazily: the driver pulls in the browser stack, and only
  // Linux.do-bound accounts ever reach it.
  const { reloginWithLinuxDo } = await import('./assistedLogin/sites/linuxDoOAuthRelogin.js');
  const relogin = await browserLane.run(() => reloginWithLinuxDo({
    baseUrl: site.url,
    clientId,
    expectedUserId,
    hosts: [host],
    callbackPath: LINUXDO_CALLBACK_PATH,
    siteLabel: host,
  }));
  if (!relogin.ok) return null;

  const { harvestLinuxDoSiteCredential } = await import('./linuxdoSession/sessionService.js');
  const captured = await harvestLinuxDoSiteCredential(site.url);
  if (!captured?.accessToken) return null;

  const nowIso = new Date().toISOString();
  const persisted = await persistCredential(account, {
    accessToken: captured.accessToken,
    platformUserId: captured.platformUserId ?? expectedUserId,
    // The marker, not `oauth`: the harvested credential is the fork's
    // management cookie, and routing must keep using the managed token.
    extraFields: buildReloginMarkerPatch(account.extraConfig, 'linuxdo', nowIso),
  });
  const prune = await pruneAfterSignIn({
    account,
    site,
    accessToken: persisted.accessToken,
    platformUserId: persisted.platformUserId,
  });
  return {
    ...persisted,
    accessToken: applyRotatedCredentialIfCarried(persisted.accessToken, prune.rotated),
    extraConfig: await persistExtraFields(account, prune.extraFields),
  };
}

/**
 * Signs the account back in through a Sub2API deployment's Linux.do handshake.
 *
 * The provider matches the new-api driver above and the account carries the
 * same marker, but nothing else does: the flow starts on
 * `/api/v1/auth/oauth/linuxdo/start`, the consent page is behind Cloudflare and
 * the site's own WAF, and the callback answers with a token pair in the URL
 * fragment that the SPA then moves into `localStorage`. Only a browser can walk
 * that, so this is the one driver for it.
 *
 * Both halves of the pair are stored: the access token is what the row sends,
 * and the refresh token is what lets `refreshSub2ApiManagedSession` renew the
 * session from then on without another browser run — which is what keeps this
 * from becoming an hourly Chromium job.
 */
async function trySub2ApiLinuxDoRelogin(
  account: any,
  site: any,
  options?: AutoReloginOptions,
): Promise<AutoReloginResult | null> {
  let host = '';
  try {
    host = new URL(site.url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;

  // A browser run costs minutes, and `connect.linux.do` escalates its challenge
  // when it is asked in bursts: the first run answers one click, the fifth
  // answers a hard 403. The cooldown is what keeps the next attempt cheap.
  if (isBrowserReloginCoolingDown(account.extraConfig)) return null;
  await recordBrowserReloginAttempt(account);

  const expectedUserId = getPlatformUserIdFromExtraConfig(account.extraConfig);

  // Imported lazily: the driver pulls in the browser stack, and only
  // Linux.do-bound accounts ever reach it. The lane is the single gate every
  // headed flow passes through, so a wave of expiries cannot start a wave of
  // Chromiums.
  const { captureSub2ApiLinuxDoCredentials } =
    await import('./assistedLogin/sites/sub2ApiLinuxDoRelogin.js');
  const captured = await browserLane.run(() => captureSub2ApiLinuxDoCredentials({
    baseUrl: site.url,
    expectedUserId,
    siteLabel: host,
  }));
  // A refusal is reported by the driver's own message and the caller keeps the
  // original verdict; only a captured pair is worth writing down.
  if (captured.status !== 'captured' || !captured.credentials?.accessToken) {
    // The driver knows exactly which step refused — the consent page never
    // appeared, the site's callback answered without a token, the captured pair
    // belonged to somebody else. Reporting it as a generic "token expired" is
    // what sends the operator looking at credentials when the problem is the
    // site, so the verdict is handed to the caller to record verbatim.
    if (captured.message) {
      options?.onRefusal?.({ code: 'relogin_refused', reason: captured.message });
    }
    return null;
  }

  const refreshToken = captured.credentials.refreshToken;
  const tokenExpiresAt = captured.credentials.tokenExpiresAt;
  // No session prune here: a Sub2API credential is a JWT, not a cookie the site
  // keeps a session list for, and its adapter exposes no session API to retire
  // entries with. There is nothing a prune could do but record `unsupported`.
  return persistCredential(account, {
    accessToken: captured.credentials.accessToken,
    platformUserId: captured.credentials.platformUserId ?? expectedUserId,
    extraFields: {
      // The marker, not `oauth`: routing has to keep using the managed token,
      // and recording the binding is also what keeps the account retryable.
      ...buildReloginMarkerPatch(account.extraConfig, 'linuxdo', new Date().toISOString()),
      ...(refreshToken
        ? { sub2apiAuth: { refreshToken, ...(tokenExpiresAt ? { tokenExpiresAt } : {}) } }
        : {}),
    },
  });
}

/**
 * Reads the OAuth client id the fork advertises, if the edge lets us.
 *
 * Optional by design: the driver resolves it inside the page when this comes
 * back empty, and a shielded `/api/status` is exactly the case that fallback is
 * for.
 */
async function readLinuxDoClientId(siteUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${siteUrl.replace(/\/+$/, '')}/api/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    const payload: any = await res.json();
    const value = payload?.data?.linuxdo_client_id;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
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
    // Same hygiene as every other sign-in: this one minted a session too, so
    // the entries it superseded are retired before the run ends. A panel with
    // no session API reports `unsupported` and changes nothing.
    const persisted = await persistCredential(account, { accessToken: outcome.accessToken });
    const prune = await pruneAfterSignIn({
      account,
      site,
      accessToken: persisted.accessToken,
      platformUserId: persisted.platformUserId,
    });
    return {
      ...persisted,
      accessToken: applyRotatedCredentialIfCarried(persisted.accessToken, prune.rotated),
      extraConfig: await persistExtraFields(account, prune.extraFields),
    };
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

  // Persist before pruning: the credential the browser just captured is a
  // rotatable cookie, and the prune exchanges it. Writing the row first is what
  // lets the rotated secret land where it belongs instead of being dropped as
  // stale, which would leave the account holding a spent secret.
  const persisted = await persistCredential(account, { accessToken });
  const prune = await pruneAfterSignIn({
    account,
    site,
    accessToken: persisted.accessToken,
    platformUserId: persisted.platformUserId,
  });
  return {
    ...persisted,
    accessToken: applyRotatedCredentialIfCarried(persisted.accessToken, prune.rotated),
    extraConfig: await persistExtraFields(account, prune.extraFields),
  };
}

/**
 * Says why a dead credential could not be renewed automatically.
 *
 * This module is the only thing that knows which replays exist, so it is also
 * the thing that can say when there is nothing to replay. An account with no
 * stored password and no OAuth binding fails identically every hour with no hint
 * that a human sign-in is the only way out, which reads like the system is
 * broken rather than missing an input. Returns undefined when a re-login was
 * possible — the failure is then about the site, not about the missing input.
 *
 * A site-side failure (the host is down, the site answers 5xx) is reported as
 * such elsewhere; saying "no credential on file" there would point the operator
 * at the wrong thing, so this only speaks when the site answered and refused.
 */
export function describeRenewalGap(
  account: { extraConfig?: string | null; oauthProvider?: string | null },
  message?: string | null,
): string | undefined {
  const reason = classifyFailureReason({ message });
  if (
    reason.code === 'site_unreachable'
    || reason.code === 'cloudflare_tunnel_unavailable'
    || reason.code === 'upstream_error'
    || reason.code === 'rate_limited'
  ) {
    return undefined;
  }
  const { extraConfig } = account;
  if (getAutoReloginConfig(extraConfig)) return undefined;
  if (getOauthProviderFromExtraConfig(extraConfig) || account.oauthProvider) return undefined;
  if (getReloginProviderFromExtraConfig(extraConfig)) return undefined;
  // Agent Router records its binding under the site's own marker rather than the
  // generic one (see `tryAgentRouterRelogin`), and it does have a replay, so it
  // must not be described as an account with nothing to replay.
  if (getAgentRouterProvider(extraConfig)) return undefined;
  return '该账号没有保存可自动续期的登录凭据（未存账号密码、也未绑定 OAuth），'
    + '需要人工在站点上重新登录一次';
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

  const oauth = await tryOauthRelogin(account, site, options);
  if (oauth) return oauth;

  if (!options?.allowBrowserFallback) return null;
  // A refused password is a wrong password; only a human-check refusal, or an
  // account with no password field at all, can be answered by a browser.
  if (!passwordAttempt.blockedByHumanCheck && getAutoReloginConfig(account.extraConfig)) return null;
  if (options.browserFallbackRequiresHumanCheck && !passwordAttempt.blockedByHumanCheck) return null;

  // Everything headed goes through one lane. The balance refresh and the
  // check-in pass both reach this point from an unbounded fan-out, so without
  // the gate a single scheduled tick could start dozens of Chromium runs at
  // once - which is what produced the `session_rejected` and "browser would not
  // start" errors, and the memory spikes that went with them.
  return browserLane.run(() => tryBrowserRelogin(account, site));
}
