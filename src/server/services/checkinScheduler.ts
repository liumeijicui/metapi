import cron from 'node-cron';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { refreshAllBalances } from './balanceService.js';
import { checkinAll } from './checkinService.js';
import * as routeRefreshWorkflow from './routeRefreshWorkflow.js';
import { sendNotification } from './notifyService.js';
import { buildDailySummaryNotification, collectDailySummaryMetrics } from './dailySummaryService.js';
import { cleanupConfiguredLogs } from './logCleanupService.js';
import { formatLocalDate } from './localTimeService.js';
import { normalizeLogCleanupRetentionDays } from '../shared/logCleanupRetentionDays.js';

export type CheckinScheduleMode = 'cron' | 'interval';

let checkinTask: cron.ScheduledTask | null = null;
let checkinIntervalTimer: ReturnType<typeof setInterval> | null = null;
let balanceTask: cron.ScheduledTask | null = null;
let dailySummaryTask: cron.ScheduledTask | null = null;
let logCleanupTask: cron.ScheduledTask | null = null;
const intervalAttemptByAccount = new Map<number, number>();
const checkinSiteTimers = new Map<number, ReturnType<typeof setTimeout>>();
const checkinScheduledSiteIds = new Set<number>();
const checkinQueuedSiteIds = new Set<number>();
const checkinRunningSiteIds = new Set<number>();
const checkinSiteQueue: Array<{ plan: CheckinDailyPlan; site: CheckinDailyPlanSite }> = [];
let checkinQueueRunning = false;
let activeCheckinPlan: CheckinDailyPlan | null = null;

const DAILY_SUMMARY_DEFAULT_CRON = '58 23 * * *';
const LOG_CLEANUP_DEFAULT_CRON = '0 6 * * *';
const CHECKIN_INTERVAL_POLL_MS = 60_000;
const CHECKIN_DAILY_PLAN_SETTING_KEY = 'checkin_daily_plan_v1';
const MAX_CHECKIN_RANDOM_WINDOW_MINUTES = 12 * 60;
const HASH_48_BIT_MODULUS = 2 ** 48;

type CheckinDailyPlanSiteStatus = 'pending' | 'done' | 'failed';

type CheckinDailyPlanSite = {
  siteId: number;
  siteName: string;
  accountIds: number[];
  scheduledAt: string;
  status: CheckinDailyPlanSiteStatus;
};

type CheckinDailyPlan = {
  version: 1;
  date: string;
  seed: string;
  createdAt: string;
  windowMinutes: number;
  sites: CheckinDailyPlanSite[];
};

type CheckinTarget = {
  siteId: number;
  siteName: string;
  accountIds: number[];
};

async function resolveJsonSetting<T>(
  settingKey: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): Promise<T> {
  try {
    const row = await db.select().from(schema.settings).where(eq(schema.settings.key, settingKey)).get();
    if (row?.value) {
      const parsed = JSON.parse(row.value);
      if (isValid(parsed)) {
        return parsed;
      }
    }
  } catch {}
  return fallback;
}

async function resolveCronSetting(settingKey: string, fallback: string): Promise<string> {
  return resolveJsonSetting(settingKey, (value): value is string => typeof value === 'string' && cron.validate(value), fallback);
}

async function resolveBooleanSetting(settingKey: string, fallback: boolean): Promise<boolean> {
  return resolveJsonSetting(settingKey, (value): value is boolean => typeof value === 'boolean', fallback);
}

async function resolvePositiveIntegerSetting(settingKey: string, fallback: number): Promise<number> {
  return resolveJsonSetting(
    settingKey,
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 1,
    fallback,
  );
}

function isCheckinDailyPlan(value: unknown): value is CheckinDailyPlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<CheckinDailyPlan>;
  if (plan.version !== 1) return false;
  if (typeof plan.date !== 'string' || !plan.date) return false;
  if (typeof plan.seed !== 'string' || !plan.seed) return false;
  if (typeof plan.createdAt !== 'string' || !Number.isFinite(Date.parse(plan.createdAt))) return false;
  if (typeof plan.windowMinutes !== 'number' || !Number.isFinite(plan.windowMinutes)) return false;
  if (!Array.isArray(plan.sites)) return false;

  return plan.sites.every((site) => (
    !!site
    && typeof site.siteId === 'number'
    && Number.isFinite(site.siteId)
    && typeof site.siteName === 'string'
    && Array.isArray(site.accountIds)
    && site.accountIds.every((id) => typeof id === 'number' && Number.isFinite(id))
    && typeof site.scheduledAt === 'string'
    && Number.isFinite(Date.parse(site.scheduledAt))
    && (site.status === 'pending' || site.status === 'done' || site.status === 'failed')
  ));
}

