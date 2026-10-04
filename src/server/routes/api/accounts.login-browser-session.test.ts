import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const convergeAccountMutationMock = vi.fn();
const browserSessionMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

vi.mock('../../services/browserSessionCredential.js', () => ({
  runBrowserSessionCheckin: (...args: unknown[]) => browserSessionMock(...args),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts login behind a turnstile-gated endpoint', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-login-browser-session-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./accounts.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.accountsRoutes);
  });

  beforeEach(async () => {
    loginMock.mockReset();
    getApiTokenMock.mockReset();
    getApiTokensMock.mockReset();
    convergeAccountMutationMock.mockReset();
    browserSessionMock.mockReset();
    resetRequestRateLimitStore();

    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    delete process.env.DATA_DIR;
  });

  const createSite = () => db.insert(schema.sites).values({
    name: '方舟',
    url: 'https://api.bxacc.xyz',
    platform: 'new-api',
  }).returning().get();

  it('binds the account with the session the browser captures', async () => {
    loginMock.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    convergeAccountMutationMock.mockResolvedValue(undefined);
    browserSessionMock.mockResolvedValue({
      outcome: {
        kind: 'result',
        result: { success: true, message: '浏览器签到成功（已通过站点人机校验）' },
        logDir: '/logs',
        profileDir: '/profile',
      },
      accessToken: 'new_api_refresh=captured',
    });

    const site = await createSite();
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: '3145215575', password: 'liyaodong7238508' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].accessToken).toBe('new_api_refresh=captured');
    expect(JSON.parse(String(accounts[0].extraConfig)).autoRelogin).toEqual(
      expect.objectContaining({ username: '3145215575' }),
    );

    // The captured cookie is a rolling credential: spending it before the
    // account row exists would retire the only secret the site handed out.
    expect(getApiTokenMock).not.toHaveBeenCalled();
    expect(getApiTokensMock).not.toHaveBeenCalled();
  });

  it('binds the refresh half a Sub2API sign-in hands back', async () => {
    // The access half of the pair dies within hours, and this deployment answers
    // `/api/v1/auth/login` with a Turnstile once it does. Storing only the
    // access token would leave the account with no way to renew itself and no
    // way to sign in again.
    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'jwt-access',
      platformUserId: 341,
      refreshToken: 'rt-1',
      tokenExpiresAt: 1_800_000_000_000,
    });
    getApiTokenMock.mockResolvedValue('sk-bound');
    getApiTokensMock.mockResolvedValue([]);
    convergeAccountMutationMock.mockResolvedValue(undefined);

    const site = await db.insert(schema.sites).values({
      name: '虾蹬王',
      url: 'https://api.kunyou.asia',
      platform: 'sub2api',
    }).returning().get();
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: '3145215575@qq.com', password: 'liyaodong7238508' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(true);
    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts[0].accessToken).toBe('jwt-access');
    expect(JSON.parse(String(accounts[0].extraConfig)).sub2apiAuth).toEqual({
      refreshToken: 'rt-1',
      tokenExpiresAt: 1_800_000_000_000,
    });
  });

  it('still reports the login failure when no browser can capture a session', async () => {
    loginMock.mockResolvedValue({ success: false, message: 'Turnstile token 为空' });
    browserSessionMock.mockResolvedValue({
      outcome: { kind: 'unavailable', reason: '未找到 chromium' },
      accessToken: null,
    });

    const site = await createSite();
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: '3145215575', password: 'liyaodong7238508' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().success).toBe(false);
    expect(await db.select().from(schema.accounts).all()).toHaveLength(0);
  });
});
