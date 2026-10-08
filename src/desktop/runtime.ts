import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type DesktopServerEnvInput = {
  inheritedEnv?: NodeJS.ProcessEnv;
  userDataDir: string;
  logsDir: string;
  port: number;
  /** 边缘版（只转发）桌面壳：强制只监听回环地址，并打开边缘实例闸门。 */
  edgeMode?: boolean;
};

type WaitForServerReadyInput = {
  url: string;
  fetcher?: (input: string, init?: RequestInit) => Promise<{ ok: boolean }>;
  timeoutMs?: number;
  intervalMs?: number;
};

type ServerExitState = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type DesktopServerWorkingDirInput = {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
};

const DEFAULT_DESKTOP_SERVER_PORT = 4000;
/** 边缘版默认端口：避开主服务默认的 4000。 */
const EDGE_DESKTOP_SERVER_PORT = 30086;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_INTERVAL_MS = 250;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function buildDesktopServerEnv(input: DesktopServerEnvInput): NodeJS.ProcessEnv {
  // 边缘版只服务本机：绝不能用默认的 0.0.0.0 把带全部上游密钥的端口暴露到局域网。
  const host = input.edgeMode
    ? '127.0.0.1'
    : ((input.inheritedEnv?.HOST || '0.0.0.0').trim() || '0.0.0.0');

  return {
    ...(input.inheritedEnv || {}),
    HOST: host,
    PORT: String(input.port),
    DATA_DIR: input.userDataDir,
    METAPI_DESKTOP: '1',
    ...(input.edgeMode ? { METAPI_EDGE_MODE: '1' } : {}),
    METAPI_LOG_DIR: input.logsDir,
  };
}

export function createDesktopServerUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function createDesktopHealthUrl(port: number): string {
  return `${createDesktopServerUrl(port)}/api/desktop/health`;
}

export function resolveDesktopServerPort(env?: NodeJS.ProcessEnv, fallbackPort = DEFAULT_DESKTOP_SERVER_PORT): number {
  const forcedPort = Number.parseInt(env?.METAPI_DESKTOP_SERVER_PORT || '', 10);
  if (Number.isFinite(forcedPort) && forcedPort > 0) return forcedPort;
  return fallbackPort;
}

/** 边缘版（只转发）默认端口。 */
export function resolveDesktopDefaultPort(edgeMode: boolean): number {
  return edgeMode ? EDGE_DESKTOP_SERVER_PORT : DEFAULT_DESKTOP_SERVER_PORT;
}

/** 边缘版用独立入口：只转发 + 使用日志，不启动任何调度器。 */
export function resolveDesktopServerEntryRelativePath(edgeMode: boolean): string {
  return edgeMode ? 'dist/server/edge/main.js' : 'dist/server/index.js';
}

function parseSwitch(value: string | undefined): boolean | null {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return null;
}

/**
 * 判定当前桌面壳是不是「边缘版」：打包元数据里带 metapiBuildVariant=edge，
 * 或者显式用 METAPI_DESKTOP_EDGE_MODE 覆盖（本地联调用）。默认是完整版。
 */
export function resolveDesktopEdgeMode(input: { appPath: string; env?: NodeJS.ProcessEnv }): boolean {
  const explicit = parseSwitch(input.env?.METAPI_DESKTOP_EDGE_MODE);
  if (explicit !== null) return explicit;

  try {
    const raw = readFileSync(join(input.appPath, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { metapiBuildVariant?: unknown };
    return String(parsed.metapiBuildVariant || '').trim().toLowerCase() === 'edge';
  } catch {
    return false;
  }
}

export function resolveDesktopServerWorkingDir(input: DesktopServerWorkingDirInput): string {
  return input.isPackaged ? input.resourcesPath : input.appPath;
}

export async function waitForServerReady(input: WaitForServerReadyInput): Promise<void> {
  const fetcher = input.fetcher || ((url: string, init?: RequestInit) => fetch(url, init));
  const timeoutMs = input.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = input.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetcher(input.url, { method: 'GET' });
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await delay(intervalMs);
  }

  throw new Error('Timed out waiting for metapi desktop server');
}

export function isFatalServerExit(exitState: ServerExitState): boolean {
  return exitState.code !== null && exitState.code !== 0 && !exitState.signal;
}
