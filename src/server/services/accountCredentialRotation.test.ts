import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type RotationModule = typeof import('./accountCredentialRotation.js');

/**
 * `new_api_refresh` is a rolling credential: each successful exchange returns a
 * brand-new secret in Set-Cookie and retires the one that was sent. Persisting
 * the replacement is what keeps a bound account usable; dropping it leaves the
 * row holding a value the site has already invalidated, so the account works
 * once (from the in-memory access-token cache) and then reports
 * AUTH_SESSION_REVOKED forever.
 */
describe('accountCredentialRotation', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let applyRotatedCredential: RotationModule['applyRotatedCredential'];
  let persistRotatedRefreshCookie: RotationModule['persistRotatedRefreshCookie'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-credential-rotation-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const rotation = await import('./accountCredentialRotation.js');

    db = dbModule.db;
    schema = dbModule.schema;
    applyRotatedCredential = rotation.applyRotatedCredential;
    persistRotatedRefreshCookie = rotation.persistRotatedRefreshCookie;
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  beforeEach(async () => {
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  const seedAccount = async (accessToken: string) => {
    const site = await db.insert(schema.sites).values({
      name: 'rotation-test',
      url: 'https://rotation.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'rotator',
      accessToken,
      status: 'active',
    }).returning().get();
    return { site, account };
  };

  describe('applyRotatedCredential', () => {
    it('replaces an existing cookie pair in place', () => {
      const token = 'new_api_refresh=old.secret; session=keep-me';
      expect(applyRotatedCredential(token, { cookieName: 'new_api_refresh', value: 'new.secret' }))
        .toBe('new_api_refresh=new.secret; session=keep-me');
    });

    it('appends the cookie when the header does not carry it yet', () => {
      expect(applyRotatedCredential('session=keep-me', { cookieName: 'new_api_refresh', value: 'new.secret' }))
        .toBe('session=keep-me; new_api_refresh=new.secret');
    });

    it('returns the token untouched when no rotation was observed', () => {
      expect(applyRotatedCredential('new_api_refresh=old.secret', undefined))
        .toBe('new_api_refresh=old.secret');
    });
  });

  describe('persistRotatedRefreshCookie', () => {
    it('writes the replacement secret back to the account row', async () => {
      const previous = 'old.secret';
      const { site, account } = await seedAccount(`new_api_refresh=${previous}; new_api_has_session=1`);

      const result = await persistRotatedRefreshCookie({
        accountId: account.id,
        siteId: site.id,
        cookieName: 'new_api_refresh',
        previousValue: previous,
        nextValue: 'rotated.secret',
      });

      expect(result).toBe('updated');
      const stored = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, account.id)).get();
      expect(stored?.accessToken).toContain('new_api_refresh=rotated.secret');
      expect(stored?.accessToken).toContain('new_api_has_session=1');
      expect(stored?.accessToken).not.toContain(previous);
    });

    it('keeps a newer secret already stored by a concurrent exchange', async () => {
      const { site, account } = await seedAccount('new_api_refresh=winner.secret');

      const result = await persistRotatedRefreshCookie({
        accountId: account.id,
        siteId: site.id,
        cookieName: 'new_api_refresh',
        previousValue: 'loser.secret',
        nextValue: 'stale.secret',
      });

      expect(result).toBe('skipped_stale');
      const stored = await db.select().from(schema.accounts)
        .where(eq(schema.accounts.id, account.id)).get();
      expect(stored?.accessToken).toBe('new_api_refresh=winner.secret');
    });

    it('ignores a rotation that returns the same secret', async () => {
      const { site, account } = await seedAccount('new_api_refresh=same.secret');

      const result = await persistRotatedRefreshCookie({
        accountId: account.id,
        siteId: site.id,
        cookieName: 'new_api_refresh',
        previousValue: 'same.secret',
        nextValue: 'same.secret',
      });

      expect(result).toBe('skipped_stale');
    });
  });
});
