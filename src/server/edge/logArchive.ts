import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { getSqliteConnection } from '../db/index.js';

/**
 * 边缘实例的本地 SQLite 存储（使用日志 + 本机设置）。
 *
 * 工作库是内存库：从服务器同步下来的配置只在内存里，进程退出就没了。
 * 使用日志是本地产生的数据，必须留下来，所以这里把 proxy_logs 的行镜像到
 * DATA_DIR 下的一个 SQLite 文件里，并在启动时把归档读回内存。
 * 服务器地址这类「跨重启必须还在」的本机设置也放同一个文件的 edge_settings 表里，
 * 这样本机的持久数据只有一个库，不用再维护 JSON 边车文件。
 *
 * 为什么不做成两个库各管一半：日志列表要跟账号/站点做 join（见 routes/api/stats.ts），
 * 拆开就没法再用同一条 SQL 查询，所以内存库里仍然是那张真实的 proxy_logs 表，
 * 归档只负责「别丢」，读写路径完全不改。
 */

/** 归档库在连接里的别名（ATTACH 用）。 */
const ARCHIVE_SCHEMA = 'edge_logs';

/** 归档文件名。 */
const ARCHIVE_FILE = 'edge-logs.db';

/** 本机设置表：跨重启要保留的边缘本地参数（例如服务器地址）都存在这里。 */
const SETTINGS_TABLE = 'edge_settings';

/** 旧版边缘实例把配置和日志放在同一个 hub.db，升级后只搬走日志，再删掉这个文件。 */
const LEGACY_DB_FILE = 'hub.db';

/** 内存里保留的日志条数上限：日志要和内存里的配置表 join，条数太多会白占内存。 */
const MEMORY_LOG_LIMIT = 100_000;

/** 把内存里新增的日志刷进归档库的间隔；崩溃最多丢这一小段日志。 */
const FLUSH_INTERVAL_MS = 1_000;

let connection: Database.Database | null = null;
/** 主库 proxy_logs 的列名；归档搬运用的列清单由它生成，schema 加了列也不用改这里。 */
let logColumns: string[] = [];
/** 归档库里已有的最大日志 id，只搬比它新的行。 */
let archivedMaxId = 0;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function readTableColumns(conn: Database.Database, schemaName: string, table: string): string[] {
  const rows = conn.prepare(`PRAGMA ${schemaName}.table_info(${quoteIdentifier(table)})`).all() as Array<{ name?: unknown }>;
  return rows.map((row) => String(row.name ?? '')).filter((name) => name.length > 0);
}

function attachArchive(conn: Database.Database, archivePath: string): void {
  const attached = conn.prepare('PRAGMA database_list').all() as Array<{ name?: unknown }>;
  if (attached.some((row) => String(row.name ?? '') === ARCHIVE_SCHEMA)) return;
  conn.prepare(`ATTACH DATABASE ? AS ${ARCHIVE_SCHEMA}`).run(archivePath);
}

/** 建归档表：列照抄主库（CTAS 不复制主键/外键，正好——历史日志引用的账号可能早就不在了）。 */
function ensureArchiveSchema(conn: Database.Database): void {
  conn.exec(`CREATE TABLE IF NOT EXISTS ${ARCHIVE_SCHEMA}.proxy_logs AS SELECT * FROM main.proxy_logs WHERE 0`);

  // 本机设置的落点：键值对，和日志共用一个文件，省掉额外的配置文件。
  conn.exec(
    `CREATE TABLE IF NOT EXISTS ${ARCHIVE_SCHEMA}.${SETTINGS_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  );

  logColumns = readTableColumns(conn, 'main', 'proxy_logs');
  const archivedColumns = readTableColumns(conn, ARCHIVE_SCHEMA, 'proxy_logs');
  for (const column of logColumns) {
    if (archivedColumns.includes(column)) continue;
    // 主库加过列（迁移）时补齐，声明类型可以省略，SQLite 按亲和性存值。
    conn.exec(`ALTER TABLE ${ARCHIVE_SCHEMA}.proxy_logs ADD COLUMN ${quoteIdentifier(column)}`);
  }

  conn.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${ARCHIVE_SCHEMA}.idx_edge_proxy_logs_id ON proxy_logs (${quoteIdentifier('id')})`,
  );
}

