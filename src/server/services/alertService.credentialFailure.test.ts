import { describe, expect, it } from 'vitest';
import { describeCredentialFailure } from './alertService.js';

describe('describeCredentialFailure', () => {
  it('names a session cap instead of calling it an expired token', () => {
    const result = describeCredentialFailure(
      '站点登录会话数已达上限：在站点上退出其他登录会话，或等会话过期后重试',
    );
    expect(result.reason.code).toBe('session_limit');
    expect(result.headline).toContain('会话数已达上限');
    expect(result.siteSide).toBe(false);
  });

  it('names a refused password instead of an expiry', () => {
    const result = describeCredentialFailure('Username or password is incorrect, or user has been banned');
    expect(result.reason.code).toBe('invalid_credentials');
    expect(result.headline).toContain('拒绝了保存的账号密码');
    expect(result.siteSide).toBe(false);
  });

  it('says the site is unreachable, and does not mark the account expired for it', () => {
    // The site never saw the request, so nothing about the credential changed:
    // flipping the account to `expired` here would take it out of rotation over
    // a condition the site owner fixes.
    for (const detail of ['fetch failed', 'HTTP 522', 'connect ECONNREFUSED 1.2.3.4:443']) {
      const result = describeCredentialFailure(detail);
      expect(result.reason.code, detail).toBe('site_unreachable');
      expect(result.headline, detail).toContain('网站可能挂了');
      expect(result.siteSide, detail).toBe(true);
    }
  });

  it('keeps the plain token verdict for a plain expired token', () => {
    const result = describeCredentialFailure(
      'HTTP 401: Unauthorized, not logged in and no access token provided',
    );
    expect(result.reason.code).toBe('token_expired');
    expect(result.headline).toBe('Token 无效或已过期');
    expect(result.siteSide).toBe(false);
  });
});
