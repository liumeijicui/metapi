import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import {
  InstaboxApiError,
  listInstaboxMachines,
  resolveInstaboxStartAction,
  runInstaboxMachineAction,
  wakeInstaboxMachine,
} from './instaboxService.js';
import { sendNotification } from './notifyService.js';

export type InstaboxKeepaliveWindow = {
  start: string;
  end: string;
};

export const INSTABOX_KEEPALIVE_WINDOWS: InstaboxKeepaliveWindow[] = [
  { start: '08:20', end: '12:45' },
  { start: '13:55', end: '22:00' },
];

const SETTING_KEY = 'instabox_keepalive_v1';
const TICK_MS = 60_000;
const KEEPALIVE_INTERVAL_MS = 20 * 60_000;
const MAX_RUN_WARNING_LEAD_MS = 15 * 60_000;
/**
 * 服务重启后可能错过整点边界（tick 每 60s 一次，重启会丢掉上一次 tick 时间）。
 * 窗口刚结束的这段时间内仍补做一次关机，超过后不再干预，避免把用户夜里
 * 手动开起来的机器又关掉。
 */
const SCHEDULE_CATCH_UP_MS = 30 * 60_000;

type StoredKeepaliveConfig = {
  enabled: boolean;
  /** 由本服务按计划关机的机器；用于第二天开机时区分「计划关机」和「用户手动暂停」。 */
  scheduleSuspend?: Record<string, string>;
};

export type InstaboxKeepaliveStatus = {
  enabled: boolean;
  windows: InstaboxKeepaliveWindow[];
  intervalMinutes: number;
  inWindow: boolean;
  currentWindow: InstaboxKeepaliveWindow | null;
  nextWindowStart: string | null;
  lastTickAt: string | null;
  lastAttemptAt: string | null;
  lastKeepaliveAt: string | null;
  nextKeepaliveAt: string | null;
  machine: { id: string; name: string; state: string } | null;
  lastResult: 'idle' | 'kept_alive' | 'suspended' | 'skipped' | 'limit_reached' | 'error' | 'disabled';
  message: string;
  lastError: string | null;
};

type WindowPosition = {
  window: InstaboxKeepaliveWindow;
  startAt: Date;
  endAt: Date;
};

let config: StoredKeepaliveConfig = { enabled: true };
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerReady = false;
let tickInFlight = false;
let lastAttemptAtMs: number | null = null;
let lastKeepaliveAtMs: number | null = null;
let lastTickAtIso: string | null = null;
let lastTickAtMs: number | null = null;
let lastCompletedSuspendBoundaryMs: number | null = null;
let lastError: string | null = null;
let lastMachine: InstaboxKeepaliveStatus['machine'] = null;
let lastResult: InstaboxKeepaliveStatus['lastResult'] = 'idle';
let lastMessage = '保活调度尚未启动';
const gaveUpWindowKeys = new Set<string>();
const notifiedKeys = new Set<string>();
/**
 * 机器被 InstaBox 自动暂停后会进入冷却期，期间唤醒请求一律 409
 * `machine_cooldown`。冷却结束后本时段仍可继续保活，所以这里只把该机器
 * 压到冷却时间点，而不是像运行上限那样放弃整个时段。
 */
const cooldownUntilMsByMachine = new Map<string, number>();

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;
}

export function parseInstaboxClock(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

function localMinuteOfDay(value: Date): number {
  return value.getHours() * 60 + value.getMinutes();
}

function atLocalClock(base: Date, clock: string): Date {
  const minutes = parseInstaboxClock(clock);
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0,
  );
}

/**
 * 返回当前所处的保活窗口。窗口是左闭右开：08:20 开始，12:45 起不再保活。
 */
export function resolveInstaboxKeepaliveWindow(
  now = new Date(),
  windows = INSTABOX_KEEPALIVE_WINDOWS,
): WindowPosition | null {
  const minute = localMinuteOfDay(now);
  for (const window of windows) {
    const start = parseInstaboxClock(window.start);
    const end = parseInstaboxClock(window.end);
    if (Number.isFinite(start) && Number.isFinite(end) && minute >= start && minute < end) {
      return {
        window,
        startAt: atLocalClock(now, window.start),
        endAt: atLocalClock(now, window.end),
      };
    }
  }
  return null;
}

