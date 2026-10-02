/**
 * Signs a site account back in through Linux.do's OAuth handshake by driving the
 * managed browser.
 *
 * Several relays pay their daily quota inside the login handler instead of on a
 * check-in route, and their FAQ answers the obvious question with "log out and
 * back in". Replaying that handshake needs a real browser: `connect.linux.do`
 * sits behind Cloudflare and refuses every plain HTTP client — curl, undici, and
 * even a request replaying the browser's own cookies.
 *
 * Three details decide whether a site accepts the replay, and each was learned
 * the hard way:
 *
 * - The OAuth `state` is bound to the browsing session. Requesting it over plain
 *   HTTP and only then opening the authorize page makes the site answer "state
 *   is empty or not same", so the state is read from inside the page.
 * - An OAuth handshake started while a session is active is read as a *bind*,
 *   not a login, and is rejected with "该 Linux DO 账户已被绑定". The account has
 *   to be signed out first — which is what the FAQ means by 退出后重新登陆.
 * - The SPAs land on /console even when the exchange failed, so the verdict has
 *   to come from the callback response instead of the landing URL.
 *
 * Deployments differ only in their host, the path they answer the callback on,
 * and the client id they advertise on /api/status. Everything else is shared, so
 * each site module is a thin wrapper over this driver instead of a copy that
 * drifts from the others.
 */
import type { BrowserContext, Page, Response as BrowserResponse } from 'playwright-core';
import { assistedLoginSessions } from '../sessionRegistry.js';
import { passCloudflareChallenge } from '../cloudflareChallenge.js';

const CONNECT_ORIGIN = 'https://connect.linux.do';
/** NewAPI forks all park the sign-out route here. */
const LOGOUT_PATH = '/api/user/logout';
/** The state is session-bound, so it is requested from inside the page. */
const OAUTH_STATE_PATH = '/api/oauth/state?mode=login';
/**
 * The consent page renders its answer buttons as links labelled 允许 / 拒绝
 * (Chinese) or Allow / Authorize (English), never as real <button> elements.
 */
const AUTHORIZE_BUTTON_TEXT = /允许|授权|Authorize|Allow/i;
const AUTHORIZE_BUTTON_SELECTOR = 'button, a, input[type="submit"], input[type="button"]';
const NAVIGATION_TIMEOUT_MS = 60_000;
const SECURITY_CHECK_TIMEOUT_MS = 45_000;
const CALLBACK_POLL_INTERVAL_MS = 500;
/** The consent page is opened after a client-side redirect; that race is retried. */
const AUTHORIZE_NAVIGATION_ATTEMPTS = 3;
/** The SPA bounce to /login is a client-side navigation Playwright cannot await. */
const SIGN_OUT_SETTLE_MS = 1_000;
/**
 * The edge answers a naked visitor with a JS challenge and only then serves the
 * SPA, so the first in-page read can land on the challenge page.
 */
const IN_PAGE_READ_ATTEMPTS = 4;
const IN_PAGE_READ_GAP_MS = 1_500;

export type LinuxDoReloginResult = {
  ok: boolean;
  message: string;
  /**
   * Account quota in new-api units, read inside the page before signing out and
   * after landing back on the site. Both are null when the site refused to
   * answer, and callers must only ever subtract one from the other — the value
   * is raw quota, not the USD balance the adapters report.
   */
  quotaBefore?: number | null;
  quotaAfter?: number | null;
};

export type LinuxDoReloginRequest = {
  /** Origin of the deployment, e.g. https://anyrouter.top */
  baseUrl: string;
  /**
   * Linux.do OAuth client id the deployment advertises on /api/status. Optional
   * on purpose: the same edge that shields the balance also shields /api/status
   * from a plain HTTP client, and the page can read it either way.
   */
  clientId?: string;
  /** Deployment user id this account must end up signed in as. */
  expectedUserId?: number;
  /** Hosts the flow is allowed to sign out of and read the callback from. */
  hosts: readonly string[];
  /** Path the deployment answers the OAuth handshake on, e.g. /api/oauth/linuxdo. */
  callbackPath: string;
  /** Deployment name used in the enforcement message, e.g. anyrouter.top. */
  siteLabel: string;
};

/** True when `hostname` is `host` itself or one of its subdomains. */
export function matchesSiteHost(hostname: string, host: string): boolean {
  const normalized = (host || '').toLowerCase().replace(/^\./, '');
  if (!normalized) return false;
  const candidate = (hostname || '').toLowerCase();
  return candidate === normalized || candidate.endsWith(`.${normalized}`);
}

/** Guard so a malformed URL can never be opened in the managed profile. */
export function isSiteUrl(rawUrl: string, hosts: readonly string[]): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && hosts.some((host) => matchesSiteHost(url.hostname, host));
  } catch {
    return false;
  }
}

export function isLinuxDoAuthorizeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === CONNECT_ORIGIN && url.pathname.startsWith('/oauth2/authorize');
  } catch {
    return false;
  }
}

/**
 * Turns the OAuth callback response into a verdict. The page navigates to
 * /console regardless of the outcome, so only the API answer is trustworthy.
 */
export function judgeLinuxDoCallback(
  status: number,
  body: string,
  options: { expectedUserId?: number } = {},
): LinuxDoReloginResult {
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
  if (options.expectedUserId && Number.isFinite(userId) && userId !== options.expectedUserId) {
    return { ok: false, message: `登录到了其他账号（id ${userId}，期望 ${options.expectedUserId}）` };
  }
  return { ok: true, message: 'Linux.do 重新登录完成' };
}

export async function reloginWithLinuxDo(
  request: LinuxDoReloginRequest,
): Promise<LinuxDoReloginResult> {
  if (!isSiteUrl(request.baseUrl, request.hosts)) {
    return { ok: false, message: `仅允许对 ${request.siteLabel} 执行 Linux.do 退出重登` };
  }
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
    if (!isCallbackResponse(response.url(), request)) return;
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
    const quotaBefore = await readQuotaInPage(page);

    // The caller only knows the client id when the edge let it read /api/status;
    // the page can always get it, so a missing one is resolved here instead of
    // failing a handshake the browser is perfectly able to finish.
    let clientId = (request.clientId || '').trim();
    if (!clientId) {
      const resolved = await readLinuxDoClientIdInPage(page);
      if (!resolved.clientId) {
        return {
          ok: false,
          message: resolved.refusal
            ? `站点未返回 Linux.do 客户端标识（${resolved.refusal}）`
            : '站点未启用 Linux.do 登录',
        };
      }
      clientId = resolved.clientId;
    }

    await signOutOfSite(page, context, siteOrigin, request.hosts);

    const state = await readOAuthStateInPage(page);
    if (!state) return { ok: false, message: '站点未返回 OAuth state' };
    const authorizeUrl = buildLinuxDoAuthorizeUrl(clientId, state);
    if (!isLinuxDoAuthorizeUrl(authorizeUrl)) {
      return { ok: false, message: '仅允许在受管浏览器中打开 connect.linux.do 的授权地址' };
    }

    await openAuthorizePage(page, authorizeUrl);
    await passCloudflareCheck(page);
    await clickAuthorizeButton(page);

    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    while (!captured.callback && Date.now() < deadline) {
      await page.waitForTimeout(CALLBACK_POLL_INTERVAL_MS);
    }
    const settled = captured.callback;
    if (!settled) return { ok: false, message: '授权后站点未回调 Linux.do 登录' };
    const verdict = judgeLinuxDoCallback(settled.status, settled.body, {
      expectedUserId: request.expectedUserId,
    });
    // Read the balance before the tab is parked: the callback lands on the SPA,
    // which fires the site's own check-in, and this is the moment the grant - if
    // there is one today - has just landed.
    const quotaAfter = verdict.ok ? await readQuotaInPage(page) : null;
    return { ...verdict, quotaBefore, quotaAfter };
  } catch (error) {
    return { ok: false, message: `Linux.do 重新登录失败：${describeError(error)}` };
  } finally {
    page.off('response', captureCallback);
    await page.close().catch(() => undefined);
  }
}

function isCallbackResponse(rawUrl: string, request: LinuxDoReloginRequest): boolean {
  try {
    const url = new URL(rawUrl);
    return url.pathname === request.callbackPath
      && request.hosts.some((host) => matchesSiteHost(url.hostname, host));
  } catch {
    return false;
  }
}

/**
 * Drops the site session so the next handshake is a login rather than a bind.
 * Only the site's own cookies are removed: the forum session that authorizes the
 * handshake lives on connect.linux.do and has to survive.
 */
async function signOutOfSite(
  page: Page,
  context: BrowserContext,
  siteOrigin: string,
  hosts: readonly string[],
): Promise<void> {
  await page
    .evaluate(async (logoutPath) => {
      await fetch(logoutPath, { method: 'GET' }).catch(() => undefined);
      try { localStorage.clear(); } catch {}
      try { sessionStorage.clear(); } catch {}
    }, LOGOUT_PATH)
    .catch(() => undefined);

  for (const cookie of await context.cookies()) {
    if (!hosts.some((allowed) => matchesSiteHost(cookie.domain.replace(/^\./, ''), allowed))) continue;
    await context
      .clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path })
      .catch(() => undefined);
  }

  // Reload so the SPA comes back without its in-memory copy of the session,
  // then let it finish bouncing to its login route: starting the authorize
  // navigation on top of that client-side redirect makes Playwright abort one
  // of the two ("navigation is interrupted by another navigation").
  await page
    .goto(siteOrigin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
    .catch((error) => {
      // The bounce this reload deliberately provokes is the very thing that
      // aborts it, and which of the two navigations Playwright reports as
      // interrupted is a race. The site is loading its signed-out shell either
      // way, which is all this step is for, so the race is not a failure.
      if (!isNavigationInterrupted(error)) throw error;
    });
  await page.waitForTimeout(SIGN_OUT_SETTLE_MS).catch(() => undefined);
}

