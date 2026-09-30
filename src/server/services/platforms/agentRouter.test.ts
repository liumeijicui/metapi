import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, readSessionMock, linuxdoLoginMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  readSessionMock: vi.fn(),
  linuxdoLoginMock: vi.fn(),
}));

vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../assistedLogin/importedSession.js', () => ({ readImportedSession: readSessionMock }));
vi.mock('../assistedLogin/sites/agentRouter.js', () => ({
  loginAgentRouterWithLinuxDo: linuxdoLoginMock,
}));
vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
}));

import {
  AgentRouterAdapter,
  extractDailyReward,
  isDailyCheckinLogEntry,
} from './agentRouter.js';

const BASE_URL = 'https://agentrouter.org';
const CLAIM_CONTENT = '每日签到成功，增加额度 ＄25.000000 额度';
const GITHUB_EXTRA_CONFIG = JSON.stringify({ agentRouter: { provider: 'github' } });
const LINUXDO_EXTRA_CONFIG = JSON.stringify({ agentRouter: { provider: 'linuxdo' } });

const STATUS_PAYLOAD = {
  success: true,
  data: {
    github_oauth: true,
    github_client_id: 'github-client-id',
    linuxdo_oauth: true,
    linuxdo_client_id: 'linuxdo-client-id',
  },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String((input as { url?: string })?.url || input);
}

let logQueue: unknown[] = [];

function defaultLogResponse(): unknown {
  return { success: true, data: { page: 1, page_size: 20, total: 0, items: [] } };
}

