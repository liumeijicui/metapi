import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('site inventory API', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-inventory-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./sites.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.sitesRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('lists accounts of a site with their tokens, never the raw token', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'inventory-site',
      url: 'https://inventory.example.com',
      platform: 'new-api',
    }).returning().get();
    const otherSite = await db.insert(schema.sites).values({
      name: 'other-site',
      url: 'https://other.example.com',
      platform: 'new-api',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'alpha',
      accessToken: 'session-token',
      balance: 12.5,
      status: 'active',
    }).returning().get();
    const otherAccount = await db.insert(schema.accounts).values({
      siteId: otherSite.id,
      username: 'bravo',
      accessToken: 'session-token-2',
      status: 'active',
    }).returning().get();

    await db.insert(schema.accountTokens).values([
      {
        accountId: account.id,
        name: 'primary',
        token: 'sk-abcdefghijklmnopqrstuvwxyz',
        tokenGroup: 'default',
        isDefault: true,
        enabled: true,
      },
      {
        accountId: account.id,
        name: 'secondary',
        token: 'sk-secondtokenvalue0987654321',
        enabled: false,
      },
      {
        accountId: otherAccount.id,
        name: 'foreign',
        token: 'sk-foreignshouldnotappear1234',
        enabled: true,
      },
    ]).run();

    const response = await app.inject({ method: 'GET', url: `/api/sites/${site.id}/inventory` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      accounts: Array<{
        id: number;
        username: string;
        tokenCount: number;
        enabledTokenCount: number;
        tokens: Array<{ name: string; tokenMasked: string }>;
      }>;
    };
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0]).toMatchObject({
      id: account.id,
      username: 'alpha',
      tokenCount: 2,
      enabledTokenCount: 1,
    });
    expect(body.accounts[0]!.tokens.map((token) => token.name)).toEqual(['primary', 'secondary']);
    for (const token of body.accounts[0]!.tokens) {
      expect(token.tokenMasked).not.toContain('abcdefghijklmnop');
      expect(token.tokenMasked).toContain('***');
    }
    // 其他站点账号不出现
    expect(JSON.stringify(body)).not.toContain('bravo');
    expect(JSON.stringify(body)).not.toContain('foreignshouldnotappear');
  });

  it('returns 404 for an unknown site', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/sites/999999/inventory' });
    expect(response.statusCode).toBe(404);
  });
});
