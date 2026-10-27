import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  buildFastifyOptions,
  config,
} from './config.js';
import { authMiddleware, getClientIp } from './middleware/auth.js';
import { sitesRoutes } from './routes/api/sites.js';
import { accountsRoutes } from './routes/api/accounts.js';
import { checkinRoutes } from './routes/api/checkin.js';
import { tokensRoutes } from './routes/api/tokens.js';
import { statsRoutes } from './routes/api/stats.js';
import { authRoutes } from './routes/api/auth.js';
import { settingsRoutes } from './routes/api/settings.js';
import { accountTokensRoutes } from './routes/api/accountTokens.js';
import { searchRoutes } from './routes/api/search.js';
import { eventsRoutes } from './routes/api/events.js';
import { taskRoutes } from './routes/api/tasks.js';
import { testRoutes } from './routes/api/test.js';
import { modelMonitorRoutes } from './routes/api/modelMonitor.js';
import { edgeSyncRoutes } from './routes/api/edgeSync.js';
import { modelForwardRoutes } from './routes/api/modelForward.js';
import { assistedLoginRoutes } from './routes/api/assistedLogin.js';
import {
  startAssistedLoginWatchSchedulers,
  stopAssistedLoginWatchSchedulers,
} from './services/assistedLogin/watchers.js';
import { downstreamApiKeysRoutes } from './routes/api/downstreamApiKeys.js';
import { oauthRoutes } from './routes/api/oauth.js';
import { securityRoutes } from './routes/api/security.js';
import { siteAnnouncementsRoutes } from './routes/api/siteAnnouncements.js';
import { promptLibraryRoutes } from './routes/api/promptLibrary.js';
import { updateCenterRoutes } from './routes/api/updateCenter.js';
import { proxyRoutes } from './routes/proxy/router.js';
import { startScheduler } from './services/checkinScheduler.js';
import { reapStrandedManagedBrowsersAndWait } from './services/managedBrowserReaper.js';
import * as routeRefreshWorkflow from './services/routeRefreshWorkflow.js';
import { startProxyFileRetentionService, stopProxyFileRetentionService } from './services/proxyFileRetentionService.js';
import { setLegacyProxyLogRetentionFallbackEnabled, stopProxyLogRetentionService } from './services/proxyLogRetentionService.js';
import { buildStartupSummaryLines } from './services/startupInfo.js';
import { repairStoredCreatedAtValues } from './services/storedTimestampRepairService.js';
import { migrateSiteApiKeysToAccounts } from './services/siteApiKeyMigrationService.js';
import { ensureDefaultSitesSeeded } from './services/defaultSiteSeedService.js';
import { ensureOauthIdentityBackfill } from './services/oauth/oauthIdentityBackfill.js';
import { startOAuthLoopbackCallbackServers, stopOAuthLoopbackCallbackServers } from './services/oauth/localCallbackServer.js';
import { startSiteAnnouncementPolling, stopSiteAnnouncementPolling } from './services/siteAnnouncementPollingService.js';
import { ensureBuiltinPromptPresets } from './services/promptLibraryService.js';
import { isIpBlocked } from './services/ipBlocklistService.js';
import { getSecuritySeedSource } from './services/securitySeedService.js';
import {
  startModelAvailabilityProbeScheduler,
  stopModelAvailabilityProbeScheduler,
} from './services/modelAvailabilityProbeService.js';
import {
  startModelMonitorScheduler,
  stopModelMonitorScheduler,
} from './services/modelMonitorService.js';
import {
  startXApiKeyScheduler,
  stopXApiKeyScheduler,
} from './services/xapiKeyService.js';
import {
  startChannelRecoveryProbeScheduler,
  stopChannelRecoveryProbeScheduler,
} from './services/channelRecoveryProbeService.js';
import {
  startSub2ApiManagedRefreshScheduler,
  stopSub2ApiManagedRefreshScheduler,
} from './services/sub2apiRefreshScheduler.js';
import { startUpdateCenterPolling, stopUpdateCenterPolling } from './services/updateCenterPollingService.js';
import {
  startAdminSnapshotWarmScheduler,
  stopAdminSnapshotWarmScheduler,
} from './services/adminSnapshotWarmService.js';
import {
  startUsageAggregationProjectorScheduler,
  stopUsageAggregationProjectorScheduler,
} from './services/usageAggregationService.js';
import { reloadBackupWebdavScheduler } from './services/backupService.js';
import { ensureRuntimeDatabaseReady } from './runtimeDatabaseBootstrap.js';
import { isPublicApiRoute, registerDesktopRoutes } from './desktop.js';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, normalize, resolve, sep } from 'path';
import {
  applyRuntimeSettings,
  parseSettingFromMap,
} from './runtimeSettingsHydration.js';
import { normalizeLogCleanupRetentionDays } from './shared/logCleanupRetentionDays.js';
import {
  db,
  ensureProxyFileCompatibilityColumns,
  ensureProxyLogClientColumns,
  ensureProxyLogDownstreamApiKeyIdColumn,
  ensureProxyLogBillingDetailsColumn,
  ensureProxyLogStreamTimingColumns,
  ensureProxyLogReasoningEffortColumn,
  ensureRouteGroupingCompatibilityColumns,
  ensureSiteCompatibilityColumns,
  runtimeDbDialect,
  schema,
  switchRuntimeDatabase,
  type RuntimeDbDialect,
} from './db/index.js';

