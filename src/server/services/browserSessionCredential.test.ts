import { beforeEach, describe, expect, it, vi } from 'vitest';

const runBrowserCheckinMock = vi.fn();
const readCookieMock = vi.fn();

vi.mock('./browserCheckinRunner.js', () => ({
  runBrowserCheckin: (...args: unknown[]) => runBrowserCheckinMock(...args),
}));

vi.mock('./browserProfileCredential.js', () => ({
  readBrowserProfileCookie: (...args: unknown[]) => readCookieMock(...args),
}));

vi.mock('./siteProxy.js', () => ({
  UNLIMITED_BODY_TIMEOUT: { bodyTimeout: 0 },
  resolveChannelProxyUrl: () => 'http://proxy.test:7890',
}));

vi.mock('../config.js', () => ({
  config: { dataDir: '/data/metapi' },
}));

const site = { id: 15, url: 'https://api.bxacc.xyz' };

describe('runBrowserSessionCheckin', () => {
  beforeEach(() => {
    runBrowserCheckinMock.mockReset();
    readCookieMock.mockReset();
  });

  it('drives the browser with the site profile and returns the login cookie', async () => {
    runBrowserCheckinMock.mockResolvedValue({
      kind: 'result',
      result: { success: true, message: 'ok' },
      logDir: '/data/metapi/checkin-browser/site-15/runs/site-15-x',
      profileDir: '/data/metapi/checkin-browser/site-15/profiles/site-15',
    });
    readCookieMock.mockReturnValue('184e90e0-9ec6-4f08-8871-bc13d9ffd6c5.abcdef');

    const { runBrowserSessionCheckin } = await import('./browserSessionCredential.js');
    const result = await runBrowserSessionCheckin({
      site,
      username: '3145215575',
      password: 'secret',
    });

    expect(runBrowserCheckinMock).toHaveBeenCalledWith(expect.objectContaining({
      siteUrl: 'https://api.bxacc.xyz',
      username: '3145215575',
      password: 'secret',
      proxyUrl: 'http://proxy.test:7890',
      profileKey: 'site-15',
      logDir: '/data/metapi/checkin-browser/site-15',
      cookieName: 'new_api_refresh',
    }));
    expect(readCookieMock).toHaveBeenCalledWith({
      profileDir: '/data/metapi/checkin-browser/site-15/profiles/site-15',
      host: 'api.bxacc.xyz',
      name: 'new_api_refresh',
    });
    expect(result.accessToken).toBe('new_api_refresh=184e90e0-9ec6-4f08-8871-bc13d9ffd6c5.abcdef');
  });

  it('reports no credential when the machine cannot run a browser', async () => {
    runBrowserCheckinMock.mockResolvedValue({ kind: 'unavailable', reason: 'chromium not found' });

    const { runBrowserSessionCheckin } = await import('./browserSessionCredential.js');
    const result = await runBrowserSessionCheckin({ site, username: 'u', password: 'p' });

    expect(result.outcome.kind).toBe('unavailable');
    expect(result.accessToken).toBeNull();
    expect(readCookieMock).not.toHaveBeenCalled();
  });
});

describe('readBrowserSessionCredential', () => {
  beforeEach(() => {
    readCookieMock.mockReset();
  });

  it('shapes the stored value as the cookie pair the adapter rotates', async () => {
    readCookieMock.mockReturnValue('fresh-value');

    const { readBrowserSessionCredential } = await import('./browserSessionCredential.js');

    expect(readBrowserSessionCredential('/profile', 'https://api.bxacc.xyz')).toBe(
      'new_api_refresh=fresh-value',
    );
    expect(readCookieMock).toHaveBeenCalledWith({
      profileDir: '/profile',
      host: 'api.bxacc.xyz',
      name: 'new_api_refresh',
    });
  });

  it('returns null when the profile holds no session or the url is unusable', async () => {
    readCookieMock.mockReturnValue(null);

    const { readBrowserSessionCredential } = await import('./browserSessionCredential.js');

    expect(readBrowserSessionCredential('/profile', 'https://api.bxacc.xyz')).toBeNull();
    expect(readBrowserSessionCredential('/profile', 'not a url')).toBeNull();
  });
});
