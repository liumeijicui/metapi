import type { Page } from 'playwright-core';
import type { AssistedLoginProvider, LoginState, ProviderHttpFetch } from '../types.js';

const ORIGIN = 'https://linux.do';
const CONNECT_HOST = 'connect.linux.do';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Linux.do exposes an unauthenticated JSON endpoint that reports the current
 * user, which is far more reliable than scraping the rendered header.
 */
async function probeLoginState(page: Page): Promise<LoginState> {
  const result = await page.evaluate(async () => {
    try {
      const response = await fetch('/session/current.json', {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return { httpStatus: response.status };
      const payload = await response.json();
      const user = payload?.current_user;
      return {
        httpStatus: response.status,
        username: typeof user?.username === 'string' ? user.username : null,
        userId: typeof user?.id === 'number' ? user.id : null,
      };
    } catch (error) {
      return { error: String(error) };
    }
  });

  const httpStatus = (result as { httpStatus?: number }).httpStatus;
  if (httpStatus === 403 || httpStatus === 503) {
    return { loggedIn: false, username: null, userId: null, blocked: true, message: 'Cloudflare 校验未通过，请在打开的浏览器窗口中完成验证' };
  }
  const username = normalizeText((result as { username?: string }).username);
  const userId = typeof (result as { userId?: number }).userId === 'number' ? (result as { userId: number }).userId : null;
  return { loggedIn: !!username, username: username || null, userId, blocked: false };
}

export const linuxDoProvider: AssistedLoginProvider = {
  id: 'linuxdo',
  label: 'Linux.do',
  origin: ORIGIN,
  loginPath: '/login',
  isHandoffHost: (host) => host === 'linux.do' || host === CONNECT_HOST,
  /**
   * Both steps of the handoff live on the connect host: `/authorize` shows the
   * consent form, and `/approve` is where granting it lands. Only the first was
   * recognised, so a flow that had already been approved — or that was waiting
   * out a Cloudflare challenge on the approve step — was judged to have no
   * handoff in flight and reported as "provider session expired" even though
   * the session behind it was valid.
   */
  isAuthorizationUrl: (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return url.host === CONNECT_HOST && /\/oauth2?\/(authorize|approve)/.test(url.pathname);
    } catch {
      return false;
    }
  },
  probeLoginState,
  /**
   * Same endpoint as the browser probe, reached over HTTP with the imported
   * cookie. Transient failures (rate limits, Cloudflare checks, network errors,
   * unexpected responses) are reported as `blocked` rather than as a logged-out
   * session: only a 404 proves the credential itself stopped working.
   */
  probeLoginStateHttp: async (fetchWithSession: ProviderHttpFetch): Promise<LoginState> => {
    let response: { status: number; body: string };
    try {
      response = await fetchWithSession('/session/current.json', { accept: 'application/json' });
    } catch (error) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: `网络错误：${(error as Error)?.message || '无法访问 Linux.do'}`,
      };
    }

    // 429 is a transient rate limit, not a dead credential: reporting it as a
    // logout would both mislead the operator and trip the expiry watcher.
    if (response.status === 429) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: 'HTTP 429（请求被限流）',
      };
    }
    if (response.status === 403) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: 'HTTP 403（Cloudflare 校验或访问被拦截）',
      };
    }
    if (response.status === 503) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: 'HTTP 503（站点服务暂不可用）',
      };
    }
    // 401/404 are the site explicitly rejecting the credential, so they are the
    // only statuses that mark the imported session as unusable.
    if (response.status === 401) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: false,
        message: 'HTTP 401（认证被拒绝），请重新导入会话',
      };
    }
    // Discourse answers 404 on the current-user endpoint when the session token
    // is no longer accepted, which reads as "logged out", not as an edge block.
    if (response.status === 404) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: false,
        message: 'HTTP 404（会话已在站点侧失效），请重新导入会话',
      };
    }
    if (response.status !== 200) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: `HTTP ${response.status}（非预期响应）`,
      };
    }

    let payload: { current_user?: { username?: unknown; id?: unknown } | null } | null = null;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = null;
    }
    const currentUser = payload?.current_user;
    const username = currentUser && typeof currentUser === 'object' ? normalizeText(currentUser.username) : '';
    if (!currentUser || typeof currentUser !== 'object' || !username) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: '响应未包含用户信息（可能被中间层拦截）',
      };
    }
    const userId = typeof currentUser.id === 'number' ? currentUser.id : null;
    return { loggedIn: true, username, userId, blocked: false };
  },
  entryNamePattern: /linux\s*\.?\s*do|linuxdo/i,
  entrySelectors: ['[href*="linuxdo"]', '[href*="linux.do"]', 'button:has-text("LinuxDO")', 'button:has-text("LINUX DO")', 'button:has-text("linuxdo")'],
  entryTextSelectors: [
    'a:has-text("Linux.do")',
    'button:has-text("Linux.do")',
    'a:has-text("LINUX DO")',
    'button:has-text("LINUX DO")',
  ],
  consentButtonNames: /允许|授权|Authorize|Allow/i,
  consentSelectors: [
    'button:has-text("允许")',
    'button:has-text("授权")',
    'button:has-text("Authorize")',
    'button:has-text("Allow")',
    'input[type="submit"]',
  ],
  messages: {
    needsLogin: '请在弹出的浏览器窗口中完成 Linux.do 登录，然后重试',
    sessionExpired: 'Linux.do 会话已失效，请在浏览器窗口中重新登录',
    entryMissing: '未在该站点找到 Linux.do 登录入口，请确认站点 URL 是否正确',
    blocked: 'Cloudflare 校验未通过，请在受管浏览器窗口中完成验证',
  },
};
