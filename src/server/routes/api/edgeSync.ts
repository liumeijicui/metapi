import type { FastifyInstance } from 'fastify';
import { exportModelForwardSnapshot } from '../../services/modelForwardService.js';

/**
 * 边缘实例（本地 exe / Edge Relay）专用的只读接口。
 *
 * 只做导出、不做任何写入：本地实例把服务器配置镜像到自己的库里，
 * 配置改动一律在服务器上完成，避免双向同步互相覆盖。
 * 鉴权由 index.ts 里 /api/* 的全局钩子（authMiddleware）负责，这里不重复处理。
 */
export async function edgeSyncRoutes(app: FastifyInstance) {
  // 模型转发规则快照：补齐 backup export 里缺少的
  // model_forward_rules / model_forward_targets 两张表的数据。
  app.get('/api/edge/model-forward-rules', async () => {
    return { success: true, ...(await exportModelForwardSnapshot()) };
  });
}
