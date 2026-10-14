import { beforeEach, describe, expect, it, vi } from 'vitest';

const adapterMock = {
  checkin: vi.fn(),
  login: vi.fn(),
};

const notifyMock = vi.fn();
const reportTokenExpiredMock = vi.fn();
const refreshBalanceMock = vi.fn();
const setHealthMock = vi.fn();
const exchangeMock = vi.fn();

const selectAllMock = vi.fn();
const insertValuesMock = vi.fn();
const updateSetMock = vi.fn();
const whereArgs: unknown[] = [];

vi.mock('../db/index.js', () => {
  const selectChain: any = {
    all: () => selectAllMock(),
    get: () => selectAllMock(),
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

  const updateWhereChain = { run: () => ({}) };
  const updateSetChain = { where: () => updateWhereChain };

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

vi.mock('./accountHealthService.js', () => ({
  setAccountRuntimeHealth: (...args: unknown[]) => setHealthMock(...args),
  extractRuntimeHealth: () => null,
}));

vi.mock('./balanceService.js', () => ({
  refreshBalance: (...args: unknown[]) => refreshBalanceMock(...args),
}));

vi.mock('./lotteryService.js', () => ({
  runDailyLottery: async () => ({ drawn: 0, wins: 0, reward: 0, reason: 'not this site' }),
}));

vi.mock('./pipiPointsExchangeService.js', () => ({
  runPipiPointsExchange: (...args: unknown[]) => exchangeMock(...args),
}));

const PIPI_ROW = {
  accounts: {
    id: 51,
    siteId: 65,
    username: '柳眉积翠',
    accessToken: 'pipi-bearer-token',
    status: 'active',
    balance: 210,
    checkinEnabled: true,
    extraConfig: null,
    oauthProvider: null,
  },
  sites: {
    id: 65,
    name: '皮皮智绘',
    url: 'https://img.pipiwangcom.com',
    platform: 'pipi-image',
    status: 'active',
    externalCheckinUrl: null,
  },
};

/** 日志行：签到与兑换应该落在同一条上。 */
function loggedMessage(): string {
  const row = insertValuesMock.mock.calls
    .map((call) => call[0] as Record<string, unknown> | undefined)
    .find((value) => value && typeof value.message === 'string' && typeof value.accountId === 'number');
  return String(row?.message || '');
}

describe('checkinService 皮皮智绘：签到 + 积分兑换', () => {
  beforeEach(() => {
    adapterMock.checkin.mockReset();
    adapterMock.login.mockReset();
    notifyMock.mockReset();
    reportTokenExpiredMock.mockReset();
    refreshBalanceMock.mockReset();
    setHealthMock.mockReset();
    exchangeMock.mockReset();
    selectAllMock.mockReset();
    insertValuesMock.mockReset();
    updateSetMock.mockReset();
    whereArgs.length = 0;
  });

  it('runs the exchange inside the scheduled pass, not only from a manual trigger', async () => {
    // The scheduled pass is the caller that matters: the operator never has to
    // open the page for the day's points to be turned into API balance.
    selectAllMock.mockReturnValue([PIPI_ROW]);
    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功 +50 积分', reward: '50' });
    exchangeMock.mockResolvedValue({
      kind: 'transferred',
      transferred: true,
      points: 200,
      usd: 10,
      reason: '兑换成功',
    });

    const { checkinAll } = await import('./checkinService.js');
    await checkinAll({ scheduleMode: 'cron' });

    expect(exchangeMock).toHaveBeenCalledTimes(1);
    expect(exchangeMock.mock.calls[0][0]).toMatchObject({
      siteUrl: 'https://img.pipiwangcom.com',
      accessToken: 'pipi-bearer-token',
    });
    expect(loggedMessage()).toContain('兑换 200 积分 → $10 API 余额');
  });

  it('still exchanges on a day the check-in was already claimed', async () => {
    // `already` means "this day is claimed", and the points that were granted
    // earlier still have to be turned into balance.
    selectAllMock.mockReturnValue([PIPI_ROW]);
    adapterMock.checkin.mockResolvedValue({ success: true, message: '今日已签到' });
    exchangeMock.mockResolvedValue({
      kind: 'transferred',
      transferred: true,
      points: 100,
      usd: 5,
      reason: '兑换成功',
    });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(51);

    expect(exchangeMock).toHaveBeenCalledTimes(1);
    expect(loggedMessage()).toContain('兑换 100 积分 → $5 API 余额');
  });

  it('stays quiet when the points are below the site minimum', async () => {
    selectAllMock.mockReturnValue([PIPI_ROW]);
    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功 +50 积分', reward: '50' });
    exchangeMock.mockResolvedValue({
      kind: 'idle',
      transferred: false,
      points: 0,
      usd: 0,
      reason: '积分 60 未达到起兑线 100',
    });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(51);

    expect(exchangeMock).toHaveBeenCalledTimes(1);
    // 稳态不写进日志：每天刷一行「没到起兑线」只会淹没真正有用的那几条。
    expect(loggedMessage()).not.toContain('起兑线');
    expect(loggedMessage()).toBe('签到成功 +50 积分');
  });

  it('reports a real exchange failure without failing the check-in', async () => {
    selectAllMock.mockReturnValue([PIPI_ROW]);
    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功 +50 积分', reward: '50' });
    exchangeMock.mockResolvedValue({
      kind: 'failed',
      transferred: false,
      points: 0,
      usd: 0,
      reason: '站点拒绝兑换请求：HTTP 502',
    });

    const { checkinAccount } = await import('./checkinService.js');
    const result = await checkinAccount(51);

    expect(result.success).toBe(true);
    expect(loggedMessage()).toContain('站点拒绝兑换请求：HTTP 502');
    // 失败原因整句只出现一次，不被调用方再拼一层前缀。
    expect(loggedMessage()).not.toContain('兑换未完成：站点拒绝');
  });

  it('never calls the exchange for a site that is not the image host', async () => {
    selectAllMock.mockReturnValue([{
      accounts: { ...PIPI_ROW.accounts, id: 7, accessToken: 'new-api-token' },
      sites: {
        id: 19,
        name: 'happycoding',
        url: 'https://happycoding.xyz',
        platform: 'new-api',
        status: 'active',
        externalCheckinUrl: null,
      },
    }]);
    adapterMock.checkin.mockResolvedValue({ success: true, message: '签到成功', reward: '1' });

    const { checkinAccount } = await import('./checkinService.js');
    await checkinAccount(7);

    expect(exchangeMock).not.toHaveBeenCalled();
  });
});