export function resolveNextInstaboxKeepaliveWindowStart(
  now = new Date(),
  windows = INSTABOX_KEEPALIVE_WINDOWS,
): Date | null {
  const minute = localMinuteOfDay(now);
  const today = [...windows]
    .map((window) => ({ window, minute: parseInstaboxClock(window.start) }))
    .filter((item) => Number.isFinite(item.minute) && item.minute > minute)
    .sort((left, right) => left.minute - right.minute);
  if (today.length > 0) return atLocalClock(now, today[0]!.window.start);

  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const first = [...windows]
    .map((window) => ({ window, minute: parseInstaboxClock(window.start) }))
    .filter((item) => Number.isFinite(item.minute))
    .sort((left, right) => left.minute - right.minute)[0];
  return first ? atLocalClock(tomorrow, first.window.start) : null;
}

export type InstaboxScheduleAction = {
  action: 'start' | 'suspend';
  at: Date;
  window: InstaboxKeepaliveWindow;
};

/**
 * 列出 (from, to] 之间跨过的开关机时间点：窗口开始开机，窗口结束关机。
 * 用边界跨越而不是「当前是否在窗口内」判断，避免关机动作在每个 tick 重复执行。
 */
export function resolveInstaboxScheduleActions(
  from: Date,
  to: Date,
  windows = INSTABOX_KEEPALIVE_WINDOWS,
): InstaboxScheduleAction[] {
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];
  const actions: InstaboxScheduleAction[] = [];
  const firstDay = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0, 0);
  const lastDay = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 0, 0, 0, 0);
  for (
    let cursor = firstDay;
    cursor.getTime() <= lastDay.getTime();
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
  ) {
    for (const window of windows) {
      const startMinute = parseInstaboxClock(window.start);
      const endMinute = parseInstaboxClock(window.end);
      if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) continue;
      const startAt = atLocalClock(cursor, window.start);
      const endAt = atLocalClock(cursor, window.end);
      if (startAt.getTime() > fromMs && startAt.getTime() <= toMs) {
        actions.push({ action: 'start', at: startAt, window });
      }
      if (endAt.getTime() > fromMs && endAt.getTime() <= toMs) {
        actions.push({ action: 'suspend', at: endAt, window });
      }
    }
  }
  return actions.sort((left, right) => left.at.getTime() - right.at.getTime());
}

/**
 * 返回刚刚结束的窗口结束时间（用于重启后的补关机）。窗口结束后
 * `graceMs` 内有效，超过则认为用户是主动开机，不再干预。
 */
export function resolveRecentInstaboxWindowEnd(
  now = new Date(),
  windows = INSTABOX_KEEPALIVE_WINDOWS,
  graceMs = SCHEDULE_CATCH_UP_MS,
): Date | null {
  const nowMs = now.getTime();
  let best: Date | null = null;
  for (const dayOffset of [-1, 0]) {
    const base = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, 0, 0, 0);
    for (const window of windows) {
      if (!Number.isFinite(parseInstaboxClock(window.end))) continue;
      const endAt = atLocalClock(base, window.end);
      const delta = nowMs - endAt.getTime();
      if (delta >= 0 && delta <= graceMs && (!best || endAt.getTime() > best.getTime())) {
        best = endAt;
      }
    }
  }
  return best;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

async function loadStoredConfig(): Promise<StoredKeepaliveConfig> {
  try {
    const row = await db
      .select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, SETTING_KEY))
      .get();
    if (!row?.value) return { enabled: true };
    const parsed = JSON.parse(String(row.value));
    const scheduleSuspend: Record<string, string> = {};
    if (parsed?.scheduleSuspend && typeof parsed.scheduleSuspend === 'object') {
      for (const [machineId, value] of Object.entries(parsed.scheduleSuspend)) {
        if (typeof value === 'string' && machineId) scheduleSuspend[machineId] = value;
      }
    }
    return { enabled: parsed?.enabled !== false, scheduleSuspend };
  } catch {
    return { enabled: true };
  }
}

async function rememberScheduleSuspend(machineId: string): Promise<void> {
  config = {
    ...config,
    scheduleSuspend: { ...(config.scheduleSuspend ?? {}), [machineId]: new Date().toISOString() },
  };
  try {
    await upsertSetting(SETTING_KEY, config);
  } catch {}
}

