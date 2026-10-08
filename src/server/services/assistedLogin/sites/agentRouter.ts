import { fetch, type RequestInit } from 'undici';
import { readImportedSession } from '../importedSession.js';
import { harvestLinuxDoSiteCredential } from '../../linuxdoSession/sessionService.js';
import { withSiteProxyRequestInit } from '../../siteProxy.js';
import {
  isLinuxDoAuthorizeUrl,
  isSiteUrl,
  judgeLinuxDoCallback,
  reloginWithLinuxDo,
} from './linuxDoOAuthRelogin.js';
import type { LinuxDoReloginResult } from './linuxDoOAuthRelogin.js';

/**
 * Agent Router's re-login replays.
 *
 * Agent Router grants the daily $25 inside its login handler and its FAQ tells
 * the user to log out and back in, so its check-in replays the account's OAuth
 * login. Two providers are supported and both end the same way: the sign-in
 * leaves a session cookie on the deployment, and that cookie is what the
 * renewal persists (or exchanges for the account's bearer, see
 * `AgentRouterAdapter.issueAccessTokenFromSession`).
 *
 * - Linux.do runs in the managed browser: the OAuth state is bound to the
 *   browsing session, connect.linux.do refuses every plain HTTP client, and an
 *   active session turns the handshake into a *bind*, which the site rejects
 *   with "该 Linux DO 账户已被绑定". The shared driver handles all three.
 * - GitHub is a plain HTTP replay: the operator's imported GitHub session is
 *   presented to GitHub's authorize endpoint, the site's callback answers with
 *   the daily-grant flag and the session cookie.
 */

const AGENT_ROUTER_HOST = 'agentrouter.org';
const CALLBACK_PATH = '/api/oauth/linuxdo';
const GITHUB_CALLBACK_PATH = '/oauth/github';
const GITHUB_ORIGIN = 'https://github.com';
const REQUEST_TIMEOUT_MS = 30_000;
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const AGENT_ROUTER_HOSTS: readonly string[] = [AGENT_ROUTER_HOST];

export { isLinuxDoAuthorizeUrl };

export type AgentRouterLoginOutcome = {
  ok: boolean;
  message: string;
  /** The site's daily grant fired inside this sign-in, when the provider reports it. */
  checkedIn?: boolean;
  /** Deployment user id the sign-in landed on, when the site reports one. */
  platformUserId?: number;
  /** Session the sign-in established, in `Cookie` header form. */
  sessionCookie?: string;
};

/**
 * Verdict of the deployment's own callback, in the shared driver's shape.
 *
 * Wider than `{ ok, message }` on purpose: this site grants the daily quota
 * inside the login handler, so `checkedIn` is part of what the callback has to
 * say — it is the only verdict left when the system log cannot be read back.
 */
export type AgentRouterLinuxDoLoginResult = LinuxDoReloginResult;

export type AgentRouterLinuxDoLoginRequest = {
  /** Origin of the deployment, e.g. https://agentrouter.org */
  baseUrl: string;
  /**
   * Linux.do OAuth client id the deployment advertises on /api/status. Optional
   * on purpose: the driver resolves it inside the page when the edge shields
   * `/api/status` from a plain HTTP client.
   */
  clientId?: string;
  /** Deployment user id this account must end up signed in as. */
  expectedUserId?: number;
};

/** The flow signs the profile out of this site, so it must be the real one. */
export function isAgentRouterSite(rawUrl: string): boolean {
  return isSiteUrl(rawUrl, AGENT_ROUTER_HOSTS);
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
  return judgeLinuxDoCallback(status, body, { expectedUserId });
}

/**
 * Merges the `Set-Cookie` headers of one response into `Cookie` header form.
 *
 * Later pairs win, which is what a browser does: a callback that re-issues
 * `session` replaces the value an earlier hop set.
 */
