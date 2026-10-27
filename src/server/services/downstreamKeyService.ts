import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { deriveSecuritySeed } from './securitySeedService.js';

const KEY_PREFIX = 'sk-';
const SIGNATURE_LENGTH = 9;
const SIGNED_KEY_PATTERN = /^sk-([A-Za-z0-9_-]{32,})\.([A-Za-z0-9_-]{9})$/;

function signPayload(payload: string): string {
  return createHmac('sha256', deriveSecuritySeed('downstream-api-key-signing'))
    .update(`metapi:downstream-key:v1:${payload}`)
    .digest('base64url')
    .slice(0, SIGNATURE_LENGTH);
}

/**
 * 生成下游密钥：随机主体 + 服务端 HMAC 签名。
 * 随机主体不可预测，签名只能由本机种子派生，因此即使数据库里的 key 泄露，
 * 也无法据此推导种子或伪造其他 key。
 */
export function generateDownstreamSkKey(): string {
  const payload = randomBytes(32).toString('base64url');
  return `${KEY_PREFIX}${payload}.${signPayload(payload)}`;
}

export function generateDownstreamProxyToken(): string {
  return generateDownstreamSkKey();
}

/**
 * 旧密钥没有签名后缀，继续兼容；新密钥必须带服务端 HMAC 后缀。
 * 返回 false 只针对“看起来是新格式但签名不符”的输入。
 */
export function isDownstreamKeySignatureValid(key: string): boolean {
  const match = SIGNED_KEY_PATTERN.exec(String(key || '').trim());
  if (!match) return true;
  const expected = Buffer.from(signPayload(match[1]!), 'utf8');
  const provided = Buffer.from(match[2]!, 'utf8');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function looksLikeSignedDownstreamSkKey(key: string): boolean {
  return SIGNED_KEY_PATTERN.test(String(key || '').trim());
}

/**
 * 新建/修改下游密钥时的格式校验：
 * - 必须 sk- 开头；
 * - 新格式必须签名正确；
 * - 旧格式（无签名）允许继续保存，避免影响已有 key。
 */
export function validateDownstreamKeyValue(key: string): { ok: true } | { ok: false; error: string } {
  const value = String(key || '').trim();
  if (!value.startsWith(KEY_PREFIX)) {
    return { ok: false, error: '令牌必须以 sk- 开头' };
  }
  if (value.length < 6) {
    return { ok: false, error: '令牌至少 6 位（含 sk-）' };
  }
  if (looksLikeSignedDownstreamSkKey(value) && !isDownstreamKeySignatureValid(value)) {
    return { ok: false, error: '令牌签名无效，请使用服务端生成的新令牌' };
  }
  return { ok: true };
}
