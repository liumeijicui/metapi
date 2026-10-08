/**
 * Keeps a credential that nothing else looks at from dying quietly.
 *
 * Most accounts are examined often enough by accident: their balance endpoint
 * answers, so every refresh pass is also an authenticated request, and a dead
 * session shows up as a 401 within the hour. A site whose quota endpoint is
 * walled off (`balanceUnavailableReason`) has no such accident — its account is
 * skipped by the balance pass, and the only other job that touches it is the
 * scheduled sign-in. A session that dies in between therefore keeps reading as
 * healthy until the next sign-in, which is the day the operator finds out.
 *
 * This pass closes that window for the sites that hand in a cheap probe: read
 * the credential with an endpoint that has to authenticate, and act only on a
 * refusal the site stated itself.
 *
 * The probe is deliberately not an excuse to sign in periodically. On the sites
 * that need this, a sign-in *is* the daily grant (Agent Router pays its $25
 * inside the login handler), and re-logging in on a schedule is exactly what
 * gets the account rate-limited — which is why `unknown` gets no action at all
 * and the renewal only runs behind the site's own "this credential is invalid"
 * verdict.
 */
import { getAdapter } from './platforms/index.js';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { resolvePlatformUserId, resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { reportTokenExpired } from './alertService.js';
import { tryAutoRelogin } from './autoRelogin.js';
import { withAccountCredentialContext, withAccountProxyOverride } from './siteProxy.js';

export type CredentialKeepaliveOutcome =
  /** The adapter has no probe, or the probe could not get an answer. */
  | 'skipped'
  /** The site accepted the credential. */
  | 'ok'
  /** The site refused it and the account signed back in. */
  | 'renewed'
  /** The site refused it and no replay could restore it. */
  | 'refused';

export async function keepAliveCredential(account: any, site: any): Promise<CredentialKeepaliveOutcome> {
  const adapter = getAdapter(site?.platform);
  if (!adapter?.probeCredential) return 'skipped';

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const verdict = await withAccountProxyOverride(
    resolveProxyUrlFromExtraConfig(account.extraConfig),
    () => withAccountCredentialContext(
      { accountId: account.id, siteId: site.id },
      () => adapter.probeCredential!(site.url, account.accessToken, platformUserId),
    ),
  ).catch(() => 'unknown' as const);

  if (verdict === 'ok') {
    // The site just accepted the credential, so an account still marked as
    // lapsed is stale, not broken. Nothing else would clear that: every other
    // promotion happens inside a sign-in, and there is no sign-in to make here
    // — which is how an account with a perfectly good credential comes to sit
    // in the list reading「过期」forever.
    if (account.status === 'expired') {
      await db.update(schema.accounts)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(eq(schema.accounts.id, account.id))
        .run();
    }
    return 'ok';
  }
  // No verdict is not a verdict. A shield page or an outage must not spend a
  // sign-in: on these sites each one claims the daily quota and counts towards
  // the rate limit that refuses the next.
  if (verdict !== 'refused') return 'skipped';

  // Typed as `unknown` because the value is only ever written from the callback
  // below: narrowing a nullable local across the `await` would leave TypeScript
  // reading it as `null` at this point (the same shape the balance retry uses).
  let refusedReport: unknown = null;
  const relogin = await tryAutoRelogin(account, site, {
    allowBrowserFallback: true,
    onRefusal: (reported) => { refusedReport = reported; },
  }).catch(() => null);

  if (relogin) {
    await setAccountRuntimeHealth(account.id, {
      state: 'healthy',
      reason: '站点判定凭据已失效，已自动重新登录并换成新凭据',
      source: 'auth',
    });
    return 'renewed';
  }

  // The refusal stands, so the account is recorded as it really is. An account
  // that is already `expired` has had this verdict announced once; repeating it
  // every hour would turn the pass into an alert firehose, so only the freshly
  // lapsed one raises the event.
  const refusal = refusedReport as { code: string; reason: string } | null;
  const reason = refusal?.reason
    || '站点判定该凭据已失效，且没有可用的自动续期方式（未绑定可重放的登录方式）';
  await setAccountRuntimeHealth(account.id, {
    state: 'unhealthy',
    reason,
    source: 'auth',
  });
  if (account.status !== 'expired') {
    await reportTokenExpired({
      accountId: account.id,
      username: account.username,
      siteName: site?.name,
      detail: reason,
      renewalNote: '已尝试自动重新登录但未成功',
    });
  }
  return 'refused';
}
