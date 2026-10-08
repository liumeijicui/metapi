import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { parseSettingFromMap } from '../runtimeSettingsHydration.js';
import { getEdgeEnv } from './edgeEnv.js';
import { rehydrateLocalRuntimeSettings } from './localSettingsPolicy.js';

/** 同步源地址存这个设置键；登录令牌直接复用本机管理员令牌 auth_token。 */
export const EDGE_SYNC_SOURCE_URL_KEY = 'edge_sync_source_url';

/** 本机管理员令牌的设置键（与主服务一致，见 runtimeSettingsHydration）。 */
export const ADMIN_TOKEN_SETTING_KEY = 'auth_token';

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
 * 读当前同步源：地址来自设置表（登录页写入），令牌就是本机管理员令牌。
 * 环境变量只在设置表为空时兜底，方便本地联调。
 */
export async function readEdgeSyncSource(): Promise<EdgeSyncSource> {
  const rows = await db.select().from(schema.settings).all() as Array<{ key: string; value: string }>;
  const settingsMap = new Map(rows.map((row) => [row.key, row.value]));
  // 环境变量由 edgeEnv 统一解析（本地联调用），设置表里的值优先。
  const env = getEdgeEnv();

  return {
    url: normalizeEdgeSourceUrl(
      parseSettingFromMap<string>(settingsMap, EDGE_SYNC_SOURCE_URL_KEY)
      || env.configSourceUrl,
    ),
    token: (
      parseSettingFromMap<string>(settingsMap, ADMIN_TOKEN_SETTING_KEY)
      || env.configSourceToken
    ).trim(),
  };
}

/**
 * 保存同步源（登录页与「同步设置」都走这里）。
 * 令牌写进 auth_token，所以本地管理接口的鉴权令牌与服务器保持一致；
 * 写完立刻热加载，后续 /api/* 请求就能用这个令牌通过本地校验。
 */
export async function saveEdgeSyncSource(input: { url: string; token: string }): Promise<EdgeSyncSource> {
  const url = normalizeEdgeSourceUrl(input.url);
  const token = (input.token || '').trim();

  await upsertSetting(EDGE_SYNC_SOURCE_URL_KEY, url);
  await upsertSetting(ADMIN_TOKEN_SETTING_KEY, token);
  await rehydrateLocalRuntimeSettings();

  return { url, token };
}