function readArchivedMaxId(conn: Database.Database): number {
  const row = conn.prepare(`SELECT max(id) AS maxId FROM ${ARCHIVE_SCHEMA}.proxy_logs`).get() as { maxId?: unknown } | undefined;
  return Number(row?.maxId ?? 0) || 0;
}

/**
 * 把旧版 hub.db 里的使用日志搬进归档，然后删掉旧的 hub.db。
 * 旧文件里还有一份配置镜像，不再需要，留着反而违背「配置不落盘」。
 */
function migrateLegacyLogs(conn: Database.Database, dataDirAbsolute: string): number {
  const legacyPath = join(dataDirAbsolute, LEGACY_DB_FILE);
  if (!existsSync(legacyPath)) return 0;

  let copied = 0;
  try {
    conn.prepare('ATTACH DATABASE ? AS edge_legacy').run(legacyPath);
    const hasLogsTable = (conn.prepare(
      "SELECT 1 FROM edge_legacy.sqlite_master WHERE type = 'table' AND name = 'proxy_logs' LIMIT 1",
    ).get() as unknown) !== undefined;
    if (hasLogsTable) {
      // 老库的列可能比现在少，取交集搬运，缺的列留空。
      const legacyColumns = readTableColumns(conn, 'edge_legacy', 'proxy_logs');
      const shared = logColumns.filter((column) => legacyColumns.includes(column));
      if (shared.length > 0) {
        const columnList = shared.map(quoteIdentifier).join(', ');
        copied = conn.prepare(
          `INSERT OR REPLACE INTO ${ARCHIVE_SCHEMA}.proxy_logs (${columnList}) SELECT ${columnList} FROM edge_legacy.proxy_logs`,
        ).run().changes;
      }
    }
    conn.exec('DETACH DATABASE edge_legacy');
  } catch (error) {
    // 搬不动就先留着旧文件，别删数据。
    console.warn(`[edge] 旧版 hub.db 日志搬运失败，已保留原文件：${(error as Error)?.message || String(error)}`);
    try {
      conn.exec('DETACH DATABASE edge_legacy');
    } catch {}
    return 0;
  }

  try {
    for (const suffix of ['', '-wal', '-shm']) {
      rmSync(`${legacyPath}${suffix}`, { force: true });
    }
    console.log(`[edge] 已搬走旧版 hub.db 的 ${copied} 条使用日志，并删除旧库（配置不再落盘）。`);
  } catch (error) {
    console.warn(`[edge] 旧版 hub.db 删除失败：${(error as Error)?.message || String(error)}`);
  }
  return copied;
}

/** 内存库 → 归档库：把比归档新的日志行搬过去。 */
export function flushEdgeLogs(): number {
  const conn = connection;
  if (!conn || logColumns.length === 0) return 0;

  const row = conn.prepare('SELECT max(id) AS maxId FROM main.proxy_logs').get() as { maxId?: unknown } | undefined;
  const maxId = Number(row?.maxId ?? 0) || 0;
  if (maxId <= archivedMaxId) return 0;

  const columnList = logColumns.map(quoteIdentifier).join(', ');
  const copied = conn.prepare(
    `INSERT OR REPLACE INTO ${ARCHIVE_SCHEMA}.proxy_logs (${columnList})`
    + ` SELECT ${columnList} FROM main.proxy_logs WHERE id > ?`,
  ).run(archivedMaxId).changes;
  archivedMaxId = maxId;
  return copied;
}

