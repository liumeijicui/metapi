import { createHash, createHmac, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const SESSION_VERSION = 'm1';
const SESSION_CONTEXT = 'metapi-admin-session-v1';
// Process-scoped session key material. A restart invalidates every issued
// session, so a token revoked by logout cannot become valid again after a
// crash/restart merely because the revocation list was in memory.
const PROCESS_SESSION_SECRET = randomBytes(32).toString('base64url');
let sessionGeneration = randomBytes(16).toString('base64url');
const MAX_REVOKED_SESSIONS = 2_000;
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAILURE_BLOCK_MS = 15 * 60 * 1000;
const MAX_AUTH_FAILURES = 10;

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_PREFIX = 'scrypt';

type AdminSessionInfo = {
  sessionId: string;
  expiresAt: number;
};

const revokedSessions = new Map<string, number>();
// 会话 → 登录时的浏览器指纹。只放内存：会话本来就会随重启失效，
// 因此不需要额外落库，也不会有过期清理负担。
const sessionFingerprints = new Map<string, { fingerprint: string; expiresAt: number }>();
const authFailures = new Map<string, { count: number; windowStartedAt: number; blockedUntil: number }>();
let adminPasswordHash: string | null = null;

function secureTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function normalizeUsername(value: unknown): string {
  return String(value ?? '').trim();
}

function sessionKey(): Buffer {
  return createHmac('sha256', config.authToken)
    .update(SESSION_CONTEXT)
    .update(PROCESS_SESSION_SECRET)
    .update(sessionGeneration)
    .digest();
}

function pruneRevokedSessions(nowMs: number): void {
  for (const [sessionId, expiresAt] of revokedSessions) {
    if (expiresAt <= nowMs) revokedSessions.delete(sessionId);
  }
  for (const [sessionId, entry] of sessionFingerprints) {
    if (entry.expiresAt <= nowMs) sessionFingerprints.delete(sessionId);
  }
  while (revokedSessions.size > MAX_REVOKED_SESSIONS) {
    const oldest = revokedSessions.keys().next().value as string | undefined;
    if (!oldest) break;
    revokedSessions.delete(oldest);
  }
}

export function getAdminUsername(): string {
  return normalizeUsername(config.adminUsername) || 'admin';
}

export function getAdminPasswordHash(): string | null {
  return adminPasswordHash;
}

export function setAdminPasswordHash(hash: string | null): void {
  const value = String(hash || '').trim();
  adminPasswordHash = value || null;
}

export function hashAdminPassword(password: string): string {
  const value = String(password ?? '');
  if (!value) throw new Error('Password is required');
  const salt = randomBytes(16).toString('base64url');
  const derived = scryptSync(value, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `${SCRYPT_PREFIX}$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString('base64url')}`;
}

function verifyScryptHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== SCRYPT_PREFIX) return Promise.resolve(false);
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4] || '';
  const expected = parts[5] || '';
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expected) {
    return Promise.resolve(false);
  }
  if (n > 1_048_576 || r > 32 || p > 16) return Promise.resolve(false);

  return new Promise((resolve) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (error, derived) => {
      if (error) return resolve(false);
      const expectedBuffer = Buffer.from(expected, 'base64url');
      const derivedBuffer = Buffer.from(derived);
      if (expectedBuffer.length !== derivedBuffer.length) return resolve(false);
      resolve(timingSafeEqual(expectedBuffer, derivedBuffer));
    });
  });
}

export async function verifyAdminPassword(password: unknown): Promise<boolean> {
  const value = String(password ?? '');
  if (!value) return false;
  if (adminPasswordHash) return verifyScryptHash(value, adminPasswordHash);
  // 兼容升级前只有 AUTH_TOKEN 的部署：首次登录仍可用 AUTH_TOKEN 作为密码。
  return secureTextEqual(value, config.authToken);
}

export async function verifyAdminCredentials(username: unknown, password: unknown): Promise<boolean> {
  const providedUsername = normalizeUsername(username);
  const providedPassword = String(password ?? '');
  if (!providedUsername || !providedPassword) return false;
  // Hash both sides first so the comparison is constant-time even when the
  // caller sends a different length.
  const usernameMatches = secureTextEqual(providedUsername, getAdminUsername());
  const passwordMatches = await verifyAdminPassword(providedPassword);
  return usernameMatches && passwordMatches;
}

export function verifyLegacyAdminToken(token: unknown): boolean {
  const value = String(token ?? '');
  if (!value) return false;
  return secureTextEqual(value, config.authToken);
}

export function invalidateAdminSessions(): void {
  sessionGeneration = randomBytes(16).toString('base64url');
  revokedSessions.clear();
  sessionFingerprints.clear();
}

