import type { Page } from 'playwright-core';
import type { AssistedLoginProvider, LoginState, ProviderHttpFetch } from '../types.js';

const ORIGIN = 'https://github.com';

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * GitHub's rendered pages always carry a `user-login` meta tag when the visitor
 * is signed in and omit it entirely when signed out, so the probe reads that
 * instead of depending on locale-specific header markup.
 */
async function probeLoginState(page: Page): Promise<LoginState> {
  const result = await page.evaluate(() => {
    try {
      const login = document.querySelector('meta[name="user-login"]')?.getAttribute('content') || '';
      const userId = document.querySelector('meta[name="octolytics-dimension-user_id"]')?.getAttribute('content') || '';
      return { login, userId };
    } catch (error) {
      return { error: String(error) };
    }
  });

  if ((result as { error?: string }).error) {
    return {
      loggedIn: false,
      username: null,
      userId: null,
      blocked: false,
      message: (result as { error: string }).error,
    };
  }

  const username = normalizeText((result as { login?: string }).login);
  const parsedUserId = Number.parseInt(normalizeText((result as { userId?: string }).userId), 10);
  return {
    loggedIn: !!username,
    username: username || null,
    userId: Number.isFinite(parsedUserId) ? parsedUserId : null,
    blocked: false,
  };
}

export const gitHubProvider: AssistedLoginProvider = {
  id: 'github',
  label: 'GitHub',
  origin: ORIGIN,
  loginPath: '/login',
  isHandoffHost: (host) => host === 'github.com' || host.endsWith('.github.com'),
  isAuthorizationUrl: (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return url.host === 'github.com' && /\/login\/oauth\/authorize/.test(url.pathname);
    } catch {
      return false;
    }
  },
  probeLoginState,
  /**
   * GitHub renders the `user-login` meta tag on every page for signed-in
   * visitors, so the imported-cookie probe reads the homepage HTML directly.
   */
  probeLoginStateHttp: async (fetchWithSession: ProviderHttpFetch): Promise<LoginState> => {
    let response: { status: number; body: string };
    try {
      response = await fetchWithSession('/', { accept: 'text/html' });
    } catch (error) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: `网络错误：${(error as Error)?.message || '无法访问 GitHub'}`,
      };
    }

    if (response.status === 401) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: false,
        message: 'HTTP 401（认证被拒绝），请重新导入会话',
      };
    }
    if (response.status === 403) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: 'HTTP 403（访问被拒绝）',
      };
    }
    if (response.status === 429) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: 'HTTP 429（请求被限流）',
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

    const login = normalizeText(/<meta name="user-login" content="([^"]*)"/i.exec(response.body)?.[1]);
    const rawUserId = normalizeText(/<meta name="octolytics-dimension-user_id" content="([^"]*)"/i.exec(response.body)?.[1]);
    const parsedUserId = Number.parseInt(rawUserId, 10);
    if (!login) {
      // Anonymous GitHub pages render no user-login meta, so a clean 200 without
      // it is the site explicitly reporting a signed-out session.
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: false,
        message: '页面未包含登录信息（会话已失效），请重新导入会话',
      };
    }
    return {
      loggedIn: true,
      username: login,
      userId: Number.isFinite(parsedUserId) ? parsedUserId : null,
      blocked: false,
    };
  },
  entryNamePattern: /git\s*hub|github/i,
  entrySelectors: ['[href*="github.com/login/oauth"]', '[href*="github"]', 'button:has-text("GitHub")', 'button:has-text("Github")'],
  entryTextSelectors: [
    'a:has-text("GitHub")',
    'button:has-text("GitHub")',
    'a:has-text("Github")',
    'button:has-text("Github")',
  ],
  consentButtonNames: /Authorize|授权|允许|Allow/i,
  consentSelectors: [
    'button#js-oauth-authorize-btn',
    'button[name="authorize"]',
    'button:has-text("Authorize")',
    'button:has-text("授权")',
  ],
  messages: {
    needsLogin: '请在弹出的浏览器窗口中完成 GitHub 登录，然后重试',
    sessionExpired: 'GitHub 会话已失效，请在浏览器窗口中重新登录',
    entryMissing: '未在该站点找到 GitHub 登录入口，请确认站点 URL 是否正确',
    blocked: 'GitHub 校验未通过，请在受管浏览器窗口中完成验证',
  },
};
