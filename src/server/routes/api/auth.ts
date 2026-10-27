import { FastifyInstance, FastifyReply } from 'fastify';
import { db, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { eq } from 'drizzle-orm';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { getClientIp, isIpAllowed } from '../../middleware/auth.js';
import { parseAdminLoginPayload, parseAuthChangePayload } from '../../contracts/supportRoutePayloads.js';
import {
  buildAuthInfo,
  clearAdminAuthFailures,
  getAdminAuthBlockRemainingMs,
  getAdminUsername,
  hashAdminPassword,
  invalidateAdminSessions,
  issueAdminSession,
  recordAdminAuthFailure,
  revokeAdminSessionToken,
  setAdminPasswordHash,
  verifyAdminCredentials,
  verifyAdminPassword,
  verifyLegacyAdminToken,
} from '../../services/adminAuthService.js';
import { recordAdminLoginAttempt } from '../../services/loginAuditService.js';
import { clearAuthFailureCounter, registerAuthFailure } from '../../services/ipBlocklistService.js';
import { isFingerprintBlocked, blockFingerprint } from '../../services/fingerprintBlocklistService.js';
import { isTrustedFingerprint, touchTrustedFingerprint } from '../../services/trustedFingerprintService.js';
import {
  resolveLoginFingerprint,
  resolveLoginIpSource,
  summarizeUserAgent,
  type FingerprintDetail,
  type LoginIpSource,
} from '../../services/browserFingerprint.js';
import {
  clearFingerprintLock,
  getFingerprintLockRemainingMs,
  registerFingerprintFailure,
} from '../../services/loginFingerprintGuard.js';

const limitAdminLogin = createRateLimitGuard({
  bucket: 'admin-login',
  max: 30,
  windowMs: 60_000,
});

const limitAdminTokenChange = createRateLimitGuard({
  bucket: 'auth-change',
  max: 3,
  windowMs: 60_000,
});

const MIN_ADMIN_PASSWORD_LENGTH = 12;
const MAX_ADMIN_PASSWORD_LENGTH = 512;
const USERNAME_PATTERN = /^[\p{L}\p{N}._@-]{2,64}$/u;
const ADMIN_LOGIN_BLOCK_THRESHOLD = 10;

function sendRateLimited(reply: FastifyReply, retryAfterMs: number) {
  return reply
    .code(429)
    .header('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))))
    .send({ success: false, message: '登录失败次数过多，请稍后再试' });
}

function getUserAgent(request: { headers: Record<string, unknown> }): string {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value : '';
}

async function persistSetting(key: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  const existing = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  if (existing) {
    await db.update(schema.settings).set({ value: serialized }).where(eq(schema.settings.key, key)).run();
  } else {
    await db.insert(schema.settings).values({ key, value: serialized }).run();
  }
}

async function auditLogin(input: {
  username?: string | null;
  ip: string;
  userAgent: string;
  success: boolean;
  reason: string;
  ipSource?: LoginIpSource;
  fingerprint?: string | null;
  fingerprintDetail?: FingerprintDetail;
  clientHashMismatch?: boolean;
}): Promise<void> {
  await recordAdminLoginAttempt({
    username: input.username,
    ip: input.ip,
    userAgent: input.userAgent,
    success: input.success,
    reason: input.reason,
    peerIp: input.ipSource?.peerIp || null,
    ipChain: input.ipSource?.ipChain || null,
    fingerprint: input.fingerprint || null,
    fingerprintDetail: input.fingerprintDetail || null,
    spoofSuspect: !!(input.ipSource?.spoofSuspect || input.clientHashMismatch),
  });
}

/**
 * 记录一次失败登录，并在 15 分钟窗口内累计到 10 次时把 IP 永久写入黑名单。
 * 黑名单由全局请求钩子拦截，后续页面、管理 API、/v1 代理都会返回 403。
 */
async function handleAdminLoginFailure(ip: string, reason: string): Promise<{ blocked: boolean }> {
  recordAdminAuthFailure(ip);
  const result = await registerAuthFailure({
    kind: 'admin_login',
    ip,
    threshold: ADMIN_LOGIN_BLOCK_THRESHOLD,
    reason: '管理员登录连续失败达到阈值',
    note: reason,
  });
  return { blocked: result.blocked };
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: unknown }>(
    '/api/auth/login',
    // The global 20 MiB body limit exists for model payloads. Authentication
    // endpoints never need more than a few hundred bytes.
    { preHandler: [limitAdminLogin], bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const clientIp = getClientIp(request);
      const userAgent = getUserAgent(request);
      const ipSource = resolveLoginIpSource(request);
      const fingerprint = resolveLoginFingerprint(request, request.body);
      // 审计上下文在所有分支复用：即使请求体非法也要留下来源与指纹。
      const auditContext = {
        ip: clientIp,
        userAgent,
        ipSource,
        fingerprint: fingerprint.hash,
        fingerprintDetail: fingerprint.detail,
        clientHashMismatch: fingerprint.clientHashMismatch,
      };

      if (!isIpAllowed(clientIp, config.adminIpAllowlist)) {
        await auditLogin({ ...auditContext, success: false, reason: 'ip_not_allowed' });
        return reply.code(403).send({ success: false, message: '当前 IP 不在管理白名单中' });
      }

      // 机主自己的设备：即使之前因为输错密码被临时锁过，也立即恢复。
      const trustedFingerprint = fingerprint.hash
        ? await isTrustedFingerprint(fingerprint.hash)
        : false;

      const blockedForMs = trustedFingerprint ? 0 : getAdminAuthBlockRemainingMs(clientIp);
      if (blockedForMs > 0) {
        await auditLogin({ ...auditContext, success: false, reason: 'temporarily_locked' });
        return sendRateLimited(reply, blockedForMs);
      }

      // 永久指纹黑名单：即使密码正确、IP 再换，该浏览器也登录不进来。
      if (fingerprint.hash && await isFingerprintBlocked(fingerprint.hash)) {
        await auditLogin({ ...auditContext, success: false, reason: 'fingerprint_blocked' });
        return reply.code(403).send({
          success: false,
          message: '当前浏览器已被禁止访问，如需恢复请联系站点管理员',
        });
      }

      if (trustedFingerprint && fingerprint.hash) {
        clearFingerprintLock(fingerprint.hash);
      }

      // 同一浏览器换 IP 继续尝试时，按指纹额外锁定。
      const fingerprintLockMs = trustedFingerprint
        ? 0
        : getFingerprintLockRemainingMs(fingerprint.hash || '');
      if (fingerprintLockMs > 0) {
        await auditLogin({ ...auditContext, success: false, reason: 'fingerprint_locked' });
        return sendRateLimited(reply, fingerprintLockMs);
      }

      const parsed = parseAdminLoginPayload(request.body);
      if (!parsed.success) {
        await auditLogin({ ...auditContext, success: false, reason: 'invalid_payload' });
        return reply.code(400).send({ success: false, message: parsed.error });
      }
      const username = parsed.data.username || '';
      const password = parsed.data.password || '';
      if (!username || !password) {
        await auditLogin({ ...auditContext, username, success: false, reason: 'missing_credentials' });
        return reply.code(400).send({ success: false, message: '请填写用户名和密码' });
      }

      if (!(await verifyAdminCredentials(username, password))) {
        await auditLogin({ ...auditContext, username, success: false, reason: 'invalid_credentials' });
        // 可信设备不累计 IP 登录失败，避免机主自己输错密码把家庭/办公 IP 锁掉。
        const blocked = trustedFingerprint
          ? false
          : (await handleAdminLoginFailure(clientIp, 'invalid_credentials')).blocked;
        const fingerprintResult = await registerFingerprintFailure(fingerprint.hash || '');
        const locked = blocked || fingerprintResult.locked;
        // 临时指纹锁到期后会自动放开；这里顺带把真正的爆破来源持久化拉黑，
        // 免得攻击者等 15 分钟再继续。
        if (fingerprintResult.locked && fingerprint.hash) {
          await blockFingerprint({
            fingerprint: fingerprint.hash,
            source: 'admin_login',
            reason: '登录失败次数达到阈值',
            note: 'auto',
            label: summarizeUserAgent(userAgent),
            lastIp: clientIp,
            lastUserAgent: userAgent,
            failureCount: fingerprintResult.count,
          }).catch(() => undefined);
        }
        return reply.code(401).send({
          success: false,
          message: locked ? '用户名或密码错误，当前来源已被暂时封禁' : '用户名或密码错误',
        });
      }

      clearAdminAuthFailures(clientIp);
      clearAuthFailureCounter('admin_login', clientIp);
      const session = issueAdminSession(fingerprint.hash);
      await auditLogin({ ...auditContext, username: getAdminUsername(), success: true, reason: 'success' });
      void touchTrustedFingerprint({
        fingerprint: fingerprint.hash,
        lastIp: clientIp,
        lastUserAgent: userAgent,
      }).catch(() => undefined);
      return {
        success: true,
        token: session.token,
        expiresAt: session.expiresAt,
        username: getAdminUsername(),
      };
    },
  );

  app.post<{ Body: unknown }>(
    '/api/settings/auth/change',
    { preHandler: [limitAdminTokenChange], bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const clientIp = getClientIp(request);
      const userAgent = getUserAgent(request);
      const ipSource = resolveLoginIpSource(request);
      const fingerprint = resolveLoginFingerprint(request, request.body);
      const trustedFingerprint = fingerprint.hash
        ? await isTrustedFingerprint(fingerprint.hash)
        : false;
      const auditContext = {
        ip: clientIp,
        userAgent,
        ipSource,
        fingerprint: fingerprint.hash,
        fingerprintDetail: fingerprint.detail,
        clientHashMismatch: fingerprint.clientHashMismatch,
      };
      const parsedBody = parseAuthChangePayload(request.body);
      if (!parsedBody.success) {
        await auditLogin({ ...auditContext, success: false, reason: 'password_change_invalid_payload' });
        return reply.code(400).send({ success: false, message: parsedBody.error });
      }

      const { oldToken, newToken, newUsername } = parsedBody.data;
      if (!oldToken || !newToken) {
        return reply.code(400).send({ success: false, message: '请填写所有字段' });
      }
      if (!(await verifyAdminPassword(oldToken))) {
        await auditLogin({ ...auditContext, username: getAdminUsername(), success: false, reason: 'password_change_invalid_old_password' });
        if (!trustedFingerprint) {
          await handleAdminLoginFailure(clientIp, 'password_change_invalid_old_password');
        }
        await registerFingerprintFailure(fingerprint.hash || '');
        return reply.code(403).send({ success: false, message: '旧密码验证失败' });
      }
      if (newToken.length < MIN_ADMIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ success: false, message: `新密码至少 ${MIN_ADMIN_PASSWORD_LENGTH} 个字符` });
      }
      if (newToken.length > MAX_ADMIN_PASSWORD_LENGTH) {
        return reply.code(400).send({ success: false, message: `新密码最多 ${MAX_ADMIN_PASSWORD_LENGTH} 个字符` });
      }

      const nextUsername = typeof newUsername === 'string' && newUsername.trim()
        ? newUsername.trim()
        : getAdminUsername();
      if (!USERNAME_PATTERN.test(nextUsername)) {
        return reply.code(400).send({ success: false, message: '用户名需为 2-64 位，只能包含文字、数字、点、下划线、@ 或短横线' });
      }

      const nextPasswordHash = hashAdminPassword(newToken);
      await persistSetting('auth_password_hash', nextPasswordHash);
      await persistSetting('auth_username', nextUsername);
      setAdminPasswordHash(nextPasswordHash);
      config.adminUsername = nextUsername;
      invalidateAdminSessions();
      clearAdminAuthFailures(clientIp);
      clearAuthFailureCounter('admin_login', clientIp);

      try {
        const createdAt = formatUtcSqlDateTime(new Date());
        await db.insert(schema.events).values({
          type: 'token',
          title: '管理员登录账号已更新',
          message: '管理员用户名或密码已被修改，其他已登录会话已失效。',
          level: 'warning',
          relatedType: 'settings',
          createdAt,
        }).run();
      } catch {}

      const session = issueAdminSession(fingerprint.hash);
      await auditLogin({ ...auditContext, username: nextUsername, success: true, reason: 'password_changed' });
      void touchTrustedFingerprint({
        fingerprint: fingerprint.hash,
        lastIp: clientIp,
        lastUserAgent: userAgent,
      }).catch(() => undefined);
      return {
        success: true,
        message: '账号密码已更新，其他登录会话已失效',
        token: session.token,
        expiresAt: session.expiresAt,
        username: nextUsername,
      };
    },
  );

  app.post('/api/auth/logout', async (request) => {
    const auth = typeof request.headers.authorization === 'string' ? request.headers.authorization : '';
    const token = auth.replace(/^Bearer\s+/i, '').trim();
    if (token && !verifyLegacyAdminToken(token)) revokeAdminSessionToken(token);
    return { success: true };
  });

  app.get('/api/settings/auth/info', async () => buildAuthInfo());
}
