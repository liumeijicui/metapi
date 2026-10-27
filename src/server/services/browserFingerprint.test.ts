import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  computeFingerprintHash,
  normalizeFingerprintDetail,
  resolveLoginFingerprint,
  resolveLoginIpSource,
  summarizeUserAgent,
} from './browserFingerprint.js';

function fakeRequest(input: {
  ip?: string;
  peer?: string;
  xff?: string;
  body?: unknown;
}) {
  return {
    ip: input.ip || '203.0.113.5',
    socket: { remoteAddress: input.peer || input.ip || '203.0.113.5' },
    headers: input.xff ? { 'x-forwarded-for': input.xff } : {},
    body: input.body,
  } as any;
}

const baseDetail = {
  ua: 'Mozilla/5.0 Chrome/153',
  platform: 'Win32',
  screen: '1920x1080x24',
  timezone: 'Asia/Shanghai',
};

describe('browserFingerprint', () => {
  const originalTrustProxy = config.trustProxy;

  afterEach(() => {
    config.trustProxy = originalTrustProxy;
  });

  it('normalizes detail and hashes deterministically regardless of key order', () => {
    const left = normalizeFingerprintDetail({ a: '1', b: '2', c: '3' });
    const right = normalizeFingerprintDetail({ c: '3', b: '2', a: '1' });
    expect(left).toEqual(right);
    expect(computeFingerprintHash(left)).toBe(computeFingerprintHash(right));
    expect(computeFingerprintHash(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses to hash almost-empty details so a forged stub cannot impersonate', () => {
    expect(computeFingerprintHash(normalizeFingerprintDetail({ a: '1' }))).toBeNull();
    expect(computeFingerprintHash({})).toBeNull();
  });

  it('recomputes the hash server-side and flags a mismatched client hash', () => {
    const mismatchedRequest = fakeRequest({
      body: { fingerprint: 'f'.repeat(64), fingerprintDetail: baseDetail },
    });
    const parsed = resolveLoginFingerprint(mismatchedRequest, mismatchedRequest.body);
    expect(parsed.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.clientHashMismatch).toBe(true);

    const matchingRequest = fakeRequest({
      body: { fingerprint: parsed.hash, fingerprintDetail: baseDetail },
    });
    const matching = resolveLoginFingerprint(matchingRequest, matchingRequest.body);
    expect(matching.clientHashMismatch).toBe(false);
  });

  it('flags X-Forwarded-For from an untrusted peer as spoofing', () => {
    config.trustProxy = ['127.0.0.1'];
    const untrusted = resolveLoginIpSource(fakeRequest({ ip: '198.51.100.9', xff: '1.2.3.4' }));
    expect(untrusted.spoofSuspect).toBe(true);
    expect(untrusted.spoofReason).toBe('untrusted_xff');
    expect(untrusted.ipChain).toBe('1.2.3.4');

    const trusted = resolveLoginIpSource(fakeRequest({ ip: '198.51.100.9', peer: '127.0.0.1', xff: '1.2.3.4' }));
    expect(trusted.spoofSuspect).toBe(false);
    expect(trusted.peerIp).toBe('127.0.0.1');
  });

  it('summarizes browser and platform from the user agent', () => {
    expect(summarizeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/153.0.0.0 Safari/537.36')).toBe('Chrome / Windows');
    expect(summarizeUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X) Firefox/140.0')).toBe('Firefox / macOS');
  });
});
