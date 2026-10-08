import type { FastifyInstance } from 'fastify';
import { getEdgeConfigSyncState, syncEdgeConfig } from './configSync.js';
import { getEdgeEnv } from './edgeEnv.js';

/**
 * 边缘实例自己的管理接口。
 * 只回运行状态，绝不回传任何令牌、密钥或账号凭据。
 */
export async function edgeStatusRoutes(app: FastifyInstance) {
  app.get('/api/edge/status', async () => {
    const edge = getEdgeEnv();
    return {
      success: true,
      edgeMode: true,
      // 恒为空数组：边缘实例不启动任何调度器，这是「没有后台任务在跑」的显式证据。
      startedSchedulers: [],
      onlyForwarding: true,
      dataDir: edge.dataDirAbsolute,
      port: Number(process.env.PORT || 0),
      // 不回传令牌明文，只说有没有配。
      configSource: { url: edge.configSourceUrl, hasToken: !!edge.configSourceToken },
      ...getEdgeConfigSyncState(),
    };
  });

  // 「同步」按钮：立刻从服务器拉一次配置。只拉不推，不会往服务器写任何东西。
  app.post('/api/edge/sync', async () => await syncEdgeConfig());
}
