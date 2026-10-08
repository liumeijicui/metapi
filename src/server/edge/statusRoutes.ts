import type { FastifyInstance } from 'fastify';
import { getEdgeConfigSyncState, syncEdgeConfig } from './configSync.js';
import { getEdgeEnv } from './edgeEnv.js';
import { normalizeEdgeSourceUrl, readEdgeSyncSource, saveEdgeSyncSource } from './syncSource.js';

/** 登录页在登录前就要读写的接口，不能要求本地令牌。 */
const EDGE_OPEN_ROUTES: Array<{ method: string; path: string }> = [
  // 登录页要显示当前配的服务器地址。
  { method: 'GET', path: '/api/edge/status' },
  // 登录本身就是拿服务器令牌去配置源验一次，验过了才写入本地。
  { method: 'PUT', path: '/api/edge/sync-source' },
];

/** 判断请求是否属于「登录前必须能访问」的边缘接口。 */
export function isEdgeOpenRoute(method: string, url: string): boolean {
  const path = url.split('?')[0];
  return EDGE_OPEN_ROUTES.some((route) => (
    route.method === method.toUpperCase() && route.path === path
  ));
}

/**
 * 登录 / 改地址时到配置源验一次令牌。
 * 这里只发一个 GET（拿服务器自己的鉴权接口当探针），不会向服务器写任何东西。
 * 返回空字符串表示通过，否则返回给用户看的错误提示。
 */
async function verifySyncSource(url: string, token: string): Promise<string> {
  try {
    const response = await fetch(`${url}/api/settings/auth/info`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) return '';
    if (response.status === 401 || response.status === 403) {
      return '令牌不正确：请填写服务器上设置的管理员令牌。';
    }
    return `服务器返回 HTTP ${response.status}，请检查服务器地址与端口。`;
  } catch {
    return '无法连接到服务器，请检查地址、端口和网络。';
  }
}

/**
 * 边缘实例自己的管理接口。
 * 只回运行状态，绝不回传任何令牌、密钥或账号凭据。
 */
export async function edgeStatusRoutes(app: FastifyInstance) {
  // 桌面壳靠这个接口判断本地服务是否就绪（路径与主服务一致，已在 isPublicApiRoute 白名单里）。
  app.get('/api/desktop/health', async () => ({ ok: true, edgeMode: true }));

  app.get('/api/edge/status', async () => {
    const edge = getEdgeEnv();
    const source = await readEdgeSyncSource();
    return {
      success: true,
      edgeMode: true,
      // 恒为空数组：边缘实例不启动任何调度器，这是「没有后台任务在跑」的显式证据。
      startedSchedulers: [],
      onlyForwarding: true,
      dataDir: edge.dataDirAbsolute,
      port: Number(process.env.PORT || 0),
      // 不回传令牌明文，只说有没有配。
      configSource: { url: source.url, hasToken: !!source.token },
      ...getEdgeConfigSyncState(),
    };
  });

  // 登录页 /「同步设置」保存服务器地址与令牌：先到服务器验令牌，验过了才写入本机
  // （地址写连接文件，令牌只进内存）。
  app.put('/api/edge/sync-source', async (request, reply) => {
    const body = (request.body || {}) as { url?: unknown; token?: unknown };
    const url = normalizeEdgeSourceUrl(typeof body.url === 'string' ? body.url : '');
    const token = typeof body.token === 'string' ? body.token.trim() : '';

    if (!url) return reply.code(400).send({ ok: false, message: '请填写服务器地址。' });
    if (!token) return reply.code(400).send({ ok: false, message: '请填写管理员令牌。' });

    const failure = await verifySyncSource(url, token);
    if (failure) return reply.code(400).send({ ok: false, message: failure });

    const saved = await saveEdgeSyncSource({ url, token });
    return { ok: true, url: saved.url, hasToken: true };
  });

  // 「同步」按钮：立刻从服务器拉一次配置。只拉不推，不会往服务器写任何东西。
  app.post('/api/edge/sync', async () => await syncEdgeConfig());
}
