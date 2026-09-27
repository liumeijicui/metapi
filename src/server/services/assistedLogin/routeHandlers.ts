import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { parseAssistedLoginCapturePayload } from '../../contracts/supportRoutePayloads.js';
import { getAdapter } from '../platforms/index.js';
import { createManualAccount } from '../manualAccountCreationService.js';
import { mergeAccountExtraConfig } from '../accountExtraConfig.js';
import { applyRotatedCredential } from '../accountCredentialRotation.js';
import {
  getAccountCredentialContext,
  withAccountCredentialContext,
} from '../siteProxy.js';
import { assistedLoginSessions } from './sessionRegistry.js';
import { getAssistedLoginWatcher } from './watchers.js';

export function createAssistedLoginStatusLimiter() {
  return createRateLimitGuard({ bucket: 'assisted-login-status', max: 40, windowMs: 60_000 });
}

export function createAssistedLoginCaptureLimiter() {
  return createRateLimitGuard({ bucket: 'assisted-login-capture', max: 12, windowMs: 60_000 });
}

const UNKNOWN_PROVIDER_MESSAGE = '未知的快捷登录提供方';

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
          watch: { lastStatus: 'unknown', lastUsername: null, lastCheckedAt: null },
        };
      }

      const browserState = session.browser.getManagedBrowserState();
      let loginState;
      try {
        loginState = await session.getLoginState();
      } catch (error) {
        loginState = {
          loggedIn: false,
          username: null,
          userId: null,
          blocked: false,
          message: (error as Error)?.message || `无法读取 ${session.provider.label} 登录状态`,
        };
      }

      // Any page view that confirms a live login refreshes the watcher baseline,
      // so an expiry is only ever reported for a session we saw working.
      if (loginState.loggedIn && !loginState.blocked) {
        void watcher?.seedBaseline().catch(() => undefined);
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
        watch: watcher
          ? await watcher.readState()
          : { lastStatus: 'unknown', lastUsername: null, lastCheckedAt: null },
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

      await syncRotatedCookieToBrowser(session, site, rotated);

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
