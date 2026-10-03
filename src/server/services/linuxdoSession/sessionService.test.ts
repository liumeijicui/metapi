import { describe, expect, it } from 'vitest';
import { pickTokenFromRecords, selectHarvestedCredential } from './sessionService.js';

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

describe('selectHarvestedCredential', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJ0b2tlbl91c2UiOiJhY2Nlc3MifQ.signature';
  const REFRESH = 'a5238573-b1fc-4df5-8a3e-972f68c59b02.43952f80bca318d343d7e3fb49243592';

  it('keeps the rotatable refresh cookie instead of the page storage token', () => {
    // The shape luckyg has: a 15-minute JWT the SPA keeps in storage and the
    // cookie that actually lasts. Storing the JWT makes the account sign in
    // again every quarter hour, and each of those sign-ins adds a server-side
    // session until the site refuses the account with AUTH_SESSION_LIMIT.
    const result = selectHarvestedCredential({
      records: [['user', JSON.stringify({ id: 698, username: '3145215575' })], ['access_token', JWT]],
      cookies: [
        { name: 'acw_tc', value: 'edge-cookie-value' },
        { name: 'new_api_refresh', value: REFRESH },
      ],
    });

    expect(result?.source).toBe('cookie');
    expect(result?.accessToken).toBe(`acw_tc=edge-cookie-value; new_api_refresh=${REFRESH}`);
    expect(result?.platformUserId).toBe(698);
    expect(result?.username).toBe('3145215575');
  });

  it('still prefers page storage when the jar holds no refresh cookie', () => {
    const result = selectHarvestedCredential({
      records: [['auth_token', 'storage-token']],
      cookies: [{ name: 'session', value: 'cookie-session-token-value' }],
    });

    expect(result?.source).toBe('localStorage');
    expect(result?.accessToken).toBe('storage-token');
  });

  it('falls back to the session cookie for a site whose page keeps no token', () => {
    const result = selectHarvestedCredential({
      records: [],
      cookies: [{ name: 'session', value: 'cookie-session-token-value' }],
    });

    expect(result?.source).toBe('cookie');
    expect(result?.accessToken).toBe('session=cookie-session-token-value');
  });

  it('ignores short flag cookies and returns null when nothing is a credential', () => {
    expect(selectHarvestedCredential({
      records: [],
      cookies: [
        { name: 'new_api_has_session', value: '1' },
        { name: 'locale', value: 'zh-CN' },
      ],
    })).toBeNull();
  });
});
