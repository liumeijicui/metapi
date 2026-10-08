import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { parseAssistedLoginCapturePayload } from '../../contracts/supportRoutePayloads.js';
import { getAdapter } from '../platforms/index.js';
import { createManualAccount } from '../manualAccountCreationService.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import { applyRotatedCredential } from '../accountCredentialRotation.js';
import { pruneOtherSessions } from '../sessionHygiene.js';
import { shouldPruneOtherSessions } from '../accountExtraConfig.js';
import {
  getAccountCredentialContext,
  withAccountCredentialContext,
} from '../siteProxy.js';
import { assistedLoginSessions } from './sessionRegistry.js';
import { getAssistedLoginWatcher } from './watchers.js';
import {
  applyTransientFallback,
  clearImportedSession,
  parsePastedProviderSession,
  probeImportedSession,
  readImportedSession,
  recordImportedSessionVerification,
  saveImportedSession,
  type ImportedProviderSession,
} from './importedSession.js';
import type { AssistedLoginProvider, LoginState } from './types.js';

export function createAssistedLoginStatusLimiter() {
  return createRateLimitGuard({ bucket: 'assisted-login-status', max: 40, windowMs: 60_000 });
}

export function createAssistedLoginCaptureLimiter() {
  return createRateLimitGuard({ bucket: 'assisted-login-capture', max: 12, windowMs: 60_000 });
}

const UNKNOWN_PROVIDER_MESSAGE = '未知的快捷登录提供方';

/**
 * Page-driven probes (status view, session read) reuse a recent result for a
 * short window so navigating in and out of the page cannot hammer the provider
 * into a rate limit. Imports and the background watcher always probe fresh.
 * A transient failure falls back to the last verified identity and is reported
 * as an annotation on an available session, never as a logout.
 */
const IMPORTED_PROBE_CACHE_MS = 60_000;
const importedProbeCache = new Map<string, { at: number; state: LoginState }>();

async function probeImportedSessionCached(
  provider: AssistedLoginProvider,
  imported: ImportedProviderSession,
): Promise<LoginState> {
  const cached = importedProbeCache.get(provider.id);
  if (cached && Date.now() - cached.at < IMPORTED_PROBE_CACHE_MS) return cached.state;

  const state = await probeImportedSession(provider, imported.cookieHeader);
  if (state.blocked) {
    const resolved = applyTransientFallback(state, imported);
    importedProbeCache.set(provider.id, { at: Date.now(), state: resolved });
    return resolved;
  }
  if (state.loggedIn) {
    // Best effort: remember who the session belongs to so later transient
    // failures can keep reporting a named, available session.
    void recordImportedSessionVerification(provider.id, {
      username: state.username,
      userId: state.userId,
    }).catch(() => undefined);
  }
  importedProbeCache.set(provider.id, { at: Date.now(), state });
  return state;
}

/**
 * Confirms a captured credential against the site's own API. A value picked up
 * from the browser can be stale (an aborted OAuth handshake) or belong to the
 * provider rather than the site, so it is only accepted once the platform
 * adapter recognises it as a live session.
 */
async function verifyCapturedCredential(
  site: { url: string; platform: string },
  credentials: { accessToken: string; username?: string | null; platformUserId?: number | null },
  provider: { isHandoffHost: (host: string) => boolean; messages: { needsLogin: string } },
): Promise<{ ok: boolean; message: string; username: string | null }> {
  let host = '';
  try {
    host = new URL(site.url).host;
  } catch {
    // ignore
  }
  if (host && provider.isHandoffHost(host)) {
    return { ok: false, message: provider.messages.needsLogin, username: null };
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) {
    return { ok: false, message: `平台 ${site.platform} 不支持托管登录校验，可改用 API Key 方式`, username: null };
  }

  try {
    const verified = await adapter.verifyToken(
      site.url,
      credentials.accessToken,
      credentials.platformUserId ?? undefined,
    );
    if (verified.tokenType !== 'unknown') {
      return { ok: true, message: '凭证已校验', username: verified.userInfo?.username || credentials.username || null };
    }
  } catch {
    // fall through to the generic failure below
  }

  return { ok: false, message: '站点未确认登录状态（授权可能未完成），请在浏览器窗口完成授权后重试', username: null };
}

