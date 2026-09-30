import { beforeEach, describe, expect, it, vi } from 'vitest';

const { ensureBrowserMock } = vi.hoisted(() => ({ ensureBrowserMock: vi.fn() }));

vi.mock('../browserManager.js', () => ({
  createManagedBrowser: () => ({ ensureManagedBrowserContext: ensureBrowserMock }),
}));
vi.mock('../../../db/index.js', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ get: vi.fn() }) }) }) },
  schema: { sites: { id: 'id' }, settings: { key: 'key' } },
}));

import {
  isAgentRouterSite,
  isLinuxDoAuthorizeUrl,
  judgeAgentRouterCallback,
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
    });
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
