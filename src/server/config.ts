import 'dotenv/config';
import type { FastifyServerOptions } from 'fastify';
import { normalizePayloadRulesConfig } from './services/payloadRules.js';

const DEFAULT_REQUEST_BODY_LIMIT = 20 * 1024 * 1024;
const DEFAULT_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const DEFAULT_CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const DEFAULT_GEMINI_CLI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const DEFAULT_GEMINI_CLI_CLIENT_SECRET = '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';
export const TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING = 30 * 24 * 60 * 60;

function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function parseCsvList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseOptionalSecret(value: string | undefined): string {
  return (value || '').trim();
}

function parseJsonValue(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseDbType(value: string | undefined): 'sqlite' | 'mysql' | 'postgres' {
  const normalized = (value || 'sqlite').trim().toLowerCase();
  if (normalized === 'mysql') return 'mysql';
  if (normalized === 'postgres' || normalized === 'postgresql') return 'postgres';
  return 'sqlite';
}

export function normalizeTokenRouterFailureCooldownMaxSec(value: unknown): number | null {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return Math.min(
    TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
    Math.max(1, Math.trunc(normalized)),
  );
}

function parseListenHost(env: NodeJS.ProcessEnv): string {
  return (env.HOST || '0.0.0.0').trim() || '0.0.0.0';
}

export function buildConfig(env: NodeJS.ProcessEnv) {
  const dataDir = env.DATA_DIR || './data';

  return {
    authToken: env.AUTH_TOKEN || 'change-me-admin-token',
    proxyToken: env.PROXY_TOKEN || 'change-me-proxy-sk-token',
    deployHelperToken: parseOptionalSecret(env.DEPLOY_HELPER_TOKEN || env.UPDATE_CENTER_HELPER_TOKEN),
    codexClientId: parseOptionalSecret(env.CODEX_CLIENT_ID) || DEFAULT_CODEX_CLIENT_ID,
    claudeClientId: parseOptionalSecret(env.CLAUDE_CLIENT_ID) || DEFAULT_CLAUDE_CLIENT_ID,
    claudeClientSecret: parseOptionalSecret(env.CLAUDE_CLIENT_SECRET),
    geminiCliClientId: parseOptionalSecret(env.GEMINI_CLI_CLIENT_ID) || DEFAULT_GEMINI_CLI_CLIENT_ID,
    geminiCliClientSecret: parseOptionalSecret(env.GEMINI_CLI_CLIENT_SECRET) || DEFAULT_GEMINI_CLI_CLIENT_SECRET,
    systemProxyUrl: env.SYSTEM_PROXY_URL || '',
    accountCredentialSecret: env.ACCOUNT_CREDENTIAL_SECRET || env.AUTH_TOKEN || 'change-me-admin-token',
    checkinCron: env.CHECKIN_CRON || '0 8 * * *',
    checkinScheduleMode: (env.CHECKIN_SCHEDULE_MODE || 'cron').trim().toLowerCase() === 'interval'
      ? 'interval' as const
      : 'cron' as const,
    checkinIntervalHours: Math.min(24, Math.max(1, Math.trunc(parseNumber(env.CHECKIN_INTERVAL_HOURS, 6)))),
    balanceRefreshCron: env.BALANCE_REFRESH_CRON || '0 * * * *',
    logCleanupCron: env.LOG_CLEANUP_CRON || '0 6 * * *',
    logCleanupConfigured: false,
    logCleanupUsageLogsEnabled: parseBoolean(env.LOG_CLEANUP_USAGE_LOGS_ENABLED, false),
    logCleanupProgramLogsEnabled: parseBoolean(env.LOG_CLEANUP_PROGRAM_LOGS_ENABLED, false),
    logCleanupRetentionDays: Math.max(1, Math.trunc(parseNumber(env.LOG_CLEANUP_RETENTION_DAYS, 30))),
    // 站点公告只同步/保留最近这么多天：上游会把很久以前的公告一起返回，
    // 全量入库既没意义又让公告页越来越长。
    siteAnnouncementRetentionDays: Math.max(1, Math.trunc(parseNumber(env.SITE_ANNOUNCEMENT_RETENTION_DAYS, 2))),
    webhookUrl: env.WEBHOOK_URL || '',
    barkUrl: env.BARK_URL || '',
    webhookEnabled: parseBoolean(env.WEBHOOK_ENABLED, true),
    barkEnabled: parseBoolean(env.BARK_ENABLED, true),
    serverChanEnabled: parseBoolean(env.SERVERCHAN_ENABLED, true),
    serverChanKey: env.SERVERCHAN_KEY || '',
    telegramEnabled: parseBoolean(env.TELEGRAM_ENABLED, false),
    telegramApiBaseUrl:
      (env.TELEGRAM_API_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://api.telegram.org',
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: env.TELEGRAM_CHAT_ID || '',
    telegramUseSystemProxy: parseBoolean(env.TELEGRAM_USE_SYSTEM_PROXY, false),
    telegramMessageThreadId: (env.TELEGRAM_MESSAGE_THREAD_ID || '').trim(),
    smtpEnabled: parseBoolean(env.SMTP_ENABLED, false),
    smtpHost: env.SMTP_HOST || '',
    smtpPort: parseInt(env.SMTP_PORT || '587'),
    smtpSecure: parseBoolean(env.SMTP_SECURE, false),
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    smtpFrom: env.SMTP_FROM || '',
    smtpTo: env.SMTP_TO || '',
    notifyCooldownSec: Math.max(0, Math.trunc(parseNumber(env.NOTIFY_COOLDOWN_SEC, 300))),
    adminIpAllowlist: parseCsvList(env.ADMIN_IP_ALLOWLIST),
    port: Math.trunc(parseNumber(env.PORT, 4000)),
    listenHost: parseListenHost(env),
    dataDir,
    dbType: parseDbType(env.DB_TYPE),
    dbUrl: (env.DB_URL || '').trim(),
    dbSsl: parseBoolean(env.DB_SSL, false),
    requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    routingFallbackUnitCost: Math.max(1e-6, parseNumber(env.ROUTING_FALLBACK_UNIT_COST, 1)),
    proxyFirstByteTimeoutSec: Math.max(0, Math.trunc(parseNumber(env.PROXY_FIRST_BYTE_TIMEOUT_SEC, 0))),
    tokenRouterFailureCooldownMaxSec: normalizeTokenRouterFailureCooldownMaxSec(
      parseNumber(env.TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC, TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING),
    ) ?? TOKEN_ROUTER_FAILURE_COOLDOWN_MAX_SEC_CEILING,
    tokenRouterCacheTtlMs: Math.max(100, Math.trunc(parseNumber(env.TOKEN_ROUTER_CACHE_TTL_MS, 1_500))),
    proxyMaxChannelAttempts: Math.max(1, Math.trunc(parseNumber(env.PROXY_MAX_CHANNEL_ATTEMPTS, 3))),
    // 连续多少次「上游自身故障」就把该通道降级到路由里最低优先级（0 = 关闭）。
    // 降级不是禁用：其他通道全都不可用时它照样会被选中；成功一次立刻恢复原优先级。
    proxyAutoDemoteFailureThreshold: Math.max(0, Math.trunc(parseNumber(env.PROXY_AUTO_DEMOTE_FAILURE_THRESHOLD, 10))),
    proxyStickySessionEnabled: parseBoolean(env.PROXY_STICKY_SESSION_ENABLED, true),
    proxyStickySessionTtlMs: Math.max(30_000, Math.trunc(parseNumber(env.PROXY_STICKY_SESSION_TTL_MS, 30 * 60 * 1000))),
    proxySessionChannelConcurrencyLimit: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_CONCURRENCY_LIMIT, 2))),
    proxySessionChannelQueueWaitMs: Math.max(0, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_QUEUE_WAIT_MS, 1_500))),
    proxySessionChannelLeaseTtlMs: Math.max(5_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_TTL_MS, 90_000))),
    proxySessionChannelLeaseKeepaliveMs: Math.max(1_000, Math.trunc(parseNumber(env.PROXY_SESSION_CHANNEL_LEASE_KEEPALIVE_MS, 15_000))),
    codexUpstreamWebsocketEnabled: parseBoolean(env.CODEX_UPSTREAM_WEBSOCKET_ENABLED, false),
    responsesCompactFallbackToResponsesEnabled: parseBoolean(env.RESPONSES_COMPACT_FALLBACK_TO_RESPONSES_ENABLED, false),
    disableCrossProtocolFallback: parseBoolean(env.DISABLE_CROSS_PROTOCOL_FALLBACK, false),
    proxyDebugTraceEnabled: parseBoolean(env.PROXY_DEBUG_TRACE_ENABLED, false),
    proxyDebugCaptureHeaders: parseBoolean(env.PROXY_DEBUG_CAPTURE_HEADERS, true),
    proxyDebugCaptureBodies: parseBoolean(env.PROXY_DEBUG_CAPTURE_BODIES, false),
    proxyDebugCaptureStreamChunks: parseBoolean(env.PROXY_DEBUG_CAPTURE_STREAM_CHUNKS, false),
    proxyDebugTargetSessionId: (env.PROXY_DEBUG_TARGET_SESSION_ID || '').trim(),
    proxyDebugTargetClientKind: (env.PROXY_DEBUG_TARGET_CLIENT_KIND || '').trim(),
    proxyDebugTargetModel: (env.PROXY_DEBUG_TARGET_MODEL || '').trim(),
    proxyDebugRetentionHours: Math.max(1, Math.trunc(parseNumber(env.PROXY_DEBUG_RETENTION_HOURS, 24))),
    proxyDebugMaxBodyBytes: Math.max(1024, Math.trunc(parseNumber(env.PROXY_DEBUG_MAX_BODY_BYTES, 262_144))),
    openAiServiceTierRules: parseJsonValue(env.OPENAI_SERVICE_TIER_RULES_JSON || env.OPENAI_SERVICE_TIER_RULES),
    modelAvailabilityProbeEnabled: parseBoolean(env.MODEL_AVAILABILITY_PROBE_ENABLED, false),
    modelAvailabilityProbeIntervalMs: Math.max(60_000, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_INTERVAL_MS, 30 * 60 * 1000))),
    modelAvailabilityProbeTimeoutMs: Math.max(3_000, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_TIMEOUT_MS, 15_000))),
    modelAvailabilityProbeConcurrency: Math.max(1, Math.min(16, Math.trunc(parseNumber(env.MODEL_AVAILABILITY_PROBE_CONCURRENCY, 1)))),
    // 模型监控采集：默认每天 07:00-23:00（[start, end) 小时区间）每 15 分钟一轮。
    // 窗口内单线程按站点顺序一个个采集；上一轮没跑完时直接跳过本次，不排队不并发。
    modelMonitorEnabled: parseBoolean(env.MODEL_MONITOR_ENABLED, true),
    modelMonitorIntervalMs: Math.max(60_000, Math.trunc(parseNumber(env.MODEL_MONITOR_INTERVAL_MS, 15 * 60 * 1000))),
    modelMonitorTimeoutMs: Math.max(5_000, Math.trunc(parseNumber(env.MODEL_MONITOR_TIMEOUT_MS, 30_000))),
    // 模型监控的「对话」不设时间上限（0 = 不限制）：推理模型动辄憋十几分钟才吐第一个
    // 字，任何按秒掐的预算都会把正常回答误杀，这一点已经吃过两次亏（第 69 条的
    // 30s 总超时、第 79 条 undici 默认 300s 的 bodyTimeout）。要停就由用户点「停止」
    // 或关页面触发（客户端断开即中断上游）。
    // 想恢复限制就把这两个值设成正的毫秒数；注意 nginx 的 proxy_read_timeout
    // 必须大于空闲上限，否则会是 nginx 先断、错误信息也变成没头没尾的 504。
    modelMonitorChatTimeoutMs: Math.max(0, Math.trunc(parseNumber(env.MODEL_MONITOR_CHAT_TIMEOUT_MS, 0))),
    modelMonitorChatIdleTimeoutMs: Math.max(0, Math.trunc(parseNumber(env.MODEL_MONITOR_CHAT_IDLE_TIMEOUT_MS, 0))),
    modelMonitorWindowStartHour: Math.min(23, Math.max(0, Math.trunc(parseNumber(env.MODEL_MONITOR_WINDOW_START_HOUR, 7)))),
    modelMonitorWindowEndHour: Math.min(24, Math.max(1, Math.trunc(parseNumber(env.MODEL_MONITOR_WINDOW_END_HOUR, 23)))),
    // 没有监控接口、只能用密钥列模型的站点（models_only），模型列表变化很少，
    // 不跟着 15 分钟轮次跑，只在每天这个小时之后刷一次。
    modelMonitorModelListRefreshHour: Math.min(23, Math.max(0, Math.trunc(parseNumber(env.MODEL_MONITOR_MODEL_LIST_REFRESH_HOUR, 7)))),
    // X-API 的对话密钥会因闲置被站点自动作废，且明文只在签发时出现一次，
    // 所以由受管浏览器每天自动重新签发一次并回写账号（站点只允许 1 个有效 Key，
    // 签发前会先作废旧 Key）。站点被删除/改平台后没有可刷目标，任务自动空转。
    xapiKeyEnabled: parseBoolean(env.XAPI_KEY_ENABLED, true),
    xapiKeyRefreshHour: Math.min(23, Math.max(0, Math.trunc(parseNumber(env.XAPI_KEY_REFRESH_HOUR, 5)))),
    proxyLogRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_DAYS, 30))),
    proxyLogRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_LOG_RETENTION_PRUNE_INTERVAL_MINUTES, 30))),
    proxyFileRetentionDays: Math.max(0, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_DAYS, 30))),
    proxyFileRetentionPruneIntervalMinutes: Math.max(1, Math.trunc(parseNumber(env.PROXY_FILE_RETENTION_PRUNE_INTERVAL_MINUTES, 60))),
    proxyErrorKeywords: parseCsvList(env.PROXY_ERROR_KEYWORDS),
    proxyEmptyContentFailEnabled: parseBoolean(env.PROXY_EMPTY_CONTENT_FAIL, false),
    globalBlockedBrands: [] as string[],
    globalAllowedModels: [] as string[],
    codexResponsesWebsocketBeta: parseOptionalSecret(env.CODEX_RESPONSES_WEBSOCKET_BETA) || 'responses_websockets=2026-02-06',
    codexHeaderDefaults: {
      userAgent: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_USER_AGENT),
      betaFeatures: parseOptionalSecret(env.CODEX_HEADER_DEFAULTS_BETA_FEATURES),
    },
    payloadRules: normalizePayloadRulesConfig(parseJsonValue(env.PAYLOAD_RULES_JSON || env.PAYLOAD_RULES)),
    routingWeights: {
      baseWeightFactor: parseNumber(env.BASE_WEIGHT_FACTOR, 0.5),
      valueScoreFactor: parseNumber(env.VALUE_SCORE_FACTOR, 0.5),
      costWeight: parseNumber(env.COST_WEIGHT, 0.4),
      balanceWeight: parseNumber(env.BALANCE_WEIGHT, 0.3),
      usageWeight: parseNumber(env.USAGE_WEIGHT, 0.3),
    },
  };
}

export const config = buildConfig(process.env);

export function buildFastifyOptions(
  appConfig: ReturnType<typeof buildConfig>,
): FastifyServerOptions {
  return {
    logger: true,
    trustProxy: true,
    bodyLimit: appConfig.requestBodyLimit,
  };
}
