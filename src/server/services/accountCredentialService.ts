import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { deriveSecuritySeed } from './securitySeedService.js';

const VERSION = 'v2';
const LEGACY_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

/**
 * v1 使用 ACCOUNT_CREDENTIAL_SECRET（缺失时回退 AUTH_TOKEN）的 sha256。
 * 新部署的 ACCOUNT_CREDENTIAL_SECRET 已经是强随机值；保留 v1 只是为了能解开
 * 升级前已入库的密码/Cookie，不能用于新写入。
 */
function buildLegacyKey(): Buffer {
  const secret = (config.accountCredentialSecret || '').trim() || config.authToken || 'change-me-admin-token';
  return createHash('sha256').update(secret).digest();
}

function buildKey(version: string): Buffer {
  if (version === LEGACY_VERSION) return buildLegacyKey();
  return deriveSecuritySeed('account-credential');
}

function encryptWithVersion(plainText: string, version: string): string {
  const key = buildKey(version);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    version,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function encryptAccountPassword(password: string): string {
  // v2 的密钥来自独立的 account-credential 子密钥，不再与其他功能共用种子。
  return encryptWithVersion(password, VERSION);
}

export function decryptAccountPassword(cipherText: string): string | null {
  const parts = (cipherText || '').split(':');
  if (parts.length !== 4) return null;
  const version = parts[0];
  if (version !== VERSION && version !== LEGACY_VERSION) return null;

  try {
    const [, ivRaw, tagRaw, dataRaw] = parts;
    const key = buildKey(version);
    const iv = Buffer.from(ivRaw!, 'base64url');
    const tag = Buffer.from(tagRaw!, 'base64url');
    const data = Buffer.from(dataRaw!, 'base64url');

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}
