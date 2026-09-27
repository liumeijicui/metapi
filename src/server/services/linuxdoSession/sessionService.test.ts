import { describe, expect, it } from 'vitest';
import { pickTokenFromRecords } from './sessionService.js';

describe('pickTokenFromRecords', () => {
  it('extracts the Sub2API credential bundle written by the site SPA', () => {
    const result = pickTokenFromRecords([
      ['sub2api_login_agreement_consent', '{"revision":"26cdf44"}'],
      ['auth_token', 'header.payload.signature'],
      ['refresh_token', 'refresh-abc'],
      ['token_expires_at', String(Date.now() + 3_600_000)],
      ['auth_user', JSON.stringify({ id: 4242, username: 'alice' })],
    ]);

    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe('header.payload.signature');
    expect(result?.refreshToken).toBe('refresh-abc');
    expect(result?.username).toBe('alice');
    expect(result?.source).toBe('localStorage');
  });

  it('prefers auth_token over the generic token key and ignores blank values', () => {
    const result = pickTokenFromRecords([
      ['token', 'generic-token'],
      ['auth_token', 'preferred-token'],
      ['refresh_token', '   '],
    ]);

    expect(result?.accessToken).toBe('preferred-token');
    expect(result?.refreshToken).toBeNull();
    expect(result?.tokenExpiresAt).toBeNull();
  });

  it('falls back to access_token and tolerates malformed auth_user', () => {
    const result = pickTokenFromRecords([
      ['access_token', 'access-xyz'],
      ['auth_user', 'not-json'],
    ]);

    expect(result?.accessToken).toBe('access-xyz');
    expect(result?.username).toBeNull();
  });

  it('returns null when no credential key is present', () => {
    expect(pickTokenFromRecords([['locale', 'zh-CN']])).toBeNull();
  });
});
