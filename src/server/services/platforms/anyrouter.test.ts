import { beforeEach, describe, expect, it, vi } from 'vitest';

const { linuxdoLoginMock } = vi.hoisted(() => ({ linuxdoLoginMock: vi.fn() }));

vi.mock('../assistedLogin/sites/anyRouter.js', () => ({
  loginAnyRouterWithLinuxDo: linuxdoLoginMock,
}));

import { NewApiAdapter, QUOTA_PER_UNIT } from './newApi.js';
import { AnyRouterAdapter } from './anyrouter.js';

const BASE_URL = 'https://anyrouter.top';
const USER_ID = 166294;
const LINUXDO_ACCOUNT = JSON.stringify({
  credentialMode: 'session',
  platformUserId: USER_ID,
  oauth: { provider: 'linuxdo' },
});
const PASSWORD_ACCOUNT = JSON.stringify({ credentialMode: 'session', platformUserId: USER_ID });

const STATUS_WITH_LINUXDO = {
  success: true,
  data: { linuxdo_oauth: true, linuxdo_client_id: 'anyrouter-client-id' },
};

/** The parent's own route never pays on this site; the tests drive it directly. */
let siteCheckinResult = { success: true, message: 'checked in' };
/** Balances in USD, consumed one per read; the last value repeats. */
let balances: number[] = [];
let statusPayload: unknown = STATUS_WITH_LINUXDO;
/** True while the site's edge shields plain HTTP, as it does for minutes at a time. */
let httpShielded = false;

function balanceUsd(): number {
  const next = balances.length > 1 ? balances.shift()! : balances[0];
  return Number(next.toFixed(6));
}

function quota(usd: number): number {
  return usd * QUOTA_PER_UNIT;
}

describe('AnyRouterAdapter', () => {
  let adapter: AnyRouterAdapter;
  let parentCheckin: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    adapter = new AnyRouterAdapter();
    balances = [];
    statusPayload = STATUS_WITH_LINUXDO;
    httpShielded = false;
    siteCheckinResult = { success: true, message: 'checked in' };
    linuxdoLoginMock.mockResolvedValue({ ok: true, message: 'Linux.do 重新登录完成' });
    parentCheckin = vi
      .spyOn(NewApiAdapter.prototype, 'checkin')
      .mockImplementation(async () => ({ ...siteCheckinResult }));
    vi.spyOn(NewApiAdapter.prototype as any, 'fetchSiteJson').mockImplementation(
      async (url: string) => {
        if (httpShielded) return null;
        if (url.endsWith('/api/status')) return statusPayload;
        if (url.endsWith('/api/user/self')) {
          return { success: true, data: { quota: quota(balanceUsd()) } };
        }
        throw new Error(`unexpected url: ${url}`);
      },
    );
  });

  it('detects the anyrouter host only', async () => {
    expect(await adapter.detect(`${BASE_URL}/console/token`)).toBe(true);
    expect(await adapter.detect('https://example.com')).toBe(false);
  });

  it('credits the reward the site pays through its own check-in route', async () => {
    balances = [100, 125];

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: LINUXDO_ACCOUNT,
    });

    expect(result).toEqual({ success: true, message: 'checked in（额度 +$25）', reward: '25' });
    expect(linuxdoLoginMock).not.toHaveBeenCalled();
  });

  it('replays the Linux.do login when the check-in route pays nothing', async () => {
    balances = [100, 100, 125];

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: LINUXDO_ACCOUNT,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('退出重登后签到到账');
    expect(result.reward).toBe('25');
    expect(linuxdoLoginMock).toHaveBeenCalledTimes(1);
    expect(linuxdoLoginMock.mock.calls[0][0]).toEqual({
      baseUrl: BASE_URL,
      clientId: 'anyrouter-client-id',
      expectedUserId: USER_ID,
    });
    // The SPA repeats the site's check-in after the callback, and so does the
    // adapter: the retry is what pays on a fresh day.
    expect(parentCheckin).toHaveBeenCalledTimes(2);
  });

  it('reports a day that pays nothing even after a fresh login', async () => {
    balances = [100, 100, 100];

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: LINUXDO_ACCOUNT,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('今日已签到');
    expect(linuxdoLoginMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the quota the browser read when the edge shields HTTP', async () => {
    httpShielded = true;
    linuxdoLoginMock.mockResolvedValue({
      ok: true,
      message: 'Linux.do 重新登录完成',
      quotaBefore: quota(1932.185456),
      quotaAfter: quota(1957.185456),
    });

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: LINUXDO_ACCOUNT,
    });

    expect(result.success).toBe(true);
    expect(result.reward).toBe('25');
    expect(result.message).toContain('退出重登后签到到账');
    // A shielded edge is not asked at all: the browser is the only channel left.
    expect(parentCheckin).not.toHaveBeenCalled();
    // The same edge that hid the balance also hid /api/status, so the browser
    // has to resolve the client id it never got.
    expect(linuxdoLoginMock.mock.calls[0][0].clientId).toBe('');
  });

  it('reports an already collected day from the browser numbers alone', async () => {
    httpShielded = true;
    linuxdoLoginMock.mockResolvedValue({
      ok: true,
      message: 'Linux.do 重新登录完成',
      quotaBefore: quota(1932.185456),
      quotaAfter: quota(1932.185456),
    });

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: LINUXDO_ACCOUNT,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('今日已签到');
  });

  it('does not claim a check-in nobody could verify', async () => {
    httpShielded = true;
    linuxdoLoginMock.mockResolvedValue({
      ok: true,
      message: 'Linux.do 重新登录完成',
      quotaBefore: null,
      quotaAfter: null,
    });

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: LINUXDO_ACCOUNT,
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('未确认发放');
  });

  it('leaves the client id to the browser when the edge hides /api/status', async () => {
    httpShielded = true;

    await adapter.checkin(BASE_URL, 'session=abc', USER_ID, { extraConfig: LINUXDO_ACCOUNT });

    expect(linuxdoLoginMock).toHaveBeenCalledTimes(1);
    expect(linuxdoLoginMock.mock.calls[0][0].clientId).toBe('');
  });

  it('reports a non-Linux.do account as already checked in when the balance is readable', async () => {
    balances = [100, 100];

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: PASSWORD_ACCOUNT,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('今日已签到');
    expect(linuxdoLoginMock).not.toHaveBeenCalled();
  });

  it('reports the site as unreachable, never as logged in, when nothing can be read', async () => {
    httpShielded = true;

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: PASSWORD_ACCOUNT,
    });

    expect(result).toEqual({ success: false, message: '站点接口不可用' });
    expect(parentCheckin).not.toHaveBeenCalled();
    expect(linuxdoLoginMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed browser login instead of a silent success', async () => {
    balances = [100, 100];
    linuxdoLoginMock.mockResolvedValue({
      ok: false,
      message: '仅允许对 anyrouter.top 执行 Linux.do 退出重登',
    });

    const result = await adapter.checkin(BASE_URL, 'session=abc', USER_ID, {
      extraConfig: LINUXDO_ACCOUNT,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('仅允许对 anyrouter.top');
  });
});