async function loadCheckinDailyPlan(): Promise<CheckinDailyPlan | null> {
  try {
    const row = await db.select().from(schema.settings)
      .where(eq(schema.settings.key, CHECKIN_DAILY_PLAN_SETTING_KEY))
      .get();
    if (!row?.value) return null;
    const parsed = JSON.parse(row.value);
    return isCheckinDailyPlan(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadTodayCheckinPlan(now = new Date()): Promise<CheckinDailyPlan | null> {
  const plan = await loadCheckinDailyPlan();
  if (!plan || plan.date !== formatLocalDate(now)) return null;
  return plan;
}

async function saveCheckinDailyPlan(plan: CheckinDailyPlan): Promise<void> {
  await upsertSetting(CHECKIN_DAILY_PLAN_SETTING_KEY, plan);
}

/**
 * Stable per-site jitter for one day. The persisted daily seed changes every
 * day, so a site does not keep the same sign-in minute while a restart on the
 * same day still reproduces exactly the same plan.
 */
export function computeCheckinSiteDelaySeconds(
  siteId: number,
  dateKey: string,
  seed: string,
  windowMinutes: number,
): number {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return 0;
  const windowSeconds = Math.max(1, Math.trunc(windowMinutes * 60));
  const digest = createHash('sha256')
    .update(`${dateKey}|${seed}|${siteId}`)
    .digest();
  const raw = digest.readUIntBE(0, 6);
  return Math.floor((raw / HASH_48_BIT_MODULUS) * windowSeconds);
}

export function buildCheckinDailyPlan(input: {
  now: Date;
  windowMinutes: number;
  seed: string;
  targets: CheckinTarget[];
}): CheckinDailyPlan {
  const date = formatLocalDate(input.now);
  const baseMs = input.now.getTime();
  const sites = input.targets.map((target) => {
    const delaySeconds = computeCheckinSiteDelaySeconds(
      target.siteId,
      date,
      input.seed,
      input.windowMinutes,
    );
    return {
      siteId: target.siteId,
      siteName: target.siteName,
      accountIds: [...target.accountIds],
      scheduledAt: new Date(baseMs + delaySeconds * 1000).toISOString(),
      status: 'pending' as const,
    };
  }).sort((a, b) => {
    const timeDiff = Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt);
    return timeDiff !== 0 ? timeDiff : a.siteId - b.siteId;
  });

  return {
    version: 1,
    date,
    seed: input.seed,
    createdAt: input.now.toISOString(),
    windowMinutes: input.windowMinutes,
    sites,
  };
}

async function loadCheckinTargets(): Promise<CheckinTarget[]> {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(and(
      eq(schema.accounts.checkinEnabled, true),
      inArray(schema.accounts.status, ['active', 'expired']),
    ))
    .all();

  const grouped = new Map<number, CheckinTarget>();
  for (const row of rows as any[]) {
    if (!row?.accounts || !row?.sites) continue;
    if ((row.sites.status || 'active') === 'disabled') continue;
    const siteId = Number(row.sites.id);
    const accountId = Number(row.accounts.id);
    if (!Number.isFinite(siteId) || !Number.isFinite(accountId)) continue;
    const current = grouped.get(siteId) || {
      siteId,
      siteName: String(row.sites.name || `站点 ${siteId}`),
      accountIds: [],
    };
    current.accountIds.push(accountId);
    grouped.set(siteId, current);
  }

  return Array.from(grouped.values()).sort((a, b) => a.siteId - b.siteId);
}

function clearCheckinSiteTimers() {
  for (const timer of checkinSiteTimers.values()) {
    clearTimeout(timer);
  }
  checkinSiteTimers.clear();
  checkinScheduledSiteIds.clear();
  checkinQueuedSiteIds.clear();
  checkinSiteQueue.length = 0;
}

function describePlanSite(site: CheckinDailyPlanSite): string {
  return `${site.siteName}(#${site.siteId}) @ ${new Date(site.scheduledAt).toLocaleString('zh-CN', { hour12: false })}`;
}

async function executePlannedSite(plan: CheckinDailyPlan, site: CheckinDailyPlanSite) {
  console.log(`[Scheduler] Check-in starting: ${site.siteName}(#${site.siteId})`);
  try {
    const results = await checkinAll({
      accountIds: site.accountIds,
      scheduleMode: 'cron',
    });
    const success = results.filter((item) => item.result.success).length;
    const skipped = results.filter((item) => item.result.status === 'skipped' || item.result.skipped).length;
    const failed = results.length - success - skipped;
    site.status = failed > 0 ? 'failed' : 'done';
    console.log(
      `[Scheduler] Check-in site complete: ${site.siteName}(#${site.siteId}) ${success} success, ${skipped} skipped, ${failed} failed`,
    );
  } catch (err) {
    site.status = 'failed';
    console.error(`[Scheduler] Check-in site error: ${site.siteName}(#${site.siteId})`, err);
  }

  if (activeCheckinPlan) {
    const activeSite = activeCheckinPlan.sites.find((item) => item.siteId === site.siteId);
    if (activeSite && activeSite.status === 'pending') {
      activeSite.status = site.status;
    }
    await saveCheckinDailyPlan(activeCheckinPlan).catch((err) => {
      console.error('[Scheduler] Failed to persist check-in daily plan:', err);
    });
  }
}

async function drainCheckinSiteQueue() {
  if (checkinQueueRunning) return;
  checkinQueueRunning = true;
  try {
    while (checkinSiteQueue.length > 0) {
      const item = checkinSiteQueue.shift()!;
      checkinQueuedSiteIds.delete(item.site.siteId);
      if (checkinRunningSiteIds.has(item.site.siteId)) continue;
      if (item.site.status !== 'pending' || activeCheckinPlan !== item.plan) continue;

      checkinRunningSiteIds.add(item.site.siteId);
      try {
        await executePlannedSite(item.plan, item.site);
      } finally {
        checkinRunningSiteIds.delete(item.site.siteId);
      }
    }
  } finally {
    checkinQueueRunning = false;
    if (checkinSiteQueue.length > 0) {
      void drainCheckinSiteQueue();
      return;
    }
    if (activeCheckinPlan) {
      const done = activeCheckinPlan.sites.filter((site) => site.status === 'done').length;
      const failed = activeCheckinPlan.sites.filter((site) => site.status === 'failed').length;
      const pending = activeCheckinPlan.sites.filter((site) => site.status === 'pending').length;
      if (pending === 0) {
        console.log(`[Scheduler] Randomized check-in complete: ${done} sites done, ${failed} sites failed`);
      }
    }
  }
}

function enqueuePlannedSite(plan: CheckinDailyPlan, site: CheckinDailyPlanSite) {
  if (activeCheckinPlan !== plan || site.status !== 'pending') return;
  if (checkinRunningSiteIds.has(site.siteId) || checkinQueuedSiteIds.has(site.siteId)) return;
  checkinQueuedSiteIds.add(site.siteId);
  checkinSiteQueue.push({ plan, site });
  void drainCheckinSiteQueue();
}

function scheduleCheckinDailyPlan(plan: CheckinDailyPlan, now = new Date()) {
  for (const timer of checkinSiteTimers.values()) clearTimeout(timer);
  checkinSiteTimers.clear();
  checkinScheduledSiteIds.clear();
  activeCheckinPlan = plan;

  if (plan.date !== formatLocalDate(now)) return;

  const pending = plan.sites.filter((site) => site.status === 'pending');
  if (pending.length === 0) {
    console.log('[Scheduler] Today check-in plan already complete');
    return;
  }

  console.log(
    `[Scheduler] Today check-in plan: ${pending.length} sites spread over ${plan.windowMinutes} minutes`,
  );
  for (const site of pending) {
    if (checkinRunningSiteIds.has(site.siteId) || checkinScheduledSiteIds.has(site.siteId)) continue;
    const delayMs = Math.max(0, Date.parse(site.scheduledAt) - now.getTime());
    checkinScheduledSiteIds.add(site.siteId);
    console.log(`[Scheduler] Check-in planned: ${describePlanSite(site)}`);
    const timer = setTimeout(() => {
      checkinSiteTimers.delete(site.siteId);
      checkinScheduledSiteIds.delete(site.siteId);
      enqueuePlannedSite(plan, site);
    }, delayMs);
    checkinSiteTimers.set(site.siteId, timer);
  }
}

async function resumeTodayCheckinPlan(now = new Date()) {
  if (config.checkinScheduleMode !== 'cron' || config.checkinRandomWindowMinutes <= 0) return;
  const plan = await loadTodayCheckinPlan(now);
  if (!plan) return;
  console.log('[Scheduler] Restoring today check-in plan');
  scheduleCheckinDailyPlan(plan, now);
}

async function runCronCheckinPass(now = new Date()) {
  console.log(`[Scheduler] Running check-in at ${now.toISOString()}`);
  if (config.checkinRandomWindowMinutes <= 0) {
    try {
      const results = await checkinAll({ scheduleMode: 'cron' });
      const success = results.filter((r) => r.result.success).length;
      const failed = results.length - success;
      console.log(`[Scheduler] Check-in complete: ${success} success, ${failed} failed`);
    } catch (err) {
      console.error('[Scheduler] Check-in error:', err);
    }
    return;
  }

  try {
    const existing = await loadTodayCheckinPlan(now);
    if (existing) {
      console.log('[Scheduler] Today check-in plan already exists, resuming it');
      scheduleCheckinDailyPlan(existing, now);
      return;
    }

    const targets = await loadCheckinTargets();
    if (targets.length === 0) {
      console.log('[Scheduler] Check-in skipped: no eligible sites');
      return;
    }

    const plan = buildCheckinDailyPlan({
      now,
      windowMinutes: config.checkinRandomWindowMinutes,
      seed: randomBytes(16).toString('hex'),
      targets,
    });
    await saveCheckinDailyPlan(plan);
    scheduleCheckinDailyPlan(plan, now);
  } catch (err) {
    console.error('[Scheduler] Randomized check-in error:', err);
  }
}

function createCheckinTask(cronExpr: string) {
  return cron.schedule(cronExpr, () => {
    void runCronCheckinPass();
  });
}

type IntervalCheckinCandidate = {
  id: number;
  lastCheckinAt?: string | null;
};

export function selectDueIntervalCheckinAccountIds(
  rows: IntervalCheckinCandidate[],
  intervalHours: number,
  now = new Date(),
  attemptState = intervalAttemptByAccount,
) {
  const nowMs = now.getTime();
  const intervalMs = Math.max(1, intervalHours) * 60 * 60 * 1000;

  return rows
    .filter((row) => {
      const lastCheckinMs = row.lastCheckinAt ? Date.parse(row.lastCheckinAt) : Number.NaN;
      const lastAttemptMs = attemptState.get(row.id);
      if (Number.isFinite(lastCheckinMs)) {
        if (nowMs - lastCheckinMs < intervalMs) return false;
        if (typeof lastAttemptMs === 'number' && lastAttemptMs >= lastCheckinMs && nowMs - lastAttemptMs < intervalMs) {
          return false;
        }
        return true;
      }
      if (typeof lastAttemptMs === 'number' && nowMs - lastAttemptMs < intervalMs) return false;
      return true;
    })
    .map((row) => row.id);
}

async function runIntervalCheckinPass(now = new Date()) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const dueAccountIds = selectDueIntervalCheckinAccountIds(
    rows
      // `expired` is included for the same reason the cron pass includes it (see
      // `checkinAll`): this job is the one that can replay a sign-in, and an
      // account that a failed balance refresh marked expired is exactly the one
      // that needs that replay. Filtering it out froze it out of the only pass
      // that could ever bring it back.
      .filter((row: any) => row.accounts?.checkinEnabled === true
        && (row.accounts?.status === 'active' || row.accounts?.status === 'expired')
        && row.sites?.status !== 'disabled')
      .map((row: any) => ({
        id: row.accounts.id,
        lastCheckinAt: row.accounts.lastCheckinAt,
      })),
    config.checkinIntervalHours,
    now,
  );

  if (dueAccountIds.length === 0) return;

  try {
    const results = await checkinAll({
      accountIds: dueAccountIds,
      scheduleMode: 'interval',
    });
    const nowMs = now.getTime();
    for (const item of results) {
      intervalAttemptByAccount.set(item.accountId, nowMs);
    }
    const success = results.filter((r) => r.result.success).length;
    const failed = results.length - success;
    console.log(`[Scheduler] Interval check-in complete: ${success} success, ${failed} failed`);
  } catch (err) {
    console.error('[Scheduler] Interval check-in error:', err);
  }
}

function stopCheckinSchedule() {
  checkinTask?.stop();
  checkinTask = null;
  if (checkinIntervalTimer) {
    clearInterval(checkinIntervalTimer);
    checkinIntervalTimer = null;
  }
  clearCheckinSiteTimers();
  activeCheckinPlan = null;
}

function startCheckinSchedule() {
  stopCheckinSchedule();
  if (config.checkinScheduleMode === 'interval') {
    checkinIntervalTimer = setInterval(() => {
      void runIntervalCheckinPass();
    }, CHECKIN_INTERVAL_POLL_MS);
    return;
  }
  checkinTask = createCheckinTask(config.checkinCron);
  void resumeTodayCheckinPlan().catch((err) => {
    console.error('[Scheduler] Failed to restore check-in plan:', err);
  });
}

function createBalanceTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Refreshing balances at ${new Date().toISOString()}`);
    try {
      await refreshAllBalances();
      await routeRefreshWorkflow.refreshModelsAndRebuildRoutes();
      console.log('[Scheduler] Balance refresh complete');
    } catch (err) {
      console.error('[Scheduler] Balance refresh error:', err);
    }
  });
}

function createDailySummaryTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    console.log(`[Scheduler] Sending daily summary at ${new Date().toISOString()}`);
    try {
      const metrics = await collectDailySummaryMetrics();
      const { title, message } = buildDailySummaryNotification(metrics);
      await sendNotification(title, message, 'info', {
        bypassThrottle: true,
        requireChannel: true,
        throwOnFailure: true,
      });
      console.log(`[Scheduler] Daily summary sent: ${title}`);
    } catch (err) {
      console.error('[Scheduler] Daily summary error:', err);
    }
  });
}

function createLogCleanupTask(cronExpr: string) {
  return cron.schedule(cronExpr, async () => {
    if (!config.logCleanupConfigured) {
      console.log('[Scheduler] Log cleanup skipped: legacy fallback mode is active');
      return;
    }
    console.log(`[Scheduler] Running log cleanup at ${new Date().toISOString()}`);
    try {
      const result = await cleanupConfiguredLogs();
      if (!result.enabled) {
        console.log('[Scheduler] Log cleanup skipped: no log target enabled');
        return;
      }
      console.log(
        `[Scheduler] Log cleanup complete: usage=${result.usageLogsDeleted}, program=${result.programLogsDeleted}, cutoff=${result.cutoffUtc}`,
      );
    } catch (err) {
      console.error('[Scheduler] Log cleanup error:', err);
    }
  });
}

export async function startScheduler() {
  const activeCheckinCron = await resolveCronSetting('checkin_cron', config.checkinCron);
  const activeCheckinScheduleMode = await resolveJsonSetting<CheckinScheduleMode>(
    'checkin_schedule_mode',
    (value): value is CheckinScheduleMode => value === 'cron' || value === 'interval',
    config.checkinScheduleMode as CheckinScheduleMode,
  );
  const activeCheckinIntervalHours = await resolvePositiveIntegerSetting(
    'checkin_interval_hours',
    config.checkinIntervalHours,
  );
  const activeCheckinRandomWindowMinutes = await resolveJsonSetting(
    'checkin_random_window_minutes',
    (value): value is number => typeof value === 'number'
      && Number.isFinite(value)
      && value >= 0
      && value <= MAX_CHECKIN_RANDOM_WINDOW_MINUTES,
    config.checkinRandomWindowMinutes,
  );
  const activeBalanceCron = await resolveCronSetting('balance_refresh_cron', config.balanceRefreshCron);
  const activeDailySummaryCron = await resolveCronSetting('daily_summary_cron', DAILY_SUMMARY_DEFAULT_CRON);
  const activeLogCleanupCron = await resolveCronSetting('log_cleanup_cron', config.logCleanupCron || LOG_CLEANUP_DEFAULT_CRON);
  const activeLogCleanupUsageLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_usage_logs_enabled',
    config.logCleanupUsageLogsEnabled,
  );
  const activeLogCleanupProgramLogsEnabled = await resolveBooleanSetting(
    'log_cleanup_program_logs_enabled',
    config.logCleanupProgramLogsEnabled,
  );
  const activeLogCleanupRetentionDays = await resolvePositiveIntegerSetting(
    'log_cleanup_retention_days',
    normalizeLogCleanupRetentionDays(config.logCleanupRetentionDays),
  );
  config.checkinCron = activeCheckinCron;
  config.checkinScheduleMode = activeCheckinScheduleMode;
  config.checkinIntervalHours = Math.min(24, Math.max(1, activeCheckinIntervalHours));
  config.checkinRandomWindowMinutes = Math.trunc(activeCheckinRandomWindowMinutes);
  config.balanceRefreshCron = activeBalanceCron;
  config.logCleanupCron = activeLogCleanupCron;
  config.logCleanupUsageLogsEnabled = activeLogCleanupUsageLogsEnabled;
  config.logCleanupProgramLogsEnabled = activeLogCleanupProgramLogsEnabled;
  config.logCleanupRetentionDays = activeLogCleanupRetentionDays;

  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  startCheckinSchedule();
  balanceTask = createBalanceTask(activeBalanceCron);
  dailySummaryTask = createDailySummaryTask(activeDailySummaryCron);
  logCleanupTask = createLogCleanupTask(activeLogCleanupCron);

  console.log(
    `[Scheduler] Check-in schedule: ${config.checkinScheduleMode} (${config.checkinScheduleMode === 'cron' ? activeCheckinCron : `${config.checkinIntervalHours}h`}), randomWindow=${config.checkinRandomWindowMinutes}m`,
  );
  console.log(`[Scheduler] Balance refresh cron: ${activeBalanceCron}`);
  console.log(`[Scheduler] Daily summary cron: ${activeDailySummaryCron}`);
  console.log(
    `[Scheduler] Log cleanup cron: ${activeLogCleanupCron} (configured=${config.logCleanupConfigured}, usage=${activeLogCleanupUsageLogsEnabled}, program=${activeLogCleanupProgramLogsEnabled}, retentionDays=${activeLogCleanupRetentionDays})`,
  );
}

export function updateCheckinCron(cronExpr: string) {
  updateCheckinSchedule({
    mode: 'cron',
    cronExpr,
    intervalHours: config.checkinIntervalHours,
  });
}

export function updateCheckinSchedule(input: {
  mode: CheckinScheduleMode;
  cronExpr?: string;
  intervalHours?: number;
}) {
  const nextMode = input.mode;
  if (nextMode !== 'cron' && nextMode !== 'interval') {
    throw new Error(`Invalid checkin schedule mode: ${String(nextMode)}`);
  }

  const nextCronExpr = input.cronExpr ?? config.checkinCron;
  if (!cron.validate(nextCronExpr)) throw new Error(`Invalid cron: ${nextCronExpr}`);

  const nextIntervalHours = input.intervalHours ?? config.checkinIntervalHours;
  if (!Number.isFinite(nextIntervalHours) || nextIntervalHours < 1 || nextIntervalHours > 24) {
    throw new Error(`Invalid interval hours: ${String(nextIntervalHours)}`);
  }

  config.checkinScheduleMode = nextMode;
  config.checkinCron = nextCronExpr;
  config.checkinIntervalHours = Math.trunc(nextIntervalHours);
  startCheckinSchedule();
}

export function updateBalanceRefreshCron(cronExpr: string) {
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);
  config.balanceRefreshCron = cronExpr;
  balanceTask?.stop();
  balanceTask = createBalanceTask(cronExpr);
}

export function updateLogCleanupSettings(input: {
  cronExpr?: string;
  usageLogsEnabled?: boolean;
  programLogsEnabled?: boolean;
  retentionDays?: number;
}) {
  const cronExpr = input.cronExpr ?? config.logCleanupCron;
  if (!cron.validate(cronExpr)) throw new Error(`Invalid cron: ${cronExpr}`);

  const retentionDays = normalizeLogCleanupRetentionDays(input.retentionDays ?? config.logCleanupRetentionDays);

  config.logCleanupCron = cronExpr;
  if (input.usageLogsEnabled !== undefined) config.logCleanupUsageLogsEnabled = !!input.usageLogsEnabled;
  if (input.programLogsEnabled !== undefined) config.logCleanupProgramLogsEnabled = !!input.programLogsEnabled;
  config.logCleanupRetentionDays = retentionDays;

  logCleanupTask?.stop();
  logCleanupTask = createLogCleanupTask(cronExpr);
}

export function __resetCheckinSchedulerForTests() {
  stopCheckinSchedule();
  balanceTask?.stop();
  dailySummaryTask?.stop();
  logCleanupTask?.stop();
  balanceTask = null;
  dailySummaryTask = null;
  logCleanupTask = null;
  intervalAttemptByAccount.clear();
  checkinRunningSiteIds.clear();
  checkinQueueRunning = false;
}
