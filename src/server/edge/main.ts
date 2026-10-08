import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ensureEdgeDataDir, getEdgeEnv, type EdgeEnv } from './edgeEnv.js';

/**
 * 本地边缘转发实例的入口：只做 /v1 转发 + 使用日志 + 一个只读状态接口。
 * 这里刻意不 import src/server/index.ts 里的任何 start* 调度器，
 * 所以本进程不会有签到、重登、采集、备份等后台任务；边界由
 * edgeBoundary.architecture.test.ts 静态锁死。
 *
 * 闸门必须早于所有会打开数据库的模块：src/server/db/index.ts 在模块求值阶段
 * 就按 DATA_DIR 建出 hub.db，所以除 fastify/cors 和 edgeEnv.ts 之外的依赖一律用
 * 动态 import 放在闸门之后加载；否则目录永远不是空的，闸门也就拦不住误指主服务数据目录。
 */
let edge: EdgeEnv;
try {
  // 闸门：环境不满足就直接退出，避免把本地实例连到主服务的库或暴露到局域网。
  edge = getEdgeEnv();
  ensureEdgeDataDir(edge.dataDirAbsolute);
} catch (error) {
  console.error(`[edge] 启动被拒绝：${(error as Error)?.message || String(error)}`);
  process.exit(1);
}

const { buildFastifyOptions, config } = await import('../config.js');
const {
  ensureProxyFileCompatibilityColumns,
  ensureProxyLogBillingDetailsColumn,
  ensureProxyLogClientColumns,
  ensureProxyLogDownstreamApiKeyIdColumn,
  ensureProxyLogStreamTimingColumns,
  ensureRouteGroupingCompatibilityColumns,
  ensureSiteCompatibilityColumns,
  runtimeDbDialect,
} = await import('../db/index.js');
const { isPublicApiRoute } = await import('../desktop.js');
const { authMiddleware } = await import('../middleware/auth.js');
const { proxyRoutes } = await import('../routes/proxy/router.js');
const { ensureRuntimeDatabaseReady } = await import('../runtimeDatabaseBootstrap.js');
const { startEdgeConfigSync, stopEdgeConfigSync, syncEdgeConfig } = await import('./configSync.js');
const { rehydrateLocalRuntimeSettings } = await import('./localSettingsPolicy.js');
const { edgeStatusRoutes, isEdgeOpenRoute } = await import('./statusRoutes.js');
const { readEdgeSyncSource } = await import('./syncSource.js');
const { registerEdgeWebAssets } = await import('./webAssets.js');

// 1) 本地库结构（边缘实例自己的 DATA_DIR，绝不指向主服务的数据目录）。
await ensureRuntimeDatabaseReady({
  dialect: runtimeDbDialect,
  connectionString: config.dbUrl,
  ssl: config.dbSsl,
});

// 2) 兼容列补齐：与主服务启动顺序一致（src/server/index.ts:189-204），写代理日志会用到。
await ensureSiteCompatibilityColumns();
await ensureRouteGroupingCompatibilityColumns();
await ensureProxyFileCompatibilityColumns();
await ensureProxyLogStreamTimingColumns();
await ensureProxyLogClientColumns();
await ensureProxyLogDownstreamApiKeyIdColumn();
await ensureProxyLogBillingDetailsColumn();

// 3) 设置项热加载：纯赋值，不碰任何调度器。
await rehydrateLocalRuntimeSettings();

// 4) 首次拉取配置：失败不退出，保留本地旧配置继续服务，错误暴露在 /api/edge/status。
await syncEdgeConfig();

// 5) 最小 HTTP 面：/api/edge/* 管理接口 + /v1 转发。
const app = Fastify(buildFastifyOptions(config));
await app.register(cors);
app.addHook('onRequest', async (request, reply) => {
  // /v1 的鉴权由 proxyRoutes 自己挂（下游 sk- 密钥），这里只保护管理接口。
  if (!request.url.startsWith('/api/')) return;
  if (isPublicApiRoute(request.url)) return;
  // 登录页要先读状态、再拿服务器令牌换本地登录，这两个接口必须免本地鉴权。
  if (isEdgeOpenRoute(request.method, request.url)) return;
  await authMiddleware(request, reply);
});
await app.register(edgeStatusRoutes);
await app.register(proxyRoutes);

// 6) 前端静态资源：exe 的登录页与「模型转发 / 使用日志」两个页面。
await registerEdgeWebAssets(app);

app.addHook('onClose', async () => {
  stopEdgeConfigSync();
});

await app.listen({ port: config.port, host: config.listenHost });
startEdgeConfigSync();

console.log(`[edge] 数据目录：${edge.dataDirAbsolute}`);
const source = await readEdgeSyncSource();
console.log(`[edge] 配置源：${source.url || '（未配置，请在登录页填写服务器地址与令牌）'}`);
console.log('[edge] 已启动的调度器：无（本进程只做转发和使用日志）');
