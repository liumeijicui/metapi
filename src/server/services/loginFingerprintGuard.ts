import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { isTrustedFingerprint } from './trustedFingerprintService.js';

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const FAILURE_THRESHOLD = 10;
const MAX_TRACKED = 5_000;

type FailureEntry = { count: number; windowStartedAt: number };

const failures = new Map<string, FailureEntry>();
const locks = new Map<string, number>();

function prune(nowMs: number): void {
  for (const [hash, entry] of failures) {
    if (nowMs - entry.windowStartedAt >= FAILURE_WINDOW_MS) failures.delete(hash);
  }
  for (const [hash, until] of locks) {
    if (until <= nowMs) locks.delete(hash);
  }
  while (failures.size > MAX_TRACKED) {
    const oldest = failures.keys().next().value as string | undefined;
    if (!oldest) break;
    failures.delete(oldest);
  }
}

export function getFingerprintLockRemainingMs(hash: string, nowMs = Date.now()): number {
  if (!hash) return 0;
  const until = locks.get(hash);
  if (!until) return 0;
  if (until <= nowMs) {
    locks.delete(hash);
    return 0;
  }
  return until - nowMs;
}

export function clearFingerprintLock(hash: string): void {
  if (!hash) return;
  locks.delete(hash);
  failures.delete(hash);
}

export function clearAllFingerprintLocks(): void {
  locks.clear();
  failures.clear();
}

async function hasSuccessfulLogin(hash: string): Promise<boolean> {
  try {
    const row = await db.select({ id: schema.adminLoginLogs.id })
      .from(schema.adminLoginLogs)
      .where(and(
        eq(schema.adminLoginLogs.fingerprint, hash),
        eq(schema.adminLoginLogs.success, true),
      ))
      .limit(1)
      .get();
    return !!row;
  } catch {
    return false;
  }
}

/**
 * 按浏览器指纹累计失败次数。
 *
 * 只按 IP 封禁挡不住换 IP 的爆破；这里用指纹作为第二维度：同一个浏览器在
 * 15 分钟内失败 10 次就锁定 15 分钟，与来源 IP 无关。已经成功登录过的指纹
 * （库里存在 success=1 的记录）视为可信设备，不会被自动锁定，避免机主自己
 * 误输密码后把自己锁在门外。
 */
export async function registerFingerprintFailure(hash: string): Promise<{ count: number; locked: boolean }> {
  if (!hash) return { count: 0, locked: false };
  const nowMs = Date.now();
  prune(nowMs);
  // 机主明确标记为“我的设备”的浏览器不受指纹锁定约束。
  // IP 维度的失败计数仍然照常生效，避免可信标记变成绕过全部风控的后门。
  if (await isTrustedFingerprint(hash)) {
    failures.delete(hash);
    locks.delete(hash);
    return { count: 0, locked: false };
  }
  const existing = failures.get(hash);
  const withinWindow = existing && nowMs - existing.windowStartedAt < FAILURE_WINDOW_MS;
  const count = withinWindow ? existing!.count + 1 : 1;
  failures.set(hash, {
    count,
    windowStartedAt: withinWindow ? existing!.windowStartedAt : nowMs,
  });

  if (count < FAILURE_THRESHOLD) return { count, locked: false };
  if (await hasSuccessfulLogin(hash)) {
    failures.delete(hash);
    return { count, locked: false };
  }

  locks.set(hash, nowMs + LOCK_MS);
  failures.delete(hash);
  return { count, locked: true };
}

export function resetLoginFingerprintGuardForTests(): void {
  locks.clear();
  failures.clear();
}
