import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BrowserContext, Locator, Page, Response as BrowserResponse } from 'playwright-core';
import { assistedLoginSessions } from '../sessionRegistry.js';

/**
 * Agent Router re-login through Linux.do.
 *
 * Agent Router has no check-in endpoint: it grants the daily $25 inside its
 * login handler, and its FAQ tells the user to log out and back in. For the
 * `linuxdo_*` accounts that means replaying the Linux.do OAuth handshake, but
 * `connect.linux.do` sits behind Cloudflare and refuses every plain HTTP client
 * (curl, undici and even a request replaying the browser's own cookies).
 *
 * The managed Linux.do browser already holds the forum session, so the
 * handshake is driven there instead. Three details decide whether the site
 * accepts it, and each was learned the hard way:
 *
 * - The OAuth `state` is bound to the browsing session. Requesting it over plain
 *   HTTP and only then opening the authorize page makes the site answer
 *   "state is empty or not same", so the state is read from inside the page.
 * - An OAuth handshake started while a session is active is read as a *bind*,
 *   not a login, and is rejected with "该 Linux DO 账户已被绑定". The account has
 *   to be signed out first — which is what the FAQ means by 退出后重新登陆.
 * - The SPA lands on /console even when the exchange failed, so the verdict has
 *   to come from the callback response instead of the landing URL.
 */

const CONNECT_ORIGIN = 'https://connect.linux.do';
const AGENT_ROUTER_HOST = 'agentrouter.org';
const CALLBACK_API_PATTERN = /agentrouter\.org\/api\/oauth\/linuxdo/i;
const LOGOUT_PATH = '/api/user/logout';
const OAUTH_STATE_PATH = '/api/oauth/state?mode=login';
const CLOUDFLARE_FRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"]';
/**
 * The consent page renders its answer buttons as links labelled 允许 / 拒绝
 * (Chinese) or Allow / Authorize (English), never as real <button> elements.
 */
const AUTHORIZE_BUTTON_TEXT = /允许|授权|Authorize|Allow/i;
const AUTHORIZE_BUTTON_SELECTOR = 'button, a, input[type="submit"], input[type="button"]';
const NAVIGATION_TIMEOUT_MS = 60_000;
const SECURITY_CHECK_TIMEOUT_MS = 45_000;
const CALLBACK_POLL_INTERVAL_MS = 500;

export type AgentRouterLinuxDoLoginResult = { ok: boolean; message: string };

export type AgentRouterLinuxDoLoginRequest = {
  /** Origin of the deployment, e.g. https://agentrouter.org */
  baseUrl: string;
  /** Linux.do OAuth client id the deployment advertises on /api/status. */
  clientId: string;
  /** Deployment user id this account must end up signed in as. */
  expectedUserId?: number;
};

/** Guard so a malformed URL can never be opened in the managed profile. */
export function isLinuxDoAuthorizeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === CONNECT_ORIGIN && url.pathname.startsWith('/oauth2/authorize');
  } catch {
    return false;
  }
}

/** The flow signs the profile out of this site, so it must be the real one. */
export function isAgentRouterSite(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === AGENT_ROUTER_HOST || url.hostname.endsWith(`.${AGENT_ROUTER_HOST}`));
  } catch {
    return false;
  }
}

/**
 * Turns the OAuth callback response into a verdict. The page navigates to
 * /console regardless of the outcome, so only the API answer is trustworthy.
 */
export function judgeAgentRouterCallback(
  status: number,
  body: string,
  expectedUserId?: number,
): AgentRouterLinuxDoLoginResult {
  let payload: { success?: unknown; message?: unknown; data?: { id?: unknown } } | null = null;
  try {
    payload = JSON.parse(body);
  } catch {}

  const reason = typeof payload?.message === 'string' && payload.message.trim()
    ? payload.message.trim()
    : '';
  if (status !== 200) {
    return { ok: false, message: `站点拒绝 Linux.do 登录：${reason || `HTTP ${status}`}` };
  }
  if (payload?.success !== true) {
    return { ok: false, message: `站点未完成 Linux.do 登录：${reason || '站点未说明原因'}` };
  }

  const userId = Number(payload?.data?.id);
  if (expectedUserId && Number.isFinite(userId) && userId !== expectedUserId) {
    return { ok: false, message: `登录到了其他账号（id ${userId}，期望 ${expectedUserId}）` };
  }
  return { ok: true, message: 'Linux.do 重新登录完成' };
}

