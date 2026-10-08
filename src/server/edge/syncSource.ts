import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { parseSettingFromMap } from '../runtimeSettingsHydration.js';
import { getEdgeEnv } from './edgeEnv.js';
import { rehydrateLocalRuntimeSettings } from './localSettingsPolicy.js';

/** 本机管理员令牌的设置键（与主服务一致，见 runtimeSettingsHydration）。 */
export const ADMIN_TOKEN_SETTING_KEY = 'auth_token';

/**
 * 服务器地址存在数据目录下的这个文件里：它是本机的连接参数，登录页要回填。
 * 令牌不落盘，只留在内存库里，进程重启后要重新登录。
 */
const CONNECTION_FILE = 'edge-connection.json';

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
 * 读当前同步源：地址来自本机连接文件（登录页写入），令牌来自内存库里的本机管理员令牌。
 */
export async function readEdgeSyncSource(): Promise<EdgeSyncSource> {
  const rows = await db.select().from(schema.settings).all() as Array<{ key: string; value: string }>;
  const settingsMap = new Map(rows.map((row) => [row.key, row.value]));

  return {
    url: readSavedSourceUrl(),
    token: (parseSettingFromMap<string>(settingsMap, ADMIN_TOKEN_SETTING_KEY) || '').trim(),
  };
}

/** 读连接文件里的服务器地址；文件不存在或损坏就当作没配过。 */
function readSavedSourceUrl(): string {
  try {
    const parsed = JSON.parse(readFileSync(connectionFilePath(), 'utf8')) as { url?: unknown };
    return normalizeEdgeSourceUrl(typeof parsed.url === 'string' ? parsed.url : '');
  } catch {
    return '';
  }
}

function connectionFilePath(): string {
  return join(getEdgeEnv().dataDirAbsolute, CONNECTION_FILE);
}

function writeSavedSourceUrl(url: string): void {
  writeFileSync(connectionFilePath(), `${JSON.stringify({ url }, null, 2)}\n`, 'utf8');
}

/**
 * 保存同步源（登录页与「同步设置」都走这里）。
 * 令牌写进 auth_token，所以本地管理接口的鉴权令牌与服务器保持一致；
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
