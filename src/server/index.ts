import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  buildFastifyOptions,
  config,
} from './config.js';
import { authMiddleware } from './middleware/auth.js';
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
  await repairStoredCreatedAtValues();
  await migrateSiteApiKeysToAccounts();
  await ensureDefaultSitesSeeded();
  await ensureOauthIdentityBackfill();
  await routeRefreshWorkflow.rebuildRoutesOnly();

  console.log('Loaded runtime settings overrides');
} catch (error) {
  console.warn(`Failed to load runtime settings overrides: ${(error as Error)?.message || 'unknown error'}`);
}

const app = Fastify(buildFastifyOptions(config));

await app.register(cors);

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

// Register OpenAI-compatible proxy routes
await app.register(proxyRoutes);

// Serve static web frontend in production
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../web');
if (existsSync(webDir)) {
  await app.register(fastifyStatic, {
    root: webDir,
    prefix: '/',
    wildcard: false,
    setHeaders: (res, filePath) => {
      const normalizedPath = normalize(filePath);
      if (normalizedPath.includes(`${sep}assets${sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (normalizedPath.endsWith(`${sep}index.html`)) {
        res.setHeader('Cache-Control', 'no-cache');
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
