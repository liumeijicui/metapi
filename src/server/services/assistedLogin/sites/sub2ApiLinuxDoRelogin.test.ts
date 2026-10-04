import { describe, expect, it } from 'vitest';

import {
  decodeJwtClaims,
  isFreshSub2ApiCapture,
  isForumSsoUrl,
  isLinuxDoConsentUrl,
  judgeSub2ApiLinuxDoCapture,
  readSub2ApiTokensFromUrl,
  supportsSub2ApiLinuxDoRelogin,
} from './sub2ApiLinuxDoRelogin.js';

/** Builds a token shaped the way the deployment mints them: a JWT. */
function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const ACCESS = jwt({ user_id: 2975, exp: 1_800_000_000 });
const CALLBACK = 'https://api.fengwind.com/api/v1/auth/oauth/linuxdo/callback';

describe('supportsSub2ApiLinuxDoRelogin', () => {
  it('claims the Sub2API Linux.do handshake and nothing else', () => {
    expect(supportsSub2ApiLinuxDoRelogin('sub2api', 'linuxdo')).toBe(true);
    expect(supportsSub2ApiLinuxDoRelogin('Sub2API', 'LinuxDo')).toBe(true);
    expect(supportsSub2ApiLinuxDoRelogin(' sub2api ', ' linuxdo ')).toBe(true);
  });

  it('leaves the provider to the driver that actually speaks its protocol', () => {
    // The new-api forks answer the same provider over a different handshake, so
    // the platform is what decides which driver runs.
    expect(supportsSub2ApiLinuxDoRelogin('new-api', 'linuxdo')).toBe(false);
    expect(supportsSub2ApiLinuxDoRelogin('sub2api', 'github')).toBe(false);
    expect(supportsSub2ApiLinuxDoRelogin(null, 'linuxdo')).toBe(false);
    expect(supportsSub2ApiLinuxDoRelogin('sub2api', undefined)).toBe(false);
  });
});

describe('decodeJwtClaims', () => {
  it('reads the user id and the expiry the site puts in the payload', () => {
    expect(decodeJwtClaims(ACCESS)).toEqual({ userId: 2975, expiresAtMs: 1_800_000_000_000 });
  });

  it('accepts the aliases other builds mint with', () => {
    expect(decodeJwtClaims(jwt({ userId: 8245 })).userId).toBe(8245);
    expect(decodeJwtClaims(jwt({ sub: '6597' })).userId).toBe(6597);
  });

  it('reports nothing rather than a guess for an opaque or broken token', () => {
    expect(decodeJwtClaims('not-a-jwt')).toEqual({});
    expect(decodeJwtClaims('a.!!!not-base64!!!.c')).toEqual({});
    expect(decodeJwtClaims(jwt({ user_id: 'nope', exp: 'later' }))).toEqual({});
    expect(decodeJwtClaims(jwt({ user_id: 0, exp: -5 }))).toEqual({});
  });
});

describe('readSub2ApiTokensFromUrl', () => {
  it('reads the pair the callback puts in the fragment', () => {
    const tokens = readSub2ApiTokensFromUrl(
      `${CALLBACK}#access_token=${ACCESS}&refresh_token=refresh-1&expires_in=7200&token_type=bearer`,
    );
    expect(tokens).toEqual({
      accessToken: ACCESS,
      refreshToken: 'refresh-1',
      tokenExpiresAt: 1_800_000_000_000,
    });
  });

  it('falls back to expires_in when the access token carries no exp', () => {
    expect(readSub2ApiTokensFromUrl(
      `${CALLBACK}#access_token=opaque-token&refresh_token=r&expires_in=3600`,
      1_000_000,
    )).toEqual({
      accessToken: 'opaque-token',
      refreshToken: 'r',
      tokenExpiresAt: 1_000_000 + 3_600_000,
    });
  });

  it('reads the query form too, and merges the two when a build splits them', () => {
    expect(readSub2ApiTokensFromUrl(`${CALLBACK}?access_token=opaque-token`)?.accessToken)
      .toBe('opaque-token');
    expect(readSub2ApiTokensFromUrl(`${CALLBACK}?refresh_token=from-query#access_token=opaque-token`))
      .toEqual({ accessToken: 'opaque-token', refreshToken: 'from-query', tokenExpiresAt: null });
  });

  it('reports no token for a URL that carries none', () => {
    // The SPA parks the page on its own routes with a fragment of its own, and a
    // `#/dashboard` must never be mistaken for a credential.
    expect(readSub2ApiTokensFromUrl(`${CALLBACK}#/dashboard`)).toBeNull();
    expect(readSub2ApiTokensFromUrl(`${CALLBACK}#access_token=`)).toBeNull();
    expect(readSub2ApiTokensFromUrl('')).toBeNull();
    expect(readSub2ApiTokensFromUrl('not a url')).toBeNull();
  });
});

