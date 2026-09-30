import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Locator, Page } from 'playwright-core';
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
 * handshake is driven there instead: open the authorize URL, answer the
 * Cloudflare check when it appears, press "授权", and let the site's SPA finish
 * the exchange back on agentrouter.org.
 */

const CONNECT_ORIGIN = 'https://connect.linux.do';
const CONSOLE_URL_PATTERN = /agentrouter\.org\/console/i;
const CALLBACK_URL_PATTERN = /agentrouter\.org\/oauth\/linuxdo/i;
const CLOUDFLARE_FRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"]';
const AUTHORIZE_BUTTON_NAME = /授权|Authorize/i;
const NAVIGATION_TIMEOUT_MS = 60_000;
const SECURITY_CHECK_TIMEOUT_MS = 45_000;

export type AgentRouterLinuxDoLoginResult = { ok: boolean; message: string };

/** Guard so a malformed URL can never be opened in the managed profile. */
export function isLinuxDoAuthorizeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === CONNECT_ORIGIN && url.pathname.startsWith('/oauth2/authorize');
  } catch {
    return false;
  }
}

export async function loginAgentRouterWithLinuxDo(
  authorizeUrl: string,
): Promise<AgentRouterLinuxDoLoginResult> {
  if (!isLinuxDoAuthorizeUrl(authorizeUrl)) {
    return { ok: false, message: '仅允许在受管浏览器中打开 connect.linux.do 的授权地址' };
  }

  const session = assistedLoginSessions.get('linuxdo');
  if (!session) return { ok: false, message: 'Linux.do 辅助登录会话未注册' };

  let context;
  try {
    context = await session.browser.ensureManagedBrowserContext();
  } catch (error) {
    return { ok: false, message: `无法启动受管浏览器：${describeError(error)}` };
  }

  const page = await context.newPage();
  try {
    await page.goto(authorizeUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await passCloudflareCheck(page);
    await clickAuthorizeButton(page);
    // The consent page redirects to the site callback, and the SPA completes the
    // OAuth exchange on its own before landing in the console.
    await page.waitForURL(CALLBACK_URL_PATTERN, { timeout: NAVIGATION_TIMEOUT_MS });
    await page.waitForURL(CONSOLE_URL_PATTERN, { timeout: NAVIGATION_TIMEOUT_MS });
    return { ok: true, message: 'Linux.do 重新登录完成' };
  } catch (error) {
    return { ok: false, message: `Linux.do 重新登录失败：${describeError(error)}` };
  } finally {
    await page.close().catch(() => undefined);
  }
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
  const button = page.getByRole('button', { name: AUTHORIZE_BUTTON_NAME }).first();
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
