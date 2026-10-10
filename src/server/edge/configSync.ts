import { createHash } from 'node:crypto';
import { importBackup } from '../services/backupService.js';
import * as routeRefreshWorkflow from '../services/routeRefreshWorkflow.js';
import { invalidateSiteProxyCache } from '../services/siteProxy.js';
import { invalidateTokenRouterCache } from '../services/tokenRouter.js';
import { getEdgeEnv } from './edgeEnv.js';
import { applyForwardRulesSnapshot, type ForwardRulesSnapshot } from './forwardRulesMirror.js';
import { reapplyLocalForwardEditsAfterSync } from './forwardLocalEdits.js';
import { flushEdgeLogs, restoreEdgeLogs } from './logArchive.js';
import {
  buildLocalPreferencesPayload,
  rehydrateLocalRuntimeSettings,
  type SettingsEntry,
} from './localSettingsPolicy.js';
import { readEdgeSyncSource, type EdgeSyncSource } from './syncSource.js';

export type EdgeSyncSections = {
  accounts: boolean;
  preferences: boolean;
  forwardRules: boolean;
};

export type EdgeSyncResult =
  | { ok: true; imported: boolean; sections: EdgeSyncSections; at: string }
  | { ok: false; message: string; at: string };

/** 各段上次成功导入时的内容指纹：内容没变就跳过导入，避免每次全表重建。 */
const lastHashes: { accounts: string | null; preferences: string | null; forwardRules: string | null } = {
  accounts: null,
  preferences: null,
  forwardRules: null,
};

let lastSyncAt: string | null = null;
let lastSyncError: string | null = null;
let lastSyncSections: EdgeSyncSections = { accounts: false, preferences: false, forwardRules: false };
let inFlight: Promise<EdgeSyncResult> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** 「恢复服务器顺序」用：这一次同步强制重新导入模型转发快照，不吃内容指纹。 */
let forceForwardRulesNext = false;

/**
 * 稳定序列化：递归排序对象 key，并剔除每次都变的字段，
 * 这样导出的 timestamp / generatedAt 不会让指纹每次都变化。
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'timestamp' && key !== 'exportedAt' && key !== 'generatedAt')
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null) ?? 'null';
}

function hashSection(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** 单次拉取的超时：配置源不可达时不能让同步和启动流程一直挂着。 */
const CONFIG_SOURCE_TIMEOUT_MS = 30_000;

