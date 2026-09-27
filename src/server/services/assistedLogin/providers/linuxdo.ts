import type { Page } from 'playwright-core';
import type { AssistedLoginProvider, LoginState } from '../types.js';

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
  isAuthorizationUrl: (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      return url.host === CONNECT_HOST && /\/oauth2?\/authorize/.test(url.pathname);
    } catch {
      return false;
    }
  },
  probeLoginState,
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
