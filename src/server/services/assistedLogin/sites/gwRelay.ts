import type { Page, Response as BrowserResponse } from 'playwright-core';
import { assistedLoginSessions } from '../sessionRegistry.js';
import { clickWithRealPointer, locateChallengeWidget } from '../cloudflareChallenge.js';

/**
 * Signs an 辉哥中转 account back in through a real browser.
 *
 * The panel gates `user_login` behind Cloudflare Turnstile, so no HTTP client can
 * ever complete it — a plain POST without a token is answered with
 * `请先完成人机验证 [400 captcha_required]`. The managed browser answers the widget
 * instead: the checkbox is clicked through an X11 pointer event, because the
 * widget ignores synthetic input (see `cloudflareChallenge.ts`), and the panel's
 * own login button only enables itself once Turnstile has handed the page a token.
 *
 * What comes back is the `ut-…` user token the panel stores in `localStorage`
 * under `gw_user_token` — the credential every management action wants. The site
 * also redirects `/auth` straight to the console whenever that key is present, so
 * the run clears it first; otherwise the login form is never rendered.
 */

const AUTH_PATH = '/auth';
const ACCOUNT_INPUT = '#login-account';
const PASSWORD_INPUT = '#login-password';
const LOGIN_BUTTON = '#login-btn';
const USER_TOKEN_STORAGE_KEY = 'gw_user_token';
const LOGIN_ACTION = 'user_login';

const NAVIGATION_TIMEOUT_MS = 60_000;
const CONSENT_TIMEOUT_MS = 60_000;
const TURNSTILE_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 500;
/** A widget that has already been answered is left alone; a stuck one is retried. */
const MAX_WIDGET_CLICKS = 4;

export type GwRelayLoginResult = {
  ok: boolean;
  message: string;
  /** The `ut-…` user token, present only on success. */
  accessToken?: string;
};

export type GwRelayLoginRequest = {
  /** Origin of the deployment, e.g. https://lzhiyu.ccwu.cc */
  baseUrl: string;
  username: string;
  password: string;
};

export async function loginGwRelayInBrowser(
  request: GwRelayLoginRequest,
): Promise<GwRelayLoginResult> {
  const origin = readHttpsOrigin(request.baseUrl);
  if (!origin) return { ok: false, message: '仅允许通过 https 站点执行浏览器登录' };
  const username = (request.username || '').trim();
  if (!username || !request.password) {
    return { ok: false, message: '账号缺少用户名或密码，无法浏览器登录' };
  }

  const session = assistedLoginSessions.get('linuxdo');
  if (!session) return { ok: false, message: '辅助登录浏览器未注册' };

  let context;
  try {
    context = await session.browser.ensureManagedBrowserContext();
  } catch (error) {
    return { ok: false, message: `无法启动受管浏览器：${describeError(error)}` };
  }

  const page = await context.newPage();
  const captured: { token: string | null; message: string | null } = { token: null, message: null };
  const captureLogin = (response: BrowserResponse): void => {
    if (!isLoginResponse(response.url())) return;
    void response
      .text()
      .then((body) => {
        let payload: any = null;
        try {
          payload = JSON.parse(body);
        } catch {}
        const token = typeof payload?.data?.token === 'string' ? payload.data.token.trim() : '';
        if (token) captured.token = token;
        else captured.message = readLoginRefusal(payload);
      })
      .catch(() => undefined);
  };
  page.on('response', captureLogin);

  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    // The console redirects to /auth on its own when the token is missing; going
    // straight there is one navigation instead of two.
    await clearStoredSession(page);
    await page.goto(new URL(AUTH_PATH, origin).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    await page.waitForSelector(ACCOUNT_INPUT, { state: 'visible', timeout: CONSENT_TIMEOUT_MS });
    await page.fill(ACCOUNT_INPUT, username);
    await page.fill(PASSWORD_INPUT, request.password);

    if (!(await solveTurnstile(page))) {
      return { ok: false, message: '人机验证未通过（Turnstile 页面未就绪）' };
    }

    await page.click(LOGIN_BUTTON, { timeout: 15_000 });
    const token = await waitForLogin(page, captured, request.password);
    if (!token) {
      return { ok: false, message: captured.message || '站点未返回登录令牌' };
    }
    return { ok: true, message: '浏览器登录成功', accessToken: token };
  } catch (error) {
    return { ok: false, message: `浏览器登录失败：${describeError(error)}` };
  } finally {
    page.off('response', captureLogin);
    await page.close().catch(() => undefined);
  }
}

/**
 * Answers the Turnstile widget and waits for the panel to accept it.
 *
 * The panel enables its login button only from the widget's own callback, which
 * makes that button the honest success signal: it settles without the page
 * emitting anything an outside observer could watch. A click that lands on an
 * already-solved widget is harmless, so a stuck one is simply clicked again.
 */
async function solveTurnstile(page: Page): Promise<boolean> {
  const deadline = Date.now() + TURNSTILE_TIMEOUT_MS;
  let clicks = 0;

  while (Date.now() < deadline) {
    if (await isLoginButtonEnabled(page)) return true;
    if (clicks < MAX_WIDGET_CLICKS) {
      const box = await locateChallengeWidget(page);
      if (box) {
        await clickWithRealPointer(page, box).catch(() => undefined);
        clicks += 1;
      }
    }
    await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => undefined);
  }
  return isLoginButtonEnabled(page);
}

async function isLoginButtonEnabled(page: Page): Promise<boolean> {
  return page
    .locator(LOGIN_BUTTON)
    .evaluate((el) => (el as HTMLButtonElement).disabled !== true)
    .catch(() => false);
}

/**
 * Waits for the token the panel hands the page on a successful login.
 *
 * The callback response is the authoritative source, so it is preferred; the
 * `localStorage` copy is the fallback for a login answered from a different
 * origin shape. A refusal is left to the caller to report, which means the poll
 * has to run to its deadline rather than guess from the landing URL.
 */
async function waitForLogin(
  page: Page,
  captured: { token: string | null; message: string | null },
  password: string,
): Promise<string | null> {
  const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (captured.token) return captured.token;
    if (captured.message) return null;
    const stored = await readStoredToken(page);
    if (stored && !stored.includes(password)) return stored;
    await page.waitForTimeout(POLL_INTERVAL_MS).catch(() => undefined);
  }
  return captured.token;
}

async function clearStoredSession(page: Page): Promise<void> {
  await page
    .evaluate((key) => {
      try {
        localStorage.removeItem(key);
        localStorage.removeItem('gw_user_name');
        localStorage.removeItem('gw_user_uid');
      } catch {}
    }, USER_TOKEN_STORAGE_KEY)
    .catch(() => undefined);
}

async function readStoredToken(page: Page): Promise<string | null> {
  const token = await page
    .evaluate((key) => {
      try {
        return localStorage.getItem(key) || '';
      } catch {
        return '';
      }
    }, USER_TOKEN_STORAGE_KEY)
    .catch(() => '');
  return token ? token : null;
}

function isLoginResponse(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.pathname.endsWith('/api/keys.php')
      && parsed.searchParams.get('action') === LOGIN_ACTION;
  } catch {
    return false;
  }
}

/** Turns the panel's refusal shape into one line; null when it reported success. */
function readLoginRefusal(payload: any): string | null {
  if (!payload) return null;
  const nested = payload?.error?.message;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  if (typeof payload?.message === 'string' && payload.message.trim()) return payload.message.trim();
  return null;
}

function readHttpsOrigin(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 160) || '未知错误';
}
