import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  login: vi.fn(),
};

const decryptPasswordMock = vi.fn();
const browserSessionMock = vi.fn();
const captureHyperMock = vi.fn();

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

vi.mock('./platforms/index.js', () => ({ getAdapter: () => adapterMock }));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
}));

vi.mock('./browserSessionCredential.js', () => ({
  BROWSER_SESSION_COOKIE: 'new_api_refresh',
  asBrowserSessionCredential: (token: unknown) =>
    (typeof token === 'string' && token.trim().startsWith('new_api_refresh=')
      ? token.trim()
      : null),
  runBrowserSessionCheckin: (...args: unknown[]) => browserSessionMock(...args),
}));

vi.mock('./assistedLogin/sites/hyper.js', () => ({
  supportsHyperGithubLogin: (siteUrl: string, provider: string) =>
    provider === 'github' && new URL(siteUrl).origin === 'https://ai.hyper.nyc.mn',
  captureHyperGithubCredentials: (...args: unknown[]) => captureHyperMock(...args),
}));

const SITE = {
  id: 32,
  name: 'motomoto',
  url: 'https://motomoto.lol',
  platform: 'new-api',
};

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 16,
    username: 'li3145215575',
    accessToken: 'new_api_refresh=dead',
    status: 'expired',
    extraConfig: JSON.stringify({
      autoRelogin: { username: 'li3145215575', passwordCipher: 'cipher' },
    }),
    ...overrides,
  };
}

function browserOutcome(accessToken: string | null) {
  return {
    outcome: {
      kind: 'result',
      result: { success: true, message: '浏览器签到成功（已通过站点人机校验）' },
      logDir: '/logs',
      profileDir: '/profile',
    },
    accessToken,
  };
}

describe('autoRelogin', () => {
  beforeEach(() => {
    adapterMock.login.mockReset();
    decryptPasswordMock.mockReset();
    browserSessionMock.mockReset();
    captureHyperMock.mockReset();
    selectGetMock.mockReset();
    updateSetMock.mockReset();
    selectGetMock.mockReturnValue(undefined);
  });

  it('falls back to the browser when the site refuses the password login with Turnstile', async () => {
    adapterMock.login.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');
    browserSessionMock.mockResolvedValue(browserOutcome('new_api_refresh=fresh'));

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE, { allowBrowserFallback: true });

    expect(result?.accessToken).toBe('new_api_refresh=fresh');
    // The dead cookie must not be seeded: the script has to type the password
    // and clear the Turnstile widget itself.
    expect(browserSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      password: 'liyaodong7238508',
      sessionCredential: null,
    }));
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'new_api_refresh=fresh',
      status: 'active',
    }));
  });

  it('does not start a browser when the credentials were simply refused', async () => {
    adapterMock.login.mockResolvedValue({
      success: false,
      message: 'Username or password is incorrect',
    });
    decryptPasswordMock.mockReturnValue('wrong-password');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE, { allowBrowserFallback: true });

    expect(result).toBeNull();
    expect(browserSessionMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('keeps the browser fallback off for callers that refresh balances', async () => {
    adapterMock.login.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE);

    expect(result).toBeNull();
    expect(browserSessionMock).not.toHaveBeenCalled();
  });

  it('replays the GitHub handshake for a password-less OAuth bind', async () => {
    captureHyperMock.mockResolvedValue({
      status: 'captured',
      credentials: {
        accessToken: 'new_api_refresh=oauth',
        platformUserId: 958,
        username: 'liumeijicui',
        source: 'cookie',
      },
    });

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account({
      username: 'liumeijicui',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        platformUserId: 958,
        oauth: { provider: 'github' },
      }),
    }), { ...SITE, id: 13, url: 'https://ai.hyper.nyc.mn' }, { allowBrowserFallback: true });

    expect(result?.accessToken).toBe('new_api_refresh=oauth');
    expect(result?.platformUserId).toBe(958);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'new_api_refresh=oauth',
      status: 'active',
    }));
    expect(browserSessionMock).not.toHaveBeenCalled();
  });

  it('ignores the GitHub handshake when the account was bound through a password', async () => {
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-bearer', platformUserId: 224 });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE, { allowBrowserFallback: true });

    expect(result?.accessToken).toBe('fresh-bearer');
    expect(captureHyperMock).not.toHaveBeenCalled();
    expect(browserSessionMock).not.toHaveBeenCalled();
  });
});
