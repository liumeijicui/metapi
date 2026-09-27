import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import {
  buildStoredSub2ApiSubscriptionSummary,
  mergeAccountExtraConfig,
} from '../../services/accountExtraConfig.js';

type DbModule = typeof import('../../db/index.js');

describe('sites route today check-in progress', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-sites-checkin-'));
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
    await db.delete(schema.checkinLogs).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('reports the site as checked in once any account succeeds today', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'checkin-site',
      url: 'https://checkin.example.com',
      platform: 'new-api',
    }).returning().get();

    const done = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'done-user',
      accessToken: 'token-done',
      balance: 1,
      status: 'active',
      checkinEnabled: true,
    }).returning().get();
    const pending = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'pending-user',
      accessToken: 'token-pending',
      balance: 2,
      status: 'active',
      checkinEnabled: true,
    }).returning().get();

    // Written in stored UTC form, which is what the day-range query compares
    // against, and stamped with the current instant so it belongs to today.
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const storedNow = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}`;
    await db.insert(schema.checkinLogs).values({
      accountId: done.id,
      status: 'success',
      message: '签到成功',
      createdAt: storedNow,
    }).run();

    const response = await app.inject({ method: 'GET', url: '/api/sites' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Array<{
      id: number;
      accountCount: number;
      checkinEnabledCount: number;
      todayCheckedIn: boolean;
      todayCheckedInCount: number;
    }>;
    const row = body.find((item) => item.id === site.id);
    expect(row).toBeTruthy();
    expect(row?.accountCount).toBe(2);
    expect(row?.checkinEnabledCount).toBe(2);
    // One of the two accounts succeeded, so the site counts as done while the
    // progress still shows it is only half finished.
    expect(row?.todayCheckedIn).toBe(true);
    expect(row?.todayCheckedInCount).toBe(1);
    expect(pending.id).toBeGreaterThan(0);
  });

  it('does not mark a site with no successful check-in', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'idle-site',
      url: 'https://idle.example.com',
      platform: 'new-api',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'idle-user',
      accessToken: 'token-idle',
      balance: 0,
      status: 'active',
    }).run();

    const response = await app.inject({ method: 'GET', url: '/api/sites' });
    const body = response.json() as Array<{
      id: number;
      todayCheckedIn: boolean;
      todayCheckedInCount: number;
    }>;
    const row = body.find((item) => item.id === site.id);
    expect(row?.todayCheckedIn).toBe(false);
    expect(row?.todayCheckedInCount).toBe(0);
  });
});
