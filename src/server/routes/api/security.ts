import { FastifyInstance } from 'fastify';
import { isIP } from 'node:net';
import {
  blockIp,
  isLoopbackIp,
  listBlockedIps,
  normalizeIp,
  unblockIpById,
  type IpBlockSource,
} from '../../services/ipBlocklistService.js';
import { listAdminLoginLogs, summarizeAdminLoginLogs } from '../../services/loginAuditService.js';
import { clearAllFingerprintLocks } from '../../services/loginFingerprintGuard.js';
import {
  blockFingerprint,
  isFingerprintBlocked,
  listBlockedFingerprints,
  normalizeFingerprintHash,
  unblockFingerprintByHash,
  unblockFingerprintById,
  type FingerprintBlockSource,
} from '../../services/fingerprintBlocklistService.js';
import { generateDownstreamProxyToken, generateDownstreamSkKey } from '../../services/downstreamKeyService.js';
import { getSessionFingerprint, verifyAdminSessionToken } from '../../services/adminAuthService.js';
import {
  isTrustedFingerprint,
  listTrustedFingerprints,
  trustFingerprint,
  untrustFingerprintById,
} from '../../services/trustedFingerprintService.js';
import { clearFingerprintLock } from '../../services/loginFingerprintGuard.js';

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function parseSource(raw: unknown): IpBlockSource | 'all' {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === 'manual' || value === 'admin_login' || value === 'proxy_auth') return value;
  return 'all';
}

function normalizeIpInput(raw: unknown): string | null {
  const value = normalizeIp(typeof raw === 'string' ? raw : '');
  if (!value) return null;
  if (isIP(value) === 0) return null;
  return value;
}

function getRequestSessionFingerprint(request: {
  headers: Record<string, unknown>;
}): string | null {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') return null;
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  const session = verifyAdminSessionToken(token);
  return session ? getSessionFingerprint(session.sessionId) : null;
}