function toSettingsMap(rows: Array<{ key: string; value: string }>) {
  return new Map(rows.map((row) => [row.key, row.value]));
}

function normalizeSavedDbType(value: unknown): RuntimeDbDialect | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'sqlite') return 'sqlite';
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  return null;
}

function validateSavedDbUrl(dialect: RuntimeDbDialect, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (dialect === 'sqlite') return normalized;
  if (dialect === 'mysql' && normalized.startsWith('mysql://')) return normalized;
  if (dialect === 'postgres' && (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://'))) return normalized;
  return null;
}

function extractSavedRuntimeDatabaseConfig(settingsMap: Map<string, string>): { dialect: RuntimeDbDialect; dbUrl: string; ssl: boolean } | null {
  const rawType = parseSettingFromMap<unknown>(settingsMap, 'db_type');
  const rawUrl = parseSettingFromMap<unknown>(settingsMap, 'db_url');
  const rawSsl = parseSettingFromMap<boolean>(settingsMap, 'db_ssl');
  const dialect = normalizeSavedDbType(rawType);
  if (!dialect) return null;
  const dbUrl = validateSavedDbUrl(dialect, rawUrl);
  if (!dbUrl) return null;
  return {
    dialect,
    dbUrl,
    ssl: typeof rawSsl === 'boolean' ? rawSsl : false,
  };
}

const LOG_CLEANUP_SETTING_KEYS = [
  'log_cleanup_cron',
  'log_cleanup_usage_logs_enabled',
  'log_cleanup_program_logs_enabled',
  'log_cleanup_retention_days',
] as const;

function hasExplicitLogCleanupSettings(settingsMap: Map<string, string>): boolean {
  return LOG_CLEANUP_SETTING_KEYS.some((key) => settingsMap.has(key));
}

// Ensure the current runtime database is bootstrapped before reading settings.
await ensureRuntimeDatabaseReady({
  dialect: runtimeDbDialect,
  connectionString: config.dbUrl,
  ssl: config.dbSsl,
});

// Load runtime config overrides from settings
try {
  const initialRows = await db.select().from(schema.settings).all();
  const initialMap = toSettingsMap(initialRows);
  const savedDbConfig = extractSavedRuntimeDatabaseConfig(initialMap);
  const activeDbUrl = (config.dbUrl || '').trim();
  const originalRuntimeConfig = {
    dialect: runtimeDbDialect,
    dbUrl: activeDbUrl,
    ssl: config.dbSsl,
  };
  if (savedDbConfig && (savedDbConfig.dialect !== runtimeDbDialect || savedDbConfig.dbUrl !== activeDbUrl || savedDbConfig.ssl !== config.dbSsl)) {
    try {
      await switchRuntimeDatabase(savedDbConfig.dialect, savedDbConfig.dbUrl, savedDbConfig.ssl);
      console.log(`Loaded runtime DB config from settings: ${savedDbConfig.dialect}`);
    } catch (error) {
      const currentDbUrl = (config.dbUrl || '').trim();
      const switchedAway = runtimeDbDialect !== originalRuntimeConfig.dialect
        || currentDbUrl !== originalRuntimeConfig.dbUrl
        || config.dbSsl !== originalRuntimeConfig.ssl;
      if (switchedAway) {
        await switchRuntimeDatabase(
          originalRuntimeConfig.dialect,
          originalRuntimeConfig.dbUrl,
          originalRuntimeConfig.ssl,
        );
      }
      console.warn(`Failed to switch runtime DB from settings: ${(error as Error)?.message || 'unknown error'}`);
    }
  }

  await ensureSiteCompatibilityColumns();
  await ensureRouteGroupingCompatibilityColumns();
  await ensureProxyFileCompatibilityColumns();
  await ensureProxyLogStreamTimingColumns();
  await ensureProxyLogClientColumns();
  await ensureProxyLogDownstreamApiKeyIdColumn();
  const finalRows = await db.select().from(schema.settings).all();
  const finalMap = toSettingsMap(finalRows);
  applyRuntimeSettings(finalMap);
  config.logCleanupConfigured = hasExplicitLogCleanupSettings(finalMap);
  if (!config.logCleanupConfigured && config.proxyLogRetentionDays > 0) {
    config.logCleanupUsageLogsEnabled = true;
    config.logCleanupProgramLogsEnabled = false;
    config.logCleanupRetentionDays = normalizeLogCleanupRetentionDays(config.proxyLogRetentionDays);
  }
  await ensureProxyLogBillingDetailsColumn();
  await ensureProxyLogReasoningEffortColumn();
  await repairStoredCreatedAtValues();
  await migrateSiteApiKeysToAccounts();
  await ensureDefaultSitesSeeded();
  await ensureOauthIdentityBackfill();
  await routeRefreshWorkflow.rebuildRoutesOnly();

  console.log('Loaded runtime settings overrides');
} catch (error) {
  console.warn(`Failed to load runtime settings overrides: ${(error as Error)?.message || 'unknown error'}`);
}

try {
  if (getSecuritySeedSource() === 'local') {
    console.warn('[security] ACCOUNT_CREDENTIAL_SECRET 未配置或强度不足，已使用本机随机种子 data/.metapi-security-seed；请把它和数据库一起备份，丢失后已加密的账号凭证无法恢复。');
  }
} catch (error) {
  console.warn(`[security] Failed to initialize local security seed: ${(error as Error)?.message || 'unknown error'}`);
}

const app = Fastify(buildFastifyOptions(config));

await app.register(cors, {
  // Same-origin is the normal deployment. Cross-origin browser callers must be
  // listed explicitly; the previous wildcard let any web page probe this admin
  // API with a stolen token.
  origin: config.corsAllowedOrigins.length > 0 ? config.corsAllowedOrigins : false,
  credentials: false,
});

app.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
  if (request.protocol === 'https') {
    reply.header('Strict-Transport-Security', 'max-age=31536000');
  }
  if (request.url.startsWith('/api/')) {
    // Admin responses can contain balances, keys, cookies and session
    // material. Never let a shared proxy or browser cache retain them.
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
  }
  return payload;
});