async function clearScheduleSuspend(machineId: string): Promise<void> {
  if (!config.scheduleSuspend?.[machineId]) return;
  const next = { ...config.scheduleSuspend };
  delete next[machineId];
  config = { ...config, scheduleSuspend: next };
  try {
    await upsertSetting(SETTING_KEY, config);
  } catch {}
}

async function appendEvent(
  level: 'info' | 'warning' | 'error',
  title: string,
  message: string,
): Promise<void> {
  try {
    await db.insert(schema.events).values({
      type: 'instabox',
      title,
      message,
      level,
      relatedType: 'instabox',
      createdAt: new Date().toISOString(),
    }).run();
  } catch {}
  try {
    await sendNotification(title, message, level);
  } catch {}
}

function notifyOnce(key: string, level: 'info' | 'warning' | 'error', title: string, message: string) {
  if (notifiedKeys.has(key)) return;
  notifiedKeys.add(key);
  void appendEvent(level, title, message);
}

function runLimitAt(machine: any): number | null {
  const startedAt = Date.parse(String(machine?.runStartedAt || ''));
  const maxRunMinutes = Number(machine?.maxRunMinutes);
  if (!Number.isFinite(startedAt) || !Number.isFinite(maxRunMinutes) || maxRunMinutes <= 0) return null;
  return startedAt + maxRunMinutes * 60_000;
}

function windowKey(machineId: string, now: Date, window: InstaboxKeepaliveWindow): string {
  return `${machineId}:${localDateKey(now)}:${window.start}`;
}

function skipMessage(machine: any, allowScheduledWake = false): string | null {
  if (!machine) return '没有可保活的机器';
  if (machine.state === 'deleting' || machine.state === 'deleted') {
    return `${machine.name || machine.id} 正在删除，保活不会处理它`;
  }
  if (machine.state === 'stopped' && machine.desiredState !== 'running') {
    return `${machine.name || machine.id} 已停止，保活不会自动启动它`;
  }
  if (machine.state === 'suspended' && !machine.autoSuspendedAt && !allowScheduledWake) {
    return `${machine.name || machine.id} 是你手动暂停的，保活不会覆盖手动操作`;
  }
  return null;
}

