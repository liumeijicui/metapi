import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, readSessionMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  readSessionMock: vi.fn(),
}));

vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../importedSession.js', () => ({ readImportedSession: readSessionMock }));
vi.mock('../../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
  withExplicitProxyRequestInit: (_proxy: string, options: unknown) => options,
}));

import {
  captureNewApiGithubCredentials,
  captureNewApiGithubCredentialsOnce,
  supportsNewApiGithubOauth,
} from './newApiGithubOauthRelogin.js';

const ORIGIN = 'https://seekai.example';
const CALLBACK = `${ORIGIN}/oauth/github?code=authorization-code&state=flow-token&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth`;

function mockFlow(callback = CALLBACK) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    success: true, data: { github_oauth: true, github_client_id: 'site-client-id' },
  })));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    success: true, data: { flow_token: 'flow-token' },
  })));
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: callback } }));
}

function mockCompletedLogin() {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    success: true, data: { user: { id: 8245, username: 'liumeijicui' }, access_token: 'short-lived-access' },
  }), { headers: { 'set-cookie': 'new_api_refresh=rotating-refresh; Path=/api/user/auth; HttpOnly; Secure' } }));
}

describe('New API GitHub HTTP login', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readSessionMock.mockResolvedValue({ cookieHeader: 'user_session=github-session' });
  });

  it('accepts any plain HTTPS origin and rejects everything else', () => {
    expect(supportsNewApiGithubOauth(ORIGIN, 'github')).toBe(true);
    expect(supportsNewApiGithubOauth(`${ORIGIN}/`, 'github')).toBe(true);
    expect(supportsNewApiGithubOauth(ORIGIN, 'linuxdo')).toBe(false);
    for (const url of ['http://seekai.example', `${ORIGIN}:444`, 'https://user@seekai.example', 'not-a-url', '']) {
      expect(supportsNewApiGithubOauth(url, 'github')).toBe(false);
    }
  });

  it('captures the refresh cookie the site hands the callback, never sending provider cookies onward', async () => {
    mockFlow();
    mockCompletedLogin();

    const result = await captureNewApiGithubCredentialsOnce(ORIGIN);

    expect(result).toMatchObject({
      status: 'captured',
      credentials: {
        accessToken: 'new_api_refresh=rotating-refresh',
        platformUserId: 8245,
        username: 'liumeijicui',
        source: 'cookie',
        harvestedKeys: ['new_api_refresh'],
      },
    });
    const requests = fetchMock.mock.calls.map(([url, options]) => ({ url: new URL(String(url)), options }));
    expect(requests[0].url.toString()).toBe(`${ORIGIN}/api/status`);
    expect(requests[1].url.toString()).toBe(`${ORIGIN}/api/oauth/state`);
    expect(requests[1].options).toMatchObject({ method: 'POST', body: JSON.stringify({ provider: 'github', intent: 'login' }) });
    expect(requests[2].url.origin).toBe('https://github.com');
    expect(requests[2].url.searchParams.get('state')).toBe('flow-token');
    expect(requests[2].url.searchParams.get('client_id')).toBe('site-client-id');
    expect(requests[2].options.headers.Cookie).toBe('user_session=github-session');
    for (const request of requests.filter(({ url }) => url.origin === ORIGIN)) {
      expect(request.options.headers.Cookie).toBeUndefined();
    }
    expect(requests[3].url.pathname).toBe('/api/oauth/github');
    expect(requests[3].url.searchParams.get('code')).toBe('authorization-code');
  });

  it('rejects a callback that points at another origin or a mismatched state', async () => {
    for (const callback of [
      'https://evil.example.com/oauth/github?code=code&state=flow-token',
      `${ORIGIN}/oauth/github?code=code&state=wrong-state`,
      `${ORIGIN}/oauth/github?code=code&state=flow-token&iss=https://evil.example.com`,
    ]) {
      vi.resetAllMocks();
      readSessionMock.mockResolvedValue({ cookieHeader: 'user_session=github-session' });
      mockFlow(callback);
      const result = await captureNewApiGithubCredentialsOnce(ORIGIN);
      expect(result).toMatchObject({ status: 'timeout', credentials: null });
      expect(result.message).toContain('校验失败');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    }
  });

  it('reports the missing provider session without touching the site', async () => {
    readSessionMock.mockResolvedValue(null);
    expect(await captureNewApiGithubCredentials(ORIGIN)).toMatchObject({
      status: 'needs_provider_login',
      credentials: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a site without GitHub sign-in instead of throwing', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      success: true, data: { github_oauth: false },
    })));
    expect(await captureNewApiGithubCredentialsOnce(ORIGIN)).toMatchObject({
      status: 'login_button_not_found',
      credentials: null,
    });
  });

  it('surfaces an unusable site address as a verdict, not an exception', async () => {
    expect(await captureNewApiGithubCredentialsOnce('not-a-url')).toMatchObject({
      status: 'timeout',
      credentials: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
