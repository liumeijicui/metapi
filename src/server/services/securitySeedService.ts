import { createHmac, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

const LOCAL_SEED_FILENAME = '.metapi-security-seed';
const MIN_SECRET_LENGTH = 32;
const KNOWN_INSECURE_SECRETS = new Set([
  'change-me-admin-token',
  'change-me-proxy-sk-token',
  'REPLACE_WITH_STRONG_RANDOM_SECRET',
]);

let cachedSeedMaterial: Buffer | null = null;
let cachedSeedSource: 'env' | 'local' | null = null;

function normalizeSecret(value: string | undefined | null): string {
  return String(value || '').trim();
}

function isStrongSecret(value: string): boolean {
  return value.length >= MIN_SECRET_LENGTH && !KNOWN_INSECURE_SECRETS.has(value);
}

function readOrCreateLocalSeed(): Buffer {
  const path = join(config.dataDir, LOCAL_SEED_FILENAME);
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    if (raw) {
      try {
        const decoded = Buffer.from(raw, 'base64url');
        if (decoded.length >= 32) return decoded;
      } catch {
        // Fall through and replace an unreadable seed only when it is empty.
      }
    }
    throw new Error(`Security seed file is invalid: ${path}`);
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const generated = randomBytes(48);
  try {
    writeFileSync(path, `${generated.toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    return readOrCreateLocalSeed();
  }
  try {
    chmodSync(path, 0o600);
  } catch {}
  return generated;
}

function getBaseSeed(): { material: Buffer; source: 'env' | 'local' } {
  if (cachedSeedMaterial && cachedSeedSource) {
    return { material: cachedSeedMaterial, source: cachedSeedSource };
  }

  const configured = normalizeSecret(config.accountCredentialSecret);
  if (isStrongSecret(configured)) {
    cachedSeedMaterial = Buffer.from(configured, 'utf8');
    cachedSeedSource = 'env';
    return { material: cachedSeedMaterial, source: cachedSeedSource };
  }

  cachedSeedMaterial = readOrCreateLocalSeed();
  cachedSeedSource = 'local';
  return { material: cachedSeedMaterial, source: cachedSeedSource };
}

/**
 * 为不同用途派生独立的 32 字节密钥，避免让加密、API Key 签名等功能共用同一把
 * 原始种子。真正的种子来自环境变量或本机随机生成的 0600 文件，不使用开源项目
 * 里常见的默认口令。
 */
export function deriveSecuritySeed(scope: string): Buffer {
  const { material } = getBaseSeed();
  return createHmac('sha256', material).update(`metapi:v2:${scope}`).digest();
}

export function getSecuritySeedSource(): 'env' | 'local' {
  return getBaseSeed().source;
}

export function resetSecuritySeedCacheForTests(): void {
  cachedSeedMaterial = null;
  cachedSeedSource = null;
}