/**
 * 归档库 → 内存库：把历史日志读回内存。
 * 内存库每次启动都是空的，配置同步又会清掉日志表（导入账号时会重建站点/账号并级联删除日志），
 * 所以启动时和每次导入配置之后都要读一次。
 *
 * 用 REPLACE 而不是 IGNORE：导入账号会把日志行按「账号/路由的业务标识」重写一遍，
 * 标识对不上时那几列会变成 null（见 backupService 的 importAccountsSection），
 * 归档里的那份才是权威副本，得盖回去。
 */
export function restoreEdgeLogs(): number {
  const conn = connection;
  if (!conn || logColumns.length === 0) return 0;

  const columnList = logColumns.map(quoteIdentifier).join(', ');
  // 历史日志引用的账号/站点可能已经在服务器上删掉了，读回来时不能卡在外键上。
  conn.pragma('foreign_keys = OFF');
  try {
    return conn.prepare(
      `INSERT OR REPLACE INTO main.proxy_logs (${columnList})`
      + ` SELECT ${columnList} FROM ${ARCHIVE_SCHEMA}.proxy_logs ORDER BY id DESC LIMIT ?`,
    ).run(MEMORY_LOG_LIMIT).changes;
  } finally {
    conn.pragma('foreign_keys = ON');
  }
}

function startFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    try {
      flushEdgeLogs();
    } catch (error) {
      // 归档失败不能影响转发：日志照旧进内存，下一次定时再补。
      console.warn(`[edge] 使用日志归档失败：${(error as Error)?.message || String(error)}`);
    }
  }, FLUSH_INTERVAL_MS);
  // 别让定时器挡着进程退出。
  flushTimer.unref?.();
}

/**
 * 读一个本机设置。归档还没就绪（例如单元测试没调 setupEdgeLogArchive）时按「没设过」处理。
 */
export function readEdgeLocalSetting(key: string): string {
  const conn = connection;
  if (!conn) return '';
  try {
    const row = conn.prepare(
      `SELECT value FROM ${ARCHIVE_SCHEMA}.${SETTINGS_TABLE} WHERE key = ?`,
    ).get(key) as { value?: unknown } | undefined;
    return typeof row?.value === 'string' ? row.value : '';
  } catch (error) {
    console.warn(`[edge] 读取本机设置失败（${key}）：${(error as Error)?.message || String(error)}`);
    return '';
  }
}

/**
 * 写一个本机设置。归档不可用时直接抛错：宁可让界面报错，也不能假装存下来了。
 */
export function writeEdgeLocalSetting(key: string, value: string): void {
  const conn = connection;
  if (!conn) {
    throw new Error('边缘本地存储还没就绪，本机设置无法保存。');
  }
  conn.prepare(
    `INSERT INTO ${ARCHIVE_SCHEMA}.${SETTINGS_TABLE} (key, value) VALUES (?, ?)`
    + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

/** 建立在内存库上的日志归档：只在边缘入口启动时调用一次。 */
export function setupEdgeLogArchive(input: { dataDirAbsolute: string }): string {
  const conn = getSqliteConnection();
  if (!conn) {
    throw new Error('边缘实例必须使用 SQLite 内存库，但没有拿到底层连接，使用日志无法归档。');
  }

  connection = conn;
  const archivePath = join(input.dataDirAbsolute, ARCHIVE_FILE);
  attachArchive(conn, archivePath);
  ensureArchiveSchema(conn);
  const migrated = migrateLegacyLogs(conn, input.dataDirAbsolute);
  archivedMaxId = readArchivedMaxId(conn);
  const restored = restoreEdgeLogs();
  if (migrated > 0 || restored > 0) {
    console.log(`[edge] 使用日志归档：${archivePath}（本次读回内存 ${restored} 条）`);
  }
  startFlusher();
  return archivePath;
}

/** 退出前把最后一批日志刷进归档，并停掉定时器。 */
export function stopEdgeLogArchive(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  try {
    flushEdgeLogs();
  } catch {}
}

/** 只在测试里用来重置状态。 */
export function resetEdgeLogArchiveForTests(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  connection = null;
  logColumns = [];
  archivedMaxId = 0;
}