export function issueAdminSession(
  fingerprint: string | null = null,
  nowMs = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = nowMs + Math.max(60_000, config.adminSessionTtlMs);
  const sessionId = randomBytes(18).toString('base64url');
  const normalizedFingerprint = String(fingerprint || '').trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(normalizedFingerprint)) {
    sessionFingerprints.set(sessionId, { fingerprint: normalizedFingerprint, expiresAt });
  }
  const signature = createHmac('sha256', sessionKey())
    .update(`${expiresAt}.${sessionId}.${getAdminUsername()}`)
    .digest('base64url');
  return {
    token: `${SESSION_VERSION}.${expiresAt}.${sessionId}.${signature}`,
    expiresAt,
  };
}

/**
 * 读取会话绑定的指纹。用于在每次管理请求时检查该指纹是否已被拉黑——
 * 这样拉黑一个浏览器后，它已经登录的会话也会立即失效。
 */
export function getSessionFingerprint(sessionId: string): string | null {
  if (!sessionId) return null;
  const entry = sessionFingerprints.get(sessionId);
  return entry ? entry.fingerprint : null;
}

export function parseAdminSessionToken(token: unknown): AdminSessionInfo | null {
  const value = String(token ?? '').trim();
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== SESSION_VERSION) return null;
  const expiresAt = Number.parseInt(parts[1] || '', 10);
  const sessionId = parts[2] || '';
  const signature = parts[3] || '';
  if (!Number.isFinite(expiresAt) || expiresAt <= 0 || !sessionId || !signature) return null;
  return { sessionId, expiresAt };
}

export function verifyAdminSessionToken(token: unknown, nowMs = Date.now()): AdminSessionInfo | null {
  const value = String(token ?? '').trim();
  const parsed = parseAdminSessionToken(value);
  if (!parsed || parsed.expiresAt <= nowMs) return null;
  pruneRevokedSessions(nowMs);
  if (revokedSessions.has(parsed.sessionId)) return null;

  const expected = createHmac('sha256', sessionKey())
    .update(`${parsed.expiresAt}.${parsed.sessionId}.${getAdminUsername()}`)
    .digest('base64url');
  const provided = value.split('.')[3] || '';
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, providedBuffer)) return null;
  return parsed;
}

export function getAdminAuthBlockRemainingMs(key: string, nowMs = Date.now()): number {
  const entry = authFailures.get(key);
  if (!entry) return 0;
  if (entry.blockedUntil > nowMs) return entry.blockedUntil - nowMs;
  if (nowMs - entry.windowStartedAt >= AUTH_FAILURE_WINDOW_MS) {
    authFailures.delete(key);
  }
  return 0;
}

export function recordAdminAuthFailure(key: string, nowMs = Date.now()): void {
  if (!key) return;
  pruneAuthFailures(nowMs);
  const existing = authFailures.get(key);
  if (!existing || nowMs - existing.windowStartedAt >= AUTH_FAILURE_WINDOW_MS) {
    authFailures.set(key, { count: 1, windowStartedAt: nowMs, blockedUntil: 0 });
    return;
  }
  existing.count += 1;
  if (existing.count >= MAX_AUTH_FAILURES) {
    existing.blockedUntil = nowMs + AUTH_FAILURE_BLOCK_MS;
  }
  authFailures.set(key, existing);
}

export function getAdminAuthFailureCount(key: string): number {
  return authFailures.get(key)?.count || 0;
}

export function clearAdminAuthFailures(key: string): void {
  authFailures.delete(key);
}

function pruneAuthFailures(nowMs: number): void {
  for (const [key, entry] of authFailures) {
    if (entry.blockedUntil > nowMs) continue;
    if (nowMs - entry.windowStartedAt >= AUTH_FAILURE_WINDOW_MS) authFailures.delete(key);
  }
}

export function revokeAdminSessionToken(token: unknown, nowMs = Date.now()): boolean {
  const parsed = verifyAdminSessionToken(token, nowMs);
  if (!parsed) return false;
  revokedSessions.set(parsed.sessionId, parsed.expiresAt);
  pruneRevokedSessions(nowMs);
  return true;
}

export function resetAdminAuthStateForTests(): void {
  revokedSessions.clear();
  sessionFingerprints.clear();
  authFailures.clear();
  adminPasswordHash = null;
  sessionGeneration = randomBytes(16).toString('base64url');
}

export function buildAuthInfo(nowMs = Date.now()) {
  return {
    username: getAdminUsername(),
    masked: adminPasswordHash ? '已设置独立密码' : '当前使用 AUTH_TOKEN 作为密码',
    passwordSet: !!adminPasswordHash,
    sessionTtlMs: config.adminSessionTtlMs,
    now: nowMs,
  };
}
