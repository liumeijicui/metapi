import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GwRelayAdapter,
  describeRequestError,
  isAlreadyCheckedIn,
  isSessionRefusal,
  normalizeSessionRefusal,
  normalizeUserToken,
  readErrorMessage,
} from './gwrelay.js';
import { classifyFailureReason } from '../failureReasonService.js';

const BASE_URL = 'https://lzhiyu.ccwu.cc';
const TOKEN = 'ut-49d273b8768f8ea804bd8';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../siteProxy.js', () => ({
  withSiteProxyRequestInit: async (_url: string, options: unknown) => options,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return String((input as { url?: string })?.url || input);
}

function actionOf(input: unknown): string {
  return new URL(urlOf(input)).searchParams.get('action') || '';
}

type Route = { status?: number; body: unknown };
let routes: Record<string, Route> = {};

function setupRoutes(overrides: Record<string, Route> = {}): void {
  routes = {
    register_status: {
      body: {
        success: true,
        data: { register_enabled: true, checkin_enabled: true, key_create_enabled: true },
      },
    },
    checkin: { body: { success: true, message: '签到成功，获得 50 次调用额度（已存入账号）', data: { reward: 50, new_balance: 680 } } },
    user_dashboard: {
      body: {
        success: true,
        data: { username: '3145215575', balance: 680, total_balance: 680, checkin_today: { checked_in: true, reward: 50 } },
      },
    },
    user_info: {
      body: {
        success: true,
        data: { username: '3145215575', email: '31***@qq.com', keys: ['sk-gw-aaa', 'sk-gw-bbb'] },
      },
    },
    notice_feed: {
      body: {
        success: true,
        data: { announcements: [{ id: 4, title: '今晚狂欢', content: '全员额度大放送', level: 'success' }] },
      },
    },
    ...overrides,
  };
}

