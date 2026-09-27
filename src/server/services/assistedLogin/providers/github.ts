import type { Page } from 'playwright-core';
import type { AssistedLoginProvider, LoginState } from '../types.js';

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
