import { fetch, type RequestInit } from 'undici';
import { config } from '../../../config.js';
import { withExplicitProxyRequestInit, withSiteProxyRequestInit } from '../../siteProxy.js';
import { readImportedSession } from '../importedSession.js';
import type { AssistedLoginProviderId, CaptureResult } from '../types.js';

const SITE_ORIGIN = 'https://ai.hyper.nyc.mn';
const GITHUB_ORIGIN = 'https://github.com';
const REQUEST_TIMEOUT_MS = 20_000;

/** Hyper uses POST flow tokens and a rotating refresh cookie instead of the legacy OAuth state API. */
export function supportsHyperGithubLogin(siteUrl: string, provider: AssistedLoginProviderId): boolean {
  try {
    const url = new URL(siteUrl);
    return provider === 'github' && url.origin === SITE_ORIGIN && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function requestSiteJson<T>(path: string, options: RequestInit = {}) {
  const url = new URL(path, SITE_ORIGIN).toString();
  const response = await fetch(url, await withSiteProxyRequestInit(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Origin: SITE_ORIGIN,
      Referer: `${SITE_ORIGIN}/sign-in`,
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

/** Reuses an already-authorized GitHub session without launching a managed browser. */
async function captureHyperGithubCredentialsOnce(): Promise<CaptureResult> {
  const imported = await readImportedSession('github');
  if (!imported) {
    return { status: 'needs_provider_login', credentials: null, message: '请先导入 GitHub 会话后重试' };
  }

  try {
    const status = await requestSiteJson<{ github_oauth?: boolean; github_client_id?: string }>('/api/status');
    const clientId = status.data.github_client_id;
    if (!status.data.github_oauth || typeof clientId !== 'string' || !clientId.trim()) {
      return { status: 'login_button_not_found', credentials: null, message: '该站点未启用 GitHub 登录' };
    }
    const flow = await requestSiteJson<{ flow_token?: string }>('/api/oauth/state', {
      method: 'POST',
      body: JSON.stringify({ provider: 'github', intent: 'login' }),
    });
    const state = flow.data.flow_token;
    if (typeof state !== 'string' || !state) throw new Error('站点未返回 OAuth flow_token');

    const authorize = new URL('/login/oauth/authorize', GITHUB_ORIGIN);
    authorize.search = new URLSearchParams({ client_id: clientId, scope: 'user:email', state }).toString();
    // Provider cookies only go to GitHub. Never forward them while following a redirect.
    const github = await fetch(authorize, withExplicitProxyRequestInit(config.systemProxyUrl, {
      headers: { Accept: 'text/html', Cookie: imported.cookieHeader, 'User-Agent': 'Mozilla/5.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }));
    await github.body?.cancel();
    const location = github.headers.get('location');
    if (github.status === 200 || github.status === 401) {
      return {
        status: 'needs_provider_login', credentials: null,
        message: 'GitHub 需要重新登录或首次授权；请在该站点完成一次 GitHub 登录，并确认导入会话仍有效',
        url: `${SITE_ORIGIN}/sign-in`,
      };
    }
    if (![302, 303].includes(github.status) || !location) {
      throw new Error(`GitHub 授权请求未完成（HTTP ${github.status}）`);
    }
    const callback = new URL(location, GITHUB_ORIGIN);
    if (callback.origin === GITHUB_ORIGIN && callback.pathname === '/login') {
      return { status: 'needs_provider_login', credentials: null, message: 'GitHub 会话已失效，请重新导入会话' };
    }
    if (callback.origin !== SITE_ORIGIN || callback.pathname !== '/oauth/github'
      || callback.searchParams.get('state') !== state
      || callback.searchParams.getAll('state').length !== 1
      || callback.searchParams.getAll('code').length !== 1
      || !callback.searchParams.get('code')
      || (callback.searchParams.has('iss')
        && ![GITHUB_ORIGIN, `${GITHUB_ORIGIN}/login/oauth`].includes(callback.searchParams.get('iss')!))) {
      throw new Error('GitHub OAuth 回调地址或 state 校验失败');
    }

    const query = new URLSearchParams({ code: callback.searchParams.get('code')!, state });
    const completed = await requestSiteJson<{ user?: { id?: number; username?: string } }>(`/api/oauth/github?${query}`);
    const user = completed.data.user;
    const refreshCookie = completed.headers.getSetCookie()
      .map((cookie) => cookie.split(';')[0].trim())
      .find((cookie) => cookie.startsWith('new_api_refresh=') && cookie.length > 'new_api_refresh='.length);
    if (!refreshCookie || !Number.isSafeInteger(user?.id) || Number(user?.id) <= 0) {
      throw new Error('站点未返回完整的账号信息或刷新 Cookie');
    }
    // The existing NewApiAdapter exchanges and persists each rotated refresh value.
    return {
      status: 'captured',
      url: `${SITE_ORIGIN}/`,
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
      message: `澎湃AI网关登录未完成：${error instanceof Error ? error.message : '请求失败'}`,
    };
  }
}

/**
 * Every `needs_provider_login` this handshake can report means the same thing:
 * the GitHub session the handoff rides on is not usable. When the operator has
 * stored a GitHub password, the managed browser can earn a fresh session and the
 * handshake is retried once; without credentials the original verdict is
 * returned untouched so the page still asks for a manual import.
 */
export async function captureHyperGithubCredentials(): Promise<CaptureResult> {
  const first = await captureHyperGithubCredentialsOnce();
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
    // Keep the site's own verdict, but surface why the self-heal did not run so
    // the page does not only suggest the manual import.
    return renewed.skipped
      ? first
      : { ...first, message: `${first.message || 'GitHub 会话不可用'}（自动重新登录失败：${renewed.message}）` };
  }

  return captureHyperGithubCredentialsOnce();
}