/** Playwright's wording for "the page navigated itself while we were waiting". */
function isNavigationInterrupted(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /interrupted by another navigation/i.test(message);
}

/**
 * Opens the consent page, tolerating a navigation that is still in flight.
 *
 * Cloudflare's own interstitial and the site's SPA redirect both race this call,
 * and the failure is transient by definition, so it is retried rather than
 * reported as a broken handshake.
 */
async function openAuthorizePage(page: Page, url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= AUTHORIZE_NAVIGATION_ATTEMPTS; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(750).catch(() => undefined);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
 * Clears the Cloudflare interstitial in front of the consent page by hand.
 *
 * The shared helper answers the same challenge the same way; this wrapper keeps
 * the call site reading like the rest of the handshake.
 */
async function passCloudflareCheck(page: Page): Promise<void> {
  await passCloudflareChallenge(page, { timeoutMs: SECURITY_CHECK_TIMEOUT_MS });
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

/**
 * Calls a site endpoint from inside the page.
 *
 * The deployments behind this driver answer a visitor they dislike with an edge
 * challenge or a plain 403 page instead of JSON, and the SPA navigates underneath
 * the call — so the result carries the status and a snippet of whatever came
 * back, and the read is retried while the page settles.
 */
type InPageRead = { status: number; payload: unknown; snippet: string };

async function readSiteJsonInPage(page: Page, path: string): Promise<InPageRead> {
  let last: InPageRead = { status: 0, payload: null, snippet: '' };
  for (let attempt = 1; attempt <= IN_PAGE_READ_ATTEMPTS; attempt += 1) {
    const outcome = await page
      .evaluate(async (requestPath: string) => {
        try {
          const res = await fetch(requestPath, { headers: { Accept: 'application/json' } });
          const text = await res.text();
          try {
            return { status: res.status, payload: JSON.parse(text) as unknown, snippet: '' };
          } catch {
            return { status: res.status, payload: null, snippet: text.slice(0, 120) };
          }
        } catch (error) {
          return {
            status: 0,
            payload: null,
            snippet: (error instanceof Error ? error.message : String(error)).slice(0, 120),
          };
        }
      }, path)
      .catch(() => ({ status: 0, payload: null, snippet: '页面读取失败' }));
    if (outcome?.payload) return outcome;
    last = outcome;
    if (attempt < IN_PAGE_READ_ATTEMPTS) {
      await page.waitForTimeout(IN_PAGE_READ_GAP_MS).catch(() => undefined);
    }
  }
  return last;
}

/** The OAuth client id the deployment advertises, read from inside the page. */
async function readLinuxDoClientIdInPage(
  page: Page,
): Promise<{ clientId: string; refusal: string | null }> {
  const read = await readSiteJsonInPage(page, '/api/status');
  if (!read.payload) return { clientId: '', refusal: describeRefusal(read) };
  const payload = read.payload as { data?: Record<string, unknown> } & Record<string, unknown>;
  const data = (payload.data ?? payload) as Record<string, unknown>;
  if (data?.linuxdo_oauth !== true) return { clientId: '', refusal: null };
  const clientId = typeof data?.linuxdo_client_id === 'string' ? data.linuxdo_client_id.trim() : '';
  return { clientId, refusal: null };
}

/**
 * Reads the account's quota from inside the page.
 *
 * The deployments behind this driver shield `/api/user/self` with an edge JS
 * challenge, and the challenge a plain HTTP client solves lapses within the
 * hour. The browser executes it instead, which makes the page the one place the
 * balance can still be read — and the only reason this driver reports raw quota
 * at all. Null means "no reading", never "zero".
 */
async function readQuotaInPage(page: Page): Promise<number | null> {
  const read = await readSiteJsonInPage(page, '/api/user/self');
  const payload = read.payload as { success?: unknown; data?: { quota?: unknown } } | null;
  if (payload?.success !== true) return null;
  const quota = Number(payload?.data?.quota);
  return Number.isFinite(quota) ? quota : null;
}

/** Names why the site did not answer with JSON, so the caller can say it out loud. */
function describeRefusal(read: InPageRead): string {
  if (read.status === 403) return '站点返回 403 拦截页';
  if (read.status === 429) return '站点限流中';
  if (read.status > 0) return `站点返回 HTTP ${read.status}`;
  return read.snippet || '页面请求失败';
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 160) || '未知错误';
}
