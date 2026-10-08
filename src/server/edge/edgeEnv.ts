import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 边缘实例数据目录里的角色标记文件名。 */
const EDGE_MARKER_FILE = 'edge-instance.json';

/** 主服务默认数据目录；边缘实例绝不允许共用。 */
const MAIN_SERVICE_DEFAULT_DATA_DIR = './data';

export type EdgeEnv = {
  /** 配置源（服务器）地址，末尾不带斜杠。 */
  configSourceUrl: string;
  /** 配置源管理令牌（服务器 AUTH_TOKEN）。 */
  configSourceToken: string;
  /** 自动同步间隔（毫秒）。 */
  syncIntervalMs: number;
  /** 数据目录绝对路径。 */
  dataDirAbsolute: string;
};

function parseBooleanFlag(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * 读取并校验边缘实例的运行前提。
 * 任一条不满足就直接抛错：宁可启动失败，也不能把本地实例连到主服务的数据目录，
 * 或者把带全部上游密钥的端口暴露到局域网。
 */
export function readEdgeEnv(env: NodeJS.ProcessEnv = process.env): EdgeEnv {
  if (!parseBooleanFlag(env.METAPI_EDGE_MODE)) {
    throw new Error('METAPI_EDGE_MODE 未开启：这个入口只用于本地边缘转发，不能当主服务启动。');
  }

  const dataDir = (env.DATA_DIR || '').trim();
  if (!dataDir) {
    throw new Error('必须显式设置 DATA_DIR（例如 ./data-edge），避免和主服务共用数据目录。');
  }
  const dataDirAbsolute = resolve(dataDir);
  if (dataDirAbsolute === resolve(MAIN_SERVICE_DEFAULT_DATA_DIR)) {
    throw new Error('DATA_DIR 不能是主服务默认的 ./data，请指向独立目录（例如 ./data-edge）。');
  }

  if ((env.HOST || '').trim() !== '127.0.0.1') {
    throw new Error('HOST 必须是 127.0.0.1：默认的 0.0.0.0 会让局域网直接访问到本地转发端口。');
  }

  if (!(env.PORT || '').trim()) {
    throw new Error('必须显式设置 PORT（建议 30086），避免占用主服务的默认端口 4000。');
  }

  const rawInterval = Number(env.METAPI_EDGE_CONFIG_SYNC_INTERVAL_MS || '');
  return {
    configSourceUrl: (env.METAPI_EDGE_CONFIG_SOURCE_URL || '').trim().replace(/\/+$/, ''),
    configSourceToken: (env.METAPI_EDGE_CONFIG_SOURCE_TOKEN || '').trim(),
    syncIntervalMs: Number.isFinite(rawInterval) && rawInterval > 0 ? Math.max(30_000, rawInterval) : 5 * 60_000,
    dataDirAbsolute,
  };
}

let cachedEdgeEnv: EdgeEnv | null = null;

/** 进程内共享的边缘环境（只解析一次）。 */
export function getEdgeEnv(): EdgeEnv {
  if (!cachedEdgeEnv) cachedEdgeEnv = readEdgeEnv();
  return cachedEdgeEnv;
}

/** 只在测试里用来重置缓存。 */
export function resetEdgeEnvCache(): void {
  cachedEdgeEnv = null;
}

/**
 * 校验数据目录归属，必要时落一个角色标记。
 * 目录里已经有 hub.db 却没有边缘标记时直接拒绝启动，避免误指到主服务的库。
 */
export function ensureEdgeDataDir(dataDirAbsolute: string): void {
  const dbPath = join(dataDirAbsolute, 'hub.db');
  const markerPath = join(dataDirAbsolute, EDGE_MARKER_FILE);

  if (!existsSync(markerPath)) {
    if (existsSync(dbPath)) {
      throw new Error(`数据目录里已有数据库但不是边缘实例创建的：${dataDirAbsolute}；请换一个空目录。`);
    }
    mkdirSync(dataDirAbsolute, { recursive: true });
    const marker = { role: 'edge', createdAt: new Date().toISOString() };
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    return;
  }

  let role = '';
  try {
    role = String((JSON.parse(readFileSync(markerPath, 'utf8')) as { role?: unknown }).role ?? '');
  } catch {
    throw new Error(`边缘实例标记文件损坏：${markerPath}`);
  }
  if (role !== 'edge') {
    throw new Error(`数据目录标记不是边缘实例（role=${role || '空'}）：${markerPath}`);
  }
}
