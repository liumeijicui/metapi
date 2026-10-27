import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import {
  hashAdminPassword,
  issueAdminSession,
  resetAdminAuthStateForTests,
  revokeAdminSessionToken,
  setAdminPasswordHash,
  verifyAdminCredentials,
  verifyAdminSessionToken,
} from './adminAuthService.js';

describe('adminAuthService', () => {
  const originalToken = config.authToken;
  const originalUsername = config.adminUsername;
  const originalTtl = config.adminSessionTtlMs;

  beforeEach(() => {
    config.authToken = 'correct-horse-battery-staple';
    config.adminUsername = 'owner';
    config.adminSessionTtlMs = 12 * 60 * 60 * 1000;
    resetAdminAuthStateForTests();
  });

  afterEach(() => {
    config.authToken = originalToken;
    config.adminUsername = originalUsername;
    config.adminSessionTtlMs = originalTtl;
    resetAdminAuthStateForTests();
  });

  it('checks username and password together', async () => {
    expect(await verifyAdminCredentials('owner', 'correct-horse-battery-staple')).toBe(true);
    expect(await verifyAdminCredentials('Owner', 'correct-horse-battery-staple')).toBe(false);
    expect(await verifyAdminCredentials('owner', 'wrong')).toBe(false);
  });

  it('binds sessions to the current username and password', () => {
    const session = issueAdminSession();
    expect(verifyAdminSessionToken(session.token)).not.toBeNull();

    config.adminUsername = 'changed-owner';
    expect(verifyAdminSessionToken(session.token)).toBeNull();
  });

  it('rejects expired sessions', () => {
    const session = issueAdminSession(null, 1_000);
    expect(verifyAdminSessionToken(session.token, session.expiresAt + 1)).toBeNull();
  });

  it('revokes a session without affecting the password login itself', async () => {
    const session = issueAdminSession();
    expect(revokeAdminSessionToken(session.token)).toBe(true);
    expect(verifyAdminSessionToken(session.token)).toBeNull();
    expect(await verifyAdminCredentials('owner', 'correct-horse-battery-staple')).toBe(true);
  });

  it('prefers the scrypt password hash over the bootstrap token', async () => {
    setAdminPasswordHash(hashAdminPassword('a-new-strong-password'));

    expect(await verifyAdminCredentials('owner', 'a-new-strong-password')).toBe(true);
    expect(await verifyAdminCredentials('owner', 'correct-horse-battery-staple')).toBe(false);
  });
});

