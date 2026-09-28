import { describe, expect, it } from 'vitest';
import { applyTransientFallback, parsePastedProviderSession } from './importedSession.js';

// Shape of a DevTools "Copy as cURL (cmd)" paste: quotes, carets, and percent
// signs are escaped, which is exactly what breaks a naive Cookie-header parse.
const CMD_ESCAPED_CURL = String.raw`curl --url ^"https://linux.do/topics/private-messages/1.json^" ^
  -H ^"accept: application/json, text/javascript, */*; q=0.01^" ^
  -b ^"_ga=GA1.1.1.2; _forum_session=abc^%^2Fdef^%^3D^%^3D; cf_clearance=cf-value; _t=tok^%^2Bvalue^%^3D^%^3D^" ^
  -H ^"x-csrf-token: csrf-value-1234567890^" ^
  -H ^"user-agent: Mozilla/5.0^"`;

describe('imported provider session parsing', () => {
  it('keeps only the Linux.do session cookies from a cmd-escaped cURL paste', () => {
    const parsed = parsePastedProviderSession('linuxdo', CMD_ESCAPED_CURL);

    expect(parsed).not.toBeNull();
    expect(parsed!.cookieNames).toEqual(['_t', '_forum_session', 'cf_clearance']);
    expect(parsed!.cookieHeader).toContain('_t=tok%2Bvalue%3D%3D');
    expect(parsed!.cookieHeader).toContain('_forum_session=abc%2Fdef%3D%3D');
    // Analytics and Cloudflare bot-management cookies must not be carried over.
    expect(parsed!.cookieHeader).not.toContain('_ga=');
    expect(parsed!.csrfToken).toBe('csrf-value-1234567890');
  });

  // A "Copy all as cURL" dump mixes the provider's own requests with Cloudflare
  // challenge traffic, and the challenge host carries its own `cf_clearance`.
  // Picking that value up poisons an otherwise valid import, so cookies must
  // come from the provider's own request header.
  const MULTI_REQUEST_CURL = [
    'curl --url ^"https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/fo/abc^" ^',
    '  -b ^"cf_clearance=challenge-host-clearance^" ^',
    '  -H ^"accept: */*^"',
    'curl --url ^"https://linux.do/notifications?limit=30^" ^',
    '  -b ^"_ga=GA1.1.1.2; __cfuvid=cf-uvid-value; _forum_session=forum-value; _t=session-token-value^" ^',
    '  -H ^"accept: application/json^"',
  ].join('\n');

  it('reads cookies from the provider request header, not from challenge traffic', () => {
    const parsed = parsePastedProviderSession('linuxdo', MULTI_REQUEST_CURL);

    expect(parsed).not.toBeNull();
    expect(parsed!.cookieNames).toEqual(['_t', '_forum_session']);
    expect(parsed!.cookieHeader).toContain('_t=session-token-value');
    expect(parsed!.cookieHeader).not.toContain('challenge-host-clearance');
  });

  it('accepts a bare cookie header string for GitHub', () => {
    const parsed = parsePastedProviderSession(
      'github',
      'foo=bar; user_session=ghsess; _gh_sess=xyz; logged_in=yes',
    );

    expect(parsed!.cookieNames).toEqual(['user_session', '_gh_sess', 'logged_in']);
    expect(parsed!.csrfToken).toBeNull();
  });

  it('rejects a paste without the provider session cookie', () => {
    expect(parsePastedProviderSession('linuxdo', '_ga=1; _forum_session=abc')).toBeNull();
    expect(parsePastedProviderSession('github', '_gh_sess=xyz; logged_in=yes')).toBeNull();
    expect(parsePastedProviderSession('linuxdo', '')).toBeNull();
    expect(parsePastedProviderSession('linuxdo', null)).toBeNull();
  });
});

describe('transient probe fallback', () => {
  const blockedState = {
    loggedIn: false,
    username: null,
    userId: null,
    blocked: true,
    message: 'HTTP 429（请求被限流）',
  };

  it('keeps a rate-limited session available and annotates the error code', () => {
    const state = applyTransientFallback(blockedState, { verifiedUsername: 'alice', verifiedUserId: 7 });

    expect(state.loggedIn).toBe(true);
    expect(state.blocked).toBe(false);
    expect(state.username).toBe('alice');
    expect(state.userId).toBe(7);
    expect(state.message).toContain('HTTP 429');
    expect(state.message).toContain('已沿用上次验证结果');
  });

  it('leaves a definitive verdict untouched', () => {
    const loggedOut = {
      loggedIn: false,
      username: null,
      userId: null,
      blocked: false,
      message: 'HTTP 404（会话已在站点侧失效），请重新导入会话',
    };

    expect(applyTransientFallback(loggedOut, { verifiedUsername: 'alice', verifiedUserId: 7 })).toBe(loggedOut);
  });

  it('still reports available when no identity has been recorded yet', () => {
    const state = applyTransientFallback(blockedState, { verifiedUsername: null, verifiedUserId: null });

    expect(state.loggedIn).toBe(true);
    expect(state.username).toBeNull();
  });
});