/**
 * Copies a freshly rotated secret back into the managed browser's cookie jar.
 *
 * The rotation happens on the server, but the browser still holds the previous
 * value. Without this the site would appear signed out on the next capture even
 * though the account row is perfectly healthy.
 */
async function syncRotatedCookieToBrowser(
  session: { updateSiteCredentialCookie: (input: { siteUrl: string; name: string; value: string }) => Promise<boolean> } | undefined,
  site: { url: string },
  rotated: { cookieName: string; value: string } | undefined,
): Promise<void> {
  if (!session || !rotated?.value) return;
  try {
    await session.updateSiteCredentialCookie({
      siteUrl: site.url,
      name: rotated.cookieName,
      value: rotated.value,
    });
  } catch {
    // Best effort: a failed jar update must not fail an otherwise valid bind.
  }
}

/** Maps a failed probe into the shared "blocked" shape instead of throwing. */
function blockedLoginStateFrom(error: unknown, label: string): LoginState {
  return {
    loggedIn: false,
    username: null,
    userId: null,
    blocked: true,
    message: (error as Error)?.message || `无法读取 ${label} 登录状态`,
  };
}

/**
 * Builds the provider-scoped route handlers. Shared by the generic
 * `/api/assisted-login/:provider/*` routes and the per-provider aliases.
 */
