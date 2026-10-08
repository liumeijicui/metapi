import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureBrowserMock, fetchMock, readSessionMock, harvestMock } = vi.hoisted(() => ({
  ensureBrowserMock: vi.fn(),
  fetchMock: vi.fn(),
  readSessionMock: vi.fn(),
  harvestMock: vi.fn(),
}));

vi.mock('../browserManager.js', () => ({
  createManagedBrowser: () => ({ ensureManagedBrowserContext: ensureBrowserMock }),
}));
vi.mock('../../../db/index.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ get: vi.fn() }) }) }) },
  schema: { sites: { id: 'id' }, settings: { key: 'key' } },
}));
vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../importedSession.js', () => ({ readImportedSession: readSessionMock }));
vi.mock('../../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
}));
vi.mock('../../linuxdoSession/sessionService.js', () => ({
  harvestLinuxDoSiteCredential: harvestMock,
}));

import {
  isAgentRouterSite,
  isLinuxDoAuthorizeUrl,
  judgeAgentRouterCallback,
  loginAgentRouterWithGitHub,
  mergeSetCookieHeaders,
} from './agentRouter.js';

function callbackBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    message: '',
    data: { id: 116261, username: 'linuxdo_116260' },
    ...overrides,
  });
}

describe('agentrouter Linux.do login guards', () => {
  it('only accepts the agentrouter host over https', () => {
    expect(isAgentRouterSite('https://agentrouter.org')).toBe(true);
    expect(isAgentRouterSite('https://agentrouter.org/console')).toBe(true);
    for (const url of ['http://agentrouter.org', 'https://agentrouter.org.evil.test', 'https://example.com', 'invalid']) {
      expect(isAgentRouterSite(url)).toBe(false);
    }
  });

  it('only accepts the connect.linux.do authorize endpoint', () => {
    expect(isLinuxDoAuthorizeUrl('https://connect.linux.do/oauth2/authorize?client_id=a')).toBe(true);
    expect(isLinuxDoAuthorizeUrl('https://connect.linux.do/oauth2/token')).toBe(false);
    expect(isLinuxDoAuthorizeUrl('https://linux.do/oauth2/authorize')).toBe(false);
  });
});

describe('judgeAgentRouterCallback', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('accepts a matching successful login', () => {
    expect(judgeAgentRouterCallback(200, callbackBody(), 116261)).toEqual({
      ok: true,
      message: 'Linux.do 重新登录完成',
      checkedIn: false,
    });
  });

  it('reports the daily grant the login handler performed', () => {
    const body = JSON.stringify({ success: true, data: { id: 116261, checked_in: true } });
    expect(judgeAgentRouterCallback(200, body, 116261).checkedIn).toBe(true);
  });

  it('surfaces the bind rejection the site returns while a session is active', () => {
    const verdict = judgeAgentRouterCallback(200, JSON.stringify({ message: '该 Linux DO 账户已被绑定', success: false }), 116261);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('该 Linux DO 账户已被绑定');
  });

  it('surfaces the session-bound state rejection', () => {
    const verdict = judgeAgentRouterCallback(403, JSON.stringify({ message: 'state is empty or not same', success: false }), 116261);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('state is empty or not same');
  });

  it('refuses a login that landed on another account', () => {
    const verdict = judgeAgentRouterCallback(200, callbackBody(), 99102);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('116261');
  });

  it('tolerates a callback that does not report an id', () => {
    expect(judgeAgentRouterCallback(200, JSON.stringify({ success: true, data: {} }), 116261).ok).toBe(true);
  });

  it('does not treat an unparseable body as success', () => {
    expect(judgeAgentRouterCallback(200, '<!doctype html>', 116261).ok).toBe(false);
  });
});

describe('agentrouter GitHub login replay', () => {
  const BASE = 'https://agentrouter.org';
  const STATUS = {
    success: true,
    data: { github_oauth: true, github_client_id: 'github-client-id' },
  };

  function jsonResponse(body: unknown, status = 200, setCookies: string[] = []): Response {
    const headers = new Headers({ 'content-type': 'application/json' });
    for (const cookie of setCookies) headers.append('set-cookie', cookie);
    return new Response(JSON.stringify(body), { status, headers });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    readSessionMock.mockResolvedValue({ cookieHeader: 'user_session=imported' });
    harvestMock.mockResolvedValue(null);
  });

  it('replays the handshake and keeps the session the callback set', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as URL).toString());
      if (url.includes('/api/status')) return jsonResponse(STATUS);
      if (url.includes('/api/oauth/state')) return jsonResponse({ success: true, data: 'state-token' });
      if (url.startsWith('https://github.com/login/oauth/authorize')) {
        return new Response(null, {
          status: 302,
          headers: { location: `${BASE}/oauth/github?code=code-1&state=state-token` },
        });
      }
      if (url.includes('/api/oauth/github')) {
        return jsonResponse(
          { success: true, message: '', data: { id: 99102, checked_in: true } },
          200,
          ['acw_tc=token-1; Path=/', 'session=session-value; Path=/'],
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await loginAgentRouterWithGitHub({ baseUrl: BASE });

    expect(result.ok).toBe(true);
    expect(result.checkedIn).toBe(true);
    expect(result.platformUserId).toBe(99102);
    expect(result.sessionCookie).toBe('acw_tc=token-1; session=session-value');
  });

  it('reports a refused callback body instead of a session', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as URL).toString());
      if (url.includes('/api/status')) return jsonResponse(STATUS);
      if (url.includes('/api/oauth/state')) return jsonResponse({ success: true, data: 'state-token' });
      if (url.startsWith('https://github.com/login/oauth/authorize')) {
        return new Response(null, {
          status: 302,
          headers: { location: `${BASE}/oauth/github?code=code-1&state=state-token` },
        });
      }
      if (url.includes('/api/oauth/github')) {
        return jsonResponse({ success: false, message: '该 Linux DO 账户已被绑定' });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await loginAgentRouterWithGitHub({ baseUrl: BASE });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('已被绑定');
    expect(result.sessionCookie).toBeUndefined();
  });

  it('refuses a callback that landed on the wrong host', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = typeof input === 'string' ? input : String((input as URL).toString());
      if (url.includes('/api/status')) return jsonResponse(STATUS);
      if (url.includes('/api/oauth/state')) return jsonResponse({ success: true, data: 'state-token' });
      if (url.startsWith('https://github.com/login/oauth/authorize')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.test/oauth/github?code=code-1&state=state-token' },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await loginAgentRouterWithGitHub({ baseUrl: BASE });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('回调校验失败');
  });

  it('will not run against a host that is not agentrouter', async () => {
    const result = await loginAgentRouterWithGitHub({ baseUrl: 'https://example.com' });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('mergeSetCookieHeaders', () => {
  it('keeps the last value of every cookie and drops attributes', () => {
    expect(mergeSetCookieHeaders([
      'session=old; Path=/; HttpOnly',
      'acw_tc=token; Path=/',
      'session=new; Path=/; SameSite=Lax',
    ])).toBe('session=new; acw_tc=token');
  });

  it('ignores empty and malformed entries', () => {
    expect(mergeSetCookieHeaders(['', 'no-equals', 'a='])).toBe('');
  });
});
