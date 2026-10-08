import { useSyncExternalStore } from 'react';
import { getAuthToken } from './authSession.js';

/** 边缘版的同步分段：哪一段这次真的变了。 */
export type EdgeSyncSections = {
  accounts: boolean;
  preferences: boolean;
  forwardRules: boolean;
};

/**
 * 边缘版默认服务器：登录页第一次打开时回填，用户改这里或直接在界面上改都行。
 * 端口用 nginx 对外暴露的 81（服务器的 4000 只在云安全组内网口放通）。
 */
export const EDGE_DEFAULT_SERVER_HOST = '43.142.48.105';
export const EDGE_DEFAULT_SERVER_PORT = '81';

/** /api/edge/status 的形状（只有边缘实例会返回 edgeMode=true）。 */
export type EdgeStatus = {
  edgeMode: boolean;
  dataDir: string;
  port: number;
  configSource: { url: string; hasToken: boolean };
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncSections: EdgeSyncSections;
  intervalMs: number;
};

type EdgeSyncResult = { ok: boolean; imported?: boolean; message?: string };

let cachedStatus: EdgeStatus | null = null;
const listeners = new Set<() => void>();

function publish(next: EdgeStatus | null): void {
  cachedStatus = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 缓存里的边缘状态；null 表示当前不是边缘实例（或还没探测过）。 */
export function getCachedEdgeStatus(): EdgeStatus | null {
  return cachedStatus;
}

/**
 * 页面用它判断自己是不是跑在 exe 里。
 * 普通服务器版探测不到 /api/edge/status，返回 null，所有边缘 UI 自动隐藏。
 */
export function useEdgeStatus(): EdgeStatus | null {
  return useSyncExternalStore(subscribe, getCachedEdgeStatus, getCachedEdgeStatus);
}

function normalizeEdgeStatus(payload: Partial<EdgeStatus>): EdgeStatus {
  const configSource = payload.configSource || { url: '', hasToken: false };
  const sections = payload.lastSyncSections;
  return {
    edgeMode: true,
    dataDir: String(payload.dataDir || ''),
    port: Number(payload.port) || 0,
    configSource: { url: String(configSource.url || ''), hasToken: configSource.hasToken === true },
    lastSyncAt: typeof payload.lastSyncAt === 'string' ? payload.lastSyncAt : null,
    lastSyncError: typeof payload.lastSyncError === 'string' ? payload.lastSyncError : null,
    lastSyncSections: {
      accounts: sections?.accounts === true,
      preferences: sections?.preferences === true,
      forwardRules: sections?.forwardRules === true,
    },
    intervalMs: Number(payload.intervalMs) || 0,
  };
}

/** 探一次边缘实例状态，并把结果广播给所有页面。 */
export async function refreshEdgeStatus(): Promise<EdgeStatus | null> {
  try {
    const response = await fetch('/api/edge/status', { headers: { accept: 'application/json' } });
    if (!response.ok) {
      publish(null);
      return null;
    }
    const payload = await response.json() as Partial<EdgeStatus>;
    const status = payload?.edgeMode === true ? normalizeEdgeStatus(payload) : null;
    publish(status);
    return status;
  } catch {
    publish(null);
    return null;
  }
}

export type EdgeServerAddress = {
  scheme: 'http' | 'https';
  host: string;
  port: string;
};

/** 状态面板里显示的上次同步时间；没有或解析不了就返回空串。 */
export function formatEdgeSyncTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', { hour12: false });
}

/** 拆地址：支持「43.142.48.105」「43.142.48.105:4000」「https://域名」三种写法。 */
export function splitServerAddress(raw: string): EdgeServerAddress {
  const text = (raw || '').trim().replace(/\/+$/, '');
  if (!text) return { scheme: 'http', host: '', port: '' };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(text);
  const scheme = withScheme && /^https:\/\//i.test(text) ? 'https' : 'http';
  const rest = withScheme ? text.slice(withScheme[0].length) : text;
  const [hostPart, portPart = ''] = rest.split('/')[0].split(':');

  return {
    scheme,
    host: hostPart || '',
    port: /^\d+$/.test(portPart) ? portPart : '',
  };
}

/** 组装地址，默认端口（80 / 443）不写进 URL。 */
export function buildServerAddress(input: { scheme: string; host: string; port: string }): string {
  const host = (input.host || '').trim().replace(/\/+$/, '');
  if (!host) return '';

  const scheme = input.scheme === 'https' ? 'https' : 'http';
  const port = (input.port || '').trim();
  const defaultPort = scheme === 'https' ? '443' : '80';
  return `${scheme}://${host}${port && port !== defaultPort ? `:${port}` : ''}`;
}

/**
 * 界面上显示服务器地址用的简写：只留「IP:端口」（默认端口不写），协议看 title 里的完整 URL。
 * 拆不出来时返回空串，调用方自己决定显示什么。
 */
export function formatServerHostPort(raw: string): string {
  const parts = splitServerAddress(raw);
  if (!parts.host) return '';

  const defaultPort = parts.scheme === 'https' ? '443' : '80';
  return parts.port && parts.port !== defaultPort ? `${parts.host}:${parts.port}` : parts.host;
}

/**
 * 保存服务器地址与令牌（登录、改地址都走这里）。
 * 服务端会先用一个 GET 探针到服务器验令牌，验过了才落库；这里只负责把结果告诉界面。
 */
export async function saveEdgeSyncSource(
  input: { address: string; token: string },
): Promise<{ ok: boolean; url?: string; message?: string }> {
  try {
    const response = await fetch('/api/edge/sync-source', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input.address, token: input.token }),
    });
    const payload = await response.json().catch(() => null) as {
      ok?: boolean;
      url?: string;
      message?: string;
    } | null;

    if (response.ok && payload?.ok) return { ok: true, url: String(payload.url || input.address) };
    return { ok: false, message: String(payload?.message || `保存失败（HTTP ${response.status}）`) };
  } catch {
    return { ok: false, message: '无法连接到本机边缘服务，请重启 Metapi Edge。' };
  }
}

/** 「同步」按钮：从服务器拉一次配置（只拉不推）。 */
export async function triggerEdgeSync(token?: string): Promise<EdgeSyncResult> {
  const resolvedToken = token ?? (typeof localStorage === 'undefined' ? '' : getAuthToken(localStorage)) ?? '';
  if (!resolvedToken) return { ok: false, message: '请先登录再同步。' };

  try {
    const response = await fetch('/api/edge/sync', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resolvedToken}` },
    });
    const payload = await response.json().catch(() => null) as {
      ok?: boolean;
      imported?: boolean;
      message?: string;
    } | null;

    if (response.ok && payload?.ok) return { ok: true, imported: payload.imported === true };
    if (response.status === 401 || response.status === 403) return { ok: false, message: '登录已过期，请重新登录。' };
    return { ok: false, message: String(payload?.message || `同步失败（HTTP ${response.status}）`) };
  } catch {
    return { ok: false, message: '无法连接到本机边缘服务。' };
  }
}
