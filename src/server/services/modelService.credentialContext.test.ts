import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const getApiTokenMock = vi.fn();
const getModelsMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: () => ({
    getApiToken: (...args: unknown[]) => getApiTokenMock(...args),
    getModels: (...args: unknown[]) => getModelsMock(...args),
  }),
}));

type DbModule = typeof import('../db/index.js');
type ModelServiceModule = typeof import('./modelService.js');
type SiteProxyModule = typeof import('./siteProxy.js');

/**
 * Model discovery calls the site with the account's own credential. For sites
 * that keep only a rolling `new_api_refresh` cookie, that call retires the
 * secret and returns the replacement in Set-Cookie. Discovery must therefore run
 * inside the account's credential context, otherwise the replacement is dropped
 * and every later balance/check-in call presents a dead secret.
 */
describe('refreshModelsForAccount credential context', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let refreshModelsForAccount: ModelServiceModule['refreshModelsForAccount'];
  let getAccountCredentialContext: SiteProxyModule['getAccountCredentialContext'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-credential-context-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const modelService = await import('./modelService.js');
    const siteProxy = await import('./siteProxy.js');

    db = dbModule.db;
    schema = dbModule.schema;
    refreshModelsForAccount = modelService.refreshModelsForAccount;
    getAccountCredentialContext = siteProxy.getAccountCredentialContext;
  });

  beforeEach(async () => {
    getApiTokenMock.mockReset();
    getModelsMock.mockReset();

    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.siteApiEndpoints).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.sites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('runs every credential probe inside the owning account context', async () => {
    const seen: Array<{ accountId?: number; siteId: number }> = [];
    getApiTokenMock.mockResolvedValue(null);
    getModelsMock.mockImplementation(async () => {
      const context = getAccountCredentialContext();
      if (context) seen.push({ accountId: context.accountId, siteId: context.siteId });
      return [];
    });

    const site = await db.insert(schema.sites).values({
      name: 'context-site',
      url: 'https://context.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rotator',
      accessToken: 'new_api_refresh=live.secret',
      status: 'active',
    }).returning().get();

    const result = await refreshModelsForAccount(account.id);
    expect(result.accountId).toBe(account.id);

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((entry) => entry.accountId === account.id && entry.siteId === site.id)).toBe(true);
  });

  it('reports not-found without entering a credential context for a missing account', async () => {
    const result = await refreshModelsForAccount(99_999);
    expect(result.refreshed).toBe(false);
    expect(getModelsMock).not.toHaveBeenCalled();
  });
});
