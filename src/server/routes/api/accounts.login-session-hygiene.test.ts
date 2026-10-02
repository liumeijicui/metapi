import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loginMock = vi.fn();
const getApiTokenMock = vi.fn();
const getApiTokensMock = vi.fn();
const convergeAccountMutationMock = vi.fn();
const listSessionsMock = vi.fn();
const revokeSessionMock = vi.fn();

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => ({
    login: (...args: unknown[]) => loginMock(...args),
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getApiTokens: (...args: unknown[]) => getApiTokensMock(...args),
    listSessions: (...args: unknown[]) => listSessionsMock(...args),
    revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
  }),
}));

vi.mock('../../services/accountMutationWorkflow.js', () => ({
  convergeAccountMutation: (...args: unknown[]) => convergeAccountMutationMock(...args),
  rebuildRoutesBestEffort: vi.fn(),
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts login session hygiene', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-login-hygiene-'));
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
    listSessionsMock.mockReset();
    revokeSessionMock.mockReset();

    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
    delete process.env.DATA_DIR;
  });

  it('retires the sessions a manual bind superseded, using the token it just minted', async () => {
    // The bind hands back a durable refresh cookie plus the short-lived token
    // for the calls the flow makes before that cookie is exchanged.
    loginMock.mockResolvedValue({
      success: true,
      accessToken: 'new_api_refresh=11111111-2222-3333-4444-555555555555.secret',
      // A real bind token is a JWT carrying the session id it was minted for.
      bearerToken: `header.${Buffer.from(JSON.stringify({ sid: 'fresh-session' })).toString('base64url')}.signature`,
      platformUserId: 38,
    });
    getApiTokenMock.mockResolvedValue(null);
    getApiTokensMock.mockResolvedValue([]);
    convergeAccountMutationMock.mockResolvedValue(undefined);
    listSessionsMock.mockResolvedValue([
      { sid: 'fresh-session', current: true, loginMethod: 'password', ip: null, userAgent: null, createdAt: null, lastActiveAt: null, expiresAt: null },
      { sid: 'stale-session', current: false, loginMethod: 'password', ip: null, userAgent: null, createdAt: null, lastActiveAt: null, expiresAt: null },
    ]);
    revokeSessionMock.mockResolvedValue(true);

    const site = await db.insert(schema.sites).values({
      name: 'Hygiene Site',
      url: 'https://hygiene.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: 'demo-user', password: 'demo-password' },
    });

    expect(response.statusCode).toBe(200);
    // The cleanup spends the just-minted token, never the cookie that was just
    // stored: exchanging the cookie here would rotate it out from under the row.
    expect(String(listSessionsMock.mock.calls[0][1])).toMatch(/^header\./);
    expect(revokeSessionMock).toHaveBeenCalledTimes(1);
    expect(revokeSessionMock.mock.calls[0][3]).toBe('stale-session');

    const account = await db.select().from(schema.accounts).all();
    expect(account).toHaveLength(1);
    expect(account[0].accessToken).toBe('new_api_refresh=11111111-2222-3333-4444-555555555555.secret');
    expect(JSON.parse(String(account[0].extraConfig)).sessionHygiene).toMatchObject({
      outcome: 'pruned',
      removed: 1,
      kept: 1,
    });
  });

  it('leaves the bind untouched when the site has no session API', async () => {
    loginMock.mockResolvedValue({ success: true, accessToken: 'plain-session-token' });
    getApiTokenMock.mockResolvedValue(null);
    getApiTokensMock.mockResolvedValue([]);
    convergeAccountMutationMock.mockResolvedValue(undefined);
    listSessionsMock.mockResolvedValue(null);

    const site = await db.insert(schema.sites).values({
      name: 'No Session API',
      url: 'https://no-session-api.example.com',
      platform: 'new-api',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/login',
      payload: { siteId: site.id, username: 'demo-user', password: 'demo-password' },
    });

    expect(response.statusCode).toBe(200);
    expect(revokeSessionMock).not.toHaveBeenCalled();
    const account = await db.select().from(schema.accounts).all();
    expect(account).toHaveLength(1);
    expect(account[0].accessToken).toBe('plain-session-token');
  });
});
