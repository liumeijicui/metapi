/**
 * Renews the 薄荷公益站 wheel session (`up.x666.me`).
 *
 * The wheel is a separate deployment from the relay (`x666.me`) and runs its own
 * Linux.do OAuth application, so the relay's `new_api_refresh` cookie is useless
 * there: the only credential is the `auth_token` JWT its callback hands out, and
 * that expires after 30 days. Re-running the handshake is the only way to get a
 * new one, and it has to happen in the managed browser because `connect.linux.do`
 * sits behind Cloudflare and refuses plain HTTP clients.
 *
 * This is deliberately not the relay driver (`linuxDoOAuthRelogin.ts`): the wheel
 * has no session list and no bind-vs-login rule, and it starts the handshake from
 * its own `/api/auth/login`, which mints and stores the OAuth state server-side.
 * Signing the wheel out first would only throw away a session that still works.
 */
import type { BrowserContext, Page } from 'playwright-core';
import { assistedLoginSessions } from '../sessionRegistry.js';
import { passCloudflareChallenge } from '../cloudflareChallenge.js';

const DEFAULT_WHEEL_ORIGIN = 'https://up.x666.me';
const AUTH_LOGIN_PATH = '/api/auth/login';
const AUTH_COOKIE_NAME = 'auth_token';
const NAVIGATION_TIMEOUT_MS = 60_000;
const CALLBACK_POLL_INTERVAL_MS = 500;
const CALLBACK_POLL_BUDGET_MS = 30_000;
/** The consent page renders its answer buttons as links, never real <button>s. */
const AUTHORIZE_BUTTON_TEXT = /允许|授权|Authorize|Allow/i;
const AUTHORIZE_BUTTON_SELECTOR = 'button, a, input[type="submit"], input[type="button"]';

export type MintWheelReloginResult = {
  ok: boolean;
  message: string;
  /** The freshly minted `auth_token`, present only on success. */
  authToken?: string;
};

export type MintWheelReloginRequest = {
  /** Wheel origin; overridable so a clone of the site can reuse the driver. */
  baseUrl?: string;
  /**
   * The credential the caller currently holds. The callback sets the cookie
   * again with the same name, so waiting for the value to *change* is what
   * distinguishes a fresh grant from the stale one still sitting in the jar.
   */
  previousToken?: string;
};

export async function reloginMintWheel(
  request: MintWheelReloginRequest = {},
): Promise<MintWheelReloginResult> {
  const session = assistedLoginSessions.get('linuxdo');
  if (!session) return { ok: false, message: 'Linux.do 辅助登录会话未注册' };

  const origin = resolveOrigin(request.baseUrl);
  if (!origin) return { ok: false, message: '签到站地址无效' };

  let context: BrowserContext;
  try {
    context = await session.browser.ensureManagedBrowserContext();
  } catch (error) {
    return { ok: false, message: `无法启动受管浏览器：${describeError(error)}` };
  }

  const page = await context.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await passCloudflareChallenge(page).catch(() => undefined);

    const authUrl = await readAuthUrlInPage(page);
    if (!authUrl) return { ok: false, message: '签到站未返回 Linux.do 授权地址' };

    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await passCloudflareChallenge(page).catch(() => undefined);
    await clickAuthorizeButton(page);

    const token = await waitForFreshToken(context, origin, request.previousToken);
    if (!token) return { ok: false, message: '授权后签到站未下发新的会话' };
    return { ok: true, message: '已重新获取签到站会话', authToken: token };
  } catch (error) {
    return { ok: false, message: `签到站重新授权失败：${describeError(error)}` };
  } finally {
    await page.close().catch(() => undefined);
  }
}

function resolveOrigin(rawBaseUrl?: string): string | null {
  try {
    return new URL((rawBaseUrl || DEFAULT_WHEEL_ORIGIN).trim()).origin;
  } catch {
    return null;
  }
}

/** Reads `/api/auth/login` from inside the page, which is where the state cookie lives. */
async function readAuthUrlInPage(page: Page): Promise<string | null> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await page
      .evaluate(async (path) => {
        try {
          const response = await fetch(path, { credentials: 'include' });
          const payload = await response.json();
          return typeof payload?.auth_url === 'string' ? payload.auth_url : null;
        } catch {
          return null;
        }
      }, AUTH_LOGIN_PATH)
      .catch(() => null);
    if (value) return value;
    await page.waitForTimeout(1_000);
  }
  return null;
}

async function clickAuthorizeButton(page: Page): Promise<void> {
  const button = page
    .locator(AUTHORIZE_BUTTON_SELECTOR)
    .filter({ hasText: AUTHORIZE_BUTTON_TEXT })
    .first();
  const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 15_000 });
      return;
    }
    await page.waitForTimeout(1_000);
  }
  throw new Error('未找到 Linux.do 的授权按钮');
}

async function waitForFreshToken(
  context: BrowserContext,
  origin: string,
  previousToken?: string,
): Promise<string | null> {
  const deadline = Date.now() + CALLBACK_POLL_BUDGET_MS;
  const previous = (previousToken || '').trim();
  while (Date.now() < deadline) {
    const cookie = (await context.cookies(origin)).find((item) => item.name === AUTH_COOKIE_NAME);
    const value = (cookie?.value || '').trim();
    if (value && value !== previous) return value;
    await new Promise((resolve) => setTimeout(resolve, CALLBACK_POLL_INTERVAL_MS));
  }
  return null;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 160) || '未知错误';
}
