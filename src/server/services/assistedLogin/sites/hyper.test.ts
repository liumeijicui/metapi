import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, readSessionMock, getSiteMock, ensureBrowserMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  readSessionMock: vi.fn(),
  getSiteMock: vi.fn(),
  ensureBrowserMock: vi.fn(),
}));

vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../importedSession.js', () => ({ readImportedSession: readSessionMock }));
vi.mock('../../siteProxy.js', () => ({
  UNLIMITED_BODY_TIMEOUT: { bodyTimeout: 0 },
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
  withExplicitProxyRequestInit: (_proxy: string, options: unknown) => options,
}));
vi.mock('../../../db/index.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ get: getSiteMock }) }) }) },
  schema: { sites: { id: 'id' } },
}));
vi.mock('../browserManager.js', () => ({
  createManagedBrowser: () => ({ ensureManagedBrowserContext: ensureBrowserMock }),
}));

import { captureHyperGithubCredentials, supportsHyperGithubLogin } from './hyper.js';
import { createAssistedLoginSession } from '../sessionService.js';
import { gitHubProvider } from '../providers/github.js';

const ORIGIN = 'https://ai.hyper.nyc.mn';
const CALLBACK = `${ORIGIN}/oauth/github?code=authorization-code&state=flow-token&iss=https%3A%2F%2Fgithub.com%2Flogin%2Foauth`;

function mockFlow(callback = CALLBACK) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    success: true, data: { github_oauth: true, github_client_id: 'hyper-client-id' },
  })));
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    success: true, data: { flow_token: 'flow-token' },
  })));
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: callback } }));
}

function mockCompletedLogin() {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    success: true, data: { user: { id: 958, username: 'test-user' }, access_token: 'short-lived-access' },
  }), { headers: { 'set-cookie': 'new_api_refresh=rotating-refresh; Path=/api/user/auth; HttpOnly; Secure' } }));
}

describe('Hyper GitHub HTTP login', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readSessionMock.mockResolvedValue({ cookieHeader: 'user_session=github-session' });
    getSiteMock.mockResolvedValue({ id: 1, url: ORIGIN, platform: 'new-api' });
  });

  it('matches only the exact HTTPS site and GitHub provider', () => {
    expect(supportsHyperGithubLogin(`${ORIGIN}/`, 'github')).toBe(true);
    expect(supportsHyperGithubLogin(ORIGIN, 'linuxdo')).toBe(false);
    for (const url of ['http://ai.hyper.nyc.mn', `${ORIGIN}.example.com`, `${ORIGIN}:444`, 'https://user@ai.hyper.nyc.mn', 'invalid']) {
      expect(supportsHyperGithubLogin(url, 'github')).toBe(false);
    }
  });

  it('captures a reusable refresh cookie and keeps the GitHub cookie off site requests', async () => {
    mockFlow();
    mockCompletedLogin();
    const result = await captureHyperGithubCredentials();

    expect(result).toMatchObject({
      status: 'captured',
      credentials: { accessToken: 'new_api_refresh=rotating-refresh', platformUserId: 958, username: 'test-user', source: 'cookie' },
    });
    const requests = fetchMock.mock.calls.map(([url, options]) => ({ url: new URL(String(url)), options }));
    expect(requests[1].options).toMatchObject({ method: 'POST', body: JSON.stringify({ provider: 'github', intent: 'login' }) });
    expect(requests[2].url.searchParams.get('state')).toBe('flow-token');
    expect(requests[2].url.searchParams.get('scope')).toBe('user:email');
    expect(requests[2].options.headers.Cookie).toBe('user_session=github-session');
    for (const request of requests.filter(({ url }) => url.origin === ORIGIN)) {
      expect(request.options.headers.Cookie).toBeUndefined();
      expect(request.options.redirect).toBe('manual');
    }
    expect(requests[3].url.pathname).toBe('/api/oauth/github');
    expect(requests[3].url.searchParams.get('code')).toBe('authorization-code');
  });

  it('accepts the GitHub origin issuer used by older callbacks', async () => {
    mockFlow(CALLBACK.replace('%2Flogin%2Foauth', ''));
    mockCompletedLogin();
    expect(await captureHyperGithubCredentials()).toMatchObject({ status: 'captured' });
  });

  it('uses the HTTP branch for capture and skips browser cookie synchronization', async () => {
    mockFlow();
    mockCompletedLogin();
    const session = createAssistedLoginSession({
      provider: gitHubProvider,
      profileDirName: 'github-test',
      executableEnvVar: 'GITHUB_BROWSER_PATH',
      missingBrowserMessage: () => 'No browser',
      watchStateSettingKey: 'github_watch',
      watchEnabledSettingKey: 'github_enabled',
    });
    expect((await session.captureSiteCredentials({ siteId: 1 })).status).toBe('captured');
    expect(await session.updateSiteCredentialCookie({ siteUrl: ORIGIN, name: 'new_api_refresh', value: 'rotated' })).toBe(false);
    expect(ensureBrowserMock).not.toHaveBeenCalled();
  });

  it('requests an import when the provider session is missing', async () => {
    readSessionMock.mockResolvedValue(null);
    expect(await captureHyperGithubCredentials()).toMatchObject({ status: 'needs_provider_login', credentials: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'https://other.example.com/oauth/github?code=code&state=flow-token',
    `${ORIGIN}/oauth/github?code=code&state=wrong-state`,
    `${CALLBACK}&state=flow-token`,
    `${ORIGIN}/oauth/github?code=code&state=flow-token&iss=https://other.example.com`,
  ])('rejects an untrusted callback without making another request: %s', async (callback) => {
    mockFlow(callback);
    const result = await captureHyperGithubCredentials();
    expect(result).toMatchObject({ status: 'timeout', credentials: null });
    expect(result.message).toContain('校验失败');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports required GitHub interaction without silently approving a consent page', async () => {
    mockFlow();
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { github_oauth: true, github_client_id: 'client' } })));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { flow_token: 'flow-token' } })));
    fetchMock.mockResolvedValueOnce(new Response('<html>Authorize application</html>'));
    expect(await captureHyperGithubCredentials()).toMatchObject({ status: 'needs_provider_login', credentials: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps temporary GitHub throttling separate from an expired session', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { github_oauth: true, github_client_id: 'client' } })));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { flow_token: 'flow-token' } })));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
    const result = await captureHyperGithubCredentials();
    expect(result).toMatchObject({ status: 'timeout', credentials: null });
    expect(result.message).toContain('HTTP 429');
  });
});
