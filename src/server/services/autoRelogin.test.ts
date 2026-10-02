import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  login: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
};

/** Builds an access token carrying `sid`, the way the site mints them. */
function tokenWithSid(sid: string): string {
  return `header.${Buffer.from(JSON.stringify({ sid })).toString('base64url')}.signature`;
}

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
    adapterMock.listSessions.mockReset();
    adapterMock.revokeSession.mockReset();
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

  it('signs the other sessions out after a successful login', async () => {
    // The fork caps concurrent sessions, and the leftovers from earlier manual
    // sign-ins are what will refuse the *next* re-login. The fresh session is
    // the one thing that must survive.
    const fresh = tokenWithSid('mine');
    adapterMock.login.mockResolvedValue({ success: true, accessToken: fresh, platformUserId: 38 });
    adapterMock.listSessions.mockResolvedValue([
      { sid: 'mine', current: true },
      { sid: 'stale-one', current: false },
      { sid: 'stale-two', current: false },
    ]);
    adapterMock.revokeSession.mockResolvedValue(true);
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE);

    expect(result?.accessToken).toBe(fresh);
    expect(adapterMock.revokeSession).toHaveBeenCalledTimes(2);
    expect(adapterMock.revokeSession).toHaveBeenCalledWith(SITE.url, fresh, 38, 'stale-one');
    expect(adapterMock.revokeSession).not.toHaveBeenCalledWith(SITE.url, fresh, 38, 'mine');
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      extraConfig: expect.stringContaining('"removed":2'),
    }));
  });

  it('never drops a session when the credential does not say which one is its own', async () => {
    // Guessing here would sign the account straight back out, so a credential
    // that carries no session id leaves the list alone and the sign-in stands.
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'opaque-session-cookie', platformUserId: 38 });
    adapterMock.listSessions.mockResolvedValue([
      { sid: 'one', current: false },
      { sid: 'two', current: false },
    ]);
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE);

    expect(result?.accessToken).toBe('opaque-session-cookie');
    expect(adapterMock.revokeSession).not.toHaveBeenCalled();
  });

  it('does not delete a session the site merely forgot to mark current', async () => {
    // The token's own id is what decides; a list without `current` flags must
    // still not cost the account the session it is holding.
    const fresh = tokenWithSid('mine');
    adapterMock.login.mockResolvedValue({ success: true, accessToken: fresh, platformUserId: 38 });
    adapterMock.listSessions.mockResolvedValue([
      { sid: 'mine', current: false },
      { sid: 'stale', current: false },
    ]);
    adapterMock.revokeSession.mockResolvedValue(true);
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    await tryAutoRelogin(account(), SITE);

    expect(adapterMock.revokeSession).toHaveBeenCalledTimes(1);
    expect(adapterMock.revokeSession).not.toHaveBeenCalledWith(SITE.url, fresh, 38, 'mine');
  });

  it('honors an account that opted out of pruning its other sessions', async () => {
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-token', platformUserId: 38 });
    adapterMock.listSessions.mockResolvedValue([
      { sid: 'mine', current: true },
      { sid: 'stale', current: false },
    ]);
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    await tryAutoRelogin(account({
      extraConfig: JSON.stringify({
        autoRelogin: {
          username: 'li3145215575',
          passwordCipher: 'cipher',
          pruneOtherSessions: false,
        },
      }),
    }), SITE);

    expect(adapterMock.listSessions).not.toHaveBeenCalled();
    expect(adapterMock.revokeSession).not.toHaveBeenCalled();
  });

  it('keeps the fresh session when the site has no session API', async () => {
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-token', platformUserId: 38 });
    adapterMock.listSessions.mockResolvedValue(null);
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE);

    expect(result?.accessToken).toBe('fresh-token');
    expect(adapterMock.revokeSession).not.toHaveBeenCalled();
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

  it('starts a browser when the site answered the login with its shield instead', async () => {
    // The fork here answers a login POST it does not like with a challenge page
    // rather than a verdict (`shield challenge blocked login`). That is not a
    // wrong password — it is the refusal a browser exists to clear.
    adapterMock.login.mockResolvedValue({
      success: false,
      message: '登录被站点人机校验拦截（shield challenge blocked login）',
    });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');
    browserSessionMock.mockResolvedValue(browserOutcome('new_api_refresh=fresh'));

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE, { allowBrowserFallback: true });

    expect(result?.accessToken).toBe('new_api_refresh=fresh');
    expect(browserSessionMock).toHaveBeenCalledTimes(1);
  });

  it('leaves the browser fallback off unless the caller asks for it', async () => {
    adapterMock.login.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE);

    expect(result).toBeNull();
    expect(browserSessionMock).not.toHaveBeenCalled();
  });

  it('waits out the cooldown before spending another browser run', async () => {
    // A browser run takes minutes and the sites that need one rate-limit hard,
    // so a second run minutes later would only add to the throttling. The
    // timestamp lives in extraConfig, which is what survives a restart.
    adapterMock.login.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(
      account({
        extraConfig: JSON.stringify({
          autoRelogin: { username: 'li3145215575', passwordCipher: 'cipher' },
          browserRelogin: { attemptedAt: new Date().toISOString() },
        }),
      }),
      SITE,
      { allowBrowserFallback: true },
    );

    expect(result).toBeNull();
    // The cheap HTTP replay still runs — it is the minutes-long browser run the
    // cooldown holds back.
    expect(browserSessionMock).not.toHaveBeenCalled();
  });

  it('tries again once the cooldown has passed', async () => {
    adapterMock.login.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');
    browserSessionMock.mockResolvedValue(browserOutcome('new_api_refresh=fresh'));

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(
      account({
        extraConfig: JSON.stringify({
          autoRelogin: { username: 'li3145215575', passwordCipher: 'cipher' },
          browserRelogin: { attemptedAt: new Date(Date.now() - 60 * 60_000).toISOString() },
        }),
      }),
      SITE,
      { allowBrowserFallback: true },
    );

    expect(result?.accessToken).toBe('new_api_refresh=fresh');
    expect(browserSessionMock).toHaveBeenCalledTimes(1);
  });

  it('spends the browser on a human check even when the caller only allows that much', async () => {
    // The shape the hourly balance refresh uses: it cannot afford a browser for
    // every account, but a site that will not answer the HTTP login until a
    // human check is passed has no other way back in.
    adapterMock.login.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');
    browserSessionMock.mockResolvedValue(browserOutcome('new_api_refresh=fresh'));

    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(account(), SITE, {
      allowBrowserFallback: true,
      browserFallbackRequiresHumanCheck: true,
    });

    expect(result?.accessToken).toBe('new_api_refresh=fresh');
    expect(browserSessionMock).toHaveBeenCalledTimes(1);
  });

  it('spares the browser for a session-only account under that same caller', async () => {
    // Nothing to type, so the run would end exactly where it started — minutes
    // later. Only a site that explicitly demanded a human check earns one.
    const { tryAutoRelogin } = await import('./autoRelogin.js');
    const result = await tryAutoRelogin(
      account({ extraConfig: JSON.stringify({ credentialMode: 'session' }) }),
      SITE,
      { allowBrowserFallback: true, browserFallbackRequiresHumanCheck: true },
    );

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