export function mergeSetCookieHeaders(setCookies: readonly string[]): string {
  const pairs = new Map<string, string>();
  for (const raw of setCookies) {
    const pair = (raw || '').split(';')[0].trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name || !value) continue;
    pairs.set(name, value);
  }
  return Array.from(pairs.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Reads the `Set-Cookie` list off a response, tolerating older clients. */
function readSetCookieHeaders(response: { headers: unknown }): string[] {
  const headers = response.headers as { getSetCookie?: () => string[] } | null;
  if (headers && typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie() || [];
  }
  const single = (response.headers as { get?: (name: string) => string | null } | null)?.get?.('set-cookie');
  return single ? [single] : [];
}

/**
 * Signs in through Linux.do and reads back the session it established.
 *
 * The handshake itself is the shared driver's job; what is specific to Agent
 * Router is that the browser ends up on the deployment with a live session, and
 * that session is the credential this account needs to hold.
 */
export async function loginAgentRouterWithLinuxDo(
  request: AgentRouterLinuxDoLoginRequest,
): Promise<AgentRouterLoginOutcome> {
  const result = await reloginWithLinuxDo({
    baseUrl: request.baseUrl,
    clientId: request.clientId,
    expectedUserId: request.expectedUserId,
    hosts: AGENT_ROUTER_HOSTS,
    callbackPath: CALLBACK_PATH,
    siteLabel: AGENT_ROUTER_HOST,
  });
  if (!result.ok) return { ok: false, message: result.message };

  const captured = await harvestLinuxDoSiteCredential(request.baseUrl);
  if (!captured?.accessToken) {
    return { ok: false, message: 'Linux.do 登录已完成，但没能从受管浏览器读回站点会话' };
  }
  return {
    ok: true,
    message: result.message,
    checkedIn: result.checkedIn,
    platformUserId: captured.platformUserId ?? request.expectedUserId,
    sessionCookie: captured.accessToken,
  };
}

/**
 * Replays the GitHub OAuth login with the imported GitHub session.
 *
 * GitHub is reached through the system proxy (see `SITES_REQUIRING_SYSTEM_PROXY`)
 * because this network cannot open github.com from Node otherwise; the site hop
 * then runs on the deployment's own proxy settings.
 */
export async function loginAgentRouterWithGitHub(request: {
  baseUrl: string;
}): Promise<AgentRouterLoginOutcome> {
  const baseUrl = (request.baseUrl || '').replace(/\/+$/, '');
  if (!isAgentRouterSite(baseUrl)) {
    return { ok: false, message: `仅允许对 ${AGENT_ROUTER_HOST} 执行 GitHub 重登` };
  }
  const imported = await readImportedSession('github');
  if (!imported?.cookieHeader) {
    return { ok: false, message: '未导入 GitHub 会话，请先在辅助登录中导入' };
  }

  let clientId = '';
  let state = '';
  try {
    const status = await fetchSiteJson<any>(`${baseUrl}/api/status`);
    const data = status?.data;
    if (data?.github_oauth !== true || typeof data?.github_client_id !== 'string') {
      return { ok: false, message: '站点未启用 GitHub 登录' };
    }
    clientId = data.github_client_id.trim();
    const statePayload = await fetchSiteJson<any>(`${baseUrl}/api/oauth/state?mode=login`);
    state = typeof statePayload?.data === 'string' ? statePayload.data.trim() : '';
  } catch (error) {
    return { ok: false, message: `读取站点登录参数失败：${describeError(error)}` };
  }
  if (!clientId) return { ok: false, message: '站点未启用 GitHub 登录' };
  if (!state) return { ok: false, message: '站点未返回 OAuth state' };

  const authorize = new URL('/login/oauth/authorize', GITHUB_ORIGIN);
  authorize.search = new URLSearchParams({ client_id: clientId, scope: 'user:email', state }).toString();

  // Provider cookies only ever go to GitHub: the redirect is followed by hand,
  // so nothing is forwarded to the callback host.
  const github = await fetch(authorize, await siteRequestInit(String(authorize), {
    headers: {
      Accept: 'text/html',
      Cookie: imported.cookieHeader,
      'User-Agent': BROWSER_USER_AGENT,
    },
    redirect: 'manual',
  }));
  await github.body?.cancel();

  const location = github.headers.get('location');
  if (github.status === 200 || github.status === 401) {
    return { ok: false, message: 'GitHub 会话需要重新登录或重新授权' };
  }
  if ((github.status !== 302 && github.status !== 303) || !location) {
    return { ok: false, message: `GitHub 授权未完成（HTTP ${github.status}）` };
  }

  const callback = new URL(location, GITHUB_ORIGIN);
  const code = callback.searchParams.get('code');
  const site = new URL(baseUrl);
  if (
    callback.host !== site.host
    || callback.pathname !== GITHUB_CALLBACK_PATH
    || !code
    || callback.searchParams.get('state') !== state
  ) {
    return { ok: false, message: 'GitHub OAuth 回调校验失败' };
  }

  const completed = await fetch(`${baseUrl}/api/oauth/github?${new URLSearchParams({ code, state, mode: 'login' })}`,
    await siteRequestInit(baseUrl, { headers: { Accept: 'application/json' } }));
  const body = await completed.text();
  const sessionCookie = mergeSetCookieHeaders(readSetCookieHeaders(completed));
  let payload: any = null;
  try { payload = JSON.parse(body); } catch {}
  if (!completed.ok) {
    return { ok: false, message: `站点拒绝 GitHub 登录（HTTP ${completed.status}）` };
  }
  if (payload?.success !== true) {
    return {
      ok: false,
      message: typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : '站点未完成 GitHub 登录',
    };
  }
  if (!sessionCookie) {
    return { ok: false, message: 'GitHub 登录已返回成功，但站点没有下发会话 Cookie' };
  }

  const userId = Number(payload?.data?.id);
  return {
    ok: true,
    message: 'GitHub 重新登录成功',
    checkedIn: payload?.data?.checked_in === true,
    platformUserId: Number.isFinite(userId) && userId > 0 ? userId : undefined,
    sessionCookie,
  };
}

async function siteRequestInit(url: string, options: RequestInit = {}): Promise<RequestInit> {
  return withSiteProxyRequestInit(url, {
    ...options,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function fetchSiteJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url, await siteRequestInit(url, { headers: { Accept: 'application/json' } }));
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
  }
  try { return JSON.parse(text) as T; } catch { return null; }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
