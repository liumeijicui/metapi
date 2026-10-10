import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../db/index.js');
type TokenRouterModule = typeof import('../services/tokenRouter.js');
type ForwardModule = typeof import('../services/modelForwardService.js');
type LocalEditsModule = typeof import('./forwardLocalEdits.js');
type LogArchiveModule = typeof import('./logArchive.js');

/** 边缘版（exe）本机的转发顺序 / 启停：只改内存镜像，服务器配置一变就以服务器为准。 */
describe('exe 本机转发顺序与启停', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let TokenRouter: TokenRouterModule['TokenRouter'];
  let invalidateTokenRouterCache: TokenRouterModule['invalidateTokenRouterCache'];
  let forwardService: ForwardModule;
  let localEdits: LocalEditsModule;
  let stopEdgeLogArchive: LogArchiveModule['stopEdgeLogArchive'];
  let resetEdgeLogArchiveForTests: LogArchiveModule['resetEdgeLogArchiveForTests'];
  let dataDir = '';
  let siteId = 0;
  let accountId = 0;

  /** 规则里顺序 1 / 顺序 2 的目标与它们的通道 id。 */
  let firstTargetId = 0;
  let secondTargetId = 0;
  let firstChannelId = 0;
  let secondChannelId = 0;
  let ruleId = 0;

  const MODEL = 'gpt-6-astra';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-edge-forward-local-'));
    process.env.DATA_DIR = dataDir;
    process.env.METAPI_EDGE_MODE = '1';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '30088';
    // 边缘实例的工作库就是内存库，本机改动落在数据目录的归档库（edge-logs.db）。
    process.env.DB_URL = ':memory:';

    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    const migrateModule = await import('../db/migrate.js');
    migrateModule.runSqliteMigrationsOn(dbModule.getSqliteConnection());
    const archiveModule = await import('./logArchive.js');
    stopEdgeLogArchive = archiveModule.stopEdgeLogArchive;
    resetEdgeLogArchiveForTests = archiveModule.resetEdgeLogArchiveForTests;
    archiveModule.setupEdgeLogArchive({ dataDirAbsolute: dataDir });

    const tokenRouterModule = await import('../services/tokenRouter.js');
    TokenRouter = tokenRouterModule.TokenRouter;
    invalidateTokenRouterCache = tokenRouterModule.invalidateTokenRouterCache;
    forwardService = await import('../services/modelForwardService.js');
    localEdits = await import('./forwardLocalEdits.js');
  }, 120_000);

  afterAll(() => {
    stopEdgeLogArchive();
    resetEdgeLogArchiveForTests();
    delete process.env.DATA_DIR;
    delete process.env.METAPI_EDGE_MODE;
    delete process.env.HOST;
    delete process.env.PORT;
    delete process.env.DB_URL;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();
    await localEdits.resetLocalForwardEdits();
    invalidateTokenRouterCache();

    const site = await db.insert(schema.sites).values({
      name: '本机转发测试站',
      url: 'https://forward-local.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;
    const account = await db.insert(schema.accounts).values({
      siteId,
      username: 'local-user',
      accessToken: 'access-local',
      status: 'active',
    }).returning().get();
    accountId = account.id;
    await db.insert(schema.accountTokens).values({
      accountId,
      name: 'default',
      token: 'token-local',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();

    const rule = await forwardService.createModelForwardRule({
      modelName: MODEL,
      targets: [
        { siteId, accountId, upstreamModel: 'deepseek-v4.1-flash' },
        { siteId, accountId, upstreamModel: 'glm-5.2' },
      ],
    });
    ruleId = rule.id;
    firstTargetId = rule.targets[0].id;
    secondTargetId = rule.targets[1].id;
    firstChannelId = rule.targets[0].channelId as number;
    secondChannelId = rule.targets[1].channelId as number;
    invalidateTokenRouterCache();
  });

  async function selectedChannelId(): Promise<number | null> {
    const selected = await new TokenRouter().selectChannel(MODEL);
    return selected?.channel.id ?? null;
  }

  async function mirrorOrder(): Promise<number[]> {
    const updated = (await forwardService.listModelForwardRules()).find((rule) => rule.id === ruleId);
    return (updated?.targets ?? []).map((target) => target.id);
  }

  async function channelPriority(channelId: number): Promise<number | undefined> {
    const row = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.id, channelId)).get();
    return row?.priority;
  }

  /** 模拟一次服务器快照重新导入：镜像顺序被服务器那版覆盖，通道不动（那要靠 reapply 补齐）。 */
  async function importServerOrderIntoMirror(): Promise<void> {
    const nowIso = new Date().toISOString();
    for (const [index, targetId] of [firstTargetId, secondTargetId].entries()) {
      await db.update(schema.modelForwardTargets).set({ sortOrder: index, enabled: true, updatedAt: nowIso })
        .where(eq(schema.modelForwardTargets.id, targetId)).run();
    }
  }

  it('置顶 / 上移 / 下移直接改通道优先级，下一次选路就生效', async () => {
    expect(await selectedChannelId()).toBe(firstChannelId);

    await localEdits.moveLocalForwardTarget(ruleId, secondTargetId, 'top');
    expect(await selectedChannelId()).toBe(secondChannelId);
    expect(await mirrorOrder()).toEqual([secondTargetId, firstTargetId]);
    expect(await channelPriority(secondChannelId)).toBe(0);
    expect(await channelPriority(firstChannelId)).toBe(1);

    await localEdits.moveLocalForwardTarget(ruleId, secondTargetId, 'down');
    expect(await selectedChannelId()).toBe(firstChannelId);
    expect(await mirrorOrder()).toEqual([firstTargetId, secondTargetId]);

    await localEdits.moveLocalForwardTarget(ruleId, secondTargetId, 'up');
    expect(await selectedChannelId()).toBe(secondChannelId);

    await localEdits.moveLocalForwardTarget(ruleId, firstTargetId, 'top');
    expect(await selectedChannelId()).toBe(firstChannelId);
  });

  it('本机停用顺序 1 后落到顺序 2，重新启用再切回来', async () => {
    await localEdits.setLocalForwardTargetEnabled(ruleId, firstTargetId, false);
    expect(await selectedChannelId()).toBe(secondChannelId);

    await localEdits.setLocalForwardTargetEnabled(ruleId, firstTargetId, true);
    expect(await selectedChannelId()).toBe(firstChannelId);
  });

  it('本机停用整条规则后没有可派发的通道（不会回落老路由）', async () => {
    await localEdits.setLocalForwardRuleEnabled(ruleId, false);
    expect(await selectedChannelId()).toBeNull();

    await localEdits.setLocalForwardRuleEnabled(ruleId, true);
    expect(await selectedChannelId()).toBe(firstChannelId);
  });

  it('服务器快照指纹一变，本机改动整份作废；指纹没变则盖回本机顺序', async () => {
    // 第一次同步：只记账，没有本机改动。
    await localEdits.reapplyLocalForwardEditsAfterSync('hash-a');
    expect(await selectedChannelId()).toBe(firstChannelId);

    // 本机把顺序 2 置顶，并且服务器那一轮没变（同一个指纹）→ 重新导入后本机顺序还在。
    await localEdits.moveLocalForwardTarget(ruleId, secondTargetId, 'top');
    expect(await selectedChannelId()).toBe(secondChannelId);
    await importServerOrderIntoMirror();
    await localEdits.reapplyLocalForwardEditsAfterSync('hash-a');
    expect(await mirrorOrder()).toEqual([secondTargetId, firstTargetId]);
    expect(await selectedChannelId()).toBe(secondChannelId);

    // 服务器改过转发规则（指纹变了）+ 快照重新导入 → 本机改动整份作废，以服务器为准。
    await importServerOrderIntoMirror();
    await localEdits.reapplyLocalForwardEditsAfterSync('hash-b');
    expect(await mirrorOrder()).toEqual([firstTargetId, secondTargetId]);
    expect(await selectedChannelId()).toBe(firstChannelId);
    expect(await channelPriority(firstChannelId)).toBe(0);
  });

  it('「恢复服务器顺序」后本机改动不再被盖回来', async () => {
    await localEdits.reapplyLocalForwardEditsAfterSync('hash-c');
    await localEdits.moveLocalForwardTarget(ruleId, secondTargetId, 'top');
    expect(await selectedChannelId()).toBe(secondChannelId);

    // 恢复：清掉本机改动，并按服务器那一版重新导入 + 重排通道。
    await localEdits.resetLocalForwardEdits();
    await importServerOrderIntoMirror();
    await localEdits.reapplyLocalForwardEditsAfterSync('hash-c');

    expect(await mirrorOrder()).toEqual([firstTargetId, secondTargetId]);
    expect(await selectedChannelId()).toBe(firstChannelId);
    expect(await channelPriority(secondChannelId)).toBe(1);
  });

  it('镜像里没有的目标直接报错，不会写出半截改动', async () => {
    await expect(localEdits.moveLocalForwardTarget(ruleId, 999_999, 'top')).rejects.toThrow();
    await expect(localEdits.setLocalForwardTargetEnabled(ruleId, 999_999, false)).rejects.toThrow();
    expect(await selectedChannelId()).toBe(firstChannelId);
  });
});
