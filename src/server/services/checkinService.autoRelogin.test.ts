import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  checkin: vi.fn(),
  login: vi.fn(),
};

const notifyMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const refreshBalanceMock = vi.fn();
const decryptPasswordMock = vi.fn();

const selectAllMock = vi.fn();
const selectGetMock = vi.fn();
const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();
/** Every `where()` argument, so a test can read back the row filter itself. */
const whereArgs: unknown[] = [];

vi.mock('../db/index.js', () => {
  const selectChain: any = {
    all: () => selectAllMock(),
    get: () => selectGetMock(),
    where: (...args: unknown[]) => {
      whereArgs.push(...args);
      return selectChain;
    },
    innerJoin: () => selectChain,
    from: () => selectChain,
  };

  const insertChain = {
    run: () => ({}),
    values: (...args: unknown[]) => {
      insertValuesMock(...args);
      return insertChain;
    },
  };

  const updateWhereChain = {
    run: () => ({}),
  };

  const updateSetChain = {
    where: () => updateWhereChain,
  };

  return {
    db: {
      select: () => selectChain,
      insert: () => insertChain,
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          updateSetMock(updates);
          return updateSetChain;
        },
      }),
    },
    schema: {
      accounts: { id: 'id', siteId: 'siteId', checkinEnabled: 'checkinEnabled', status: 'status', extraConfig: 'extraConfig' },
      sites: { id: 'id' },
      checkinLogs: {},
      events: {},
    },
  };
});

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => adapterMock,
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => notifyMock(...args),
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

/** Captured health writes, so a test can read back which reason landed last. */
const setHealthMock = vi.fn();

vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => setHealthMock(...args),
  extractRuntimeHealth: () => null,
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./accountCredentialService.js', () => ({
  decryptAccountPassword: (...args: unknown[]) => decryptPasswordMock(...args),
}));

const browserSessionMock = vi.fn();

vi.mock('./browserSessionCredential.js', () => ({
  // Mirrors the real module's constant so the service can recognise a session.
  BROWSER_SESSION_COOKIE: 'new_api_refresh',
  asBrowserSessionCredential: (token: unknown) =>
    (typeof token === 'string' && token.trim().startsWith('new_api_refresh=')
      ? token.trim()
      : null),
  runBrowserSessionCheckin: (...args: unknown[]) => browserSessionMock(...args),
}));

