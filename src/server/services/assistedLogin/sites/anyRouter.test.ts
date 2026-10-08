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
  isAnyRouterSite,
  judgeAnyRouterCallback,
  loginAnyRouterWithLinuxDo,
} from './anyRouter.js';

function callbackBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    success: true,
    message: '',
    data: { id: 166294, username: 'linuxdo_166294' },
    ...overrides,
  });
}

describe('anyrouter Linux.do login guards', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('only accepts the anyrouter host over https', () => {
    expect(isAnyRouterSite('https://anyrouter.top')).toBe(true);
    expect(isAnyRouterSite('https://anyrouter.top/console/token')).toBe(true);
    for (const url of ['http://anyrouter.top', 'https://anyrouter.top.evil.test', 'https://example.com', 'invalid']) {
      expect(isAnyRouterSite(url)).toBe(false);
    }
  });

  it('refuses to sign out of a site that is not anyrouter', async () => {
    const result = await loginAnyRouterWithLinuxDo({
      baseUrl: 'https://agentrouter.org',
      clientId: 'client-id',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('仅允许对 anyrouter.top');
    expect(ensureBrowserMock).not.toHaveBeenCalled();
  });


});

describe('judgeAnyRouterCallback', () => {
  it('accepts a matching successful login', () => {
    expect(judgeAnyRouterCallback(200, callbackBody(), 166294)).toEqual({
      ok: true,
      message: 'Linux.do 重新登录完成',
      checkedIn: false,
    });
  });

  it('surfaces the bind rejection the site returns while a session is active', () => {
    const verdict = judgeAnyRouterCallback(
      200,
      JSON.stringify({ message: '该 Linux DO 账户已被绑定', success: false }),
      166294,
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('该 Linux DO 账户已被绑定');
  });

  it('refuses a login that landed on another account', () => {
    const verdict = judgeAnyRouterCallback(200, callbackBody(), 99102);

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('166294');
  });

  it('does not treat an unparseable body as success', () => {
    expect(judgeAnyRouterCallback(200, '<!doctype html>', 166294).ok).toBe(false);
  });
});