describe('GwRelayAdapter', () => {
  let adapter: GwRelayAdapter;

  beforeEach(() => {
    vi.resetAllMocks();
    setupRoutes();
    adapter = new GwRelayAdapter();
    fetchMock.mockImplementation(async (input: unknown) => {
      const route = routes[actionOf(input)];
      if (!route) throw new Error(`unexpected action: ${actionOf(input)}`);
      return jsonResponse(route.body, route.status ?? 200);
    });
  });

  it('detects the panel by its bootstrap endpoint, not by the host', async () => {
    expect(await adapter.detect(BASE_URL)).toBe(true);
    setupRoutes({ register_status: { body: { success: true, data: { register_enabled: true } } } });
    expect(await adapter.detect('https://example.com')).toBe(false);
  });

  it('never claims an HTTP password login it cannot perform', async () => {
    const result = await adapter.login();

    expect(result.success).toBe(false);
    // The wording has to carry both halves the shared classifier looks for, or a
    // human-check refusal is mistaken for a wrong password and the browser
    // fallback is never attempted.
    expect(result.message).toContain('Turnstile');
    expect(result.message).toContain('人机验证');
  });

  it('reports the reward the site paid out', async () => {
    const result = await adapter.checkin(BASE_URL, TOKEN);

    expect(result).toEqual({
      success: true,
      message: '签到成功，获得 50 次调用额度（已存入账号）',
      reward: '50',
    });
    const checkinCall = fetchMock.mock.calls.find(([input]) => actionOf(input) === 'checkin');
    expect(checkinCall).toBeTruthy();
    const [url, options] = checkinCall!;
    expect(urlOf(url)).toContain('action=checkin');
    expect((options as any).headers['X-User-Token']).toBe(TOKEN);
    expect(JSON.parse((options as any).body)).toEqual({ user_token: TOKEN });
  });

  it('turns the site\'s repeat refusal into the wording the scheduler knows', async () => {
    setupRoutes({
      checkin: { status: 400, body: { error: { message: '今天已经签到过了' } } },
    });

    const result = await adapter.checkin(BASE_URL, TOKEN);

    expect(result.success).toBe(false);
    expect(result.message).toBe('今日已签到');
  });

  it('keeps the 401 that sends the caller to a re-login', async () => {
    setupRoutes({
      checkin: {
        status: 401,
        body: { error: { message: '登录已失效或未登录，请重新登录 [401 user_unauthorized]' } },
      },
    });

    const result = await adapter.checkin(BASE_URL, TOKEN);

    expect(result.success).toBe(false);
    expect(result.message).toContain('HTTP 401');
    expect(result.message).toContain('user_unauthorized');
  });

  it('refuses to call the site without a stored token', async () => {
    const result = await adapter.checkin(BASE_URL, '  ');

    expect(result.success).toBe(false);
    expect(result.message).toContain('用户令牌');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads a token the panel cannot parse as an expired session', async () => {
    // An unreadable token never reaches the 401 branch: the panel answers
    // `400 invalid_request`, which on its own reads as a plain error. Left as
    // that, the account is reported but never signed back in — and the balance
    // refresh that follows marks it `expired`, dropping it out of the daily
    // check-in set for good.
    setupRoutes({
      checkin: {
        status: 400,
        body: { error: { code: 'invalid_request', message: '请先登录，或携带 api_key 参数' } },
      },
    });

    const result = await adapter.checkin(BASE_URL, TOKEN);

    expect(result.success).toBe(false);
    expect(result.message).toContain('访问令牌无效或已过期');
    expect(result.message).toContain('请先登录');
    expect(classifyFailureReason({ message: result.message }).code).toBe('token_expired');
  });

  it('reads the account-level balance', async () => {
    const balance = await adapter.getBalance(BASE_URL, TOKEN);

    expect(balance).toEqual({ balance: 680, used: 0, quota: 680 });
  });

  it('surfaces a dead token while reading the balance too', async () => {
    setupRoutes({
      user_dashboard: {
        status: 401,
        body: { error: { message: '登录已失效或未登录，请重新登录 [401 user_unauthorized]' } },
      },
    });

    await expect(adapter.getBalance(BASE_URL, TOKEN)).rejects.toThrow(/HTTP 401/);
  });

  it('rewrites an unreadable token on the balance path as well', async () => {
    setupRoutes({
      user_dashboard: {
        status: 400,
        body: { error: { code: 'invalid_request', message: '请先登录，或携带 api_key 参数' } },
      },
    });

    await expect(adapter.getBalance(BASE_URL, TOKEN)).rejects.toThrow(/访问令牌无效或已过期/);
  });

  it('exposes the user and the API keys the panel hands out', async () => {
    expect(await adapter.getUserInfo(BASE_URL, TOKEN)).toEqual({
      username: '3145215575',
      email: '31***@qq.com',
    });
    expect(await adapter.getApiTokens(BASE_URL, TOKEN)).toEqual([
      { name: '密钥 1', key: 'sk-gw-aaa', enabled: true, tokenGroup: null },
      { name: '密钥 2', key: 'sk-gw-bbb', enabled: true, tokenGroup: null },
    ]);
  });

  it('maps the announcement feed onto site announcements', async () => {
    const announcements = await adapter.getSiteAnnouncements(BASE_URL, TOKEN);

    expect(announcements).toHaveLength(1);
    expect(announcements[0].title).toBe('今晚狂欢');
    expect(announcements[0].content).toBe('全员额度大放送');
    expect(announcements[0].level).toBe('info');
    expect(announcements[0].sourceKey).toContain('notice:');
  });
});

describe('gwrelay payload helpers', () => {
  it('accepts the token shapes an operator can paste', () => {
    expect(normalizeUserToken(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(normalizeUserToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(normalizeUserToken(undefined)).toBe('');
  });

  it('reads both refusal shapes the panel uses', () => {
    expect(readErrorMessage({ error: { message: '出错' } })).toBe('出错');
    expect(readErrorMessage({ message: '签到失败' })).toBe('签到失败');
    expect(readErrorMessage({ success: true })).toBe('');
  });

  it('keeps the HTTP status and drops the body noise', () => {
    expect(describeRequestError(new Error(`HTTP 401: {"error":{"message":"登录已失效或未登录"}}`)))
      .toBe('HTTP 401 登录已失效或未登录');
    expect(describeRequestError(new Error('ECONNRESET'))).toBe('ECONNRESET');
  });

  it('recognizes the repeat-checkin wording', () => {
    expect(isAlreadyCheckedIn('今天已经签到过了')).toBe(true);
    expect(isAlreadyCheckedIn('already checked in')).toBe(true);
    expect(isAlreadyCheckedIn('签到失败')).toBe(false);
  });

  it('rewrites only the refusals that mean the session is gone', () => {
    expect(isSessionRefusal('HTTP 401 登录已失效或未登录，请重新登录')).toBe(true);
    expect(isSessionRefusal('HTTP 400 请先登录，或携带 api_key 参数')).toBe(true);
    expect(isSessionRefusal('HTTP 500 internal server error')).toBe(false);

    // Already-collected days are not session refusals; the caller words those.
    expect(normalizeSessionRefusal('今天已经签到过了')).toBe('今天已经签到过了');
    expect(normalizeSessionRefusal('HTTP 500 上游异常')).toBe('HTTP 500 上游异常');
  });
});
