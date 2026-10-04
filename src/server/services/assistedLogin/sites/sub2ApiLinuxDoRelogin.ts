/**
 * Linux.do sign-in for Sub2API deployments, replayed in the managed browser.
 *
 * Sub2API forks sign in through the same forum handshake new-api does, but none
 * of its plumbing matches: `/api/status` does not exist on them, so the client
 * id cannot be read from there, and the handshake is not the
 * `/api/oauth/state` + `/api/oauth/linuxdo` pair the new-api driver speaks. What
 * they do have is a single entry point —
 *
 *   GET /api/v1/auth/oauth/linuxdo/start?redirect=%2Fdashboard
 *
 * — which answers 302 to `connect.linux.do/oauth2/authorize`, and a callback
 * that answers with the token pair in the URL **fragment**
 * (`#access_token=…&refresh_token=…`), which the SPA then writes to
 * `localStorage` as `auth_token` / `refresh_token`. Both halves were read off a
 * live deployment, not assumed.
 *
 * Three things make this a browser job rather than an HTTP one:
 *
 * - `connect.linux.do` is behind Cloudflare and answers plain HTTP clients with
 *   a challenge, so the consent page and its approval POST only happen inside a
 *   real browser.
 * - The `/start` route is behind the site's own WAF (Aliyun on the deployment
 *   this was written against), which answers a bare HTTP GET with a challenge
 *   page instead of the redirect.
 * - The approval step is a POST the page makes for the visitor, so there is no
 *   request to replay.
 *
 * Unlike the new-api driver, this one does not sign the site out first: the
 * start route mints a fresh login flow, and the callback fragment carries a new
 * token pair regardless of whether the profile still holds the previous one.
 * Clearing the site's own storage turned out to be unnecessary work with its own
 * failure mode (it can strand the profile on a signed-out SPA), so the flow is
 * simply replayed as the site's own UI does.
 */
import type { Page } from 'playwright-core';
import { assistedLoginSessions } from '../sessionRegistry.js';
import { passCloudflareChallenge } from '../cloudflareChallenge.js';
import type { CaptureResult } from '../types.js';

/** Path the deployment starts the handshake on. */
const START_PATH = '/api/v1/auth/oauth/linuxdo/start';
/** Landing path the site itself asks for after a successful sign-in. */
const LANDING_PATH = '/dashboard';
/** Where the forum hands the visitor back for the SSO dance. */
const FORUM_HOST = 'linux.do';
const FORUM_SSO_PATH = '/session/sso_provider';
const AUTHORIZE_PATH = '/oauth2/authorize';
const APPROVE_PATH = '/oauth2/approve';

/**
 * Consent pages render their answer as a link labelled 允许 (Chinese) or
 * Authorize / Allow (English), never as a real button.
 */
const AUTHORIZE_BUTTON_TEXT = /允许|授权|Authorize|Allow/i;

/** How long the whole handshake may take. CF challenges make it a slow one. */
const HANDSHAKE_TIMEOUT_MS = 150_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
/** A fresh challenge can appear on the consent page and again on the approve POST. */
const CHALLENGE_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 500;
/** Waiting on the forum's own SSO bounce; it is short but not instant. */
const SSO_SETTLE_MS = 20_000;

export type Sub2ApiTokenSet = {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry in ms, from the response's `expires_in` or the JWT's `exp`. */
  tokenExpiresAt: number | null;
};

export type Sub2ApiLinuxDoReloginRequest = {
  /** Origin of the deployment, e.g. https://api.fengwind.com */
  baseUrl: string;
  /** User id this account must end up signed in as, when one is on file. */
  expectedUserId?: number;
  /** Deployment name used in messages, e.g. api.fengwind.com */
  siteLabel: string;
};

/**
 * Whether this deployment signs in through the Sub2API Linux.do handshake.
 *
 * Only the platform and provider are judged here. The URL is validated again
 * before anything is opened in the managed profile, so a malformed address can
 * never reach the browser.
 */
export function supportsSub2ApiLinuxDoRelogin(
  platform?: string | null,
  provider?: string | null,
): boolean {
  return (platform || '').trim().toLowerCase() === 'sub2api'
    && (provider || '').trim().toLowerCase() === 'linuxdo';
}

