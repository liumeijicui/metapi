import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type AnyRecord = Record<string, any>;

describe('edge 同步源配置（服务器地址 + 登录令牌）', () => {
  let dataDir = '';
  let server: Server | null = null;
  let sourceUrl = '';
  let db: AnyRecord;
  let schema: AnyRecord;
  let config: AnyRecord;
  let normalizeEdgeSourceUrl: (raw: string) => string;
  let readEdgeSyncSource: () => Promise<{ url: string; token: string }>;
  let saveEdgeSyncSource: (input: { url: string; token: string }) => Promise<{ url: string; token: string }>;
  let isEdgeOpenRoute: (method: string, url: string) => boolean;
  const requests: Array<{ method: string; url: string; authorization: string }> = [];

  /** 假的「服务器」：只提供一个鉴权探针，令牌对才回 200。 */
  async function handleRequest(request: IncomingMessage, reply: ServerResponse) {
    requests.push({
      method: String(request.method || ''),
      url: String(request.url || ''),
      authorization: String(request.headers.authorization || ''),
    });
    if (String(request.url || '').split('?')[0] !== '/api/settings/auth/info') {
      reply.statusCode = 404;
      reply.end('{}');
      return;
    }
    if (request.headers.authorization === 'Bearer good-token') {
      reply.setHeader('content-type', 'application/json');
      reply.end(JSON.stringify({ success: true }));
      return;
    }
    reply.statusCode = 403;
    reply.end(JSON.stringify({ error: 'Invalid token' }));
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-edge-sync-source-'));
    process.env.DATA_DIR = dataDir;
    process.env.METAPI_EDGE_MODE = '1';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '30086';

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const configModule = await import('../config.js');
    db = dbModule.db;
    schema = dbModule.schema;
    config = configModule.config;

    server = createServer((request, reply) => { void handleRequest(request, reply); });
    await new Promise<void>((resolve) => { server!.listen(0, '127.0.0.1', () => resolve()); });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    sourceUrl = `127.0.0.1:${port}`;

    const module = await import('./syncSource.js');
    normalizeEdgeSourceUrl = module.normalizeEdgeSourceUrl;
    readEdgeSyncSource = module.readEdgeSyncSource;
    saveEdgeSyncSource = module.saveEdgeSyncSource;
    isEdgeOpenRoute = (await import('./statusRoutes.js')).isEdgeOpenRoute;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => { server ? server.close(() => resolve()) : resolve(); });
    delete process.env.DATA_DIR;
    delete process.env.METAPI_EDGE_MODE;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('地址规整：只填 IP:端口 时补 http://，去掉结尾斜杠', () => {
    expect(normalizeEdgeSourceUrl('')).toBe('');
    expect(normalizeEdgeSourceUrl(' 43.142.48.105 ')).toBe('http://43.142.48.105');
    expect(normalizeEdgeSourceUrl('43.142.48.105:4000/')).toBe('http://43.142.48.105:4000');
    expect(normalizeEdgeSourceUrl('https://metapi.cita777.me/')).toBe('https://metapi.cita777.me');
  });

  it('登录前可访问的接口只有状态与保存同步源', () => {
    expect(isEdgeOpenRoute('GET', '/api/edge/status')).toBe(true);
    expect(isEdgeOpenRoute('PUT', '/api/edge/sync-source')).toBe(true);
    // 同步按钮要走本地令牌，不能免鉴权。
    expect(isEdgeOpenRoute('POST', '/api/edge/sync')).toBe(false);
    expect(isEdgeOpenRoute('GET', '/api/model-forward-rules')).toBe(false);
  });

  it('保存同步源会把地址写进连接文件、令牌只进内存，并热加载成本机管理员令牌', async () => {
    const saved = await saveEdgeSyncSource({ url: sourceUrl, token: 'good-token' });
    expect(saved).toEqual({ url: `http://${sourceUrl}`, token: 'good-token' });

    // 地址落在数据目录的连接文件里（登录页要回填）；令牌只在内存库里，进程重启要重新登录。
    const connectionFile = join(dataDir, 'edge-connection.json');
    expect(existsSync(connectionFile)).toBe(true);
    expect(JSON.parse(readFileSync(connectionFile, 'utf8')).url).toBe(`http://${sourceUrl}`);

    const rows = await db.select().from(schema.settings).all();
    const stored = new Map(rows.map((row: AnyRecord) => [row.key, row.value]));
    expect(JSON.parse(String(stored.get('auth_token')))).toBe('good-token');
    expect(stored.has('edge_sync_source_url')).toBe(false);
    // 热加载之后本地 /api/* 就认这个令牌。
    expect(config.authToken).toBe('good-token');

    // 读回来的也是同一份，且地址已规整。
    expect(await readEdgeSyncSource()).toEqual({ url: `http://${sourceUrl}`, token: 'good-token' });
  });

  it('保存接口先用 GET 探针验令牌，验不过直接拒绝且不落库', async () => {
    const app = Fastify();
    await app.register((await import('./statusRoutes.js')).edgeStatusRoutes);

    try {
      const before = requests.length;
      const rejected = await app.inject({
        method: 'PUT',
        url: '/api/edge/sync-source',
        payload: { url: sourceUrl, token: 'wrong-token' },
      });
      expect(rejected.statusCode).toBe(400);
      expect(JSON.parse(rejected.body).message).toContain('令牌不正确');

      // 探针只发 GET，不会往服务器写任何东西。
      const probeRequests = requests.slice(before);
      expect(probeRequests.length).toBe(1);
      expect(probeRequests.every((item) => item.method === 'GET')).toBe(true);
      expect(probeRequests[0].url).toBe('/api/settings/auth/info');

      const accepted = await app.inject({
        method: 'PUT',
        url: '/api/edge/sync-source',
        payload: { url: `${sourceUrl}/`, token: 'good-token' },
      });
      expect(accepted.statusCode).toBe(200);
      expect(JSON.parse(accepted.body)).toEqual({
        ok: true,
        url: `http://${sourceUrl}`,
        hasToken: true,
      });

      const missingToken = await app.inject({
        method: 'PUT',
        url: '/api/edge/sync-source',
        payload: { url: sourceUrl },
      });
      expect(missingToken.statusCode).toBe(400);
      expect(JSON.parse(missingToken.body).message).toContain('管理员令牌');
    } finally {
      await app.close();
    }
  }, 30_000);
});
