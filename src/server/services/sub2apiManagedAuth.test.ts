import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const undiciFetchMock = vi.fn();

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => undiciFetchMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type AuthModule = typeof import('./sub2apiManagedAuth.js');

function buildSub2ApiExtraConfig(refreshToken: string, tokenExpiresAt: number): string {
  return JSON.stringify({
    credentialMode: 'session',
    sub2apiAuth: { refreshToken, tokenExpiresAt },
  });
}

describe('sub2apiManagedAuth', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshSub2ApiManagedSession: AuthModule['refreshSub2ApiManagedSession'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sub2api-managed-auth-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const authModule = await import('./sub2apiManagedAuth.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshSub2ApiManagedSession = authModule.refreshSub2ApiManagedSession;
  });

  beforeEach(async () => {
    undiciFetchMock.mockReset();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  async function seedAccount(input: { status: string }) {
    const site = await db.insert(schema.sites).values({
      name: `sub2-auth-${input.status}`,
      url: `https://sub2-auth-${input.status}.example.com`,
      platform: 'sub2api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: `${input.status}@example.com`,
      accessToken: 'stale-access-token',
      apiToken: null,
      status: input.status,
      extraConfig: buildSub2ApiExtraConfig('stale-refresh-token', Date.now() - 60_000),
    }).returning().get();

    return { site, account };
  }

  it('promotes an expired account back to active once the managed refresh succeeds', async () => {
    const { site, account } = await seedAccount({ status: 'expired' });

    undiciFetchMock.mockResolvedValue({
      status: 200,
      text: async () => JSON.stringify({
        code: 0,
        data: {
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
        },
      }),
    });

    const refreshed = await refreshSub2ApiManagedSession({
      account,
      site,
      currentAccessToken: account.accessToken || '',
      currentExtraConfig: account.extraConfig,
    });

    expect(refreshed.accessToken).toBe('fresh-access-token');

    const row = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(row?.status).toBe('active');
    expect(row?.accessToken).toBe('fresh-access-token');

    const extraConfig = JSON.parse(row?.extraConfig || '{}');
    expect(extraConfig.sub2apiAuth.refreshToken).toBe('fresh-refresh-token');
    expect(extraConfig.sub2apiAuth.tokenExpiresAt).toBeGreaterThan(Date.now());
  });

  it('leaves the account untouched when the refresh token is refused', async () => {
    const { site, account } = await seedAccount({ status: 'expired' });

    undiciFetchMock.mockResolvedValue({
      status: 401,
      text: async () => JSON.stringify({ code: 401, message: 'invalid refresh token' }),
    });

    await expect(refreshSub2ApiManagedSession({
      account,
      site,
      currentAccessToken: account.accessToken || '',
      currentExtraConfig: account.extraConfig,
    })).rejects.toThrow(/invalid refresh token/);

    const row = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(row?.status).toBe('expired');
    expect(row?.accessToken).toBe('stale-access-token');
  });
});