async function keepMachineAwake(machine: any, now: Date, activeWindow: WindowPosition): Promise<void> {
  const key = windowKey(String(machine.id), now, activeWindow.window);
  if (gaveUpWindowKeys.has(key)) {
    lastResult = 'limit_reached';
    lastMessage = `${machine.name || machine.id} 本轮已停止保活，等待下一个时段`;
    return;
  }

  const limitAt = runLimitAt(machine);
  if (limitAt !== null) {
    const warningKey = `${machine.id}:${machine.runStartedAt}:approaching`;
    if (limitAt > now.getTime() && limitAt - now.getTime() <= MAX_RUN_WARNING_LEAD_MS) {
      notifyOnce(
        warningKey,
        'warning',
        'InstaBox 保活即将到达运行上限',
        `${machine.name || machine.id} 将在 ${new Date(limitAt).toLocaleString()} 达到连续运行 ${machine.maxRunMinutes} 分钟上限，之后会暂停并进入冷却。`,
      );
    }
    if (now.getTime() >= limitAt) {
      gaveUpWindowKeys.add(key);
      notifyOnce(
        `${key}:reached`,
        'warning',
        'InstaBox 本时段无法继续保活',
        `${machine.name || machine.id} 已达到连续运行 ${machine.maxRunMinutes} 分钟上限，继续保活会被 InstaBox 拒绝。下一保活时段会自动重新开始。`,
      );
      lastResult = 'limit_reached';
      lastMessage = `${machine.name || machine.id} 已达到运行上限，本时段停止保活`;
      return;
    }
  }

  const machineId = String(machine.id);
  const scheduledSuspend = !!config.scheduleSuspend?.[machineId];
  const skipped = skipMessage(machine, scheduledSuspend);
  if (skipped) {
    lastResult = 'skipped';
    lastMessage = skipped;
    return;
  }

  const cooldownUntil = cooldownUntilMsByMachine.get(String(machine.id)) ?? 0;
  if (cooldownUntil > now.getTime()) {
    lastResult = 'skipped';
    lastMessage = `${machine.name || machine.id} 处于 InstaBox 冷却期，${new Date(cooldownUntil).toLocaleString('zh-CN')} 后自动恢复保活`;
    return;
  }

  const startAction = resolveInstaboxStartAction(machine);
  if (startAction === 'pending') {
    lastResult = 'skipped';
    lastMessage = `${machine.name || machineId} 正在开关机，等待状态稳定`;
    return;
  }
  if (startAction === 'skip') {
    lastResult = 'skipped';
    lastMessage = `${machine.name || machineId} 当前状态 ${machine.state}，保活不会自动启动它`;
    return;
  }
  // 每分钟只做一次轻量状态查询，真正的 wake 仍按 20 分钟一次，
  // 这样客户机重启导致的 stopped 能在一分钟内被发现并拉起。
  if (
    startAction === 'wake'
    && lastKeepaliveAtMs !== null
    && now.getTime() - lastKeepaliveAtMs < KEEPALIVE_INTERVAL_MS
  ) {
    lastResult = 'kept_alive';
    lastMessage = `${machine.name || machineId} 保活中，下次唤醒 ${new Date(lastKeepaliveAtMs + KEEPALIVE_INTERVAL_MS).toLocaleString('zh-CN')}`;
    return;
  }

  try {
    if (startAction === 'resume') {
      await runInstaboxMachineAction(machineId, 'resume');
    } else if (startAction === 'start') {
      await runInstaboxMachineAction(machineId, 'start');
    } else {
      await wakeInstaboxMachine(machineId);
    }
    if (scheduledSuspend) await clearScheduleSuspend(machineId);
    lastKeepaliveAtMs = now.getTime();
    lastError = null;
    lastResult = 'kept_alive';
    lastMessage = startAction === 'resume' || startAction === 'start'
      ? `${machine.name || machine.id} 已按计划开机（${startAction === 'start' ? '冷启动' : '恢复中'}）`
      : `${machine.name || machine.id} 已保活`;
  } catch (error) {
    const apiError = error instanceof InstaboxApiError ? error : null;
    if (apiError?.code === 'machine_cooldown' || apiError?.code === 'max_run_disabled') {
      // 冷却有明确结束时间：到点后本时段还能接着保活，只有冷却跨过时段
      // 末尾才放弃这一轮。早期把所有 409 都当成“本时段结束”，导致机器
      // 明明 16:54 就恢复可用，却整晚都不再被唤醒。
      const untilMs = apiError.retryAfterSeconds && apiError.retryAfterSeconds > 0
        ? now.getTime() + apiError.retryAfterSeconds * 1000
        : null;
      if (untilMs !== null && untilMs < activeWindow.endAt.getTime()) {
        cooldownUntilMsByMachine.set(String(machine.id), untilMs);
        lastResult = 'skipped';
        lastMessage = `${machine.name || machine.id} 处于冷却期，${new Date(untilMs).toLocaleString('zh-CN')} 后自动恢复保活`;
        notifyOnce(
          `${machine.id}:cooldown:${untilMs}`,
          'warning',
          'InstaBox 机器冷却中',
          `${machine.name || machine.id} 被自动暂停，冷却至 ${new Date(untilMs).toLocaleString('zh-CN')}，之后会自动恢复保活。`,
        );
        return;
      }
      gaveUpWindowKeys.add(key);
      notifyOnce(
        `${key}:limit`,
        'warning',
        'InstaBox 本时段无法继续保活',
        `${machine.name || machine.id} 当前处于运行上限或长时间冷却：${apiError.message}。本时段不再重复唤醒，下一保活时段会自动继续。`,
      );
      lastResult = 'limit_reached';
      lastMessage = apiError.message;
      return;
    }
    if (apiError?.code === 'operation_conflict' || apiError?.code === 'machine_not_running') {
      lastResult = 'skipped';
      lastMessage = apiError.message;
      return;
    }
    lastError = error instanceof Error ? error.message : String(error);
    lastResult = 'error';
    lastMessage = `保活失败：${lastError}`;
    notifyOnce(`${key}:error:${lastError}`, 'error', 'InstaBox 保活失败', lastMessage);
  }
}


/**
 * 到达窗口结束时间后主动关机。InstaBox 免费套餐的「停止」会让机器进入
 * stopped 状态且不再被保活自动拉起，所以这里用 suspend（暂停）：磁盘与
 * 进程现场保留，第二天窗口开始时可以直接 wake。
 * 返回是否已经处理完成（已关机或无需处理）。
 */
