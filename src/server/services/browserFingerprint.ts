import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { isIpAllowed } from '../middleware/auth.js';

const MAX_DETAIL_KEYS = 24;
const MAX_KEY_LENGTH = 40;
const MAX_VALUE_LENGTH = 200;

export type FingerprintDetail = Record<string, string | number | boolean>;

export type LoginIpSource = {
  ip: string;
  peerIp: string;
  ipChain: string | null;
  spoofSuspect: boolean;
  spoofReason: string | null;
};

function normalizeIp(raw: string | null | undefined): string {
  const ip = String(raw || '').trim();
  if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length).trim();
  if (ip === '::1') return '127.0.0.1';
  return ip;
}

export function isTrustedProxyIp(ip: string): boolean {
  if (config.trustProxy === true) return true;
  if (config.trustProxy === false) return false;
  return isIpAllowed(ip, config.trustProxy);
}

/**
 * 记录真实的链路信息：socket 对端地址 + 客户端声明的 XFF。
 *
 * Fastify 只有在 socket 对端属于 TRUST_PROXY 时才会采用 X-Forwarded-For，
 * 所以 `request.ip` 本身已经不能被伪造。这里额外保存原始对端地址和声明链，
 * 用于在审计里识别“绕过 nginx 直接伪造 XFF”的探测行为。
 */
export function resolveLoginIpSource(request: FastifyRequest): LoginIpSource {
  const peerIp = normalizeIp(request.socket?.remoteAddress || request.ip);
  const rawChain = request.headers['x-forwarded-for'];
  const chain = Array.isArray(rawChain) ? rawChain.join(',') : (typeof rawChain === 'string' ? rawChain : '');
  const ipChain = chain ? chain.replace(/\s+/g, ' ').trim().slice(0, 512) || null : null;
  const trustedPeer = isTrustedProxyIp(peerIp);

  let spoofSuspect = false;
  let spoofReason: string | null = null;
  if (ipChain && !trustedPeer) {
    spoofSuspect = true;
    spoofReason = 'untrusted_xff';
  } else if (ipChain && ipChain.split(',').length > 6) {
    spoofSuspect = true;
    spoofReason = 'xff_chain_too_long';
  }

  return {
    ip: normalizeIp(request.ip),
    peerIp,
    ipChain,
    spoofSuspect,
    spoofReason,
  };
}

export function normalizeFingerprintDetail(input: unknown): FingerprintDetail {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const detail: FingerprintDetail = {};
  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = String(rawKey || '').trim().slice(0, MAX_KEY_LENGTH);
    if (!key) continue;
    if (typeof rawValue === 'string') {
      detail[key] = rawValue.replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE_LENGTH);
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      detail[key] = Math.trunc(rawValue);
    } else if (typeof rawValue === 'boolean') {
      detail[key] = rawValue;
    } else {
      continue;
    }
    if (Object.keys(detail).length >= MAX_DETAIL_KEYS) break;
  }
  return detail;
}

/**
 * 指纹哈希在服务端重新计算，不直接采信客户端传上来的 hash。
 * 这样攻击者无法只伪造一个“看起来正常”的 hash 来复用他人指纹。
 */
export function computeFingerprintHash(detail: FingerprintDetail): string | null {
  const keys = Object.keys(detail);
  if (keys.length < 3) return null;
  const canonical = keys.sort().map((key) => `${key}=${String(detail[key])}`).join('|');
  return createHash('sha256').update(`metapi:login-fingerprint:v1|${canonical}`).digest('hex');
}

export function resolveLoginFingerprint(request: FastifyRequest, body: unknown): {
  hash: string | null;
  detail: FingerprintDetail;
  clientHashMismatch: boolean;
} {
  const raw = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
  const detail = normalizeFingerprintDetail(raw.fingerprintDetail);
  const hash = computeFingerprintHash(detail);
  const clientHash = typeof raw.fingerprint === 'string' ? raw.fingerprint.trim().toLowerCase() : '';
  // 只有长度合理且两边都算出来时才比较，避免把旧版客户端误判成伪造。
  const clientHashMismatch = !!hash && /^[a-f0-9]{64}$/.test(clientHash) && clientHash !== hash;
  return { hash, detail, clientHashMismatch };
}

export function summarizeUserAgent(userAgent: string): string {
  const value = String(userAgent || '');
  const browser = /Edg\//.test(value) ? 'Edge'
    : /Chrome\//.test(value) ? 'Chrome'
      : /Firefox\//.test(value) ? 'Firefox'
        : /Safari\//.test(value) ? 'Safari'
          : 'Unknown';
  const platform = /Windows NT/.test(value) ? 'Windows'
    : /Macintosh|Mac OS X/.test(value) ? 'macOS'
      : /Android/.test(value) ? 'Android'
        : /iPhone|iPad|iOS/.test(value) ? 'iOS'
          : /Linux/.test(value) ? 'Linux'
            : 'Unknown';
  return `${browser} / ${platform}`;
}