function setupRoutes(overrides: { status?: unknown; state?: unknown; callback?: unknown } = {}): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = urlOf(input);
    if (url.startsWith('https://github.com/login/oauth/authorize')) {
      const state = new URL(url).searchParams.get('state') || '';
      return new Response(null, {
        status: 302,
        headers: { location: `${BASE_URL}/oauth/github?code=code-1&state=${state}` },
      });
    }
    if (url.includes('/api/log/self')) {
      const payload = logQueue.length > 1 ? logQueue.shift() : logQueue[0];
      return jsonResponse(payload ?? defaultLogResponse());
    }
    if (url.includes('/api/status')) return jsonResponse(overrides.status ?? STATUS_PAYLOAD);
    if (url.includes('/api/oauth/state')) {
      return jsonResponse(overrides.state ?? { success: true, data: 'state-token' });
    }
    if (url.includes('/api/oauth/github') || url.includes('/api/oauth/linuxdo')) {
      return jsonResponse(
        overrides.callback ?? { success: true, message: '', data: { id: 99102, checked_in: true } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function claimLogResponse(): unknown {
  return {
    success: true,
    data: {
      page: 1,
      page_size: 20,
      total: 1,
      items: [{ created_at: Math.floor(Date.now() / 1000) - 60, content: CLAIM_CONTENT }],
    },
  };
}

function githubAuthorizeCalls(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => urlOf(input))
    .filter((url) => url.startsWith('https://github.com/login/oauth/authorize'));
}

describe('AgentRouterAdapter', () => {
  let adapter: AgentRouterAdapter;

  beforeEach(() => {
    vi.resetAllMocks();
    logQueue = [defaultLogResponse()];
    adapter = new AgentRouterAdapter();
    readSessionMock.mockResolvedValue({ cookieHeader: 'user_session=github-session' });
    linuxdoLoginMock.mockResolvedValue({ ok: true, message: 'Linux.do 重新登录完成' });
    setupRoutes();
  });

  it('detects the agentrouter host only', async () => {
    expect(await adapter.detect(`${BASE_URL}/console`)).toBe(true);
    expect(await adapter.detect('https://example.com')).toBe(false);
  });

  it('reads the daily claim wording out of the system log', () => {
    expect(isDailyCheckinLogEntry(CLAIM_CONTENT)).toBe(true);
    expect(isDailyCheckinLogEntry('登录成功')).toBe(false);
    expect(extractDailyReward(CLAIM_CONTENT)).toBe('25');
    expect(extractDailyReward('')).toBeUndefined();
  });

  it('requires the provider to be declared on the account', async () => {
    const result = await adapter.checkin(BASE_URL, 'session-token', 99102, { extraConfig: '{}' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('agentRouter.provider');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an already claimed day without logging in again', async () => {
    logQueue = [claimLogResponse()];

    const result = await adapter.checkin(BASE_URL, 'session-token', 99102, {
      extraConfig: GITHUB_EXTRA_CONFIG,
    });

    expect(result.message).toContain('今日已签到');
    expect(githubAuthorizeCalls()).toHaveLength(0);
  });

  it('claims the daily quota by replaying the GitHub login', async () => {
    logQueue = [defaultLogResponse(), claimLogResponse()];

    const result = await adapter.checkin(BASE_URL, 'session-token', 99102, {
      extraConfig: GITHUB_EXTRA_CONFIG,
    });

    expect(result.success).toBe(true);
    expect(result.reward).toBe('25');
    expect(result.message).toContain('第 1 次');
    expect(githubAuthorizeCalls()).toHaveLength(1);
    expect(githubAuthorizeCalls()[0]).toContain('client_id=github-client-id');
  });

  it('gives up after five logins that never land in the log', async () => {
    setupRoutes({ callback: { success: true, message: '', data: { id: 99102, checked_in: false } } });

    const result = await adapter.checkin(BASE_URL, 'session-token', 99102, {
      extraConfig: GITHUB_EXTRA_CONFIG,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('连续 5 次');
    expect(githubAuthorizeCalls()).toHaveLength(5);
  });

  it('falls back to the login verdict when the log cannot be read', async () => {
    fetchMock.mockImplementation(async (input: unknown) => {
      const url = urlOf(input);
      if (url.startsWith('https://github.com/login/oauth/authorize')) {
        const state = new URL(url).searchParams.get('state') || '';
        return new Response(null, {
          status: 302,
          headers: { location: `${BASE_URL}/oauth/github?code=code-1&state=${state}` },
        });
      }
      if (url.includes('/api/log/self')) {
        return new Response('<html>waf</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.includes('/api/status')) return jsonResponse(STATUS_PAYLOAD);
      if (url.includes('/api/oauth/state')) {
        return jsonResponse({ success: true, data: 'state-token' });
      }
      if (url.includes('/api/oauth/github')) {
        return jsonResponse({ success: true, message: '', data: { id: 99102, checked_in: true } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const result = await adapter.checkin(BASE_URL, 'session-token', 99102, {
      extraConfig: GITHUB_EXTRA_CONFIG,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('登录响应');
  });

  it('drives the Linux.do login for linuxdo accounts', async () => {
    logQueue = [defaultLogResponse(), claimLogResponse()];

    const result = await adapter.checkin(BASE_URL, 'session-token', 116261, {
      extraConfig: LINUXDO_EXTRA_CONFIG,
    });

    expect(result.success).toBe(true);
    expect(githubAuthorizeCalls()).toHaveLength(0);
    expect(linuxdoLoginMock).toHaveBeenCalledTimes(1);
    expect(linuxdoLoginMock.mock.calls[0][0]).toEqual({
      baseUrl: BASE_URL,
      clientId: 'linuxdo-client-id',
      expectedUserId: 116261,
    });
  });

  it('surfaces a failed Linux.do browser login', async () => {
    linuxdoLoginMock.mockResolvedValue({ ok: false, message: 'Linux.do 重新登录失败：Cloudflare 未通过' });

    const result = await adapter.checkin(BASE_URL, 'session-token', 116261, {
      extraConfig: LINUXDO_EXTRA_CONFIG,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('Cloudflare 未通过');
    expect(linuxdoLoginMock).toHaveBeenCalledTimes(5);
  });
});
