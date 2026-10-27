import { and, desc, eq, like, type SQL } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';

export type FingerprintBlocklistRow = typeof schema.fingerprintBlocklist.$inferSelect;
export type FingerprintBlockSource = 'manual' | 'admin_login';

const CACHE_TTL_MS = 10_000;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

let cachedFingerprints: Map<string, FingerprintBlocklistRow> | null = null;
let cachedAt = 0;

export function normalizeFingerprintHash(value: unknown): string | null {
  const raw = String(value || '').trim().toLowerCase();
  return FINGERPRINT_PATTERN.test(raw) ? raw : null;
}

async function loadBlocklist(force = false): Promise<Map<string, FingerprintBlocklistRow>> {
  const nowMs = Date.now();
  if (!force && cachedFingerprints && nowMs - cachedAt < CACHE_TTL_MS) {
    return cachedFingerprints;
  }
  const rows = await db.select().from(schema.fingerprintBlocklist).all();
  cachedFingerprints = new Map(rows.map((row) => [row.fingerprint, row]));
  cachedAt = nowMs;
  return cachedFingerprints;
}

export async function isFingerprintBlocked(fingerprint: string | null | undefined): Promise<boolean> {
  const hash = normalizeFingerprintHash(fingerprint);
  if (!hash) return false;
  return (await loadBlocklist()).has(hash);
}

export async function listBlockedFingerprints(input: {
  query?: string;
  source?: FingerprintBlockSource | 'all' | null;
  limit?: number;
} = {}): Promise<FingerprintBlocklistRow[]> {
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit || 500)));
  const clauses: SQL<unknown>[] = [];
  const query = String(input.query || '').trim().toLowerCase();
  if (query) clauses.push(like(schema.fingerprintBlocklist.fingerprint, `${query.slice(0, 64)}%`));
  if (input.source && input.source !== 'all') {
    clauses.push(eq(schema.fingerprintBlocklist.source, input.source));
  }

  let statement = db.select().from(schema.fingerprintBlocklist) as any;
  if (clauses.length === 1) statement = statement.where(clauses[0]);
  if (clauses.length > 1) statement = statement.where(and(...clauses));
  const rows = await statement.orderBy(desc(schema.fingerprintBlocklist.blockedAt)).limit(limit).all();
  return rows as FingerprintBlocklistRow[];
}

export async function blockFingerprint(input: {
  fingerprint: string;
  reason: string;
  source?: FingerprintBlockSource;
  note?: string | null;
  label?: string | null;
  lastIp?: string | null;
  lastUserAgent?: string | null;
  failureCount?: number;
}): Promise<FingerprintBlocklistRow> {
  const fingerprint = normalizeFingerprintHash(input.fingerprint);
  if (!fingerprint) throw new Error('指纹格式无效');

  const nowIso = new Date().toISOString();
  const existing = await db.select().from(schema.fingerprintBlocklist)
    .where(eq(schema.fingerprintBlocklist.fingerprint, fingerprint))
    .get();

  if (existing) {
    const next = {
      source: input.source || existing.source,
      reason: input.reason || existing.reason,
      note: input.note ?? existing.note,
      label: input.label ?? existing.label,
      lastIp: input.lastIp ?? existing.lastIp,
      lastUserAgent: input.lastUserAgent ?? existing.lastUserAgent,
      failureCount: Math.max(existing.failureCount || 0, input.failureCount || 0),
      updatedAt: nowIso,
    };
    await db.update(schema.fingerprintBlocklist).set(next)
      .where(eq(schema.fingerprintBlocklist.id, existing.id)).run();
    const updated = { ...existing, ...next };
    cachedFingerprints?.set(fingerprint, updated);
    cachedAt = Date.now();
    return updated;
  }

  const inserted = await insertAndGetById<FingerprintBlocklistRow>({
    table: schema.fingerprintBlocklist,
    idColumn: schema.fingerprintBlocklist.id,
    values: {
      fingerprint,
      label: input.label || null,
      source: input.source || 'manual',
      reason: input.reason || '管理员手动拉黑',
      note: input.note || null,
      lastIp: input.lastIp || null,
      lastUserAgent: input.lastUserAgent || null,
      failureCount: input.failureCount || 0,
      blockedAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    insertErrorMessage: 'Failed to create fingerprint blocklist entry',
  });
  cachedFingerprints?.set(fingerprint, inserted);
  cachedAt = Date.now();
  return inserted;
}

export async function unblockFingerprintById(id: number): Promise<boolean> {
  const existing = await db.select().from(schema.fingerprintBlocklist)
    .where(eq(schema.fingerprintBlocklist.id, id))
    .get();
  if (!existing) return false;
  await db.delete(schema.fingerprintBlocklist).where(eq(schema.fingerprintBlocklist.id, id)).run();
  cachedFingerprints?.delete(existing.fingerprint);
  cachedAt = Date.now();
  return true;
}

/** 只解除指定来源的封禁；用于把指纹标记为“我的设备”时清掉误判的自动拉黑。 */
export async function unblockFingerprintByHash(
  fingerprint: string,
  source?: FingerprintBlockSource,
): Promise<boolean> {
  const hash = normalizeFingerprintHash(fingerprint);
  if (!hash) return false;
  const existing = await db.select().from(schema.fingerprintBlocklist)
    .where(eq(schema.fingerprintBlocklist.fingerprint, hash))
    .get();
  if (!existing) return false;
  if (source && existing.source !== source) return false;
  await db.delete(schema.fingerprintBlocklist)
    .where(eq(schema.fingerprintBlocklist.id, existing.id))
    .run();
  cachedFingerprints?.delete(hash);
  cachedAt = Date.now();
  return true;
}

export function resetFingerprintBlocklistStateForTests(): void {
  cachedFingerprints = null;
  cachedAt = 0;
}