describe('judgeSub2ApiLinuxDoCapture', () => {
  it('hands over the pair it was asked for', () => {
    const verdict = judgeSub2ApiLinuxDoCapture(
      { accessToken: ACCESS, refreshToken: 'refresh-1', tokenExpiresAt: 1_800_000_000_000 },
      { expectedUserId: 2975 },
    );
    expect(verdict.status).toBe('captured');
    expect(verdict.credentials).toEqual(expect.objectContaining({
      accessToken: ACCESS,
      refreshToken: 'refresh-1',
      tokenExpiresAt: 1_800_000_000_000,
      platformUserId: 2975,
      source: 'localStorage',
    }));
    expect(verdict.credentials?.harvestedKeys).toEqual(['auth_token', 'refresh_token']);
  });

  it('refuses to swap the account for whoever the browser is signed in as', () => {
    // Storing this pair would silently replace the operator's account with
    // another person's; it has to be reported, not written.
    const verdict = judgeSub2ApiLinuxDoCapture(
      { accessToken: jwt({ user_id: 8245 }), refreshToken: 'r', tokenExpiresAt: null },
      { expectedUserId: 2975 },
    );
    expect(verdict.status).toBe('needs_provider_login');
    expect(verdict.credentials).toBeNull();
    expect(verdict.message).toContain('其他账号');
  });

  it('keeps a pair whose id is unknown when no id is on file to compare it with', () => {
    expect(judgeSub2ApiLinuxDoCapture(
      { accessToken: 'opaque-token', refreshToken: null, tokenExpiresAt: null },
      { expectedUserId: 2975 },
    ).status).toBe('captured');
    expect(judgeSub2ApiLinuxDoCapture(
      { accessToken: jwt({ user_id: 8245 }), refreshToken: 'r', tokenExpiresAt: null },
    ).status).toBe('captured');
  });

  it('names an empty handshake instead of reporting it as a capture', () => {
    const verdict = judgeSub2ApiLinuxDoCapture(null, { expectedUserId: 2975 });
    expect(verdict.status).toBe('timeout');
    expect(verdict.credentials).toBeNull();
  });

  it('refuses a token that expired before this sign-in could have minted it', () => {
    // The managed profile keeps the `auth_token` of whatever manual sign-in last
    // used it, and swallowing that stale pair replaces a working credential with
    // a dead one — the account then reads as signed in while every call 401s.
    const verdict = judgeSub2ApiLinuxDoCapture({
      accessToken: jwt({ user_id: 2975, exp: Math.floor(Date.now() / 1000) - 60 }),
      refreshToken: 'stale-refresh',
      tokenExpiresAt: Date.now() - 60_000,
    }, { expectedUserId: 2975 });
    expect(verdict.status).toBe('timeout');
    expect(verdict.credentials).toBeNull();
    expect(verdict.message).toContain('旧会话');
  });
});

describe('isFreshSub2ApiCapture', () => {
  const live = jwt({ user_id: 2975, exp: Math.floor(Date.now() / 1000) + 3600 });

  it('accepts a pair that is neither expired nor the one already on file', () => {
    expect(isFreshSub2ApiCapture(
      { accessToken: live, refreshToken: 'r', tokenExpiresAt: null },
      { baselineAccessToken: 'what-the-profile-already-held' },
    )).toBe(true);
  });

  it('rejects the pair the profile held before the flow started', () => {
    expect(isFreshSub2ApiCapture(
      { accessToken: live, refreshToken: 'r', tokenExpiresAt: null },
      { baselineAccessToken: live },
    )).toBe(false);
  });

  it('rejects an expired pair even when it differs from the baseline', () => {
    const stale = jwt({ user_id: 2975, exp: Math.floor(Date.now() / 1000) - 1 });
    expect(isFreshSub2ApiCapture(
      { accessToken: stale, refreshToken: 'r', tokenExpiresAt: null },
      { baselineAccessToken: 'something-else' },
    )).toBe(false);
  });

  it('accepts an opaque token, which states no expiry to judge it by', () => {
    expect(isFreshSub2ApiCapture(
      { accessToken: 'opaque-token', refreshToken: null, tokenExpiresAt: null },
      { baselineAccessToken: null },
    )).toBe(true);
  });

  it('treats an empty capture as nothing to store', () => {
    expect(isFreshSub2ApiCapture(null)).toBe(false);
    expect(isFreshSub2ApiCapture({ accessToken: '', refreshToken: null, tokenExpiresAt: null })).toBe(false);
  });
});

describe('handshake step matchers', () => {
  it('recognises the consent page and its approval endpoint', () => {
    expect(isLinuxDoConsentUrl('https://connect.linux.do/oauth2/authorize?client_id=x&state=y')).toBe(true);
    expect(isLinuxDoConsentUrl('https://connect.linux.do/oauth2/approve/abc123')).toBe(true);
    expect(isLinuxDoConsentUrl('https://connect.linux.do/')).toBe(false);
    expect(isLinuxDoConsentUrl('https://linux.do/oauth2/authorize')).toBe(false);
    expect(isLinuxDoConsentUrl('')).toBe(false);
  });

  it('recognises the forum bounce that has to be let through', () => {
    expect(isForumSsoUrl('https://linux.do/session/sso_provider?sso=abc&sig=def')).toBe(true);
    expect(isForumSsoUrl('https://connect.linux.do/oauth2/authorize')).toBe(false);
    expect(isForumSsoUrl('https://api.fengwind.com/dashboard')).toBe(false);
    expect(isForumSsoUrl('')).toBe(false);
  });
});
