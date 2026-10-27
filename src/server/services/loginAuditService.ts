import { and, desc, eq, gte, like, lt, sql, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getLocalDayRangeUtc } from './localTimeService.js';

type LoginAuditInput = {
  username?: string | null;
  ip: string;
  userAgent?: string | null;
  success: boolean;
  reason?: string | null;
  peerIp?: string | null;
  ipChain?: string | null;
  fingerprint?: string | null;
  fingerprintDetail?: unknown;
  spoofSuspect?: boolean;
};

function serializeDetail(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized === '{}') return null;
    return serialized.slice(0, 2000);
  } catch {
    return null;
  }
}

export async function recordAdminLoginAttempt(input: LoginAuditInput): Promise<void> {
  try {
    await db.insert(schema.adminLoginLogs).values({
      username: String(input.username || '').trim().slice(0, 64) || null,
      ip: String(input.ip || 'unknown').trim().slice(0, 64) || 'unknown',
      userAgent: String(input.userAgent || '').trim().slice(0, 512) || null,
      success: input.success,
      reason: String(input.reason || '').trim().slice(0, 256) || null,
      peerIp: String(input.peerIp || '').trim().slice(0, 64) || null,
      ipChain: String(input.ipChain || '').trim().slice(0, 512) || null,
      fingerprint: String(input.fingerprint || '').trim().slice(0, 64) || null,
      fingerprintDetail: serializeDetail(input.fingerprintDetail),
      spoofSuspect: !!input.spoofSuspect,
      createdAt: new Date().toISOString(),
    }).run();
  } catch {
    // 登录审计不能影响登录本身；数据库异常会由主流程/日志单独发现。
  }
}

export async function listAdminLoginLogs(input: {
  limit?: number;
  ip?: string;
  success?: boolean | null;
  fingerprint?: string;
  spoofOnly?: boolean;
} = {}): Promise<Array<typeof schema.adminLoginLogs.$inferSelect>> {
  const limit = Math.min(500, Math.max(1, Math.trunc(input.limit || 200)));
  const clauses = buildLoginLogClauses(input);

  let query = db.select().from(schema.adminLoginLogs) as any;
  if (clauses.length === 1) query = query.where(clauses[0]);
  if (clauses.length > 1) query = query.where(and(...clauses));
  return query.orderBy(desc(schema.adminLoginLogs.id)).limit(limit).all() as Promise<
    Array<typeof schema.adminLoginLogs.$inferSelect>
  >;
}

function buildLoginLogClauses(input: {
  ip?: string;
  success?: boolean | null;
  fingerprint?: string;
  spoofOnly?: boolean;
}): SQL<unknown>[] {
  const clauses: SQL<unknown>[] = [];
  const ip = String(input.ip || '').trim();
  if (ip) clauses.push(eq(schema.adminLoginLogs.ip, ip.slice(0, 64)));
  if (typeof input.success === 'boolean') {
    clauses.push(eq(schema.adminLoginLogs.success, input.success));
  }
  const fingerprint = String(input.fingerprint || '').trim().toLowerCase();
  if (fingerprint) {
    // 指纹是 64 位十六进制；允许用前缀查询，方便在页面上从审计行里直接筛选。
    if (/^[a-f0-9]{64}$/.test(fingerprint)) {
      clauses.push(eq(schema.adminLoginLogs.fingerprint, fingerprint));
    } else {
      clauses.push(like(schema.adminLoginLogs.fingerprint, `${fingerprint.slice(0, 32)}%`));
    }
  }
  if (input.spoofOnly) clauses.push(eq(schema.adminLoginLogs.spoofSuspect, true));
  return clauses;
}

export type AdminLoginLogWindowSummary = {
  /** 该时间窗口内的登录尝试（含失败）。 */
  total: number;
  success: number;
  failed: number;
  /** 来自「我的设备」的登录尝试与其中成功次数。 */
  trusted: number;
  trustedSuccess: number;
  /** 来自未标记设备（含未采集到指纹）的登录尝试与其中成功次数。 */
  other: number;
  otherSuccess: number;
  uniqueFingerprints: number;
};

