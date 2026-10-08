import { beforeEach, describe, expect, it, vi } from 'vitest';

const mintMock = vi.fn();
const listSessionsMock = vi.fn();
const revokeSessionMock = vi.fn();
const linuxdoLoginMock = vi.fn();
const githubLoginMock = vi.fn();

const selectGetMock = vi.fn();
const updateSetMock = vi.fn();

vi.mock('../db/index.js', () => {
  const selectChain: any = {
    all: () => [],
    get: () => selectGetMock(),
    where: () => selectChain,
    innerJoin: () => selectChain,
    from: () => selectChain,
  };
  const insertChain: any = { run: () => ({}), values: () => insertChain };
  const updateChain: any = {
    set: (updates: Record<string, unknown>) => {
      updateSetMock(updates);
      return { where: () => ({ run: () => ({}) }) };
    },
  };
  return {
    db: { select: () => selectChain, insert: () => insertChain, update: () => updateChain },
    schema: { accounts: { id: 'id', extraConfig: 'extraConfig', accessToken: 'accessToken' } },
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    issueAccessTokenFromSession: (...args: unknown[]) => mintMock(...args),
    listSessions: (...args: unknown[]) => listSessionsMock(...args),
    revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
  }),
}));

vi.mock('./assistedLogin/sites/agentRouter.js', () => ({
  isAgentRouterSite: (url: string) => new URL(url).hostname === 'agentrouter.org',
  loginAgentRouterWithLinuxDo: (...args: unknown[]) => linuxdoLoginMock(...args),
  loginAgentRouterWithGitHub: (...args: unknown[]) => githubLoginMock(...args),
}));

// The generic OAuth replays are not what this file tests; they are stubbed so a
// non-agentrouter account cannot start a real browser handshake.
vi.mock('./assistedLogin/sites/linuxDoOAuthRelogin.js', () => ({
  reloginWithLinuxDo: vi.fn(async () => ({ ok: false, message: 'not used in this test' })),
}));
vi.mock('./assistedLogin/sites/newApiGithubOauthRelogin.js', () => ({
  supportsNewApiGithubOauth: () => false,
  captureNewApiGithubCredentials: vi.fn(),
}));

const SITE = {
  id: 35,
  name: 'agentrouter',
  url: 'https://agentrouter.org',
  platform: 'agentrouter',
};

function account(extraConfig: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    username: 'linuxdo_116260',
    accessToken: 'dead-bearer',
    status: 'expired',
    extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 116261, ...extraConfig }),
    ...overrides,
  };
}

const LINUXDO_ACCOUNT_EXTRA = { agentRouter: { provider: 'linuxdo' } };

describe('autoRelogin for agentrouter', () => {
  beforeEach(() => {
    mintMock.mockReset();
    listSessionsMock.mockReset();
    revokeSessionMock.mockReset();
    linuxdoLoginMock.mockReset();
    githubLoginMock.mockReset();
    selectGetMock.mockReset();
    updateSetMock.mockReset();
    selectGetMock.mockReturnValue(undefined);
    // `readLinuxDoClientId` reads /api/status before the browser handshake.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      json: async () => ({ data: { linuxdo_client_id: 'linuxdo-client-id' } }),
    })));
  });

  it('renews a Linux.do-bound account and stores the bearer the session mints', async () => {
    linuxdoLoginMock.mockResolvedValue({
      ok: true,
      message: 'Linux.do 重新登录完成',
      platformUserId: 116261,
      sessionCookie: 'session=live-cookie; acw_tc=token',
    });
    mintMock.mockResolvedValue('fresh-bearer');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(LINUXDO_ACCOUNT_EXTRA), SITE, { allowBrowserFallback: true });

    expect(result?.accessToken).toBe('fresh-bearer');
    expect(linuxdoLoginMock).toHaveBeenCalledWith({
      baseUrl: 'https://agentrouter.org',
      clientId: 'linuxdo-client-id',
      expectedUserId: 116261,
    });
    expect(mintMock).toHaveBeenCalledWith(
      'https://agentrouter.org',
      'session=live-cookie; acw_tc=token',
      116261,
    );
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'fresh-bearer',
      status: 'active',
    }));
  });

  it('renews a GitHub-bound account over plain HTTP', async () => {
    githubLoginMock.mockResolvedValue({
      ok: true,
      message: 'GitHub 重新登录成功',
      checkedIn: true,
      platformUserId: 99102,
      sessionCookie: 'session=github-cookie; acw_tc=token',
    });
    mintMock.mockResolvedValue('fresh-bearer-2');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(
      account({ agentRouter: { provider: 'github' }, platformUserId: 99102 }, { id: 19 }),
      SITE,
      { allowBrowserFallback: true },
    );

    expect(result?.accessToken).toBe('fresh-bearer-2');
    expect(githubLoginMock).toHaveBeenCalledTimes(1);
    expect(linuxdoLoginMock).not.toHaveBeenCalled();
  });

  it('keeps the session when the site refuses to mint a bearer', async () => {
    linuxdoLoginMock.mockResolvedValue({
      ok: true,
      message: 'Linux.do 重新登录完成',
      platformUserId: 116261,
      sessionCookie: 'session=live-cookie',
    });
    mintMock.mockResolvedValue(null);

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(LINUXDO_ACCOUNT_EXTRA), SITE);

    expect(result?.accessToken).toBe('session=live-cookie');
  });

  it('reports the site refusal instead of a generic expiry', async () => {
    linuxdoLoginMock.mockResolvedValue({
      ok: false,
      message: '站点拒绝 Linux.do 登录：该 Linux DO 账户已被绑定',
    });
    const refusals: Array<{ code: string; reason: string }> = [];

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(LINUXDO_ACCOUNT_EXTRA), SITE, {
      allowBrowserFallback: true,
      onRefusal: (refusal) => refusals.push(refusal),
    });

    expect(result).toBeNull();
    expect(refusals[0]?.reason).toContain('已被绑定');
    expect(mintMock).not.toHaveBeenCalled();
  });

  it('does not start a second browser handshake inside the cooldown', async () => {
    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(
      account({
        ...LINUXDO_ACCOUNT_EXTRA,
        browserRelogin: { attemptedAt: new Date().toISOString() },
      }),
      SITE,
      { allowBrowserFallback: true },
    );

    expect(result).toBeNull();
    expect(linuxdoLoginMock).not.toHaveBeenCalled();
  });

  it('leaves accounts of other platforms alone', async () => {
    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(
      account({ oauth: { provider: 'linuxdo' } }),
      { id: 40, name: 'other', url: 'https://other.example', platform: 'new-api' },
      { allowBrowserFallback: false },
    );

    expect(result).toBeNull();
    expect(linuxdoLoginMock).not.toHaveBeenCalled();
  });
});