export function buildAssistedLoginHandlers(rawProviderId: string) {
  const providerId = (rawProviderId || '').trim().toLowerCase();
  const session = assistedLoginSessions.get(providerId);
  const watcher = getAssistedLoginWatcher(providerId);

  return {
    session,

    async status() {
      if (!session) {
        return {
          browser: { available: false, running: false, connected: false },
          session: { loggedIn: false, username: null, userId: null, blocked: false, message: UNKNOWN_PROVIDER_MESSAGE },
          watch: { lastStatus: 'unknown', lastUsername: null, lastCheckedAt: null, lastKeepAliveAt: null },
        };
      }

      const browserState = session.browser.getManagedBrowserState();
      const imported = await readImportedSession(session.provider.id);
      let loginState: LoginState;
      if (imported) {
        // An imported session replaces the managed browser entirely, so a
        // browser-less server reports the real state instead of "browser missing".
        try {
          loginState = await probeImportedSessionCached(session.provider, imported);
        } catch (error) {
          loginState = blockedLoginStateFrom(error, session.provider.label);
        }
      } else if (browserState.connected) {
        // A status view never launches a browser: on a browser-less server that is
        // exactly the resource spike the imported-session path exists to avoid.
        // Only a browser that is already attached is asked directly.
        try {
          loginState = await session.getLoginState();
        } catch (error) {
          loginState = blockedLoginStateFrom(error, session.provider.label);
        }
      } else {
        // Without an import and without a browser to ask, the honest answer is
        // guidance, not a signed-out session.
        loginState = {
          loggedIn: false,
          username: null,
          userId: null,
          blocked: false,
          message: '尚未导入会话：粘贴一次 Cookie 保存后即可长期查看状态（服务器不会为此启动浏览器）',
        };
      }

      // Any page view that confirms a live login refreshes the watcher baseline,
      // so an expiry is only ever reported for a session we saw working.
      if (loginState.loggedIn && !loginState.blocked) {
        void watcher?.seedBaseline(loginState).catch(() => undefined);
      }

      return {
        provider: { id: session.provider.id, label: session.provider.label },
        browser: {
          available: !!browserState.executablePath,
          running: browserState.running,
          connected: browserState.connected,
          executableLabel: browserState.executableLabel,
          profileDir: browserState.profileDir,
        },
        session: loginState,
        importedSession: imported
          ? {
            cookieNames: imported.cookieNames,
            savedAt: imported.savedAt,
            hasCsrfToken: !!imported.csrfToken,
            cookieHeader: imported.cookieHeader,
          }
          : null,
        watch: watcher
          ? await watcher.readState()
          : { lastStatus: 'unknown', lastUsername: null, lastCheckedAt: null, lastKeepAliveAt: null },
      };
    },

    async openLoginWindow() {
      if (!session) throw new Error(UNKNOWN_PROVIDER_MESSAGE);
      return session.openLoginWindow();
    },

    async checkSession() {
      await watcher?.runPass();
      return { success: true, checkedAt: new Date().toISOString() };
    },

    /**
     * Reads back the imported provider session and probes it over plain HTTP.
     * This is the browser-free replacement for "open the login window": the
     * operator pastes a cookie once and the server reuses it from then on.
     */
    async readImportedSessionState() {
      if (!session) {
        return { success: false, message: UNKNOWN_PROVIDER_MESSAGE, importedSession: null, loginState: null };
      }
      const imported = await readImportedSession(session.provider.id);
      if (!imported) {
        return { success: true, importedSession: null, loginState: null };
      }
      let loginState: LoginState;
      try {
        loginState = await probeImportedSessionCached(session.provider, imported);
      } catch (error) {
        loginState = {
          loggedIn: false,
          username: null,
          userId: null,
          blocked: true,
          message: (error as Error)?.message || `无法读取 ${session.provider.label} 登录状态`,
        };
      }
      return {
        success: true,
        importedSession: {
          cookieNames: imported.cookieNames,
          savedAt: imported.savedAt,
          hasCsrfToken: !!imported.csrfToken,
          cookieHeader: imported.cookieHeader,
        },
        loginState,
      };
    },

    async saveImportedSessionState(body: unknown, reply: any) {
      if (!session) return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });

      const payload = (body ?? {}) as Record<string, unknown>;
      const parsed = parsePastedProviderSession(
        session.provider.id,
        typeof payload.raw === 'string' ? payload.raw : '',
      );
      if (!parsed) {
        return reply.code(400).send({
          success: false,
          message: `没能在粘贴内容里找到 ${session.provider.label} 的会话 Cookie，请确认复制的是已登录请求的 Cookie 头`,
        });
      }

      // Verification runs before the write: a paste the provider explicitly
      // rejects must never replace a session that still works. A transient
      // failure (rate limit, edge block, network error) says nothing about the
      // cookie, so the import is kept and annotated instead of being dropped.
      const previous = await readImportedSession(session.provider.id);
      let loginState: LoginState;
      try {
        loginState = await probeImportedSession(session.provider, parsed.cookieHeader);
      } catch (error) {
        loginState = blockedLoginStateFrom(error, session.provider.label);
      }
      if (!loginState.loggedIn && !loginState.blocked) {
        return reply.code(400).send({
          success: false,
          message: `检测未通过${loginState.message ? `：${loginState.message}` : ''}，未保存（原有会话保持不变）`,
          loginState,
        });
      }

      const verified = loginState.loggedIn;
      const saved = await saveImportedSession(
        session.provider.id,
        parsed,
        verified
          ? { username: loginState.username, userId: loginState.userId }
          // An unverified paste keeps the last identity the provider confirmed,
          // so a rate-limited probe cannot blank out a known-good account name.
          : { username: previous?.verifiedUsername ?? null, userId: previous?.verifiedUserId ?? null },
      );
      const resolvedState: LoginState = verified
        ? loginState
        : {
          ...applyTransientFallback(loginState, saved),
          message: `已保存，本次检测异常：${loginState.message || '未知错误'}；稍后刷新状态会自动复检`,
        };
      importedProbeCache.set(session.provider.id, { at: Date.now(), state: resolvedState });

      // A verified import becomes the watcher baseline, so an expiry is only ever
      // reported for a session we actually saw working.
      if (verified) {
        void watcher?.seedBaseline(loginState).catch(() => undefined);
      }

      return {
        success: true,
        verified,
        importedSession: {
          cookieNames: saved.cookieNames,
          savedAt: saved.savedAt,
          hasCsrfToken: !!saved.csrfToken,
        },
        loginState: resolvedState,
      };
    },

    async clearImportedSessionState() {
      if (!session) return { success: false, message: UNKNOWN_PROVIDER_MESSAGE };
      await clearImportedSession(session.provider.id);
      importedProbeCache.delete(session.provider.id);
      return { success: true, importedSession: null };
    },

    async capture(body: unknown, reply: any) {
      const parsed = parseAssistedLoginCapturePayload(body);
      if (!parsed.success) {
        return reply.code(400).send({ success: false, message: parsed.error });
      }

      const siteId = parsed.data.siteId;
      if (!siteId) {
        return reply.code(400).send({ success: false, message: '请指定站点' });
      }
      if (!session) {
        return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      }

      // One rolling credential is exchanged several times below (verify, then
      // account creation, then the background token sync). Every exchange retires
      // the previous secret, so the whole flow shares a single tracking scope and
      // the final write stores the value that is still alive.
      return withAccountCredentialContext({ siteId }, async () => {
        // A cookie found in the browser is not proof of a usable login: a rolling
        // credential is retired the moment it is exchanged, so the jar routinely
        // holds a value the site has already invalidated. Try it, and on rejection
        // force a fresh OAuth handshake rather than reporting the site as signed
        // out - the user never actually signed out.
        const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
        if (!site) {
          return reply.code(404).send({ success: false, message: '站点不存在' });
        }

        let result = await session.captureSiteCredentials({ siteId });
        let verification = await verifyCapturedCredential(site, result.credentials ?? { accessToken: '' }, session.provider);
        if (!verification.ok && result.credentials) {
          const retry = await session.captureSiteCredentials({ siteId, forceLogin: true });
          const retryUsable = retry.status === 'captured' || retry.status === 'already_authorized';
          if (retryUsable && retry.credentials) {
            const retryVerification = await verifyCapturedCredential(site, retry.credentials, session.provider);
            if (retryVerification.ok) {
              result = retry;
              verification = retryVerification;
            }
          }
        }

        const usable = result.status === 'captured' || result.status === 'already_authorized';
        if (!usable || !result.credentials) {
          return {
            success: false,
            status: result.status,
            message: result.message || '未能获取站点凭证',
            url: result.url || null,
            credentials: null,
          };
        }
        if (!verification.ok) {
          return {
            success: false,
            status: 'needs_provider_login',
            message: verification.message,
            url: result.url || null,
            credentials: null,
          };
        }
        if (!result.credentials.username && verification.username) {
          result.credentials.username = verification.username;
        }

        if (parsed.data.bindAccount !== true) {
          return {
            success: true,
            status: result.status,
            credentials: {
              username: result.credentials.username,
              source: result.credentials.source,
              hasRefreshToken: !!result.credentials.refreshToken,
              tokenExpiresAt: result.credentials.tokenExpiresAt,
            },
            message: '凭证已捕获（未绑定账号）',
          };
        }

        const adapter = getAdapter(site.platform);
        if (!adapter) {
          return reply.code(400).send({
            success: false,
            message: `平台 ${site.platform} 不支持托管登录，可改用 API Key 方式`,
          });
        }

        const username = (parsed.data.username || '').trim() || result.credentials.username || undefined;
        const platformUserId = result.credentials.platformUserId ?? undefined;
        const credentialMode = parsed.data.credentialMode || 'auto';

        // Stamping the provider lets the account page re-run this exact handoff
        // later, once the captured credential eventually expires.
        const oauthPatch = {
          oauth: { provider: session.provider.id, capturedAt: new Date().toISOString() },
        };

        let created;
        try {
          created = await createManualAccount({
            body: {
              siteId,
              username,
              platformUserId,
              accessToken: result.credentials.accessToken,
              refreshToken: result.credentials.refreshToken || undefined,
              tokenExpiresAt: result.credentials.tokenExpiresAt || undefined,
              skipModelFetch: parsed.data.skipModelFetch,
              credentialMode,
            },
            site,
            adapter,
            credentialMode,
            rawAccessToken: result.credentials.accessToken,
            usernameOverride: username,
          });
        } catch (error) {
          return reply.code(400).send({
            success: false,
            message: (error as Error)?.message || '绑定账号失败',
          });
        }

        await db
          .update(schema.accounts)
          .set({ extraConfig: mergeAccountExtraConfig(created.account.extraConfig, oauthPatch) })
          .where(eq(schema.accounts.id, created.account.id))
          .run();

        // The exchanges above retired the secret the browser is still holding, so
        // the jar has to learn the replacement. Otherwise every later capture reads
        // a dead cookie and the site looks logged out until the user signs in again.
        await syncRotatedCookieToBrowser(session, site, getAccountCredentialContext()?.rotated);

        return {
          success: true,
          status: 'bound',
          accountId: created.account.id,
          username: created.account.username || username || null,
          tokenType: created.tokenType,
          modelCount: created.modelCount,
          refreshTokenSaved: !!result.credentials.refreshToken,
          message: created.message || '账号已绑定',
        };
      });
    },

    /**
     * Re-runs the assisted-login handoff for an account whose credential has
     * expired, reusing the persisted provider session. This is what backs the
     * "重新获取凭证" action on the account page, so a user never has to paste a
     * token by hand when the site rotates it.
     */
    async refreshAccount(body: unknown, reply: any) {
      const payload = (body ?? {}) as Record<string, unknown>;
      const accountId = Number.parseInt(String(payload.accountId ?? ''), 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ success: false, message: '缺少 accountId' });
      }

      const row = await db
        .select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!row) {
        return reply.code(404).send({ success: false, message: '账号不存在' });
      }

      const { accounts: account, sites: site } = row;
      if (!session) {
        return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      }

      const capture = await session.captureSiteCredentials({ siteId: site.id });
      const usable = capture.status === 'captured' || capture.status === 'already_authorized';
      if (!usable || !capture.credentials) {
        return {
          success: false,
          status: capture.status,
          message: capture.message || '重新获取凭证失败',
          url: capture.url || null,
        };
      }

      const capturedCredentials = capture.credentials;
      // Verification exchanges the rolling credential, and the replacement only
      // comes back in Set-Cookie. Read the rotation *inside* the context: the
      // store is gone once `run` resolves, so a later `getAccountCredentialContext()`
      // returns undefined and the value persisted below would be the retired one.
      const verificationOutcome = await withAccountCredentialContext(
        { accountId, siteId: site.id },
        async () => ({
          verification: await verifyCapturedCredential(site, capturedCredentials, session.provider),
          rotated: getAccountCredentialContext()?.rotated,
        }),
      );
      const verification = verificationOutcome.verification;
      const rotated = verificationOutcome.rotated;
      if (!verification.ok) {
        return {
          success: false,
          status: 'needs_provider_login',
          message: verification.message,
          url: capture.url || null,
        };
      }

      const nextExtraConfig = mergeAccountExtraConfig(account.extraConfig, {
        credentialMode: 'session',
        oauth: { provider: session.provider.id, capturedAt: new Date().toISOString() },
      });

      await db
        .update(schema.accounts)
        .set({
          // The verification above already rolled the secret, so the raw captured
          // value would be retired the moment it is written.
          accessToken: applyRotatedCredential(capturedCredentials.accessToken, rotated),
          status: 'active',
          extraConfig: nextExtraConfig,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.accounts.id, accountId))
        .run();

      // The capture signed the account in, which minted another server-side
      // session. Retire the ones it superseded here, before the browser jar is
      // synced: the prune may rotate the cookie again, and pushing a value the
      // cleanup already retired into the jar would leave the browser holding a
      // spent secret. The account row is the source of truth for what to sync.
      let rotatedForBrowser = rotated;
      try {
        const pruneAdapter = getAdapter(site.platform);
        const prune = pruneAdapter ? await withAccountCredentialContext(
          { accountId, siteId: site.id },
          () => pruneOtherSessions({
            adapter: pruneAdapter,
            siteUrl: site.url,
            accessToken: applyRotatedCredential(capturedCredentials.accessToken, rotated),
            platformUserId: (account as any).platformUserId ?? undefined,
            enabled: shouldPruneOtherSessions(account.extraConfig),
          }),
        ) : null;
        if (prune && (prune.status === 'pruned' || prune.status === 'skipped')) {
          // Merge onto the config written just above rather than the snapshot
          // read at the start of the handler. That snapshot predates the OAuth
          // binding this refresh just established, so merging from it silently
          // dropped the marker the next renewal needs: the account kept a live
          // session but no provider to renew it with, and the following expiry
          // could only be repaired by hand.
          await db.update(schema.accounts)
            .set({
              extraConfig: mergeAccountExtraConfig(nextExtraConfig, {
                sessionHygiene: {
                  outcome: prune.status === 'skipped' ? prune.reason : prune.status,
                  ...(prune.status === 'pruned' ? { removed: prune.removed, kept: prune.kept } : {}),
                  updatedAt: new Date().toISOString(),
                },
              }),
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.accounts.id, accountId))
            .run();
        }
        const refreshed = await db
          .select({ accessToken: schema.accounts.accessToken })
          .from(schema.accounts)
          .where(eq(schema.accounts.id, accountId))
          .get();
        const latest = String(refreshed?.accessToken || '').match(/(?:^|;\s*)new_api_refresh=([^;]+)/i);
        if (latest?.[1]) rotatedForBrowser = { cookieName: 'new_api_refresh', value: latest[1].trim() };
      } catch {
        // Cleanup is best-effort; the rebound credential above is already stored.
      }

      await syncRotatedCookieToBrowser(session, site, rotatedForBrowser);

      return {
        success: true,
        status: 'refreshed',
        accountId,
        username: verification.username || account.username || null,
        message: '凭证已重新获取，账号恢复可用',
        url: capture.url || null,
      };
    },

    async bind(body: unknown, reply: any) {
      const payload = (body ?? {}) as Record<string, unknown>;
      const accountId = Number.parseInt(String(payload.accountId ?? ''), 10);
      const siteId = Number.parseInt(String(payload.siteId ?? ''), 10);
      const accessToken = typeof payload.accessToken === 'string' ? payload.accessToken.trim() : '';
      const refreshToken = typeof payload.refreshToken === 'string' ? payload.refreshToken.trim() : '';

      if (!Number.isFinite(accountId) || accountId <= 0 || !accessToken) {
        return reply.code(400).send({ success: false, message: '缺少 accountId 或 accessToken' });
      }

      const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
      if (!account) {
        return reply.code(404).send({ success: false, message: '账号不存在' });
      }

      const patch: Record<string, unknown> = { credentialMode: 'session' };
      if (refreshToken && Number.isFinite(siteId)) {
        const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
        if (site && (site.platform || '').toLowerCase() === 'sub2api') {
          patch.sub2apiAuth = { refreshToken };
        }
      }

      await db
        .update(schema.accounts)
        .set({
          accessToken,
          status: 'active',
          extraConfig: mergeAccountExtraConfig(account.extraConfig, patch),
          updatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        })
        .where(eq(schema.accounts.id, accountId))
        .run();

      return { success: true, accountId, message: '凭证已更新' };
    },
  };
}

export type AssistedLoginHandlers = ReturnType<typeof buildAssistedLoginHandlers>;
