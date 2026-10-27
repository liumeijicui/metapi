import { desc, eq, like } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import { normalizeFingerprintHash } from './fingerprintBlocklistService.js';

export type TrustedFingerprintRow = typeof schema.trustedFingerprints.$inferSelect;

const CACHE_TTL_MS = 10_000;

let cachedFingerprints: Map<string, TrustedFingerprintRow> | null = null;
let cachedAt = 0;

async function loadTrustedFingerprints(force = false): Promise<Map<string, TrustedFingerprintRow>> {
  const nowMs = Date.now();
  if (!force && cachedFingerprints && nowMs - cachedAt < CACHE_TTL_MS) {
    return cachedFingerprints;
  }
  const rows = await db.select().from(schema.trustedFingerprints).all();
  cachedFingerprints = new Map(rows.map((row) => [row.fingerprint, row]));
  cachedAt = nowMs;
  return cachedFingerprints;
}

export async function isTrustedFingerprint(fingerprint: string | null | undefined): Promise<boolean> {
  const hash = normalizeFingerprintHash(fingerprint);
  if (!hash) return false;
  return (await loadTrustedFingerprints()).has(hash);
}

export async function listTrustedFingerprints(input: {
  query?: string;
  limit?: number;
} = {}): Promise<TrustedFingerprintRow[]> {
  const limit = Math.min(1000, Math.max(1, Math.trunc(input.limit || 500)));
  const query = String(input.query || '').trim().toLowerCase();
  let statement = db.select().from(schema.trustedFingerprints) as any;
  if (query) {
    statement = statement.where(like(schema.trustedFingerprints.fingerprint, `${query.slice(0, 64)}%`));
  }
  return statement.orderBy(desc(schema.trustedFingerprints.createdAt)).limit(limit).all();
}

export async function trustFingerprint(input: {
  fingerprint: string;
  label?: string | null;
  note?: string | null;
  lastIp?: string | null;
  lastUserAgent?: string | null;
}): Promise<TrustedFingerprintRow> {
  const fingerprint = normalizeFingerprintHash(input.fingerprint);
  if (!fingerprint) throw new Error('指纹格式无效');

  const nowIso = new Date().toISOString();
  const existing = await db.select().from(schema.trustedFingerprints)
    .where(eq(schema.trustedFingerprints.fingerprint, fingerprint))
    .get();

  if (existing) {
    const next = {
      label: input.label ?? existing.label,
      note: input.note ?? existing.note,
      lastIp: input.lastIp ?? existing.lastIp,
      lastUserAgent: input.lastUserAgent ?? existing.lastUserAgent,
      lastSeenAt: input.lastIp || input.lastUserAgent ? nowIso : existing.lastSeenAt,
      updatedAt: nowIso,
    };
    await db.update(schema.trustedFingerprints).set(next)
      .where(eq(schema.trustedFingerprints.id, existing.id)).run();
    const updated = { ...existing, ...next };
    cachedFingerprints?.set(fingerprint, updated);
    cachedAt = Date.now();
    return updated;
  }

  const inserted = await insertAndGetById<TrustedFingerprintRow>({
    table: schema.trustedFingerprints,
    idColumn: schema.trustedFingerprints.id,
    values: {
      fingerprint,
      label: input.label || null,
      note: input.note || null,
      lastIp: input.lastIp || null,
      lastUserAgent: input.lastUserAgent || null,
      lastSeenAt: input.lastIp || input.lastUserAgent ? nowIso : null,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
    insertErrorMessage: 'Failed to create trusted fingerprint entry',
  });
  cachedFingerprints?.set(fingerprint, inserted);
  cachedAt = Date.now();
  return inserted;
}

export async function untrustFingerprintById(id: number): Promise<boolean> {
  const existing = await db.select().from(schema.trustedFingerprints)
    .where(eq(schema.trustedFingerprints.id, id))
    .get();
  if (!existing) return false;
  await db.delete(schema.trustedFingerprints).where(eq(schema.trustedFingerprints.id, id)).run();
  cachedFingerprints?.delete(existing.fingerprint);
  cachedAt = Date.now();
  return true;
}

/** 可信设备成功登录时刷新最近使用信息，不改变可信状态。 */
export async function touchTrustedFingerprint(input: {
  fingerprint: string | null | undefined;
  lastIp?: string | null;
  lastUserAgent?: string | null;
}): Promise<void> {
  const fingerprint = normalizeFingerprintHash(input.fingerprint);
  if (!fingerprint) return;
  const existing = await db.select().from(schema.trustedFingerprints)
    .where(eq(schema.trustedFingerprints.fingerprint, fingerprint))
    .get();
  if (!existing) return;
  const nowIso = new Date().toISOString();
  const next = {
    lastIp: input.lastIp || existing.lastIp,
    lastUserAgent: input.lastUserAgent || existing.lastUserAgent,
    lastSeenAt: nowIso,
    updatedAt: nowIso,
  };
  await db.update(schema.trustedFingerprints).set(next)
    .where(eq(schema.trustedFingerprints.id, existing.id)).run();
  cachedFingerprints?.set(fingerprint, { ...existing, ...next });
  cachedAt = Date.now();
}

export function resetTrustedFingerprintStateForTests(): void {
  cachedFingerprints = null;
  cachedAt = 0;
}
