import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const getBalanceMock = vi.fn();
const reportTokenExpiredMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getBalance: (...args: unknown[]) => getBalanceMock(...args),
    login: vi.fn(),
  }),
}));

vi.mock('./alertService.js', () => ({
  reportTokenExpired: (...args: unknown[]) => reportTokenExpiredMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type BalanceModule = typeof import('./balanceService.js');

describe('refreshAllBalances account selection', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshAllBalances: BalanceModule['refreshAllBalances'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-balance-refresh-all-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const balanceModule = await import('./balanceService.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshAllBalances = balanceModule.refreshAllBalances;
  });

  beforeEach(async () => {
    getBalanceMock.mockReset();
    reportTokenExpiredMock.mockReset();
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

  async function seedSite(name: string) {
    return db.insert(schema.sites).values({
      name,
      url: `https://${name}.example.com`,
      platform: 'new-api',
      status: 'active',
    }).returning().get();
  }

  async function seedAccount(input: { siteId: number; username: string; status: string; accessToken: string }) {
    return db.insert(schema.accounts).values({
      siteId: input.siteId,
      username: input.username,
      accessToken: input.accessToken,
      apiToken: null,
      status: input.status,
      extraConfig: '{}',
    }).returning().get();
  }

  it('refreshes an expired account and promotes it back to active', async () => {
    const site = await seedSite('revive');
    const account = await seedAccount({
      siteId: site.id,
      username: 'expired@example.com',
      status: 'expired',
      accessToken: 'revivable-token',
    });

    getBalanceMock.mockResolvedValue({ balance: 100, used: 0, quota: 200, todayIncome: 1 });

    await refreshAllBalances();

    expect(getBalanceMock.mock.calls.map((call) => call[1])).toEqual(['revivable-token']);

    const row = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .get();
    expect(row?.status).toBe('active');
    expect(row?.balance).toBe(100);
    expect(row?.lastBalanceRefresh).toBeTruthy();
  });

  it('leaves disabled accounts alone', async () => {
    const site = await seedSite('disabled-site');
    const disabledAccount = await seedAccount({
      siteId: site.id,
      username: 'disabled@example.com',
      status: 'disabled',
      accessToken: 'disabled-token',
    });

    getBalanceMock.mockResolvedValue({ balance: 100, used: 0, quota: 200, todayIncome: 1 });

    await refreshAllBalances();

    expect(getBalanceMock).not.toHaveBeenCalled();

    const row = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, disabledAccount.id))
      .get();
    expect(row?.status).toBe('disabled');
    expect(row?.lastBalanceRefresh).toBeNull();
  });

  it('records a fresh reason for an already expired account without re-announcing it', async () => {
    const site = await seedSite('still-dead');
    const expiredAccount = await seedAccount({
      siteId: site.id,
      username: 'expired@example.com',
      status: 'expired',
      accessToken: 'expired-dead-token',
    });
    const activeAccount = await seedAccount({
      siteId: site.id,
      username: 'active@example.com',
      status: 'active',
      accessToken: 'active-dead-token',
    });

    getBalanceMock.mockImplementation(async (_url: string, token: string) => {
      if (token === 'expired-dead-token' || token === 'active-dead-token') {
        throw new Error('HTTP 401 Unauthorized');
      }
      return { balance: 100, used: 0, quota: 200, todayIncome: 1 };
    });

    await refreshAllBalances();

    // Only the account that just lapsed is worth announcing; the one that was
    // already expired only needs its reason refreshed on the account itself.
    expect(reportTokenExpiredMock).toHaveBeenCalledTimes(1);
    expect(reportTokenExpiredMock.mock.calls[0][0]?.accountId).toBe(activeAccount.id);

    const expiredRow = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, expiredAccount.id))
      .get();
    expect(expiredRow?.status).toBe('expired');
  });
});