export type AdminLoginLogSummary = AdminLoginLogWindowSummary & {
  /** 按服务器本地时区计算的“今日”统计，筛选条件与上方列表一致。 */
  today: AdminLoginLogWindowSummary & { localDay: string };
};

function toIsoBoundary(sqlUtc: string): string {
  // 审计表的 createdAt 使用 Date#toISOString()（带 T 和毫秒），
  // 这里把日界线转换成同样的格式，保证字符串比较在 SQLite/MySQL/PG 上一致。
  return `${sqlUtc.replace(' ', 'T')}.000Z`;
}

async function summarizeLoginLogWindow(
  clauses: SQL<unknown>[],
  trustedSet: Set<string>,
): Promise<AdminLoginLogWindowSummary> {
  let query = db.select({
    fingerprint: schema.adminLoginLogs.fingerprint,
    success: schema.adminLoginLogs.success,
    total: sql<number>`count(*)`,
  }).from(schema.adminLoginLogs) as any;
  if (clauses.length === 1) query = query.where(clauses[0]);
  if (clauses.length > 1) query = query.where(and(...clauses));
  // 在数据库里按 (指纹, 结果) 聚合，避免审计表变大后把全部行拉到进程里。
  const rows = await query
    .groupBy(schema.adminLoginLogs.fingerprint, schema.adminLoginLogs.success)
    .all() as Array<{ fingerprint: string | null; success: boolean; total: number | string }>;

  const summary: AdminLoginLogWindowSummary = {
    total: 0,
    success: 0,
    failed: 0,
    trusted: 0,
    trustedSuccess: 0,
    other: 0,
    otherSuccess: 0,
    uniqueFingerprints: 0,
  };
  const fingerprints = new Set<string>();

  for (const row of rows) {
    const count = Math.max(0, Math.trunc(Number(row.total) || 0));
    if (count === 0) continue;
    const fingerprint = String(row.fingerprint || '').trim();
    if (fingerprint) fingerprints.add(fingerprint);
    summary.total += count;
    if (row.success) summary.success += count;
    else summary.failed += count;
    if (fingerprint && trustedSet.has(fingerprint)) {
      summary.trusted += count;
      if (row.success) summary.trustedSuccess += count;
    } else {
      summary.other += count;
      if (row.success) summary.otherSuccess += count;
    }
  }
  summary.uniqueFingerprints = fingerprints.size;
  return summary;
}

/**
 * 登录审计汇总。统计与列表使用同一组筛选条件，但不受列表 500 条上限影响，
 * 否则“总计”只会统计当前页，数字会误导人。
 */
export async function summarizeAdminLoginLogs(input: {
  ip?: string;
  success?: boolean | null;
  fingerprint?: string;
  spoofOnly?: boolean;
} = {}): Promise<AdminLoginLogSummary> {
  const clauses = buildLoginLogClauses(input);
  const dayRange = getLocalDayRangeUtc();
  const todayClauses = [
    ...clauses,
    gte(schema.adminLoginLogs.createdAt, toIsoBoundary(dayRange.startUtc)),
    lt(schema.adminLoginLogs.createdAt, toIsoBoundary(dayRange.endUtc)),
  ];
  const trustedRows = await db.select({ fingerprint: schema.trustedFingerprints.fingerprint })
    .from(schema.trustedFingerprints)
    .all() as Array<{ fingerprint: string }>;
  const trustedSet = new Set(trustedRows.map((row) => row.fingerprint));

  const [allTime, today] = await Promise.all([
    summarizeLoginLogWindow(clauses, trustedSet),
    summarizeLoginLogWindow(todayClauses, trustedSet),
  ]);
  return { ...allTime, today: { ...today, localDay: dayRange.localDay } };
}
