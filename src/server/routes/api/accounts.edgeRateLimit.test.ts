import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';

const verifyTokenMock = vi.fn();

/**
 * Inert adapter: verification is the only call under test, every other
 * capability answers empty so the background initialisation stays quiet.
 */
const adapterStub = {
  platformName: 'anyrouter',
  verifyToken: (...args: unknown[]) => verifyTokenMock(...args),
  getApiToken: async () => null,
  getApiTokens: async () => [],
  getBalance: async () => ({ quota: 0, used: 0, balance: 0 }),
  getModels: async () => [],
  getUserInfo: async () => null,
};

vi.mock('../../services/platforms/index.js', () => ({
  getAdapter: () => adapterStub,
}));

type DbModule = typeof import('../../db/index.js');

describe('accounts edge rate limit binding', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-accounts-edge-rate-limit-'));
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
    verifyTokenMock.mockReset();
    resetRequestRateLimitStore();

    await db.delete(schema.proxyLogs).run();
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('binds the session when the site throttles verification instead of rejecting the token', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown', failureReason: 'rate-limited' });

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'anyrouter',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        username: 'linuxdo_166294',
        accessToken: 'throttled-session-token',
        platformUserId: 166294,
        credentialMode: 'session',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      success?: boolean;
      credentialMode?: string;
      message?: string;
      requiresVerification?: boolean;
    };
    expect(body.success).not.toBe(false);
    expect(body.credentialMode).toBe('session');
    expect(body.requiresVerification).toBeUndefined();
    expect(body.message || '').toContain('限流');

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.accessToken).toBe('throttled-session-token');
  });

  it('still refuses an unknown verdict that is not site throttling', async () => {
    verifyTokenMock.mockResolvedValueOnce({ tokenType: 'unknown' });

    const site = await db.insert(schema.sites).values({
      name: 'AnyRouter',
      url: 'https://anyrouter.example.com',
      platform: 'anyrouter',
    }).returning().get();

    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      payload: {
        siteId: site.id,
        accessToken: 'unverified-token',
        credentialMode: 'session',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      requiresVerification: true,
    });

    const accounts = await db.select().from(schema.accounts).all();
    expect(accounts).toHaveLength(0);
  });
});