/** 从服务器拉一段只读配置；这里只发 GET，绝不对配置源做任何写操作。 */
async function fetchConfigSource(source: EdgeSyncSource, path: string): Promise<unknown> {
  const response = await fetch(`${source.url}${path}`, {
    headers: { authorization: `Bearer ${source.token}` },
    signal: AbortSignal.timeout(CONFIG_SOURCE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`配置源 ${path} 返回 HTTP ${response.status}`);
  }
  return await response.json();
}

function readAccountsSection(payload: unknown): unknown {
  const section = (payload as { accounts?: unknown } | null)?.accounts;
  if (!section || typeof section !== 'object') {
    throw new Error('配置源返回的 accounts 段格式不对，请确认服务器版本与本地一致。');
  }
  return section;
}

function readPreferencesSettings(payload: unknown): SettingsEntry[] {
  const settings = (payload as { preferences?: { settings?: unknown } } | null)?.preferences?.settings;
  if (!Array.isArray(settings)) {
    throw new Error('配置源返回的 preferences 段格式不对。');
  }
  return settings as SettingsEntry[];
}

function readForwardSnapshot(payload: unknown): ForwardRulesSnapshot {
  const candidate = payload as { rules?: unknown; targets?: unknown } | null;
  if (!Array.isArray(candidate?.rules) || !Array.isArray(candidate?.targets)) {
    throw new Error('配置源没有返回模型转发规则快照，服务器版本可能太旧，需要先升级服务器。');
  }
  return candidate as ForwardRulesSnapshot;
}

function readPayloadVersion(payload: unknown): unknown {
  return (payload as { version?: unknown } | null)?.version;
}

/**
 * 拉一次配置源并落到本地库。
 * 单飞：同一时刻只跑一次，慢的同步不会堆积。失败不退出进程，只把错误抛给状态接口。
 */
export function syncEdgeConfig(): Promise<EdgeSyncResult> {
  if (inFlight) return inFlight;
  inFlight = runSync().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync(): Promise<EdgeSyncResult> {
  const forceForwardRules = forceForwardRulesNext;
  forceForwardRulesNext = false;
  const source = await readEdgeSyncSource();
  if (!source.url || !source.token) {
    // 还没登录（登录页只填了地址、令牌还没进来）：这不是故障，定时同步安静跳过，不写成错误状态。
    return { ok: false, message: '还没有配置同步源：请先填写服务器地址和管理令牌。', at: new Date().toISOString() };
  }

  try {
    const accountsPayload = await fetchConfigSource(source, '/api/settings/backup/export?type=accounts');
    const preferencesPayload = await fetchConfigSource(source, '/api/settings/backup/export?type=preferences');
    const forwardPayload = await fetchConfigSource(source, '/api/edge/model-forward-rules');

    const accountsSection = readAccountsSection(accountsPayload);
    const settings = readPreferencesSettings(preferencesPayload);
    const forwardSnapshot = readForwardSnapshot(forwardPayload);

    const accountsHash = hashSection(accountsSection);
    const preferencesHash = hashSection(settings);
    const forwardRulesHash = hashSection({ rules: forwardSnapshot.rules, targets: forwardSnapshot.targets });

    const sections: EdgeSyncSections = {
      accounts: accountsHash !== lastHashes.accounts,
      preferences: preferencesHash !== lastHashes.preferences,
      forwardRules: forceForwardRules || forwardRulesHash !== lastHashes.forwardRules,
    };

    if (!sections.accounts && !sections.preferences && !sections.forwardRules) {
      return recordSuccess(false, sections);
    }

    if (sections.accounts) {
      // 导入账号会级联删掉本机日志，先把内存里最后一段（归档定时器还没刷到）刷进归档。
      flushEdgeLogs();
      await importBackup(accountsPayload as Parameters<typeof importBackup>[0]);
      // 导入账号会重建站点/账号并级联删掉本机使用日志，这里立刻从归档读回来，避免日志凭空少一段。
      restoreEdgeLogs();
    }

    // 规则镜像必须排在 accounts 导入之后：导入重建 accounts/sites 会级联删掉本地转发目标行。
    if (sections.accounts || sections.forwardRules) {
      await applyForwardRulesSnapshot(forwardSnapshot);
    }

    if (sections.preferences) {
      await importBackup(buildLocalPreferencesPayload({
        version: readPayloadVersion(preferencesPayload),
        settings,
        timestamp: Date.now(),
      }));
      // 顺序必须是先落库、再热加载，否则 config 里还是服务器那份代理地址。
      await rehydrateLocalRuntimeSettings();
    }

    if (sections.accounts) {
      invalidateTokenRouterCache();
      invalidateSiteProxyCache();
      await routeRefreshWorkflow.rebuildRoutesOnly();
    }

    // 本机的顺序 / 启停是「这台机器先用哪个源」的开关：快照指纹没变就重新盖回镜像，
    // 服务器那边改过模型转发规则（指纹变了）就整份作废 —— 永远以服务器为准。
    // 必须排在 rebuildRoutesOnly 之后，不然路由重建会把本机顺序冲掉。
    if (sections.accounts || sections.forwardRules) {
      await reapplyLocalForwardEditsAfterSync(forwardRulesHash);
    }

    lastHashes.accounts = accountsHash;
    lastHashes.preferences = preferencesHash;
    lastHashes.forwardRules = forwardRulesHash;
    return recordSuccess(true, sections);
  } catch (error) {
    return recordFailure((error as Error)?.message || String(error));
  }
}

function recordSuccess(imported: boolean, sections: EdgeSyncSections): EdgeSyncResult {
  lastSyncAt = new Date().toISOString();
  lastSyncError = null;
  lastSyncSections = sections;
  return { ok: true, imported, sections, at: lastSyncAt };
}

function recordFailure(message: string): EdgeSyncResult {
  // 失败时保留 lastSyncAt（那仍是最后一次成功的时间），只更新错误信息。
  lastSyncError = message;
  return { ok: false, message, at: new Date().toISOString() };
}

/**
 * 「恢复服务器顺序」用：强制重新导入一次模型转发快照。
 * 先等正在跑的那次同步收尾，避免两次导入并发把镜像写乱。
 */
export async function syncEdgeForwardRules(): Promise<EdgeSyncResult> {
  if (inFlight) await inFlight.catch(() => undefined);
  forceForwardRulesNext = true;
  return await syncEdgeConfig();
}

/** 启动定时同步（间隔默认 5 分钟，可由 METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS 覆盖）。 */
export function startEdgeConfigSync(): void {
  if (timer) return;
  const edge = getEdgeEnv();
  timer = setInterval(() => {
    void syncEdgeConfig();
  }, edge.syncIntervalMs);
  // 别让定时器挡着进程退出。
  timer.unref?.();
}

export function stopEdgeConfigSync(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function getEdgeConfigSyncState() {
  return {
    intervalMs: getEdgeEnv().syncIntervalMs,
    lastSyncAt,
    lastSyncError,
    lastSyncSections,
  };
}
