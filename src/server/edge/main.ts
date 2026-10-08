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
 * DB_URL 也必须在 import ../db/index.js 之前定下来：它在模块求值阶段就打开数据库。
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

// 工作库一律用内存库：从服务器同步下来的配置只在内存里，进程退出就没了（不落本地磁盘）。
// 使用日志是本地产生的数据，由 logArchive 另外归档到数据目录下的 SQLite 文件。
process.env.DB_URL = ':memory:';

const { buildFastifyOptions, config } = await import('../config.js');
const {
  ensureProxyFileCompatibilityColumns,
  ensureProxyLogBillingDetailsColumn,
  ensureProxyLogClientColumns,
  ensureProxyLogDownstreamApiKeyIdColumn,
  ensureProxyLogStreamTimingColumns,
  ensureRouteGroupingCompatibilityColumns,
  ensureSiteCompatibilityColumns,
  getSqliteConnection,
} = await import('../db/index.js');
const { runSqliteMigrationsOn } = await import('../db/migrate.js');
const { isPublicApiRoute } = await import('../desktop.js');
const { authMiddleware } = await import('../middleware/auth.js');
const { proxyRoutes } = await import('../routes/proxy/router.js');
const { startEdgeConfigSync, stopEdgeConfigSync } = await import('./configSync.js');
const { rehydrateLocalRuntimeSettings } = await import('./localSettingsPolicy.js');
const { setupEdgeLogArchive, stopEdgeLogArchive } = await import('./logArchive.js');
const { edgeLocalApiRoutes } = await import('./localApiRoutes.js');
const { edgeStatusRoutes, isEdgeOpenRoute } = await import('./statusRoutes.js');
const { readEdgeSyncSource } = await import('./syncSource.js');
const { registerEdgeWebAssets } = await import('./webAssets.js');

// 1) 内存库结构：内存库只存在于创建它的那条连接上，迁移必须落在同一条连接里，
//    所以这里不能走 ensureRuntimeDatabaseReady（它会在另一条连接上建表，建完就没了）。
const sqliteConnection = getSqliteConnection();
if (!sqliteConnection) {
  console.error('[edge] 启动失败：边缘实例必须使用 SQLite 内存库（DB_URL=:memory:）。');
  process.exit(1);
}
runSqliteMigrationsOn(sqliteConnection);

// 2) 兼容列补齐：与主服务启动顺序一致（src/server/index.ts:189-204），写代理日志会用到。
await ensureSiteCompatibilityColumns();
await ensureRouteGroupingCompatibilityColumns();
await ensureProxyFileCompatibilityColumns();
await ensureProxyLogStreamTimingColumns();
await ensureProxyLogClientColumns();
await ensureProxyLogDownstreamApiKeyIdColumn();
await ensureProxyLogBillingDetailsColumn();

// 3) 使用日志归档：日志镜像到数据目录下的 SQLite 文件，并把上次的日志读回内存。
setupEdgeLogArchive({ dataDirAbsolute: edge.dataDirAbsolute });

// 4) 设置项热加载：纯赋值，不碰任何调度器。
await rehydrateLocalRuntimeSettings();

// 5) 不在这里拉配置：内存库是空的，配置要等登录后（登录页写入服务器地址与令牌）再拉，
//    之后由定时器与「同步」按钮继续拉。

// 6) 最小 HTTP 面：/api/edge/* 管理接口 + /v1 转发。
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
// 两个页面要用的只读接口（使用日志 + 模型转发），主服务那份在 routes/api 里，这里只注册只读部分。
await app.register(edgeLocalApiRoutes);
await app.register(proxyRoutes);

// 7) 前端静态资源：exe 的登录页与「模型转发 / 使用日志」两个页面。
await registerEdgeWebAssets(app);

app.addHook('onClose', async () => {
  stopEdgeConfigSync();
  stopEdgeLogArchive();
});

await app.listen({ port: config.port, host: config.listenHost });
startEdgeConfigSync();

console.log(`[edge] 数据目录：${edge.dataDirAbsolute}`);
const source = await readEdgeSyncSource();
console.log(`[edge] 配置源：${source.url || '（未配置，请在登录页填写服务器地址与令牌）'}`);
console.log('[edge] 配置只驻内存：登录后从服务器拉取，本机不保存同步下来的配置。');
