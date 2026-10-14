import { assistedLoginSessions } from '../sessionRegistry.js';
import { isPipiImageLoginSite } from './pipiImageSite.js';

/**
 * 皮皮智绘没有管理面，也没有可重放的刷新令牌：站点自己签发的
 * `pipi_pc_token` 只在浏览器里，7 天后失效。失效之后唯一能回到站内的路，
 * 就是操作者当初走过的那条 —— 在受管浏览器里点一次 Linux.do 授权。
 *
 * 复用模块化的 `captureSiteCredentials`，而不是另写一套浏览器流程：入口
 * 点击、Cloudflare 过盾、同意按钮、凭证采集都已经在那里，站点专属的部分
 * （`pipi_pc_token` 这类自有 storage 键）也已经在采集器里声明过。
 */

export type PipiImageReloginOutcome = {
  ok: boolean;
  accessToken: string | null;
  platformUserId: number | null;
  username: string | null;
  message?: string;
};

export function supportsPipiImageLinuxDoLogin(siteUrl: string, providerId: string): boolean {
  return providerId === 'linuxdo' && isPipiImageLoginSite(siteUrl);
}

/**
 * 先退掉站点自己的会话再重新授权。
 *
 * 站点把登录态同时放在 localStorage 和 `__Secure-pipi_ld_oauth_state` 这类
 * 站点专属 cookie 上；带着一个仍然在的会话去点授权，服务端会把它读成
 * 「绑定」而不是「登录」。只清站点这一份，Linux.do 自己的论坛会话
 * （在 connect.linux.do 上）必须留着，否则授权拿不到。
 */
async function signOutOfSite(siteUrl: string): Promise<void> {
  const session = assistedLoginSessions.get('linuxdo');
  if (!session) return;
  let origin: URL;
  try {
    origin = new URL(siteUrl);
  } catch {
    return;
  }

  let context: import('playwright-core').BrowserContext;
  try {
    context = await session.browser.ensureManagedBrowserContext();
  } catch {
    return;
  }

  const host = origin.hostname.toLowerCase();
  const page = await context.newPage();
  try {
    await page.goto(origin.origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
    await page
      .evaluate(() => {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
        } catch {
          // A storage-blocked page just keeps its stale token; the entry click
          // below still decides whether the handshake can start.
        }
      })
      .catch(() => undefined);
  } finally {
    await page.close().catch(() => undefined);
  }

  const doomed = (await context.cookies().catch(() => [])).filter((cookie) => {
    const domain = (cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === host || host.endsWith(`.${domain}`);
  });
  for (const cookie of doomed) {
    await context
      .clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path })
      .catch(() => undefined);
  }
}

export async function reloginPipiImageWithLinuxDo(input: {
  siteId: number;
  siteUrl: string;
}): Promise<PipiImageReloginOutcome> {
  const session = assistedLoginSessions.get('linuxdo');
  if (!session) {
    return { ok: false, accessToken: null, platformUserId: null, username: null, message: 'Linux.do 辅助登录会话未注册' };
  }

  await signOutOfSite(input.siteUrl);

  const result = await session.captureSiteCredentials({ siteId: input.siteId, forceLogin: true });
  const usable = result.status === 'captured' || result.status === 'already_authorized';
  const accessToken = result.credentials?.accessToken || '';
  if (!usable || !accessToken) {
    return {
      ok: false,
      accessToken: null,
      platformUserId: null,
      username: null,
      message: result.message || '未能重新获取皮皮智绘登录凭证',
    };
  }

  return {
    ok: true,
    accessToken,
    platformUserId: result.credentials?.platformUserId ?? null,
    username: result.credentials?.username ?? null,
  };
}
