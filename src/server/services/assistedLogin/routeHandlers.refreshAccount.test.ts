import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every `update().set()` payload, in the order the handler wrote them. */
const updatePayloads: Array<Record<string, unknown>> = [];

const selectGetMock = vi.fn();
const pruneMock = vi.fn();
const verifyTokenMock = vi.fn();
const captureSiteCredentialsMock = vi.fn();

vi.mock('../../db/index.js', () => {
  const selectChain: any = {
    from: () => selectChain,
    innerJoin: () => selectChain,
    where: () => selectChain,
    get: () => selectGetMock(),
    all: () => [],
  };
  const updateChain: any = {
    set: (payload: Record<string, unknown>) => {
      updatePayloads.push(payload);
      return { where: () => ({ run: () => ({}) }) };
    },
  };
  return {
    db: {
      select: () => selectChain,
      update: () => updateChain,
      insert: () => ({ values: () => ({ run: () => ({}) }) }),
    },
    schema: {
      accounts: { id: 'id', siteId: 'siteId', extraConfig: 'extraConfig', accessToken: 'accessToken' },
      sites: { id: 'id', url: 'url', platform: 'platform' },
    },
  };
});

vi.mock('../platforms/index.js', () => ({
  getAdapter: () => ({
    verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
  }),
}));

vi.mock('../sessionHygiene.js', () => ({
  pruneOtherSessions: (...args: unknown[]) => pruneMock(...args),
}));

vi.mock('../siteProxy.js', () => ({
  withAccountCredentialContext: (_scope: unknown, fn: () => unknown) => fn(),
  getAccountCredentialContext: () => undefined,
}));

vi.mock('../manualAccountCreationService.js', () => ({ createManualAccount: vi.fn() }));

vi.mock('./sessionRegistry.js', () => ({
  assistedLoginSessions: {
    get: () => ({
      provider: { id: 'linuxdo', label: 'Linux.do', isHandoffHost: () => false, messages: { needsLogin: '需要登录' } },
      captureSiteCredentials: (...args: unknown[]) => captureSiteCredentialsMock(...args),
    }),
  },
}));

vi.mock('./watchers.js', () => ({ getAssistedLoginWatcher: () => null }));

vi.mock('./importedSession.js', () => ({
  applyTransientFallback: vi.fn(),
  clearImportedSession: vi.fn(),
  parsePastedProviderSession: vi.fn(),
  probeImportedSession: vi.fn(),
  readImportedSession: vi.fn(),
  recordImportedSessionVerification: vi.fn(),
  saveImportedSession: vi.fn(),
}));

describe('assisted login refreshAccount', () => {
  beforeEach(() => {
    updatePayloads.length = 0;
    selectGetMock.mockReset();
    pruneMock.mockReset();
    verifyTokenMock.mockReset();
    captureSiteCredentialsMock.mockReset();
  });

  it('keeps the OAuth binding when the session cleanup writes afterwards', async () => {
    // The refresh establishes the binding by writing `oauth` to extraConfig, and
    // the cleanup runs one statement later. Merging it onto the *pre-refresh*
    // snapshot dropped that marker: the account kept a working session but the
    // next expiry had no provider to renew it from, which is only repairable by
    // hand. Both keys have to survive the second write.
    selectGetMock.mockReturnValue({
      accounts: {
        id: 46,
        siteId: 60,
        username: '3145215575',
        accessToken: 'opaque-token',
        extraConfig: JSON.stringify({ credentialMode: 'session' }),
      },
      sites: { id: 60, url: 'https://iceberg.tiktok.vip', platform: 'new-api' },
      accessToken: 'new_api_refresh=fresh',
    });
    captureSiteCredentialsMock.mockResolvedValue({
      status: 'already_authorized',
      credentials: { accessToken: 'new_api_refresh=from-browser', platformUserId: 501 },
      url: 'https://iceberg.tiktok.vip/',
    });
    verifyTokenMock.mockResolvedValue({ tokenType: 'session', userInfo: { username: '3145215575' } });
    pruneMock.mockResolvedValue({ status: 'pruned', removed: 1, kept: 1 });

    const { buildAssistedLoginHandlers } = await import('./routeHandlers.js');
    const reply = { code: () => reply, send: (body: unknown) => body };
    const result: any = await buildAssistedLoginHandlers('linuxdo').refreshAccount({ accountId: 46 }, reply);

    expect(result.success).toBe(true);
    expect(pruneMock).toHaveBeenCalled();

    const configs = updatePayloads
      .map((payload) => payload.extraConfig)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value));
    const last = configs.at(-1) as any;
    expect(last.sessionHygiene).toEqual(expect.objectContaining({ outcome: 'pruned', removed: 1, kept: 1 }));
    expect(last.oauth).toEqual(expect.objectContaining({ provider: 'linuxdo' }));
    expect(last.credentialMode).toBe('session');
  });
});
