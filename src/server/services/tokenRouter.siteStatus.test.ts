import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('./tokenRouter.js');

describe('TokenRouter site status guard', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-token-router-site-status-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const tokenRouterModule = await import('./tokenRouter.js');
    db = dbModule.db;
    schema = dbModule.schema;
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
  });

  beforeEach(async () => {
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.tokenModelAvailability).run();
    await db.delete(schema.modelAvailability).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    invalidateTokenRouterCache();
  });

  afterAll(() => {
    invalidateTokenRouterCache();
    delete process.env.DATA_DIR;
  });

  /**
   * 造一条「模型转发」规则（A → B）并返回它的通道 id。
   *
   * 派发只认模型转发：老路由已整体退出派发，这些「凭证 / 站点状态」的可选性判定必须
   * 在转发通道上验证。
   */
  async function seedForwardRule(modelName: string, siteId: number, accountId: number) {
    const service = await import('./modelForwardService.js');
    const rule = await service.createModelForwardRule({
      modelName,
      targets: [{ siteId, accountId, upstreamModel: `${modelName}-upstream` }],
    });
    invalidateTokenRouterCache();
    return rule.targets[0].channelId as number;
  }

  it('does not select channels from disabled sites', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'disabled-site',
      url: 'https://disabled.example.com',
      platform: 'new-api',
    }).returning().get();
    await db.run(sql`update sites set status = 'disabled' where id = ${site.id}`);

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'disabled-user',
      accessToken: 'access-disabled',
      apiToken: 'sk-disabled',
      status: 'active',
    }).returning().get();

    const channel = { id: await seedForwardRule('gpt-4o-mini', site.id, account.id) };

    const router = new TokenRouter();
    const selected = await router.selectChannel('gpt-4o-mini');
    expect(selected).toBeNull();

    const decision = await router.explainSelection('gpt-4o-mini');
    expect(decision.matched).toBe(true);
    const candidate = decision.candidates.find((item) => item.channelId === channel.id);
    expect(candidate?.eligible).toBe(false);
  });

  it('does not fallback to deprecated site apiKey when channel and account tokens are missing', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'site-api-key-only',
      url: 'https://site-key.example.com',
      platform: 'new-api',
      apiKey: 'sk-site-only',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'site-key-user',
      accessToken: '',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({ credentialMode: 'apikey' }),
    }).returning().get();

    await seedForwardRule('gpt-4.1-mini', site.id, account.id);

    const selected = await new TokenRouter().selectChannel('gpt-4.1-mini');
    expect(selected).toBeNull();
  });

  it('uses codex oauth access token when no api token is present', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken: 'oauth-access-token',
      apiToken: null,
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: 'chatgpt-account-123',
          email: 'codex-user@example.com',
          planType: 'plus',
        },
      }),
    }).returning().get();

    await seedForwardRule('gpt-5.2-codex', site.id, account.id);

    const selected = await new TokenRouter().selectChannel('gpt-5.2-codex');
    expect(selected).not.toBeNull();
    expect(selected?.tokenValue).toBe('oauth-access-token');
  });

  it('prefers codex oauth access token over a stale legacy api token on oauth-managed rows', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken: 'oauth-access-token',
      apiToken: 'stale-direct-token',
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: 'chatgpt-account-123',
          email: 'codex-user@example.com',
          planType: 'plus',
        },
      }),
    }).returning().get();

    await seedForwardRule('gpt-5.2-codex', site.id, account.id);

    const selected = await new TokenRouter().selectChannel('gpt-5.2-codex');
    expect(selected).not.toBeNull();
    expect(selected?.tokenValue).toBe('oauth-access-token');
  });

  it('does not fall back to a stale legacy api token when an oauth-managed row has no access token', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'codex-site',
      url: 'https://chatgpt.com/backend-api/codex',
      platform: 'codex',
      status: 'active',
    }).returning().get();

    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'codex-user@example.com',
      accessToken: '',
      apiToken: 'stale-direct-token',
      status: 'active',
      extraConfig: JSON.stringify({
        credentialMode: 'session',
        oauth: {
          provider: 'codex',
          accountId: 'chatgpt-account-123',
          email: 'codex-user@example.com',
          planType: 'plus',
        },
      }),
    }).returning().get();

    await seedForwardRule('gpt-5.2-codex', site.id, account.id);

    const selected = await new TokenRouter().selectChannel('gpt-5.2-codex');
    expect(selected).toBeNull();
  });
});
