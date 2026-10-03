/**
 * GitHub sign-in for New API sites, replayed over plain HTTP.
 *
 * A site whose sign-in is a GitHub redirect has no password form to drive, so
 * once its stored session dies the only ways back in are the provider handshake
 * or a headed browser. The handshake is by far the cheaper of the two: the
 * GitHub session the operator already imported is presented to GitHub's
 * authorize endpoint, and the callback the site answers with sets the same
 * `new_api_refresh` cookie the accounts table already knows how to exchange.
 *
 * New API 的 rc 版本把这条链路标准化了（`POST /api/oauth/state` 取
 * `flow_token`、`/oauth/github` 收授权码），所以这里不需要按站点写死：凡是
 * `/api/status` 报了 `github_oauth` 且带 `github_client_id` 的站点都能用。
 * `hyper.ts` 曾经是这条逻辑的唯一入口，现在它只是把本站 origin 传进来的一份
 * 薄封装。
 */
import { fetch, type RequestInit } from 'undici';
import { config } from '../../../config.js';
import { withExplicitProxyRequestInit, withSiteProxyRequestInit } from '../../siteProxy.js';
import { readImportedSession } from '../importedSession.js';
import type { AssistedLoginProviderId, CaptureResult } from '../types.js';

const GITHUB_ORIGIN = 'https://github.com';
const REQUEST_TIMEOUT_MS = 20_000;

/** GitHub's own issuer value, in both the short and long spelling. */
const GITHUB_ISSUERS = [GITHUB_ORIGIN, `${GITHUB_ORIGIN}/login/oauth`];

/**
 * Whether this site is a candidate for the HTTP handshake.
 *
 * Only the URL shape is judged here — whether the site actually offers GitHub
 * sign-in is answered by the handshake itself reading `/api/status`, because a
 * probe cannot be answered synchronously and callers decide whether to spend a
 * request at all.
 */
export function supportsNewApiGithubOauth(
  siteUrl: string,
  provider: AssistedLoginProviderId = 'github',
): boolean {
  try {
    const url = new URL(siteUrl);
    return provider === 'github'
      && url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && !!url.hostname;
  } catch {
    return false;
  }
}

/** One site call, with the site's own proxy settings and no provider cookies. */
async function requestSiteJson<T>(origin: string, path: string, options: RequestInit = {}) {
  const url = new URL(path, origin).toString();
  const response = await fetch(url, await withSiteProxyRequestInit(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: origin,
      Referer: `${origin}/sign-in`,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`站点请求失败（HTTP ${response.status}）`);
  }
  const payload = await response.json().catch(() => null) as { success?: boolean; data?: T } | null;
  if (payload?.success !== true || !payload.data) {
    throw new Error('站点未返回有效的登录数据');
  }
  return { data: payload.data, headers: response.headers };
}

/**
 * Runs the handshake once. A missing or retired provider session is a verdict
 * rather than an error, so the caller can tell the operator to re-import it.
 */
