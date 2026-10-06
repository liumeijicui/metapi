import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./siteDirectChatService.js');

describe('siteDirectChatService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-direct-chat-'));
    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./siteDirectChatService.js');
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  async function seed(input: {
    withToken?: boolean;
    tokenReady?: boolean;
    accountStatus?: string;
  } = {}) {
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'Direct Site',
      url: 'https://direct.example.com',
      platform: 'new-api',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'direct-user',
      accessToken: 'jwt-token',
      status: input.accountStatus ?? 'active',
    }).returning().get();
    let tokenId: number | null = null;
    if (input.withToken !== false) {
      const token = await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: '默认令牌',
        token: 'sk-direct-secret',
        valueStatus: input.tokenReady === false ? 'masked_pending' : 'ready',
        enabled: true,
      }).returning().get();
      tokenId = token.id;
    }
    return { site, account, tokenId };
  }

  it('站点只有账号和 sk 密钥、完全没有路由时也能直连', async () => {
    const { site, account, tokenId } = await seed();
    // 特意不建任何 token_routes / route_channels。
    const targets = await service.listSiteDirectChatTargets(site.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      accountId: account.id,
      tokenId,
      accountName: 'direct-user',
      tokenName: '默认令牌',
      credential: 'api_token',
    });
    // 只暴露令牌 id，不带明文。
    expect(JSON.stringify(targets)).not.toContain('sk-direct-secret');

    const resolved = await service.resolveSiteDirectChat({ siteId: site.id, accountId: account.id, tokenId });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.tokenValue).toBe('sk-direct-secret');
  });

  it('账号没有 sk 令牌时退回账号凭据', async () => {
    const { site, account } = await seed({ withToken: false });
    const targets = await service.listSiteDirectChatTargets(site.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ accountId: account.id, tokenId: null, credential: 'account' });
  });

  it('令牌没就绪时不当作可用凭据，也不带出明文', async () => {
    const { site, account, tokenId } = await seed({ tokenReady: false });
    const targets = await service.listSiteDirectChatTargets(site.id);
    // 令牌不可用时退回账号凭据，而不是把未就绪的密钥拿来用。
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ accountId: account.id, tokenId: null, credential: 'account' });

    const resolved = await service.resolveSiteDirectChat({ siteId: site.id, accountId: account.id, tokenId });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain('不可用');
  });

  it('跨站点取账号会被拒绝', async () => {
    const { site, account } = await seed();
    const other = await db.insert(schema.sites).values({
      name: 'Other Site',
      url: 'https://other.example.com',
      platform: 'new-api',
    }).returning().get();
    const resolved = await service.resolveSiteDirectChat({
      siteId: other.id,
      accountId: account.id,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toContain('不属于该站点');

    expect(await service.listSiteDirectChatTargets(other.id)).toEqual([]);
    expect(await service.listSiteDirectChatTargets(site.id)).toHaveLength(1);
  });
});