/** Decodes a JWT payload without verifying it — enough to read `user_id`/`exp`. */
export function decodeJwtClaims(token: string): { userId?: number; expiresAtMs?: number } {
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const userId = Number(payload?.user_id ?? payload?.userId ?? payload?.sub);
    const exp = Number(payload?.exp);
    return {
      userId: Number.isFinite(userId) && userId > 0 ? userId : undefined,
      expiresAtMs: Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Reads the token pair the callback puts in the URL fragment.
 *
 * The fragment is what the deployment actually uses; the query string is read
 * too because it costs nothing and some builds pass the pair there instead.
 */
export function readSub2ApiTokensFromUrl(rawUrl: string, nowMs = Date.now()): Sub2ApiTokenSet | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  const params = new URLSearchParams(hash);
  for (const [key, value] of url.searchParams) {
    if (!params.has(key)) params.set(key, value);
  }

  const accessToken = (params.get('access_token') || '').trim();
  if (!accessToken) return null;
  const refreshToken = (params.get('refresh_token') || '').trim() || null;
  const expiresIn = Number.parseInt(params.get('expires_in') || '', 10);
  const claims = decodeJwtClaims(accessToken);
  const tokenExpiresAt = claims.expiresAtMs
    ?? (Number.isFinite(expiresIn) && expiresIn > 0 ? nowMs + expiresIn * 1000 : null);

  return { accessToken, refreshToken, tokenExpiresAt };
}

/**
 * Turns a captured token pair into a verdict.
 *
 * A pair that belongs to a different user id than the account on file is
 * reported rather than stored: silently swapping the account for whoever the
 * browser happens to be signed in as is the one outcome that must not happen.
 */
export function judgeSub2ApiLinuxDoCapture(
  tokens: Sub2ApiTokenSet | null,
  options: { expectedUserId?: number } = {},
): CaptureResult {
  if (!tokens) {
    return {
      status: 'timeout',
      credentials: null,
      message: 'Linux.do 授权后站点未返回访问令牌',
    };
  }
  const claims = decodeJwtClaims(tokens.accessToken);
  if (
    options.expectedUserId
    && claims.userId
    && claims.userId !== options.expectedUserId
  ) {
    return {
      status: 'needs_provider_login',
      credentials: null,
      message: `登录到了其他账号（id ${claims.userId}，期望 ${options.expectedUserId}）`,
    };
  }
  return {
    status: 'captured',
    credentials: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.tokenExpiresAt,
      username: null,
      platformUserId: claims.userId ?? null,
      source: 'localStorage',
      harvestedKeys: tokens.refreshToken
        ? ['auth_token', 'refresh_token']
        : ['auth_token'],
    },
    message: 'Linux.do 重新登录完成',
  };
}

/** True for the consent page and its approval endpoint. */
export function isLinuxDoConsentUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.hostname === 'connect.linux.do'
      && (url.pathname.startsWith(AUTHORIZE_PATH) || url.pathname.startsWith(APPROVE_PATH));
  } catch {
    return false;
  }
}

/** True while the browser is on the forum's SSO bounce, which must be let through. */
export function isForumSsoUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname === FORUM_HOST;
  } catch {
    return false;
  }
}

function isSiteOrigin(rawUrl: string, origin: string): boolean {
  try {
    return new URL(rawUrl).origin === origin;
  } catch {
    return false;
  }
}

/** Tokens the SPA has already moved into storage after consuming the fragment. */
async function readStoredTokens(page: Page): Promise<Sub2ApiTokenSet | null> {
  try {
    const stored = await page.evaluate(() => ({
      accessToken: window.localStorage.getItem('auth_token') || '',
      refreshToken: window.localStorage.getItem('refresh_token') || '',
      expiresAt: window.localStorage.getItem('auth_token_expires_at') || '',
    }));
    const accessToken = (stored.accessToken || '').trim();
    if (!accessToken) return null;
    const claims = decodeJwtClaims(accessToken);
    const explicit = Number.parseInt(stored.expiresAt || '', 10);
    return {
      accessToken,
      refreshToken: (stored.refreshToken || '').trim() || null,
      tokenExpiresAt: claims.expiresAtMs
        ?? (Number.isFinite(explicit) && explicit > 0 ? explicit : null),
    };
  } catch {
    return null;
  }
}

/**
 * Drives the handshake to a verdict.
 *
 * The loop exists because the flow is a chain of client-side redirects through
 * a challenge: the challenge can appear on the consent page, and again on the
 * approval POST, and only the URL knows which step is on screen. Every refusal
 * is named where it happens instead of being reported as a timeout.
 */
