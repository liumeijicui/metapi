import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../../db/index.js');

describe('oauth site registry', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-oauth-site-registry-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
  });

  beforeEach(async () => {
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    const { closeDbConnections } = await import('../../db/index.js');
    await closeDbConnections();
    delete process.env.DATA_DIR;
    if (dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('creates only requested oauth provider sites without duplicating existing rows', async () => {
    await db.insert(schema.sites).values({
      name: 'Anthropic Claude OAuth',
      url: 'https://api.anthropic.com',
      platform: 'claude',
      status: 'active',
      useSystemProxy: true,
    }).run();

    const { ensureOauthProviderSite } = await import('./oauthSiteRegistry.js');
    const { getOAuthProviderDefinition } = await import('./providers.js');
    const codex = getOAuthProviderDefinition('codex')!;
    const claude = getOAuthProviderDefinition('claude')!;
    const existingClaude = await ensureOauthProviderSite(claude);
    const createdCodex = await ensureOauthProviderSite(codex);
    const reusedCodex = await ensureOauthProviderSite(codex);

    const rows = await db.select().from(schema.sites).all();
    expect(rows).toHaveLength(2);
    expect(existingClaude.useSystemProxy).toBe(true);
    expect(reusedCodex.id).toBe(createdCodex.id);
    expect(rows.filter((row) => row.platform === 'codex')).toHaveLength(1);
    expect(rows.filter((row) => row.platform === 'claude')).toHaveLength(1);
  });
});