export async function captureNewApiGithubCredentialsOnce(siteUrl: string): Promise<CaptureResult> {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return { status: 'timeout', credentials: null, message: '站点地址无效，无法执行 GitHub 登录' };
  }

  const imported = await readImportedSession('github');
  if (!imported) {
    return { status: 'needs_provider_login', credentials: null, message: '请先导入 GitHub 会话后重试' };
  }

  try {
    const status = await requestSiteJson<{ github_oauth?: boolean; github_client_id?: string }>(origin, '/api/status');
    const clientId = status.data.github_client_id;
    if (!status.data.github_oauth || typeof clientId !== 'string' || !clientId.trim()) {
      return { status: 'login_button_not_found', credentials: null, message: '该站点未启用 GitHub 登录' };
    }
    const flow = await requestSiteJson<{ flow_token?: string }>(origin, '/api/oauth/state', {
      method: 'POST',
      body: JSON.stringify({ provider: 'github', intent: 'login' }),
    });
    const state = flow.data.flow_token;
    if (typeof state !== 'string' || !state) throw new Error('站点未返回 OAuth flow_token');

    const authorize = new URL('/login/oauth/authorize', GITHUB_ORIGIN);
    authorize.search = new URLSearchParams({ client_id: clientId, scope: 'user:email', state }).toString();
    // Provider cookies only go to GitHub. Never forward them while following a redirect.
    const github = await fetch(authorize, await withExplicitProxyRequestInit(config.systemProxyUrl, {
      headers: { Accept: 'text/html', Cookie: imported.cookieHeader, 'User-Agent': 'Mozilla/5.0' },
      redirect: 'manual',
    }));
    await github.body?.cancel();
    const location = github.headers.get('location');
    if (github.status === 200 || github.status === 401) {
      return {
        status: 'needs_provider_login', credentials: null,
        message: 'GitHub 需要重新登录或首次授权；请在该站点完成一次 GitHub 登录，并确认导入会话仍有效',
        url: `${origin}/sign-in`,
      };
    }
    if (![302, 303].includes(github.status) || !location) {
      throw new Error(`GitHub 授权请求未完成（HTTP ${github.status}）`);
    }
    const callback = new URL(location, GITHUB_ORIGIN);
    if (callback.origin === GITHUB_ORIGIN && callback.pathname === '/login') {
      return { status: 'needs_provider_login', credentials: null, message: 'GitHub 会话已失效，请重新导入会话' };
    }
    if (callback.origin !== origin || callback.pathname !== '/oauth/github'
      || callback.searchParams.get('state') !== state
      || callback.searchParams.getAll('state').length !== 1
      || callback.searchParams.getAll('code').length !== 1
      || !callback.searchParams.get('code')
      || (callback.searchParams.has('iss')
        && !GITHUB_ISSUERS.includes(callback.searchParams.get('iss')!))) {
      throw new Error('GitHub OAuth 回调地址或 state 校验失败');
    }

    const query = new URLSearchParams({ code: callback.searchParams.get('code')!, state });
    const completed = await requestSiteJson<{ user?: { id?: number; username?: string } }>(origin, `/api/oauth/github?${query}`);
    const user = completed.data.user;
    const refreshCookie = completed.headers.getSetCookie()
      .map((cookie) => cookie.split(';')[0].trim())
      .find((cookie) => cookie.startsWith('new_api_refresh=') && cookie.length > 'new_api_refresh='.length);
    if (!refreshCookie || !Number.isSafeInteger(user?.id) || Number(user?.id) <= 0) {
      throw new Error('站点未返回完整的账号信息或刷新 Cookie');
    }
    // The NewApiAdapter exchanges and persists each rotated refresh value, so the
    // cookie is handed over as-is instead of being spent here.
    return {
      status: 'captured',
      url: `${origin}/`,
      credentials: {
        accessToken: refreshCookie,
        refreshToken: null,
        tokenExpiresAt: null,
        username: typeof user?.username === 'string' ? user.username : null,
        platformUserId: user!.id!,
        source: 'cookie',
        harvestedKeys: ['new_api_refresh'],
      },
    };
  } catch (error) {
    return {
      status: 'timeout', credentials: null,
      message: `GitHub 登录未完成：${error instanceof Error ? error.message : '请求失败'}`,
    };
  }
}

/**
 * The handshake, plus one self-heal.
 *
 * A dead GitHub session is the one failure the machine can repair on its own
 * when the operator stored a password: renewing it in the managed browser and
 * retrying the handshake is what keeps these accounts alive without a manual
 * cookie import.
 */
export async function captureNewApiGithubCredentials(siteUrl: string): Promise<CaptureResult> {
  const first = await captureNewApiGithubCredentialsOnce(siteUrl);
  if (first.status !== 'needs_provider_login') return first;

  // A self-heal that fails must degrade to the original verdict, never replace
  // it with an exception: the page still has the manual-import fallback.
  const renewed = await import('./githubPasswordLogin.js')
    .then((module) => module.renewGitHubSessionIfConfigured())
    .catch((error) => ({
      ok: false,
      skipped: false,
      message: error instanceof Error ? error.message : '自动重新登录不可用',
    }));
  if (!renewed.ok) {
    return renewed.skipped
      ? first
      : { ...first, message: `${first.message || 'GitHub 会话不可用'}（自动重新登录失败：${renewed.message}）` };
  }

  return captureNewApiGithubCredentialsOnce(siteUrl);
}