async function driveHandshake(
  page: Page,
  request: Sub2ApiLinuxDoReloginRequest,
): Promise<CaptureResult> {
  const origin = new URL(request.baseUrl).origin;
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  let clicked = false;
  let sawConsent = false;
  let forumSince = 0;
  let lastUrl = page.url();

  while (Date.now() < deadline) {
    lastUrl = page.url();

    // The callback fragment is the answer, whether or not the SPA has consumed
    // it yet; the storage read is the fallback for a build that redirects twice.
    const fromUrl = readSub2ApiTokensFromUrl(lastUrl);
    if (fromUrl) return judgeSub2ApiLinuxDoCapture(fromUrl, { expectedUserId: request.expectedUserId });
    if (isSiteOrigin(lastUrl, origin)) {
      const stored = await readStoredTokens(page);
      if (stored) return judgeSub2ApiLinuxDoCapture(stored, { expectedUserId: request.expectedUserId });
    }

    if (isForumSsoUrl(lastUrl)) {
      forumSince = forumSince || Date.now();
      if (Date.now() - forumSince > SSO_SETTLE_MS) {
        return {
          status: 'needs_provider_login',
          credentials: null,
          message: 'Linux.do 需要重新登录：论坛会话已失效，请在受管浏览器中登录一次 Linux.do',
          url: lastUrl,
        };
      }
    } else {
      forumSince = 0;
    }

    const title = await page.title().catch(() => '');
    if (/just a moment|attention required|checking your browser|请稍候|正在验证/i.test(title)) {
      await passCloudflareChallenge(page, { timeoutMs: CHALLENGE_TIMEOUT_MS });
      await page.waitForTimeout(POLL_INTERVAL_MS);
      continue;
    }

    if (isLinuxDoConsentUrl(lastUrl)) {
      sawConsent = true;
      if (!clicked) {
        const allow = page
          .locator('a', { hasText: AUTHORIZE_BUTTON_TEXT })
          .or(page.locator('button', { hasText: AUTHORIZE_BUTTON_TEXT }))
          .first();
        if (await allow.count().catch(() => 0)) {
          await allow.click({ timeout: 10_000 }).catch(() => undefined);
          clicked = true;
        }
      }
      await page.waitForTimeout(POLL_INTERVAL_MS);
      continue;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  // A loop that ran out of time on the consent page is a refusal to approve, not
  // a broken site; saying which is what lets the operator act on it.
  if (sawConsent) {
    return {
      status: 'timeout',
      credentials: null,
      message: clicked
        ? 'Linux.do 授权后站点未返回令牌（可稍后重试）'
        : 'Linux.do 授权页未出现「允许」按钮，请人工确认该账号是否可授权本站',
      url: lastUrl,
    };
  }
  return {
    status: 'timeout',
    credentials: null,
    message: 'Linux.do 登录流程未完成（站点或 Cloudflare 长时间未放行）',
    url: lastUrl,
  };
}

/**
 * Runs the handshake once and reports what came back.
 *
 * Deliberately does not retry: `connect.linux.do` is behind Cloudflare, and a
 * burst of attempts escalates the challenge from "one click" to a hard 403. The
 * caller's own cooldown is what keeps the next attempt cheap.
 */
export async function captureSub2ApiLinuxDoCredentialsOnce(
  request: Sub2ApiLinuxDoReloginRequest,
): Promise<CaptureResult> {
  let origin: string;
  try {
    const url = new URL(request.baseUrl);
    if (url.protocol !== 'https:' || !url.hostname) throw new Error('bad url');
    origin = url.origin;
  } catch {
    return { status: 'site_not_found', credentials: null, message: '站点地址无效，无法执行 Linux.do 登录' };
  }

  const session = assistedLoginSessions.get('linuxdo');
  if (!session) {
    return { status: 'browser_unavailable', credentials: null, message: 'Linux.do 辅助登录会话未注册' };
  }

  let page: Page | null = null;
  try {
    const context = await session.browser.ensureManagedBrowserContext();
    page = await context.newPage();
  } catch (error) {
    return {
      status: 'browser_unavailable',
      credentials: null,
      message: `无法启动受管浏览器：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const startUrl = `${origin}${START_PATH}?redirect=${encodeURIComponent(LANDING_PATH)}`;
  try {
    await page
      .goto(startUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
      .catch(() => undefined);
    return await driveHandshake(page, request);
  } catch (error) {
    return {
      status: 'timeout',
      credentials: null,
      message: `Linux.do 重新登录失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

export async function captureSub2ApiLinuxDoCredentials(
  request: Sub2ApiLinuxDoReloginRequest,
): Promise<CaptureResult> {
  return captureSub2ApiLinuxDoCredentialsOnce(request);
}
