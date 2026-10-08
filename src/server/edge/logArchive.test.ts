import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type AnyRecord = Record<string, any>;

/** 旧版 hub.db 里那条日志的 id；故意取大一点，跟归档里已有的行错开。 */
const LEGACY_LOG_ID = 900_001;

describe('边缘实例内存库与使用日志归档', () => {
  let dataDir = '';
  let archivePath = '';
  let db: AnyRecord;
  let schema: AnyRecord;
  let getSqliteConnection: () => AnyRecord | null;
  let flushEdgeLogs: () => number;
  let restoreEdgeLogs: () => number;
  let stopEdgeLogArchive: () => void;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-edge-archive-'));
    process.env.DATA_DIR = dataDir;
    process.env.METAPI_EDGE_MODE = '1';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '30086';
    // 边缘实例的工作库就是内存库。
    process.env.DB_URL = ':memory:';

    // 旧版本边缘实例的 hub.db：日志和配置混在一起，升级后只把日志搬走，再把旧库删掉。
    const legacy = new Database(join(dataDir, 'hub.db'));
    legacy.exec('CREATE TABLE proxy_logs (id INTEGER PRIMARY KEY, model_requested TEXT)');
    legacy.prepare('INSERT INTO proxy_logs (id, model_requested) VALUES (?, ?)')
      .run(LEGACY_LOG_ID, 'gpt-6-astra');
    legacy.close();

    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    getSqliteConnection = dbModule.getSqliteConnection;

    // 内存库的表只存在于这条连接上，迁移必须落在同一条连接里。
    const migrateModule = await import('../db/migrate.js');
    migrateModule.runSqliteMigrationsOn(getSqliteConnection());
    // 与边缘入口一致：先补齐写代理日志用的兼容列，归档的列清单也按补完之后的表生成。
    await dbModule.ensureProxyLogStreamTimingColumns();
    await dbModule.ensureProxyLogClientColumns();
    await dbModule.ensureProxyLogDownstreamApiKeyIdColumn();
    await dbModule.ensureProxyLogBillingDetailsColumn();
    await dbModule.ensureSiteCompatibilityColumns();

    const archiveModule = await import('./logArchive.js');
    flushEdgeLogs = archiveModule.flushEdgeLogs;
    restoreEdgeLogs = archiveModule.restoreEdgeLogs;
    stopEdgeLogArchive = archiveModule.stopEdgeLogArchive;
    archivePath = archiveModule.setupEdgeLogArchive({ dataDirAbsolute: dataDir });
  }, 120_000);

  afterAll(() => {
    stopEdgeLogArchive();
    delete process.env.DATA_DIR;
    delete process.env.METAPI_EDGE_MODE;
    delete process.env.DB_URL;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('内存库用的是内存连接，数据目录里不留工作库文件', async () => {
    expect(getSqliteConnection()).toBeTruthy();
    // 完整表结构建在同一条连接上：日志表与配置表都能查，旧库那条日志也已经读回内存。
    const logs = await db.select().from(schema.proxyLogs).all() as AnyRecord[];
    expect(logs.map((row) => row.id)).toEqual([LEGACY_LOG_ID]);
    expect(await db.select().from(schema.sites).all()).toEqual([]);
    expect(existsSync(join(dataDir, 'hub.db'))).toBe(false);
  });

  it('旧版 hub.db 的日志搬进归档，旧库文件删除', () => {
    expect(archivePath).toBe(join(dataDir, 'edge-logs.db'));
    const archive = new Database(archivePath, { readonly: true });
    try {
      const row = archive.prepare('SELECT id, model_requested FROM proxy_logs WHERE id = ?')
        .get(LEGACY_LOG_ID) as AnyRecord | undefined;
      expect(row?.model_requested).toBe('gpt-6-astra');
    } finally {
      archive.close();
    }
    expect(existsSync(join(dataDir, 'hub.db'))).toBe(false);
  });

  it('配置导入清掉内存日志后，本机日志能从归档读回来', async () => {
    const inserted = await db.insert(schema.proxyLogs).values({
      modelRequested: 'gpt-6-luna',
      status: 'success',
      createdAt: '2026-10-08 00:00:00',
    }).returning().get() as AnyRecord;

    expect(flushEdgeLogs()).toBeGreaterThan(0);

    // 模拟配置同步：导入账号时会 delete proxy_logs，站点重建再级联删一遍。
    await db.delete(schema.proxyLogs).run();
    expect(await db.select().from(schema.proxyLogs).all()).toEqual([]);

    expect(restoreEdgeLogs()).toBeGreaterThan(0);
    const restored = await db.select().from(schema.proxyLogs).all() as AnyRecord[];
    const mine = restored.find((row) => row.id === inserted.id);
    expect(mine?.modelRequested).toBe('gpt-6-luna');
    // 归档里的历史日志也一起读回来了。
    expect(restored.some((row) => row.id === LEGACY_LOG_ID)).toBe(true);
  });

  it('导入账号把日志的关联列改空时，归档那份会盖回来', async () => {
    const inserted = await db.insert(schema.proxyLogs).values({
      accountId: 43,
      routeId: 572,
      channelId: 1977,
      modelRequested: 'gpt-6-astra',
      status: 'failed',
      createdAt: '2026-10-08 00:10:00',
    }).returning().get() as AnyRecord;
    flushEdgeLogs();

    // 模拟 importAccountsSection：日志按业务标识重写，标识对不上时关联列变成 null。
    await db.update(schema.proxyLogs)
      .set({ accountId: null, routeId: null, channelId: null })
      .where(eq(schema.proxyLogs.id, inserted.id))
      .run();

    restoreEdgeLogs();
    const row = await db.select().from(schema.proxyLogs)
      .where(eq(schema.proxyLogs.id, inserted.id)).get() as AnyRecord;
    expect(row.accountId).toBe(43);
    expect(row.routeId).toBe(572);
    expect(row.channelId).toBe(1977);
  });
});
