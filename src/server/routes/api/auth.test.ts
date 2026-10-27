import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { authMiddleware } from '../../middleware/auth.js';
import { isPublicApiRoute } from '../../desktop.js';
import { resetRequestRateLimitStore } from '../../middleware/requestRateLimit.js';
import { resetAdminAuthStateForTests } from '../../services/adminAuthService.js';
import { resetIpBlocklistStateForTests } from '../../services/ipBlocklistService.js';
import { resetLoginFingerprintGuardForTests } from '../../services/loginFingerprintGuard.js';
import { resetFingerprintBlocklistStateForTests } from '../../services/fingerprintBlocklistService.js';
import { resetTrustedFingerprintStateForTests } from '../../services/trustedFingerprintService.js';

type ConfigModule = typeof import('../../config.js');
type DbModule = typeof import('../../db/index.js');

describe('auth routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let config: ConfigModule['config'];
  let dataDir = '';
  let originalDataDir: string | undefined;
  let originalAuthToken = '';
  let originalAdminUsername = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-auth-routes-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const configModule = await import('../../config.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./auth.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;
    originalAuthToken = config.authToken;
    originalAdminUsername = config.adminUsername;

    app = Fastify();
    app.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/api/') && !isPublicApiRoute(request.url)) {
        await authMiddleware(request, reply);
      }
    });
    await app.register(routesModule.authRoutes);
  });

  beforeEach(async () => {
    config.authToken = 'secret-token';
    config.adminUsername = 'admin';
    resetRequestRateLimitStore();
    resetAdminAuthStateForTests();
    resetIpBlocklistStateForTests();
    resetLoginFingerprintGuardForTests();
    resetFingerprintBlocklistStateForTests();
    resetTrustedFingerprintStateForTests();
    await db.delete(schema.events).run();
    await db.delete(schema.settings).run();
    await db.delete(schema.ipBlocklist).run();
    await db.delete(schema.fingerprintBlocklist).run();
    await db.delete(schema.trustedFingerprints).run();
    await db.delete(schema.adminLoginLogs).run();
  });

  afterAll(async () => {
    config.authToken = originalAuthToken;
    config.adminUsername = originalAdminUsername;
    await app.close();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('rejects malformed auth change payloads at the route boundary', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/settings/auth/change',
      headers: { authorization: 'Bearer secret-token' },
      payload: {
        oldToken: 'secret-token',
        newToken: 123,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      success: false,
      message: 'Invalid newToken. Expected string.',
    });
  });

  it('requires both username and password at login', async () => {
    const wrongUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.20',
      payload: { username: 'root', password: 'secret-token' },
    });
    expect(wrongUser.statusCode).toBe(401);

    const missingPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.20',
      payload: { username: 'admin' },
    });
    expect(missingPassword.statusCode).toBe(400);
  });

  it('rejects oversized login payloads before password verification', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.23',
      payload: { username: 'admin', password: 'x'.repeat(5 * 1024) },
    });

    expect(response.statusCode).toBe(413);
  });

  it('issues a server-expiring session and accepts it for admin APIs', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.21',
      payload: { username: 'admin', password: 'secret-token' },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json() as { token?: string; expiresAt?: number; username?: string };
    expect(body.username).toBe('admin');
    expect(body.token).toMatch(/^m1\./);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect(body.token).not.toBe('secret-token');

    const info = await app.inject({
      method: 'GET',
      url: '/api/settings/auth/info',
      remoteAddress: '198.51.100.21',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ username: 'admin' });
    expect(String((info.json() as { masked?: string }).masked || '')).toContain('AUTH_TOKEN');
  });

  it('records the browser fingerprint and spoof flags in the login audit', async () => {
    const detail = {
      ua: 'Mozilla/5.0 Chrome/153',
      platform: 'Win32',
      screen: '1920x1080x24',
      timezone: 'Asia/Shanghai',
    };
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.31',
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/153', 'x-forwarded-for': '1.2.3.4' },
      payload: { username: 'admin', password: 'secret-token', fingerprintDetail: detail },
    });
    expect(login.statusCode).toBe(200);

    const rows = await db.select().from(schema.adminLoginLogs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ success: true, ip: '198.51.100.31', spoofSuspect: true });
    expect(String(rows[0]!.fingerprint || '')).toMatch(/^[a-f0-9]{64}$/);
    expect(String(rows[0]!.fingerprintDetail || '')).toContain('Asia/Shanghai');
  });

  it('permanently blocks a fingerprint across rotating IPs after repeated failures', async () => {
    const detail = {
      ua: 'Mozilla/5.0 Chrome/153',
      platform: 'Win32',
      screen: '1920x1080x24',
      timezone: 'Asia/Shanghai',
    };

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        // 每次换一个 IP：只按 IP 封禁是挡不住的。
        remoteAddress: `198.51.100.${40 + attempt}`,
        payload: { username: 'admin', password: `wrong-${attempt}`, fingerprintDetail: detail },
      });
      expect(response.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.200',
      payload: { username: 'admin', password: 'secret-token', fingerprintDetail: detail },
    });
    expect(blocked.statusCode).toBe(403);
    const fpRows = await db.select().from(schema.fingerprintBlocklist).all();
    expect(fpRows).toHaveLength(1);
    expect(fpRows[0]).toMatchObject({ source: 'admin_login' });
  });

  it('does not lock a fingerprint marked as my device', async () => {
    const detail = {
      ua: 'Mozilla/5.0 Chrome/153',
      platform: 'Win32',
      screen: '1920x1080x24',
      timezone: 'Asia/Shanghai',
    };
    const { computeFingerprintHash } = await import('../../services/browserFingerprint.js');
    const { trustFingerprint } = await import('../../services/trustedFingerprintService.js');
    const fingerprint = computeFingerprintHash(detail);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await trustFingerprint({ fingerprint: fingerprint!, label: 'my chrome' });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        // 同一 IP 连续失败：可信设备不应触发 IP 临时锁或自动拉黑。
        remoteAddress: '198.51.100.80',
        payload: { username: 'admin', password: `wrong-${attempt}`, fingerprintDetail: detail },
      });
      expect(response.statusCode).toBe(401);
    }

    const success = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.80',
      payload: { username: 'admin', password: 'secret-token', fingerprintDetail: detail },
    });
    expect(success.statusCode).toBe(200);
    const blocks = await db.select().from(schema.fingerprintBlocklist).all();
    expect(blocks).toHaveLength(0);
  });

  it('refuses to log in from a permanently blocked fingerprint', async () => {
    const detail = {
      ua: 'Mozilla/5.0 Chrome/153',
      platform: 'Win32',
      screen: '1920x1080x24',
      timezone: 'Asia/Shanghai',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.51',
      payload: { username: 'admin', password: 'secret-token', fingerprintDetail: detail },
    });
    expect(first.statusCode).toBe(200);

    const rows = await db.select().from(schema.adminLoginLogs).all();
    const fingerprint = String(rows[0]!.fingerprint || '');
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const { blockFingerprint } = await import('../../services/fingerprintBlocklistService.js');
    await blockFingerprint({ fingerprint, reason: 'test block' });

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      // 即使换 IP、密码正确，指纹被封仍然不能登录。
      remoteAddress: '198.51.100.52',
      payload: { username: 'admin', password: 'secret-token', fingerprintDetail: detail },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ success: false });
    expect(String((blocked.json() as { message?: string }).message || '')).toContain('禁止访问');
  });

  it('invalidates an existing admin session when its fingerprint gets blocked', async () => {
    const detail = {
      ua: 'Mozilla/5.0 Chrome/153',
      platform: 'Win32',
      screen: '1920x1080x24',
      timezone: 'Asia/Shanghai',
    };
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.61',
      payload: { username: 'admin', password: 'secret-token', fingerprintDetail: detail },
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token: string }).token;
    const rows = await db.select().from(schema.adminLoginLogs).all();
    const fingerprint = String(rows[0]!.fingerprint || '');
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const { blockFingerprint } = await import('../../services/fingerprintBlocklistService.js');
    await blockFingerprint({ fingerprint, reason: 'test block' });

    const info = await app.inject({
      method: 'GET',
      url: '/api/settings/auth/info',
      remoteAddress: '198.51.100.61',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(info.statusCode).toBe(403);
    expect(info.json()).toMatchObject({ error: 'Fingerprint blocked' });
  });

  it('blocks repeated bad passwords from the same client', async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: '198.51.100.22',
        payload: { username: 'admin', password: `wrong-${attempt}` },
      });
      expect(response.statusCode).toBe(401);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '198.51.100.22',
      payload: { username: 'admin', password: 'secret-token' },
    });
    expect(blocked.statusCode).toBe(429);
  });
});