async function suspendMachineForSchedule(
  machine: any,
  now: Date,
  boundaryAt: Date,
): Promise<boolean> {
  const machineId = String(machine.id);
  const name = machine.name || machineId;
  if (machine.state === 'suspended' || machine.state === 'stopped') {
    lastResult = 'suspended';
    lastMessage = `${name} 已关机（计划关机时间 ${boundaryAt.toLocaleTimeString('zh-CN', { hour12: false })}）`;
    return true;
  }
  if (machine.state === 'deleting' || machine.state === 'deleted') {
    lastResult = 'skipped';
    lastMessage = `${name} 正在删除，无法执行计划关机`;
    return true;
  }

  const key = `${machineId}:suspend:${boundaryAt.toISOString()}`;
  try {
    await runInstaboxMachineAction(machineId, 'suspend');
    await rememberScheduleSuspend(machineId);
    lastError = null;
    lastResult = 'suspended';
    const nextStart = resolveNextInstaboxKeepaliveWindowStart(now);
    lastMessage = `${name} 已按计划关机，下次开机 ${nextStart ? nextStart.toLocaleString() : '-'}`;
    notifyOnce(
      key,
      'info',
      'InstaBox 已按计划关机',
      `${name} 已于 ${now.toLocaleString('zh-CN')} 关机（计划 ${boundaryAt.toLocaleTimeString('zh-CN', { hour12: false })}），将在下一个保活时段自动开机。`,
    );
    return true;
  } catch (error) {
    const apiError = error instanceof InstaboxApiError ? error : null;
    if (
      apiError?.code === 'machine_not_running'
      || apiError?.code === 'operation_conflict'
      || apiError?.code === 'invalid_state'
    ) {
      lastResult = 'suspended';
      lastMessage = `${name} 已经处于关机状态`;
      return true;
    }
    lastError = error instanceof Error ? error.message : String(error);
    lastResult = 'error';
    lastMessage = `计划关机失败：${lastError}`;
    notifyOnce(`${key}:error`, 'error', 'InstaBox 计划关机失败', lastMessage);
    return false;
  }
}

async function tick(): Promise<void> {
  if (!schedulerReady || tickInFlight) return;
  const now = new Date();
  const nowMs = now.getTime();
  const previousTickMs = lastTickAtMs ?? nowMs - TICK_MS;
  lastTickAtMs = nowMs;
  lastTickAtIso = now.toISOString();
  if (!config.enabled) {
    lastResult = 'disabled';
    lastMessage = '自动开关机与保活已关闭';
    return;
  }

  const activeWindow = resolveInstaboxKeepaliveWindow(now);
  const transitions = resolveInstaboxScheduleActions(new Date(previousTickMs), now);
  const crossedSuspendAt = [...transitions]
    .filter((item) => item.action === 'suspend')
    .map((item) => item.at)
    .pop() ?? null;
  // 服务在整点后重启时，tick 基线只有 60 秒，会漏掉边界；这里补一次关机。
  const catchUpSuspendAt = activeWindow ? null : resolveRecentInstaboxWindowEnd(now);
  const suspendAt = crossedSuspendAt ?? catchUpSuspendAt;
  const crossedStart = transitions.some((item) => item.action === 'start');

  if (!activeWindow && !suspendAt) {
    const nextStart = resolveNextInstaboxKeepaliveWindowStart(now);
    lastResult = 'idle';
    lastMessage = nextStart
      ? `当前不在开关机时段（机器应保持关机），下次开机 ${nextStart.toLocaleString()}`
      : '当前不在开关机时段（机器应保持关机）';
    return;
  }

  if (suspendAt && lastCompletedSuspendBoundaryMs === suspendAt.getTime()) {
    lastResult = 'suspended';
    lastMessage = `已按计划关机（${suspendAt.toLocaleTimeString('zh-CN', { hour12: false })}），下次开机 ${resolveNextInstaboxKeepaliveWindowStart(now)?.toLocaleString() ?? '-'}`;
    return;
  }

  // 窗口开始这一刻强制唤醒一次，不受 20 分钟节流影响。
  if (crossedStart) lastKeepaliveAtMs = null;

  tickInFlight = true;
  lastAttemptAtMs = nowMs;
  try {
    const result = await listInstaboxMachines();
    const machines = Array.isArray(result.machines) ? result.machines : [];
    const candidates = machines.filter((machine: any) => machine?.id);
    if (candidates.length === 0) {
      lastMachine = null;
      lastResult = 'skipped';
      lastMessage = '没有可保活的机器';
      return;
    }

    // 单人使用且免费套餐只有一台机器；即使以后有多台也顺序处理，避免同时唤醒。
    let allSuspended = true;
    for (const machine of candidates) {
      lastMachine = { id: machine.id, name: machine.name || machine.id, state: machine.state };
      if (suspendAt) {
        const handled = await suspendMachineForSchedule(machine, now, suspendAt);
        if (!handled) allSuspended = false;
        continue;
      }
      if (machine.state === 'running' && config.scheduleSuspend?.[String(machine.id)]) {
        await clearScheduleSuspend(String(machine.id));
      }
      await keepMachineAwake(machine, now, activeWindow!);
    }
    if (suspendAt && allSuspended) lastCompletedSuspendBoundaryMs = suspendAt.getTime();
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    lastResult = 'error';
    lastMessage = `保活检查失败：${lastError}`;
  } finally {
    tickInFlight = false;
  }
}

