import { db, schema } from '../db/index.js';
import { applyRuntimeSettings } from '../runtimeSettingsHydration.js';

/** settings 表里的一行（value 为 JSON 文本）。 */
export type SettingsEntry = { key: string; value: unknown };

/**
 * 本地强行改写的 settings：照抄服务器的值会在本地出错或产生副作用。
 * 这些项在同步时一律用下面的固定值覆盖服务器那份。
 */
export const EDGE_OVERRIDE_SETTINGS: Record<string, unknown> = {
  // 服务器那份通常指向服务器自己的本地代理（127.0.0.1:7890），本地照抄必然连接失败。
  system_proxy_url: '',
  // 本地只监听 127.0.0.1，照抄服务器的 IP 白名单会把本地浏览器挡在门外。
  admin_ip_allowlist: '',
  // 边缘实例不发任何通知：否则本地一次转发失败就会和服务器的告警重复。
  webhook_enabled: false,
  bark_enabled: false,
  serverchan_enabled: false,
  telegram_enabled: false,
  smtp_enabled: false,
};

/** 本地直接丢弃、不写入的 settings：属于服务器侧的备份行为，镜像过来只会误导。 */
export const EDGE_IGNORED_SETTING_KEYS = new Set<string>([
  'backup_webdav_config_v1',
  'backup_webdav_state_v1',
]);

export type LocalPreferencesPayload = {
  version: string;
  timestamp: number;
  type: 'preferences';
  preferences: { settings: SettingsEntry[] };
};

/** 服务器备份载荷的版本号格式（见 backupService 的 BACKUP_VERSION）。 */
const FALLBACK_BACKUP_VERSION = '2.1';

function normalizeBackupVersion(value: unknown): string {
  return typeof value === 'string' && value.startsWith('2') ? value : FALLBACK_BACKUP_VERSION;
}

/**
 * 按本地策略裁剪服务器导出的 preferences 段，产出可直接交给 importBackup 的载荷。
 * 覆盖项放在最后：导入按行 upsert，后写的胜出。
 */
export function buildLocalPreferencesPayload(input: {
  version?: unknown;
  settings: SettingsEntry[];
  timestamp: number;
}): LocalPreferencesPayload {
  const kept: SettingsEntry[] = [];
  const seen = new Set<string>();

  for (const entry of input.settings) {
    const key = String(entry?.key ?? '').trim();
    if (!key || seen.has(key)) continue;
    if (EDGE_IGNORED_SETTING_KEYS.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(EDGE_OVERRIDE_SETTINGS, key)) continue;
    seen.add(key);
    kept.push({ key, value: entry.value });
  }

  for (const [key, value] of Object.entries(EDGE_OVERRIDE_SETTINGS)) {
    kept.push({ key, value });
  }

  return {
    version: normalizeBackupVersion(input.version),
    timestamp: input.timestamp,
    type: 'preferences',
    preferences: { settings: kept },
  };
}

/**
 * 把本地 settings 表里的值热加载进 config。
 * 只用 applyRuntimeSettings（纯赋值），不碰任何调度器。
 */
export async function rehydrateLocalRuntimeSettings(): Promise<void> {
  const rows = await db.select().from(schema.settings).all() as Array<{ key: string; value: string }>;
  applyRuntimeSettings(new Map(rows.map((row) => [row.key, row.value])));
}