export async function loginAgentRouterWithLinuxDo(
  request: AgentRouterLinuxDoLoginRequest,
): Promise<AgentRouterLinuxDoLoginResult> {
  if (!isAgentRouterSite(request.baseUrl)) {
    return { ok: false, message: '仅允许对 agentrouter.org 执行 Linux.do 退出重登' };
  }
  const clientId = (request.clientId || '').trim();
  if (!clientId) return { ok: false, message: '站点未启用 Linux.do 登录' };

  const session = assistedLoginSessions.get('linuxdo');
  if (!session) return { ok: false, message: 'Linux.do 辅助登录会话未注册' };

  let context: BrowserContext;
  try {
    context = await session.browser.ensureManagedBrowserContext();
  } catch (error) {
    return { ok: false, message: `无法启动受管浏览器：${describeError(error)}` };
  }

  const siteOrigin = new URL(request.baseUrl).origin;
  const page = await context.newPage();
  const captured: { callback: { status: number; body: string } | null } = { callback: null };
  const captureCallback = (response: BrowserResponse): void => {
    if (!CALLBACK_API_PATTERN.test(response.url())) return;
    void response
      .text()
      .then((body) => {
        captured.callback = { status: response.status(), body };
      })
      .catch(() => undefined);
  };
  page.on('response', captureCallback);

  try {
    await page.goto(siteOrigin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await signOutOfAgentRouter(page, context, siteOrigin);

    const state = await readOAuthStateInPage(page);
    if (!state) return { ok: false, message: '站点未返回 OAuth state' };
    const authorizeUrl = buildLinuxDoAuthorizeUrl(clientId, state);
    if (!isLinuxDoAuthorizeUrl(authorizeUrl)) {
      return { ok: false, message: '仅允许在受管浏览器中打开 connect.linux.do 的授权地址' };
    }

    await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await passCloudflareCheck(page);
    await clickAuthorizeButton(page);

    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    while (!captured.callback && Date.now() < deadline) {
      await page.waitForTimeout(CALLBACK_POLL_INTERVAL_MS);
    }
    const settled = captured.callback;
    if (!settled) return { ok: false, message: '授权后站点未回调 Linux.do 登录' };
    return judgeAgentRouterCallback(settled.status, settled.body, request.expectedUserId);
  } catch (error) {
    return { ok: false, message: `Linux.do 重新登录失败：${describeError(error)}` };
  } finally {
    page.off('response', captureCallback);
    await page.close().catch(() => undefined);
  }
}

/**
 * Drops the site session so the next handshake is a login rather than a bind.
 * Only agentrouter.org cookies are removed: the forum session that authorizes
 * the handshake lives on connect.linux.do and has to survive.
 */
async function signOutOfAgentRouter(
  page: Page,
  context: BrowserContext,
  siteOrigin: string,
): Promise<void> {
  await page
    .evaluate(async (logoutPath) => {
      await fetch(logoutPath, { method: 'GET' }).catch(() => undefined);
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    }, LOGOUT_PATH)
    .catch(() => undefined);

  const host = new URL(siteOrigin).hostname;
  for (const cookie of await context.cookies()) {
    if (!cookie.domain.replace(/^\./, '').endsWith(host)) continue;
    await context
      .clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path })
      .catch(() => undefined);
  }

  // Reload so the SPA comes back without its in-memory copy of the session.
  await page.goto(siteOrigin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
}

/** The site binds the state to the session, so it is read from inside the page. */
async function readOAuthStateInPage(page: Page): Promise<string | null> {
  const state = await page
    .evaluate(async (path) => {
      const payload = await fetch(path, { headers: { Accept: 'application/json' } }).then((res) => res.json());
      return typeof payload?.data === 'string' ? payload.data.trim() : '';
    }, OAUTH_STATE_PATH)
    .catch(() => '');
  return state || null;
}

function buildLinuxDoAuthorizeUrl(clientId: string, state: string): string {
  const url = new URL('/oauth2/authorize', CONNECT_ORIGIN);
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, state }).toString();
  return url.toString();
}

/**
 * Cloudflare only steps in on some days; when it does, it renders the "Verify
 * you are human" checkbox in an iframe. A regular click answers it, and the
 * fallback replays the click as a real X11 pointer event for the variants that
 * ignore synthetic input.
 */
async function passCloudflareCheck(page: Page): Promise<void> {
  const widget = page.locator(CLOUDFLARE_FRAME_SELECTOR).first();
  if ((await widget.count()) === 0) return;

  const checkbox = page
    .frameLocator(CLOUDFLARE_FRAME_SELECTOR)
    .locator('input[type="checkbox"]')
    .first();
  try {
    await checkbox.click({ timeout: 15_000 });
  } catch {
    await clickWithRealPointer(page, widget).catch(() => undefined);
  }

  await page
    .waitForFunction(() => !/just a moment/i.test(document.title || ''), undefined, {
      timeout: SECURITY_CHECK_TIMEOUT_MS,
    })
    .catch(() => undefined);
}

/** Replays a click through xdotool so the site sees a real pointer event. */
async function clickWithRealPointer(page: Page, widget: Locator): Promise<void> {
  const box = await widget.boundingBox();
  if (!box) return;

  const geometry = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    chromeWidth: Math.max(0, window.outerWidth - window.innerWidth),
    chromeHeight: Math.max(0, window.outerHeight - window.innerHeight),
  }));
  const x = Math.round(geometry.screenX + geometry.chromeWidth / 2 + box.x + box.width / 2);
  const y = Math.round(geometry.screenY + geometry.chromeHeight + box.y + box.height / 2);
  await promisify(execFile)('xdotool', ['mousemove', String(x), String(y), 'click', '1']);
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

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 160) || '未知错误';
}