// 全局 IP 黑名单：页面、管理 API、/v1 代理一律拦截。环回地址在服务层永久豁免，
// 避免误封本机后连 SSH 隧道都进不来。
app.addHook('onRequest', async (request, reply) => {
  if (await isIpBlocked(getClientIp(request))) {
    reply
      .code(403)
      .header('Cache-Control', 'no-store')
      .send({ success: false, error: 'IP blocked', message: '当前 IP 已被禁止访问' });
    return;
  }
});

// Auth middleware for /api routes
app.addHook('onRequest', async (request, reply) => {
  if (request.url.startsWith('/api/') && !isPublicApiRoute(request.url)) {
    await authMiddleware(request, reply);
  }
});

// Register API routes
await app.register(registerDesktopRoutes);
await app.register(sitesRoutes);
await app.register(accountsRoutes);
await app.register(checkinRoutes);
await app.register(tokensRoutes);
await app.register(statsRoutes);
await app.register(authRoutes);
await app.register(settingsRoutes);
await app.register(accountTokensRoutes);
await app.register(searchRoutes);
await app.register(eventsRoutes);
await app.register(siteAnnouncementsRoutes);
await app.register(promptLibraryRoutes);
await app.register(updateCenterRoutes);
await app.register(taskRoutes);
await app.register(testRoutes);
await app.register(modelMonitorRoutes);
await app.register(modelForwardRoutes);
await app.register(edgeSyncRoutes);
await app.register(assistedLoginRoutes);
await app.register(downstreamApiKeysRoutes);
await app.register(oauthRoutes);
await app.register(securityRoutes);

