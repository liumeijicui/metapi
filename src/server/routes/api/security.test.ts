import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('security routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';
  let originalDataDir: string | undefined;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-security-routes-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./security.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.securityRoutes);
  });

  beforeEach(async () => {
    const { resetIpBlocklistStateForTests } = await import('../../services/ipBlocklistService.js');
    const { resetFingerprintBlocklistStateForTests } = await import('../../services/fingerprintBlocklistService.js');
    const { resetTrustedFingerprintStateForTests } = await import('../../services/trustedFingerprintService.js');
    resetIpBlocklistStateForTests();
    resetFingerprintBlocklistStateForTests();
    resetTrustedFingerprintStateForTests();
    await db.delete(schema.ipBlocklist).run();
    await db.delete(schema.fingerprintBlocklist).run();
    await db.delete(schema.trustedFingerprints).run();
    await db.delete(schema.adminLoginLogs).run();
  });

  afterAll(async () => {
    await app.close();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('creates, lists and removes a blocklist entry', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/security/ip-blocklist',
      payload: { ip: '203.0.113.9', reason: 'manual test' },
    });
    expect(created.statusCode).toBe(200);
    const item = (created.json() as { item: { id: number; ip: string } }).item;
    expect(item.ip).toBe('203.0.113.9');

    const listed = await app.inject({ method: 'GET', url: '/api/security/ip-blocklist' });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: Array<{ ip: string }> }).items).toHaveLength(1);

    const removed = await app.inject({ method: 'DELETE', url: `/api/security/ip-blocklist/${item.id}` });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/security/ip-blocklist' });
    expect((after.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('refuses to block loopback so the host cannot lock itself out', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/security/ip-blocklist',
      payload: { ip: '127.0.0.1' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('creates, lists and removes a fingerprint blocklist entry', async () => {
    const fingerprint = 'a'.repeat(64);
    const created = await app.inject({
      method: 'POST',
      url: '/api/security/fingerprint-blocklist',
      payload: { fingerprint, reason: 'manual test', label: 'Chrome on Windows', lastIp: '203.0.113.10' },
    });
    expect(created.statusCode).toBe(200);
    const item = (created.json() as { item: { id: number; fingerprint: string } }).item;
    expect(item.fingerprint).toBe(fingerprint);

    const listed = await app.inject({ method: 'GET', url: '/api/security/fingerprint-blocklist' });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { items: Array<{ fingerprint: string }> }).items).toHaveLength(1);

    const removed = await app.inject({ method: 'DELETE', url: `/api/security/fingerprint-blocklist/${item.id}` });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/security/fingerprint-blocklist' });
    expect((after.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('rejects an invalid fingerprint hash', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/security/fingerprint-blocklist',
      payload: { fingerprint: 'not-a-hash' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('keeps the enforcement cache complete when the list is filtered', async () => {
    const first = 'b'.repeat(64);
    const second = 'c'.repeat(64);
    for (const fingerprint of [first, second]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/security/fingerprint-blocklist',
        payload: { fingerprint, reason: 'cache test' },
      });
      expect(response.statusCode).toBe(200);
    }

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/security/fingerprint-blocklist?query=${'c'.repeat(12)}`,
    });
    expect(filtered.statusCode).toBe(200);
    expect((filtered.json() as { items: unknown[] }).items).toHaveLength(1);

    const { isFingerprintBlocked } = await import('../../services/fingerprintBlocklistService.js');
    expect(await isFingerprintBlocked(first)).toBe(true);
    expect(await isFingerprintBlocked(second)).toBe(true);
  });

  it('refuses to block the fingerprint of the current admin session', async () => {
    const fingerprint = 'd'.repeat(64);
    const { issueAdminSession } = await import('../../services/adminAuthService.js');
    const session = issueAdminSession(fingerprint);
    const response = await app.inject({
      method: 'POST',
      url: '/api/security/fingerprint-blocklist',
      headers: { authorization: `Bearer ${session.token}` },
      payload: { fingerprint, reason: 'self block' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('marks a fingerprint as trusted and clears its automatic block', async () => {
    const fingerprint = 'e'.repeat(64);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/security/fingerprint-blocklist',
      payload: { fingerprint, reason: 'auto block' },
    });
    expect(blocked.statusCode).toBe(200);
    // 模拟自动拉黑来源
    await db.update(schema.fingerprintBlocklist)
      .set({ source: 'admin_login' })
      .run();
    const { resetFingerprintBlocklistStateForTests } = await import('../../services/fingerprintBlocklistService.js');
    resetFingerprintBlocklistStateForTests();

    const trusted = await app.inject({
      method: 'POST',
      url: '/api/security/trusted-fingerprints',
      payload: { fingerprint, label: 'my chrome' },
    });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.json()).toMatchObject({ success: true, autoUnblocked: true, stillBlocked: false });

    const listed = await app.inject({ method: 'GET', url: '/api/security/trusted-fingerprints' });
    expect(listed.statusCode).toBe(200);
    const items = (listed.json() as { items: Array<{ id: number; fingerprint: string; label: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ fingerprint, label: 'my chrome' });

    const remainingBlocks = await app.inject({ method: 'GET', url: '/api/security/fingerprint-blocklist' });
    expect((remainingBlocks.json() as { items: unknown[] }).items).toHaveLength(0);

    const removed = await app.inject({ method: 'DELETE', url: `/api/security/trusted-fingerprints/${items[0]!.id}` });
    expect(removed.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/api/security/trusted-fingerprints' });
    expect((after.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it('does not auto-unblock a manually blocked fingerprint when trusted', async () => {
    const fingerprint = 'f'.repeat(64);
    await app.inject({
      method: 'POST',
      url: '/api/security/fingerprint-blocklist',
      payload: { fingerprint, reason: 'manual block' },
    });
    const trusted = await app.inject({
      method: 'POST',
      url: '/api/security/trusted-fingerprints',
      payload: { fingerprint },
    });
    expect(trusted.statusCode).toBe(200);
    expect(trusted.json()).toMatchObject({ autoUnblocked: false, stillBlocked: true });
  });

  it('refuses to block a fingerprint that is marked as trusted', async () => {
    const fingerprint = 'a1'.repeat(32);
    await app.inject({
      method: 'POST',
      url: '/api/security/trusted-fingerprints',
      payload: { fingerprint },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/security/fingerprint-blocklist',
      payload: { fingerprint, reason: 'conflict' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('filters login logs by ip and success at the same time', async () => {
    const createdAt = new Date().toISOString();
    await db.insert(schema.adminLoginLogs).values([
      { ip: '198.51.100.1', success: false, reason: 'invalid_credentials', createdAt },
      { ip: '198.51.100.1', success: true, reason: 'success', createdAt },
      { ip: '198.51.100.2', success: true, reason: 'success', createdAt },
    ]).run();

    const response = await app.inject({
      method: 'GET',
      url: '/api/security/login-logs?ip=198.51.100.1&success=true',
    });
    expect(response.statusCode).toBe(200);
    const items = (response.json() as { items: Array<{ ip: string; success: boolean }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ ip: '198.51.100.1', success: true });
  });

  it('summarizes login logs by my devices and other devices', async () => {
    const own = 'a2'.repeat(32);
    const outsider = 'b2'.repeat(32);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await db.insert(schema.trustedFingerprints).values({
      fingerprint: own,
      label: 'my device',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
    await db.insert(schema.adminLoginLogs).values([
      { ip: '198.51.100.1', success: true, fingerprint: own, createdAt: new Date().toISOString() },
      { ip: '198.51.100.1', success: false, fingerprint: own, createdAt: new Date().toISOString() },
      { ip: '198.51.100.2', success: true, fingerprint: outsider, createdAt: new Date().toISOString() },
      { ip: '198.51.100.2', success: false, fingerprint: outsider, createdAt: new Date().toISOString() },
      { ip: '198.51.100.3', success: false, fingerprint: null, createdAt: new Date().toISOString() },
      // 昨天的记录计入总计，但不能计入“今日”。
      { ip: '198.51.100.4', success: true, fingerprint: own, createdAt: yesterday },
    ]).run();

    const response = await app.inject({ method: 'GET', url: '/api/security/login-logs?limit=2' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: unknown[];
      summary: Record<string, any>;
    };
    // 列表有 2 条上限，但汇总要覆盖全部 6 条。
    expect(body.items).toHaveLength(2);
    expect(body.summary).toMatchObject({
      total: 6,
      success: 3,
      failed: 3,
      trusted: 3,
      trustedSuccess: 2,
      other: 3,
      otherSuccess: 1,
      uniqueFingerprints: 2,
      today: {
        total: 5,
        success: 2,
        failed: 3,
        trusted: 2,
        trustedSuccess: 1,
        other: 3,
        otherSuccess: 1,
        uniqueFingerprints: 2,
      },
    });
    expect(String(body.summary.today.localDay)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('issues a server-signed downstream key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/security/generate-key',
      payload: { kind: 'downstream' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { key: string }).key).toMatch(/^sk-[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{9}$/);
  });
});