export async function securityRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { query?: string; source?: string; limit?: string } }>(
    '/api/security/ip-blocklist',
    async (request) => {
      const rows = await listBlockedIps({
        query: typeof request.query?.query === 'string' ? request.query.query : '',
        source: parseSource(request.query?.source),
        limit: parsePositiveInt(request.query?.limit, 500, 1000),
      });
      return { success: true, items: rows };
    },
  );

  app.post<{ Body: { ip?: unknown; reason?: unknown; note?: unknown } }>(
    '/api/security/ip-blocklist',
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const ip = normalizeIpInput(request.body?.ip);
      if (!ip) return reply.code(400).send({ success: false, message: '请输入合法的 IP 地址' });
      if (isLoopbackIp(ip)) {
        return reply.code(400).send({ success: false, message: '环回地址不允许拉黑，避免本机被锁死' });
      }
      const reasonRaw = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
      const noteRaw = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
      const row = await blockIp({
        ip,
        source: 'manual',
        reason: (reasonRaw || '管理员手动拉黑').slice(0, 256),
        note: noteRaw.slice(0, 512) || null,
        failureCount: 0,
      });
      return { success: true, item: row };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/security/ip-blocklist/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ success: false, message: '无效的记录 ID' });
      }
      const removed = await unblockIpById(id);
      if (!removed) return reply.code(404).send({ success: false, message: '记录不存在' });
      return { success: true };
    },
  );

  app.get<{
    Querystring: { ip?: string; success?: string; fingerprint?: string; spoofOnly?: string; limit?: string };
  }>(
    '/api/security/login-logs',
    async (request) => {
      const successRaw = typeof request.query?.success === 'string' ? request.query.success.trim() : '';
      const success = successRaw === 'true' ? true : successRaw === 'false' ? false : null;
      const filters = {
        ip: typeof request.query?.ip === 'string' ? request.query.ip : '',
        success,
        fingerprint: typeof request.query?.fingerprint === 'string' ? request.query.fingerprint : '',
        spoofOnly: request.query?.spoofOnly === 'true',
      };
      const [rows, summary] = await Promise.all([
        listAdminLoginLogs({
          ...filters,
          limit: parsePositiveInt(request.query?.limit, 200, 500),
        }),
        summarizeAdminLoginLogs(filters),
      ]);
      return { success: true, items: rows, summary };
    },
  );

  // 指纹锁定只存在内存里，15 分钟自动过期；这里给机主一个立即自救的入口。
  app.delete('/api/security/login-locks', async () => {
    clearAllFingerprintLocks();
    return { success: true, cleared: 1 };
  });

  app.get<{ Querystring: { query?: string; source?: string; limit?: string } }>(
    '/api/security/fingerprint-blocklist',
    async (request) => {
      const sourceRaw = typeof request.query?.source === 'string' ? request.query.source.trim() : '';
      const source: FingerprintBlockSource | 'all' =
        sourceRaw === 'manual' || sourceRaw === 'admin_login' ? sourceRaw : 'all';
      const rows = await listBlockedFingerprints({
        query: typeof request.query?.query === 'string' ? request.query.query : '',
        source,
        limit: parsePositiveInt(request.query?.limit, 500, 1000),
      });
      return { success: true, items: rows };
    },
  );

  app.post<{
    Body: {
      fingerprint?: unknown;
      reason?: unknown;
      note?: unknown;
      label?: unknown;
      lastIp?: unknown;
      lastUserAgent?: unknown;
      failureCount?: unknown;
    };
  }>(
    '/api/security/fingerprint-blocklist',
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const fingerprint = normalizeFingerprintHash(request.body?.fingerprint);
      if (!fingerprint) {
        return reply.code(400).send({ success: false, message: '指纹格式无效（需 64 位十六进制）' });
      }
      if (fingerprint === getRequestSessionFingerprint(request)) {
        return reply.code(400).send({
          success: false,
          message: '不能拉黑当前正在登录的浏览器，否则会立即把自己锁在门外',
        });
      }
      if (await isTrustedFingerprint(fingerprint)) {
        return reply.code(409).send({
          success: false,
          message: '该指纹已标记为「我的设备」，请先取消信任再拉黑',
        });
      }
      const reasonRaw = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
      const noteRaw = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
      const labelRaw = typeof request.body?.label === 'string' ? request.body.label.trim() : '';
      const failureCount = Number(request.body?.failureCount);
      const row = await blockFingerprint({
        fingerprint,
        source: 'manual',
        reason: (reasonRaw || '管理员手动拉黑').slice(0, 256),
        note: noteRaw.slice(0, 512) || null,
        label: labelRaw.slice(0, 128) || null,
        lastIp: typeof request.body?.lastIp === 'string' ? request.body.lastIp.trim().slice(0, 64) : null,
        lastUserAgent: typeof request.body?.lastUserAgent === 'string'
          ? request.body.lastUserAgent.trim().slice(0, 512)
          : null,
        failureCount: Number.isFinite(failureCount) && failureCount > 0 ? Math.trunc(failureCount) : 0,
      });
      return { success: true, item: row };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/security/fingerprint-blocklist/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ success: false, message: '无效的记录 ID' });
      }
      const removed = await unblockFingerprintById(id);
      if (!removed) return reply.code(404).send({ success: false, message: '记录不存在' });
      return { success: true };
    },
  );

  app.get<{ Querystring: { query?: string; limit?: string } }>(
    '/api/security/trusted-fingerprints',
    async (request) => {
      const rows = await listTrustedFingerprints({
        query: typeof request.query?.query === 'string' ? request.query.query : '',
        limit: parsePositiveInt(request.query?.limit, 500, 1000),
      });
      return { success: true, items: rows };
    },
  );

  app.post<{
    Body: {
      fingerprint?: unknown;
      label?: unknown;
      note?: unknown;
      lastIp?: unknown;
      lastUserAgent?: unknown;
    };
  }>(
    '/api/security/trusted-fingerprints',
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      const fingerprint = normalizeFingerprintHash(request.body?.fingerprint);
      if (!fingerprint) {
        return reply.code(400).send({ success: false, message: '指纹格式无效（需 64 位十六进制）' });
      }
      const labelRaw = typeof request.body?.label === 'string' ? request.body.label.trim() : '';
      const noteRaw = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
      const row = await trustFingerprint({
        fingerprint,
        label: labelRaw.slice(0, 128) || null,
        note: noteRaw.slice(0, 512) || null,
        lastIp: typeof request.body?.lastIp === 'string' ? request.body.lastIp.trim().slice(0, 64) : null,
        lastUserAgent: typeof request.body?.lastUserAgent === 'string'
          ? request.body.lastUserAgent.trim().slice(0, 512)
          : null,
      });
      clearFingerprintLock(fingerprint);
      // 之前因连续失败被自动拉黑的，标记为我的设备时一并解除；手动拉黑仍然保留。
      const autoUnblocked = await unblockFingerprintByHash(fingerprint, 'admin_login');
      const stillBlocked = await isFingerprintBlocked(fingerprint);
      return {
        success: true,
        item: row,
        autoUnblocked,
        stillBlocked,
        message: stillBlocked
          ? '已标记为我的设备，但该指纹仍在手动黑名单中，请先解除拉黑'
          : '已标记为我的设备，后续不会再触发指纹锁定或自动拉黑',
      };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/security/trusted-fingerprints/:id',
    async (request, reply) => {
      const id = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ success: false, message: '无效的记录 ID' });
      }
      const removed = await untrustFingerprintById(id);
      if (!removed) return reply.code(404).send({ success: false, message: '记录不存在' });
      return { success: true };
    },
  );

  app.post<{ Body: { kind?: unknown } }>(
    '/api/security/generate-key',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      const kind = typeof request.body?.kind === 'string' ? request.body.kind.trim() : 'downstream';
      if (kind !== 'downstream' && kind !== 'proxy') {
        return reply.code(400).send({ success: false, message: '不支持的密钥类型' });
      }
      return {
        success: true,
        key: kind === 'proxy' ? generateDownstreamProxyToken() : generateDownstreamSkKey(),
      };
    },
  );
}