describe('checkinService auto relogin', () => {
  beforeEach(() => {
    adapterMock.checkin.mockReset();
    adapterMock.login.mockReset();
    notifyMock.mockReset();
    reportTokenExpiredMock.mockReset();
    refreshBalanceMock.mockReset();
    decryptPasswordMock.mockReset();
    selectAllMock.mockReset();
    selectGetMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
    setHealthMock.mockReset();
    browserSessionMock.mockReset();
    whereArgs.length = 0;
  });

  it('scans expired accounts, so a dead session still gets its revival run', async () => {
    // `reportTokenExpired()` marks an account `expired` from the hourly balance
    // refresh. Filtering those out here would hide them from the only job that
    // may run the browser, and for a Turnstile-gated site the browser is the
    // only way back in — the account would stay dead forever.
    selectAllMock.mockReturnValue([]);

    const { checkinAll } = await import('./checkinService.js');
    await checkinAll();

    const filter = JSON.stringify(whereArgs);
    expect(filter).toContain('active');
    expect(filter).toContain('expired');
  });

  it('leaves an expired account expired when nothing could sign it back in', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          username: '3145215575',
          accessToken: 'dead-token',
          status: 'expired',
          extraConfig: JSON.stringify({
            autoRelogin: { username: '3145215575', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 16,
          name: 'luckyg',
          url: 'https://luckyg.131518.xyz',
          platform: 'new-api',
        },
      },
    ]);
    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'HTTP 401: Unauthorized, not logged in and no access token provided',
    });
    decryptPasswordMock.mockReturnValue('plain-password');
    // The site caps concurrent sessions, so the password login is refused even
    // though the password is right. Nothing here can revive the account, and
    // claiming otherwise would just have the next balance run mark it expired
    // again.
    adapterMock.login.mockResolvedValue({ success: false, message: 'Conflict（AUTH_SESSION_LIMIT）' });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(1);

    expect(updateSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));

    // The log, the event and the notification are what the operator actually
    // reads, so the session cap has to replace the 401 the failed request
    // produced instead of sitting next to it.
    const loggedLines = insertValuesMock.mock.calls.map((call) => call[0]).filter((row: any) => row?.accountId === 1);
    const checkinLogRow = loggedLines.find((row: any) => row?.status === 'failed');
    expect(checkinLogRow?.message).toContain('\u4f1a\u8bdd\u6570\u5df2\u8fbe\u4e0a\u9650');
    expect(checkinLogRow?.message).not.toContain('401');
    expect(loggedLines.some((row: any) => String(row?.message || '').includes('401'))).toBe(false);
  });

  it('keeps the site refusal as the recorded health reason, not the token verdict', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          username: '3145215575',
          accessToken: 'dead-token',
          status: 'active',
          extraConfig: JSON.stringify({
            autoRelogin: { username: '3145215575', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 16,
          name: 'luckyg',
          url: 'https://luckyg.131518.xyz',
          platform: 'new-api',
        },
      },
    ]);
    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'HTTP 401: Unauthorized, not logged in and no access token provided',
    });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({ success: false, message: 'Conflict（AUTH_SESSION_LIMIT）' });
    // Mirrors the real reportTokenExpired(): it writes the generic token verdict
    // and flips the account to `expired`. A health reason recorded before it
    // would be erased, which is exactly the bug this locks out.
    reportTokenExpiredMock.mockImplementation(async (params: any) => {
      setHealthMock(params.accountId, {
        state: 'unhealthy',
        reason: `\u8bbf\u95ee\u4ee4\u724c\u5931\u6548\uff1a${params.detail}`,
        source: 'auth',
      });
    });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(1);

    expect(reportTokenExpiredMock).toHaveBeenCalled();
    const lastHealthCall = setHealthMock.mock.calls.at(-1) as any[];
    expect(lastHealthCall[1]).toEqual(expect.objectContaining({
      source: 'checkin',
      reason: expect.stringContaining('\u4f1a\u8bdd\u6570\u5df2\u8fbe\u4e0a\u9650'),
    }));

    // And the surfaces the operator reads carry it too.
    expect(notifyMock).toHaveBeenCalledWith(
      'checkin failed',
      expect.stringContaining('\u4f1a\u8bdd\u6570\u5df2\u8fbe\u4e0a\u9650'),
      'error',
    );
  });

  it('revives an expired account once a sign-in hands it a live credential', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          username: '3145215575',
          accessToken: 'dead-token',
          status: 'expired',
          extraConfig: JSON.stringify({
            autoRelogin: { username: '3145215575', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 16,
          name: 'luckyg',
          url: 'https://luckyg.131518.xyz',
          platform: 'new-api',
        },
      },
    ]);
    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: 'HTTP 401: Unauthorized, not logged in and no access token provided' })
      .mockResolvedValueOnce({ success: true, message: '签到成功' });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-token' });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(1);

    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'active' }));
  });

  it('retries checkin once after auto relogin when access token is missing', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          username: 'linuxdo_7659',
          accessToken: 'expired-token',
          status: 'active',
          extraConfig: JSON.stringify({
            autoRelogin: { username: 'linuxdo_7659', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 3,
          name: 'kfc',
          url: 'https://kfc-api.sxxe.net',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: '无权进行此操作，未登录且未提供 access token' })
      .mockResolvedValueOnce({ success: true, message: 'checked in' });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({ success: true, accessToken: 'fresh-token' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(1);

    expect(result.success).toBe(true);
    expect(adapterMock.login).toHaveBeenCalledTimes(1);
    expect(adapterMock.checkin).toHaveBeenCalledTimes(2);
    expect(adapterMock.checkin.mock.calls[0][1]).toBe('expired-token');
    expect(adapterMock.checkin.mock.calls[1][1]).toBe('fresh-token');
    expect(adapterMock.checkin.mock.calls[0][2]).toBe(7659);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh-token' }));
  });

  it('prefers the id reported by relogin over the guess, and never writes the guess back', async () => {
    // `alice_1999` ends in digits that are not the account id — precisely the case
    // guessPlatformUserIdFromUsername() gets wrong, since its /(\d{3,8})$/ only
    // knows how to read a trailing number.
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 1,
          username: 'alice_1999',
          accessToken: 'expired-token',
          status: 'active',
          extraConfig: JSON.stringify({
            autoRelogin: { username: 'alice_1999', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 3,
          name: 'kfc',
          url: 'https://kfc-api.sxxe.net',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: '无权进行此操作，未登录且未提供 access token' })
      .mockResolvedValueOnce({ success: true, message: 'checked in' });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockResolvedValue({
      success: true,
      accessToken: 'fresh-token',
      platformUserId: 500123,
    });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(1);

    // The first attempt has nothing better than the guess...
    expect(adapterMock.checkin.mock.calls[0][2]).toBe(1999);
    // ...but the retry must use the id the site itself reported.
    expect(adapterMock.checkin.mock.calls[1][2]).toBe(500123);

    // And no later write may put the guess back over it. Parse the whole config,
    // not just the id: a write that *replaced* extraConfig with only
    // `{ platformUserId }` would satisfy an id-only assertion while dropping the
    // autoRelogin credentials, leaving nothing to re-login with next time.
    const writtenConfigs = updateSetMock.mock.calls
      .map((call) => (call[0] as Record<string, unknown> | undefined)?.extraConfig)
      .filter((cfg): cfg is string => typeof cfg === 'string')
      .map((cfg) => JSON.parse(cfg) as {
        platformUserId?: number;
        autoRelogin?: { username?: string; passwordCipher?: string };
      });
    expect(writtenConfigs.length).toBeGreaterThan(0);
    // Credentials must survive *every* write. `toContainEqual` would only prove one
    // write got it right, while a later one could still drop them — and a single
    // drop leaves nothing to re-login with next round.
    for (const cfg of writtenConfigs) {
      expect(cfg.autoRelogin).toEqual({ username: 'alice_1999', passwordCipher: 'cipher' });
    }
    const writtenIds = writtenConfigs.map((cfg) => cfg.platformUserId);
    expect(writtenIds).toContain(500123);
    expect(writtenIds).not.toContain(1999);
  });

  it('preserves account configuration updated while auto relogin is in flight', async () => {
    const autoRelogin = { username: 'alice@example.com', passwordCipher: 'cipher' };
    let currentExtraConfig = JSON.stringify({
      autoRelogin,
      proxyUrl: 'http://old-proxy.example',
    });
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 15,
          username: 'alice@example.com',
          accessToken: 'expired-token',
          status: 'active',
          extraConfig: currentExtraConfig,
        },
        sites: {
          id: 15,
          name: 'concurrent-settings',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);
    selectGetMock.mockImplementation(() => ({ extraConfig: currentExtraConfig }));

    adapterMock.checkin
      .mockResolvedValueOnce({ success: false, message: 'access token required' })
      .mockResolvedValueOnce({ success: true, message: 'checked in' });
    decryptPasswordMock.mockReturnValue('plain-password');
    adapterMock.login.mockImplementation(async () => {
      currentExtraConfig = JSON.stringify({
        autoRelogin,
        proxyUrl: 'http://new-proxy.example',
      });
      return {
        success: true,
        accessToken: 'fresh-token',
        platformUserId: 500123,
      };
    });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(15);

    expect(selectGetMock).toHaveBeenCalled();
    const writtenConfigs = updateSetMock.mock.calls
      .map((call) => call[0]?.extraConfig)
      .filter((value): value is string => typeof value === 'string')
      .map((value) => JSON.parse(value) as Record<string, unknown>);
    expect(writtenConfigs.length).toBeGreaterThan(0);
    for (const config of writtenConfigs) {
      expect(config).toMatchObject({
        autoRelogin,
        proxyUrl: 'http://new-proxy.example',
      });
    }
    expect(writtenConfigs.some((config) => config.platformUserId === 500123)).toBe(true);
  });

  it('passes guessed platform user id when config does not include it', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 2,
          username: 'linuxdo_11494',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 4,
          name: 'wong',
          url: 'https://wzw.pp.ua',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: 'checked in' });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(2);

    expect(adapterMock.checkin).toHaveBeenCalledTimes(1);
    expect(adapterMock.checkin.mock.calls[0][2]).toBe(11494);
  });

  it('keeps successful checkin as success when message is 签到成功', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 12,
          username: 'linuxdo_5566',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 12,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(12);

    expect(result.success).toBe(true);
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('success');
  });

  it('infers reward from balance delta when checkin reward text is empty', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 13,
          username: 'linuxdo_7788',
          accessToken: 'token',
          status: 'active',
          balance: 10,
          extraConfig: null,
        },
        sites: {
          id: 13,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: 'checkin success' });
    refreshBalanceMock.mockResolvedValue({ balance: 12.5, used: 0, quota: 12.5 });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(13);

    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Number(firstInsertPayload?.reward)).toBeCloseTo(2.5, 6);
  });

  it('treats already checked in responses as successful checkins', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 9,
          username: 'linuxdo_9999',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 9,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: false, message: '今天已经签到过啦' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(9);

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('success');
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('does not advance lastCheckinAt for already checked in responses in interval mode', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 16,
          username: 'interval-user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 16,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: false, message: '今天已经签到过啦' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(16, { scheduleMode: 'interval' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('success');
    expect(updateSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });

  it('advances lastCheckinAt when interval mode gets a direct success', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 17,
          username: 'interval-success',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 17,
          name: 'demo',
          url: 'https://example.com',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功' });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(17, { scheduleMode: 'interval' });

    expect(result.success).toBe(true);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ lastCheckinAt: expect.any(String) }));
  });

  it('treats unsupported checkin endpoint responses as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 10,
          username: 'linuxdo_131936',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 10,
          name: 'anyrouter',
          url: 'https://anyrouter.top',
          platform: 'anyrouter',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'HTTP 404: {"error":{"message":"Invalid URL (POST /api/user/checkin)"}}',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(10);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('skips account updates when unsupported checkin responses do not change account state', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 18,
          username: 'plain-user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 18,
          name: 'done-hub',
          url: 'https://done.example.com',
          platform: 'donehub',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'checkin endpoint not found',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(18);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    expect(updateSetMock).not.toHaveBeenCalled();
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
  });

  it('treats sub2api checkin unsupported message as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 15,
          username: 'sub2_user',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 15,
          name: 'sub2',
          url: 'https://sub2.example.com',
          platform: 'sub2api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Check-in is not supported by Sub2API',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(15);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('treats turnstile-required responses as skipped', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 14,
          username: 'linuxdo_10277',
          accessToken: 'token',
          status: 'active',
          extraConfig: null,
        },
        sites: {
          id: 14,
          name: 'run-anytime',
          url: 'https://runanytime.hxi.me',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Turnstile token 为空',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(14);

    expect(result.success).toBe(true);
    expect(result.status).toBe('skipped');
    const firstInsertPayload = insertValuesMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstInsertPayload?.status).toBe('skipped');
    expect(firstInsertPayload?.message).toBe('站点开启了 Turnstile 校验，需要人工签到');
    expect(refreshBalanceMock).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('keeps the session a browser check-in establishes', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 3,
          username: '3145215575',
          accessToken: 'new_api_refresh=retired',
          status: 'expired',
          extraConfig: JSON.stringify({
            credentialMode: 'session',
            autoRelogin: { username: '3145215575', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 15,
          name: '方舟',
          url: 'https://api.bxacc.xyz',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Turnstile token 为空',
    });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');
    browserSessionMock.mockResolvedValue({
      outcome: {
        kind: 'result',
        result: { success: true, message: '浏览器签到成功（已通过站点人机校验）' },
        logDir: '/data/metapi/checkin-browser/site-15/runs/site-15-x',
        profileDir: '/data/metapi/checkin-browser/site-15/profiles/site-15',
      },
      accessToken: 'new_api_refresh=fresh',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(3);

    expect(result.success).toBe(true);
    // The credential the browser earned has to reach the account row, or the
    // next call spends a retired secret and the account looks revoked again.
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      accessToken: 'new_api_refresh=fresh',
      status: 'active',
    }));
  });

  it('leaves the stored credential alone when the browser run stores no session', async () => {
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 3,
          username: '3145215575',
          accessToken: 'new_api_refresh=retired',
          status: 'expired',
          extraConfig: JSON.stringify({
            autoRelogin: { username: '3145215575', passwordCipher: 'cipher' },
          }),
        },
        sites: {
          id: 15,
          name: '方舟',
          url: 'https://api.bxacc.xyz',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Turnstile token 为空',
    });
    decryptPasswordMock.mockReturnValue('liyaodong7238508');
    browserSessionMock.mockResolvedValue({
      outcome: {
        kind: 'result',
        result: { success: false, message: '浏览器签到未完成：login_failed' },
        logDir: '/logs',
        profileDir: '/profile',
      },
      accessToken: null,
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(3);

    // Without a session the browser run is just a failed check-in, and the
    // account keeps the credential it had instead of a value nothing can use.
    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('drives the browser with the stored session when the account has no password', async () => {
    // A token-only bind on a site whose sign-in is a GitHub redirect: there is
    // no autoRelogin config and no password to type, so the session cookie is
    // the only way the browser can reach the check-in card. Before this, that
    // shape of account was refused outright and every run ended in
    // "needs manual verification".
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 22,
          username: 'liumeijicui',
          accessToken: 'new_api_refresh=seeded',
          status: 'active',
          extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 4219 }),
        },
        sites: {
          id: 37,
          name: 'KKtoken AI',
          url: 'https://kktoken.cc',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Turnstile token 为空',
    });
    browserSessionMock.mockResolvedValue({
      outcome: {
        kind: 'result',
        result: { success: true, message: '浏览器签到成功（已通过站点人机校验）' },
        logDir: '/logs',
        profileDir: '/profile',
      },
      accessToken: null,
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(22);

    expect(result.success).toBe(true);
    expect(decryptPasswordMock).not.toHaveBeenCalled();
    expect(browserSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      sessionCredential: 'new_api_refresh=seeded',
      username: 'liumeijicui',
      password: '',
    }));
  });

  it('does not start a browser for a credential that is not a session cookie', async () => {
    // A bare API key or access token is not something the browser can present,
    // so launching Chromium for it would only burn a run on the sign-in form.
    selectAllMock.mockReturnValue([
      {
        accounts: {
          id: 22,
          username: 'liumeijicui',
          accessToken: 'DniVswV+PKybmfhUqqiTlherargWYtM=',
          status: 'active',
          extraConfig: JSON.stringify({ credentialMode: 'session', platformUserId: 4219 }),
        },
        sites: {
          id: 37,
          name: 'KKtoken AI',
          url: 'https://kktoken.cc',
          platform: 'new-api',
        },
      },
    ]);

    adapterMock.checkin.mockResolvedValue({
      success: false,
      message: 'Turnstile token 为空',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(22);

    expect(browserSessionMock).not.toHaveBeenCalled();
    // The turnstile verdict still stands on its own: the run is recorded as
    // "needs a person" rather than failed, and no browser was spent on it.
    expect(result.status).toBe('skipped');
  });
});
