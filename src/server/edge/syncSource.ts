import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { parseSettingFromMap } from '../runtimeSettingsHydration.js';
import { getEdgeEnv } from './edgeEnv.js';
import { readEdgeLocalSetting, writeEdgeLocalSetting } from './logArchive.js';
import { rehydrateLocalRuntimeSettings } from './localSettingsPolicy.js';

/** 本机管理员令牌的设置键（与主服务一致，见 runtimeSettingsHydration）。 */
export const ADMIN_TOKEN_SETTING_KEY = 'auth_token';

/** 服务器地址在本地 SQLite 里的设置键：它是本机的连接参数，登录页要回填，必须跨重启保留。 */
export const SOURCE_URL_SETTING_KEY = 'edge_sync_source_url';

/** 旧版把服务器地址写在这个 JSON 文件里；升级后搬进本地 SQLite 并删掉这个文件。 */
const LEGACY_CONNECTION_FILE = 'edge-connection.json';

export type EdgeSyncSource = {
  /** 配置源（服务器）地址，末尾不带斜杠。 */
  url: string;
  /** 配置源管理令牌（服务器 AUTH_TOKEN）。 */
  token: string;
};

/**
 * 规整服务器地址：去掉首尾空格与结尾斜杠；只填了 IP 或 IP:端口 时补上 http://。
 * 用户通常只填「43.142.48.105 / 4000」，补协议这件事放在服务端做，前端只负责收集输入。
 */
export function normalizeEdgeSourceUrl(raw: string): string {
  const trimmed = (raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/**
 * 读当前同步源：地址来自本地 SQLite（登录页写入），令牌来自内存库里的本机管理员令牌。
 * 令牌不落盘，进程重启后要重新登录。
 */
export async function readEdgeSyncSource(): Promise<EdgeSyncSource> {
  const rows = await db.select().from(schema.settings).all() as Array<{ key: string; value: string }>;
  const settingsMap = new Map(rows.map((row) => [row.key, row.value]));

  return {
    url: readSavedSourceUrl(),
    token: (parseSettingFromMap<string>(settingsMap, ADMIN_TOKEN_SETTING_KEY) || '').trim(),
  };
}

/** 读本地 SQLite 里保存的服务器地址；首次读到时先把旧版 JSON 文件搬进来。 */
function readSavedSourceUrl(): string {
  migrateLegacyConnectionFile();
  return normalizeEdgeSourceUrl(readEdgeLocalSetting(SOURCE_URL_SETTING_KEY));
}

/** 旧版连接文件的搬迁只尝试一次，避免每次读状态都去碰磁盘。 */
let legacyConnectionMigrated = false;

/**
 * 把旧版 edge-connection.json 里的服务器地址搬进本地 SQLite，然后删掉旧文件。
 * 本地存储还没就绪时保留原文件，下次启动重试；文件本身损坏则直接清掉，它已经没有可搬的内容。
 */
function migrateLegacyConnectionFile(): void {
  if (legacyConnectionMigrated) return;
  const path = join(getEdgeEnv().dataDirAbsolute, LEGACY_CONNECTION_FILE);
  if (!existsSync(path)) {
    legacyConnectionMigrated = true;
    return;
  }

  let raw = '';
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    legacyConnectionMigrated = true;
    return;
  }
  let url = '';
  try {
    url = normalizeEdgeSourceUrl(String((JSON.parse(raw) as { url?: unknown })?.url ?? ''));
  } catch {
    url = '';
  }

  try {
    // 已经有值时以 SQLite 为准，旧文件只负责清理。
    if (url && !readEdgeLocalSetting(SOURCE_URL_SETTING_KEY)) {
      writeEdgeLocalSetting(SOURCE_URL_SETTING_KEY, url);
    }
    rmSync(path, { force: true });
    legacyConnectionMigrated = true;
    console.log('[edge] 已把旧版 edge-connection.json 里的服务器地址搬进本地 SQLite。');
  } catch (error) {
    console.warn(`[edge] 旧版连接文件迁移失败，已保留原文件：${(error as Error)?.message || String(error)}`);
  }
}

/** 把服务器地址写进本地 SQLite，并清掉旧版 JSON 文件，避免数据目录里留两份配置。 */
function writeSavedSourceUrl(url: string): void {
  writeEdgeLocalSetting(SOURCE_URL_SETTING_KEY, url);
  rmSync(join(getEdgeEnv().dataDirAbsolute, LEGACY_CONNECTION_FILE), { force: true });
  legacyConnectionMigrated = true;
}

/**
 * 保存同步源（登录页与「同步设置」都走这里）。
 * 地址落本地 SQLite；令牌写进内存库的 auth_token，所以本地管理接口的鉴权令牌与服务器保持一致；
 * 写完立刻热加载，后续 /api/* 请求就能用这个令牌通过本地校验。
 */
export async function saveEdgeSyncSource(input: { url: string; token: string }): Promise<EdgeSyncSource> {
  const url = normalizeEdgeSourceUrl(input.url);
  const token = (input.token || '').trim();

  writeSavedSourceUrl(url);
  await upsertSetting(ADMIN_TOKEN_SETTING_KEY, token);
  await rehydrateLocalRuntimeSettings();

  return { url, token };
}