export async function getInstaboxKeepaliveStatus(now = new Date()): Promise<InstaboxKeepaliveStatus> {
  const activeWindow = resolveInstaboxKeepaliveWindow(now);
  const nextStart = resolveNextInstaboxKeepaliveWindowStart(now);
  const nextKeepalive = lastKeepaliveAtMs === null
    ? null
    : lastKeepaliveAtMs + KEEPALIVE_INTERVAL_MS;
  return {
    enabled: config.enabled,
    windows: INSTABOX_KEEPALIVE_WINDOWS,
    intervalMinutes: Math.round(KEEPALIVE_INTERVAL_MS / 60_000),
    inWindow: !!activeWindow,
    currentWindow: activeWindow?.window ?? null,
    nextWindowStart: nextStart?.toISOString() ?? null,
    lastTickAt: lastTickAtIso,
    lastAttemptAt: iso(lastAttemptAtMs),
    lastKeepaliveAt: iso(lastKeepaliveAtMs),
    nextKeepaliveAt: nextKeepalive === null ? null : iso(nextKeepalive),
    machine: lastMachine,
    lastResult,
    message: lastMessage,
    lastError,
  };
}

export async function setInstaboxKeepaliveEnabled(enabled: boolean): Promise<InstaboxKeepaliveStatus> {
  config = { enabled: enabled === true };
  await upsertSetting(SETTING_KEY, config);
  lastError = null;
  if (!config.enabled) {
    lastResult = 'disabled';
    lastMessage = '自动保活已关闭';
  } else {
    lastResult = 'idle';
    lastMessage = '自动开关机与保活已开启，等待检查';
    lastAttemptAtMs = null;
    lastTickAtMs = null;
    void tick();
  }
  return getInstaboxKeepaliveStatus();
}

export function startInstaboxKeepaliveScheduler(): void {
  stopInstaboxKeepaliveScheduler();
  void loadStoredConfig()
    .then((stored) => {
      config = stored;
      schedulerReady = true;
      void tick();
    })
    .catch(() => {
      config = { enabled: true };
      schedulerReady = true;
      void tick();
    });
  schedulerTimer = setInterval(() => { void tick(); }, TICK_MS);
  schedulerTimer.unref?.();
}

export function stopInstaboxKeepaliveScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerReady = false;
  lastAttemptAtMs = null;
  lastKeepaliveAtMs = null;
  lastTickAtMs = null;
  lastCompletedSuspendBoundaryMs = null;
  lastMachine = null;
}

export function resetInstaboxKeepaliveStateForTests(): void {
  config = { enabled: true };
  schedulerReady = false;
  tickInFlight = false;
  lastAttemptAtMs = null;
  lastKeepaliveAtMs = null;
  lastTickAtIso = null;
  lastTickAtMs = null;
  lastCompletedSuspendBoundaryMs = null;
  lastError = null;
  lastMachine = null;
  lastResult = 'idle';
  lastMessage = '保活调度尚未启动';
  gaveUpWindowKeys.clear();
  notifiedKeys.clear();
}
