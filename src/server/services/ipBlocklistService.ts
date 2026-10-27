import { and, desc, eq, like, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';

type IpBlocklistRow = typeof schema.ipBlocklist.$inferSelect;
export type IpBlockSource = 'manual' | 'admin_login' | 'proxy_auth';
export type AuthFailureKind = 'admin_login' | 'proxy_auth';

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRACKED_FAILURE_KEYS = 10_000;
const BLOCKLIST_CACHE_TTL_MS = 10_000;
const failureCounters = new Map<string, { count: number; windowStartedAt: number }>();
let cachedBlocklist: Map<string, IpBlocklistRow> | null = null;
let cachedBlocklistAt = 0;

export function normalizeIp(value: string): string {
  const ip = String(value || '').trim();
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length).trim();
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

/**
 * 环回地址永远不参与自动/手动封禁：避免把服务器本机（含 nginx 健康检查、
 * SSH 隧道）一起封死，导致无法从本机恢复。
 */
export function isLoopbackIp(value: string): boolean {
  const ip = normalizeIp(value);
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

function pruneFailureCounters(nowMs: number): void {
  for (const [key, value] of failureCounters) {
    if (nowMs - value.windowStartedAt >= FAILURE_WINDOW_MS) failureCounters.delete(key);
  }
  while (failureCounters.size > MAX_TRACKED_FAILURE_KEYS) {
    const oldest = failureCounters.keys().next().value as string | undefined;
    if (!oldest) break;
    failureCounters.delete(oldest);
  }
}

async function loadBlocklist(force = false): Promise<Map<string, IpBlocklistRow>> {
  const nowMs = Date.now();
  if (!force && cachedBlocklist && nowMs - cachedBlocklistAt < BLOCKLIST_CACHE_TTL_MS) {
    return cachedBlocklist;
  }
  const rows = await db.select().from(schema.ipBlocklist).all();
  cachedBlocklist = new Map(rows.map((row) => [normalizeIp(row.ip), row]));
  cachedBlocklistAt = nowMs;
  return cachedBlocklist;
}

export async function isIpBlocked(ip: string): Promise<boolean> {
  const normalized = normalizeIp(ip);
  if (!normalized || isLoopbackIp(normalized)) return false;
  return (await loadBlocklist()).has(normalized);
}

export async function listBlockedIps(input: {
  query?: string;
  source?: IpBlockSource | 'all' | null;
  limit?: number;
} = {}): Promise<IpBlocklistRow[]> {
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit || 500)));
  const clauses: SQL<unknown>[] = [];
  const query = String(input.query || '').trim();
  if (query) clauses.push(like(schema.ipBlocklist.ip, `%${query.slice(0, 64)}%`));
  if (input.source && input.source !== 'all') {
    clauses.push(eq(schema.ipBlocklist.source, input.source));
  }
  let statement = db.select().from(schema.ipBlocklist) as any;
  if (clauses.length === 1) statement = statement.where(clauses[0]);
  if (clauses.length > 1) statement = statement.where(and(...clauses));
  const rows = await statement.orderBy(desc(schema.ipBlocklist.blockedAt)).limit(limit).all();
  cachedBlocklist = new Map(rows.map((row) => [normalizeIp(row.ip), row]));
  cachedBlocklistAt = Date.now();
  return rows as IpBlocklistRow[];
}

export async function blockIp(input: {
  ip: string;
  source: IpBlockSource;
  reason: string;
  note?: string | null;
  failureCount?: number;
}): Promise<IpBlocklistRow> {
  const ip = normalizeIp(input.ip);
  if (!ip) throw new Error('IP is required');
  if (isLoopbackIp(ip)) throw new Error('Refusing to block loopback address');

  const nowIso = new Date().toISOString();
  const existing = await db.select().from(schema.ipBlocklist).where(eq(schema.ipBlocklist.ip, ip)).get();
  if (existing) {
    const next = {
      source: input.source,
      reason: input.reason,
      note: input.note ?? existing.note,
      failureCount: Math.max(existing.failureCount || 0, input.failureCount || 0),
      updatedAt: nowIso,
    };
    await db.update(schema.ipBlocklist).set(next).where(eq(schema.ipBlocklist.id, existing.id)).run();
    const updated = { ...existing, ...next };
    cachedBlocklist?.set(ip, updated);
    cachedBlocklistAt = Date.now();
    return updated;
  }

  const inserted = await insertAndGetById<IpBlocklistRow>({
    table: schema.ipBlocklist,
    idColumn: schema.ipBlocklist.id,
    values: {
      ip,
      source: input.source,
      reason: input.reason,
      note: input.note || null,
      failureCount: input.failureCount || 0,
      blockedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    insertErrorMessage: 'Failed to create IP blocklist entry',
  });
  cachedBlocklist?.set(ip, inserted);
  cachedBlocklistAt = Date.now();
  return inserted;
}

export async function unblockIpById(id: number): Promise<boolean> {
  const existing = await db.select().from(schema.ipBlocklist).where(eq(schema.ipBlocklist.id, id)).get();
  if (!existing) return false;
  await db.delete(schema.ipBlocklist).where(eq(schema.ipBlocklist.id, id)).run();
  cachedBlocklist?.delete(normalizeIp(existing.ip));
  cachedBlocklistAt = Date.now();
  return true;
}

export function clearAuthFailureCounter(kind: AuthFailureKind, ip: string): void {
  failureCounters.delete(`${kind}:${normalizeIp(ip)}`);
}

/**
 * 在固定窗口内累计失败次数。达到阈值后写库封禁，并返回 blocked=true。
 * 计数与封禁分开：失败本身走内存，真正拉黑才落库，避免高频写库。
 */
export async function registerAuthFailure(input: {
  kind: AuthFailureKind;
  ip: string;
  threshold: number;
  reason: string;
  note?: string;
}): Promise<{ count: number; blocked: boolean }> {
  const ip = normalizeIp(input.ip);
  if (!ip || isLoopbackIp(ip)) return { count: 0, blocked: false };
  if (await isIpBlocked(ip)) return { count: 0, blocked: true };

  const nowMs = Date.now();
  pruneFailureCounters(nowMs);
  const key = `${input.kind}:${ip}`;
  const existing = failureCounters.get(key);
  const withinWindow = existing && nowMs - existing.windowStartedAt < FAILURE_WINDOW_MS;
  const count = withinWindow ? existing!.count + 1 : 1;
  failureCounters.set(key, {
    count,
    windowStartedAt: withinWindow ? existing!.windowStartedAt : nowMs,
  });

  if (count < Math.max(1, input.threshold)) return { count, blocked: false };
  try {
    await blockIp({
      ip,
      source: input.kind,
      reason: input.reason,
      note: input.note,
      failureCount: count,
    });
    failureCounters.delete(key);
    return { count, blocked: true };
  } catch (error) {
    // 黑名单写入失败不应把认证请求变成 500；保留计数，下一次继续尝试。
    console.warn(`[security] Failed to block IP ${ip}: ${(error as Error)?.message || 'unknown error'}`);
    return { count, blocked: false };
  }
}

export function resetIpBlocklistStateForTests(): void {
  cachedBlocklist = null;
  cachedBlocklistAt = 0;
  failureCounters.clear();
}