// Register OpenAI-compatible proxy routes
await app.register(proxyRoutes);

// Serve static web frontend in production
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
if (existsSync(webDir)) {
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    // 必须用通配路由，而不是启动时枚举文件：
    // 前端每次构建都会换 hash 文件名，如果静态插件在启动时就把文件清单固定住，
    // 新构建的资源要等下一次重启服务才认得，期间 `/assets/*.js` 会落到 SPA
    // 回退里返回 index.html，浏览器按严格 MIME 检查直接拒绝执行 → 整页空白。
    wildcard: true,
    setHeaders: (res, filePath) => {
      const normalizedPath = normalize(filePath);
      if (normalizedPath.includes(`${sep}assets${sep}`)) {
        res.header('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (normalizedPath.endsWith(`${sep}index.html`)) {
        res.header('Cache-Control', 'no-cache');
      }
    },
  });
  // SPA fallback
  app.setNotFoundHandler(async (request, reply) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/v1/')) {
      return reply.sendFile('index.html');
    }
    reply.code(404).send({ error: 'Not found' });
  });
}

// Start scheduler
await startScheduler();
await reloadBackupWebdavScheduler();
try {
  // 内置题库（鹈鹕测试 / 糖果测试 / 时钟 / 六边形弹跳球…）幂等补齐，
  // 换库或新装后不用手动去提示词管理里点导入。
  const { imported, translated } = await ensureBuiltinPromptPresets();
  if (imported.length) {
    console.log(`[PromptLibrary] imported builtin presets: ${imported.join(', ')}`);
  }
  if (translated > 0) {
    console.log(`[PromptLibrary] translated ${translated} legacy builtin prompt(s) to Chinese`);
  }
} catch (error) {
  console.warn(`Failed to ensure builtin prompt presets: ${(error as Error)?.message || 'unknown error'}`);
}
startSiteAnnouncementPolling();
startModelAvailabilityProbeScheduler();
startModelMonitorScheduler();
startXApiKeyScheduler();
startChannelRecoveryProbeScheduler();
startSub2ApiManagedRefreshScheduler();
startAssistedLoginWatchSchedulers();
startUpdateCenterPolling();
startUsageAggregationProjectorScheduler();
startAdminSnapshotWarmScheduler();
try {
  await startOAuthLoopbackCallbackServers();
} catch (error) {
  console.warn(`Failed to start OAuth callback listeners: ${(error as Error)?.message || 'unknown error'}`);
}
setLegacyProxyLogRetentionFallbackEnabled(!config.logCleanupConfigured);
startProxyFileRetentionService();
app.addHook('onClose', async () => {
  stopSiteAnnouncementPolling();
  stopUpdateCenterPolling();
  stopProxyFileRetentionService();
  stopProxyLogRetentionService();
  stopModelAvailabilityProbeScheduler();
  stopModelMonitorScheduler();
  stopXApiKeyScheduler();
  stopChannelRecoveryProbeScheduler();
  await stopUsageAggregationProjectorScheduler();
  await stopAdminSnapshotWarmScheduler();
  await stopSub2ApiManagedRefreshScheduler();
  stopAssistedLoginWatchSchedulers();
  await stopOAuthLoopbackCallbackServers();
});

// Start server
try {
  // A managed Chromium that outlived the process which launched it holds its
  // profile lock and a few hundred megabytes, and nothing here would notice it
  // until some flow happened to want the browser again. Sweep before serving.
  const strandedBrowsers = await reapStrandedManagedBrowsersAndWait();
  if (strandedBrowsers > 0) {
    console.log(`[Startup] Reaped ${strandedBrowsers} stranded managed browser process(es)`);
  }

  await app.listen({ port: config.port, host: config.listenHost });
  const summaryLines = buildStartupSummaryLines({
    port: config.port,
    host: config.listenHost,
    authToken: config.authToken,
    proxyToken: config.proxyToken,
  });
  for (const line of summaryLines) {
    console.log(line);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
