import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  probeMock,
  adapterMock,
  tryAutoReloginMock,
  setAccountRuntimeHealthMock,
  reportTokenExpiredMock,
  updateSetMock,
} = vi.hoisted(() => {
  const probeMock = vi.fn();
  return {
    probeMock,
    adapterMock: { platformName: 'agentrouter', probeCredential: probeMock } as Record<string, unknown>,
    tryAutoReloginMock: vi.fn(),
    setAccountRuntimeHealthMock: vi.fn(),
    reportTokenExpiredMock: vi.fn(),
    updateSetMock: vi.fn(),
  };
});

vi.mock('../db/index.js', () => {
  const chain = { set: (values: unknown) => { updateSetMock(values); return chain; }, where: () => chain, run: () => ({}) };
  return {
    db: { update: () => chain },
    schema: { accounts: { id: 'id' } },
  };
});
vi.mock('./platforms/index.js', () => ({ getAdapter: () => adapterMock }));
vi.mock('./autoRelogin.js', () => ({ tryAutoRelogin: (...args: unknown[]) => tryAutoReloginMock(...args) }));
vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => setAccountRuntimeHealthMock(...args),
}));
vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));
vi.mock('./siteProxy.js', () => ({
  withAccountProxyOverride: async (_url: unknown, run: () => unknown) => run(),
  withAccountCredentialContext: async (_scope: unknown, run: () => unknown) => run(),
}));
vi.mock('./accountExtraConfig.js', () => ({
  resolvePlatformUserId: () => 116261,
  resolveProxyUrlFromExtraConfig: () => null,
}));

import { keepAliveCredential } from './credentialKeepalive.js';

const ACCOUNT = {
  id: 20,
  username: 'linuxdo_116260',
  accessToken: 'opaque-token',
  status: 'active',
  extraConfig: JSON.stringify({ agentRouter: { provider: 'linuxdo' } }),
};
const SITE = { id: 35, name: 'agentrouter', url: 'https://agentrouter.org', platform: 'agentrouter' };

describe('keepAliveCredential', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    adapterMock.probeCredential = probeMock;
    setAccountRuntimeHealthMock.mockResolvedValue(null);
    reportTokenExpiredMock.mockResolvedValue(undefined);
  });

  it('does nothing for an adapter that cannot probe', async () => {
    delete adapterMock.probeCredential;

    expect(await keepAliveCredential(ACCOUNT, SITE)).toBe('skipped');
    expect(tryAutoReloginMock).not.toHaveBeenCalled();
  });

  it('stops at a credential the site accepted', async () => {
    probeMock.mockResolvedValue('ok');

    expect(await keepAliveCredential(ACCOUNT, SITE)).toBe('ok');
    expect(tryAutoReloginMock).not.toHaveBeenCalled();
    expect(setAccountRuntimeHealthMock).not.toHaveBeenCalled();
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('clears a stale expiry once the site accepts the credential again', async () => {
    probeMock.mockResolvedValue('ok');

    expect(await keepAliveCredential({ ...ACCOUNT, status: 'expired' }, SITE)).toBe('ok');
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('treats an unreadable probe as no verdict, not as a dead credential', async () => {
    // A shield page or an outage answers nothing at all. Signing in on that
    // would spend the site's daily grant and count towards its rate limit.
    probeMock.mockResolvedValue('unknown');

    expect(await keepAliveCredential(ACCOUNT, SITE)).toBe('skipped');
    expect(tryAutoReloginMock).not.toHaveBeenCalled();
  });

  it('swallows a probe that threw and reports no verdict', async () => {
    probeMock.mockRejectedValue(new Error('fetch failed'));

    expect(await keepAliveCredential(ACCOUNT, SITE)).toBe('skipped');
    expect(tryAutoReloginMock).not.toHaveBeenCalled();
  });

  it('renews the credential the site refused', async () => {
    probeMock.mockResolvedValue('refused');
    tryAutoReloginMock.mockResolvedValue({ accessToken: 'fresh-token', platformUserId: 116261 });

    expect(await keepAliveCredential(ACCOUNT, SITE)).toBe('renewed');
    expect(tryAutoReloginMock).toHaveBeenCalledWith(ACCOUNT, SITE, expect.objectContaining({
      allowBrowserFallback: true,
    }));
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(20, expect.objectContaining({ state: 'healthy' }));
    expect(reportTokenExpiredMock).not.toHaveBeenCalled();
  });

  it('records the refusal as the account’s real state when no replay can restore it', async () => {
    probeMock.mockResolvedValue('refused');
    tryAutoReloginMock.mockImplementation(async (
      _account: unknown,
      _site: unknown,
      options: { onRefusal?: (refusal: { code: string; reason: string }) => void },
    ) => {
      options.onRefusal?.({ code: 'relogin_refused', reason: 'GitHub 会话需要重新登录或重新授权' });
      return null;
    });

    expect(await keepAliveCredential(ACCOUNT, SITE)).toBe('refused');
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(20, expect.objectContaining({
      state: 'unhealthy',
      reason: 'GitHub 会话需要重新登录或重新授权',
    }));
    expect(reportTokenExpiredMock).toHaveBeenCalledTimes(1);
    expect(reportTokenExpiredMock.mock.calls[0][0]).toMatchObject({ accountId: 20 });
  });

  it('does not re-announce a refusal the account is already marked by', async () => {
    probeMock.mockResolvedValue('refused');
    tryAutoReloginMock.mockResolvedValue(null);

    expect(await keepAliveCredential({ ...ACCOUNT, status: 'expired' }, SITE)).toBe('refused');
    expect(setAccountRuntimeHealthMock).toHaveBeenCalledWith(20, expect.objectContaining({ state: 'unhealthy' }));
    expect(reportTokenExpiredMock).not.toHaveBeenCalled();
  });
});
