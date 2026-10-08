import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type AnyRecord = Record<string, any>;
type SyncResult = AnyRecord;

describe('edge 配置同步（只拉不推）', () => {
  let dataDir = '';
  let server: Server | null = null;
  let db: AnyRecord;
  let schema: AnyRecord;
  let eq: AnyRecord;
  let syncEdgeConfig: () => Promise<SyncResult>;
  let saveEdgeSyncSource: (input: { url: string; token: string }) => Promise<unknown>;
  let detectLocalSystemProxyUrl: () => string;
  let sourceUrl = '';
  let payloads: Record<string, unknown> = {};
  let failNextRequest = false;
  const requests: Array<{ method: string; url: string; authorization: string }> = [];

  async function handleRequest(request: IncomingMessage, reply: ServerResponse) {
    requests.push({
      method: String(request.method || ''),
      url: String(request.url || ''),
      authorization: String(request.headers.authorization || ''),
    });
    if (failNextRequest) {
      reply.statusCode = 500;
      reply.end('boom');
      return;
    }
    const body = payloads[String(request.url || '')];
    if (!body) {
      reply.statusCode = 404;
      reply.end('{}');
      return;
    }
    reply.setHeader('content-type', 'application/json');
    reply.end(JSON.stringify(body));
  }

  async function readSetting(key: string): Promise<unknown> {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row ? JSON.parse(String(row.value)) : undefined;
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-edge-config-sync-'));
    process.env.DATA_DIR = dataDir;
    process.env.METAPI_EDGE_MODE = '1';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '30086';
    process.env.METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS = '30000';

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const drizzleModule = await import('drizzle-orm');
    db = dbModule.db;
    schema = dbModule.schema;
    eq = drizzleModule.eq;

    server = createServer((request, reply) => { void handleRequest(request, reply); });
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    sourceUrl = `http://127.0.0.1:${port}`;

    const configSyncModule = await import('./configSync.js');
    syncEdgeConfig = configSyncModule.syncEdgeConfig as () => Promise<SyncResult>;
    saveEdgeSyncSource = (await import('./syncSource.js')).saveEdgeSyncSource;
    detectLocalSystemProxyUrl = (await import('./localSystemProxy.js')).detectLocalSystemProxyUrl;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => { server ? server.close(() => resolve()) : resolve(); });
    delete process.env.DATA_DIR;
    delete process.env.METAPI_EDGE_MODE;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('首次同步拉下账号、设置与转发规则，并按本地策略覆盖敏感项', async () => {
    // 造一份「服务器侧」数据，直接用它真实导出的载荷当接口响应，保证形状与生产一致。
    const site = await db.insert(schema.sites).values({
      name: '边缘同步源站',
      url: 'https://edge-source.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'source-user',
      accessToken: 'source-access',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accountTokens).values({
      accountId: account.id,
      name: 'default',
      token: 'sk-source-token',
      enabled: true,
      isDefault: true,
      valueStatus: 'ready',
    }).run();
    const rule = await db.insert(schema.modelForwardRules).values({
      modelName: 'gpt-6-astra',
      enabled: true,
      notes: '同步测试',
    }).returning().get();
    await db.insert(schema.modelForwardTargets).values({
      ruleId: rule.id,
      siteId: site.id,
      accountId: account.id,
      upstreamModel: 'deepseek-v4-flash',
      weight: 10,
      enabled: true,
      sortOrder: 0,
    }).run();
    await db.insert(schema.settings).values([
      { key: 'system_proxy_url', value: JSON.stringify('http://127.0.0.1:7890') },
      { key: 'admin_ip_allowlist', value: JSON.stringify(['10.0.0.1']) },
      { key: 'webhook_enabled', value: JSON.stringify(true) },
      { key: 'smtp_enabled', value: JSON.stringify(true) },
      { key: 'backup_webdav_config_v1', value: JSON.stringify({ enabled: true }) },
      { key: 'payload_rules', value: JSON.stringify([]) },
    ]).run();

    const { exportBackup } = await import('../services/backupService.js');
    const { exportModelForwardSnapshot } = await import('../services/modelForwardService.js');
    payloads = {
      '/api/settings/backup/export?type=accounts': await exportBackup('accounts'),
      '/api/settings/backup/export?type=preferences': await exportBackup('preferences'),
      '/api/edge/model-forward-rules': { success: true, ...(await exportModelForwardSnapshot()) },
    };

    // 清空本地，模拟一个刚装好的边缘实例。
    await db.delete(schema.modelForwardTargets).run();
    await db.delete(schema.modelForwardRules).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
    await db.delete(schema.settings).run();

    // 登录：地址写连接文件、令牌只进内存，同步就按这份来。
    await saveEdgeSyncSource({ url: sourceUrl, token: 'edge-test-token' });

    const result = await syncEdgeConfig();
    expect(result.ok).toBe(true);
    expect(result.sections).toEqual({ accounts: true, preferences: true, forwardRules: true });

    // 账号数据被镜像下来。
    const sites = await db.select().from(schema.sites).all();
    const accounts = await db.select().from(schema.accounts).all();
    expect(sites).toHaveLength(1);
    expect(accounts).toHaveLength(1);

    // 转发规则镜像：id 与顺序都沿用服务器。
    const mirroredRules = await db.select().from(schema.modelForwardRules).all();
    const mirroredTargets = await db.select().from(schema.modelForwardTargets).all();
    expect(mirroredRules).toHaveLength(1);
    expect(mirroredRules[0].modelName).toBe('gpt-6-astra');
    expect(mirroredTargets).toHaveLength(1);
    expect(mirroredTargets[0].upstreamModel).toBe('deepseek-v4-flash');

    // 本地策略：覆盖项按本地值写入。
    // 系统代理不是照抄服务器那份，而是本机探测结果（探测不到就是空串）。
    expect(await readSetting('system_proxy_url')).toBe(detectLocalSystemProxyUrl());
    expect(await readSetting('admin_ip_allowlist')).toBe('');
    expect(await readSetting('webhook_enabled')).toBe(false);
    expect(await readSetting('smtp_enabled')).toBe(false);
    // 忽略项不写入本地，无关项原样同步。
    expect(await readSetting('backup_webdav_config_v1')).toBeUndefined();
    expect(await readSetting('payload_rules')).toEqual([]);

    // 只拉不推：对配置源的请求全部是 GET，且都带服务器令牌。
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((item) => item.method === 'GET')).toBe(true);
    expect(requests.every((item) => item.authorization === 'Bearer edge-test-token')).toBe(true);
  }, 60_000);

  it('内容没变时跳过导入（避免每次全表重建）', async () => {
    const before = requests.length;
    const result = await syncEdgeConfig();
    expect(result.ok).toBe(true);
    expect(result.imported).toBe(false);
    expect(result.sections).toEqual({ accounts: false, preferences: false, forwardRules: false });
    // 仍然会去拉一次，但不再写库。
    expect(requests.length).toBeGreaterThan(before);
  }, 60_000);

  it('配置源报错时同步失败但不影响进程，错误暴露给状态接口', async () => {
    failNextRequest = true;
    try {
      const result = await syncEdgeConfig();
      expect(result.ok).toBe(false);
      expect(String(result.message)).toContain('500');
    } finally {
      failNextRequest = false;
    }
  }, 60_000);
});

