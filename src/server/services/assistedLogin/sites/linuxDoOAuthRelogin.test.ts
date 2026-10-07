import { describe, expect, it } from 'vitest';

import {
  isCallbackRedirectStatus,
  judgeLinuxDoCallback,
  judgeRedirectCallback,
  readLegacyOAuthState,
  readOAuthFlowToken,
} from './linuxDoOAuthRelogin.js';

describe('readLegacyOAuthState', () => {
  it('reads the bare string a pre-rc build answers with', () => {
    expect(readLegacyOAuthState({ success: true, data: 'cWDbFdFHDzKb' })).toBe('cWDbFdFHDzKb');
  });

  it('trims the value', () => {
    expect(readLegacyOAuthState({ data: '  cWDbFdFHDzKb\n' })).toBe('cWDbFdFHDzKb');
  });

  it('ignores the rc shape, so the flow_token probe is what answers it', () => {
    expect(readLegacyOAuthState({ data: { flow_token: '7juMUFMIJoqu' } })).toBeNull();
  });

  it('treats an error body and an empty value as no state', () => {
    expect(readLegacyOAuthState({ success: false, message: 'Unknown OAuth provider' })).toBeNull();
    expect(readLegacyOAuthState({ data: '' })).toBeNull();
    expect(readLegacyOAuthState({ data: '   ' })).toBeNull();
    expect(readLegacyOAuthState(null)).toBeNull();
    expect(readLegacyOAuthState(undefined)).toBeNull();
  });
});

describe('readOAuthFlowToken', () => {
  it('reads the one-shot flow_token an rc build answers with', () => {
    expect(readOAuthFlowToken({
      success: true,
      data: { expires_at: 1791024169, flow_token: '7juMUFMIJoquQObWi4WEJdzmOHoBJq9zl02f6JFSknc' },
    })).toBe('7juMUFMIJoquQObWi4WEJdzmOHoBJq9zl02f6JFSknc');
  });

  it('ignores the legacy shape, which the GET probe already handled', () => {
    expect(readOAuthFlowToken({ data: 'cWDbFdFHDzKb' })).toBeNull();
  });

  it('treats a missing, empty or non-string token as no state', () => {
    expect(readOAuthFlowToken({ success: false, message: 'Invalid URL (POST /api/oauth/state)' })).toBeNull();
    expect(readOAuthFlowToken({ data: { expires_at: 1 } })).toBeNull();
    expect(readOAuthFlowToken({ data: { flow_token: '' } })).toBeNull();
    expect(readOAuthFlowToken({ data: { flow_token: 123 } })).toBeNull();
    expect(readOAuthFlowToken(null)).toBeNull();
  });
});

describe('isCallbackRedirectStatus', () => {
  it('marks the callbacks whose body Playwright refuses to hand out', () => {
    expect(isCallbackRedirectStatus(302)).toBe(true);
    expect(isCallbackRedirectStatus(303)).toBe(true);
    expect(isCallbackRedirectStatus(399)).toBe(true);
  });

  it('leaves the readable answers to the JSON judge', () => {
    expect(isCallbackRedirectStatus(200)).toBe(false);
    expect(isCallbackRedirectStatus(403)).toBe(false);
    expect(isCallbackRedirectStatus(0)).toBe(false);
  });
});

describe('judgeLinuxDoCallback', () => {
  it('accepts the JSON answer and checks the account id', () => {
    expect(judgeLinuxDoCallback(200, JSON.stringify({ success: true, data: { id: 9054 } }), {
      expectedUserId: 9054,
    })).toMatchObject({ ok: true });
  });

  it('refuses a redirect rather than reading it as a refusal', () => {
    // A redirect is how the newer forks answer a *successful* handshake; calling
    // it "站点拒绝" would send the operator hunting a problem that is not there.
    const verdict = judgeLinuxDoCallback(303, '', { expectedUserId: 9054 });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('跳转方式回调');
    expect(verdict.message).not.toContain('拒绝');
  });

  it('still reports a real refusal', () => {
    const verdict = judgeLinuxDoCallback(403, JSON.stringify({
      success: false,
      message: 'State parameter is empty or mismatched',
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('State parameter is empty or mismatched');
  });
});

describe('judgeRedirectCallback', () => {
  const options = {
    siteOrigin: 'https://new-api.pigeonw.com',
    siteLabel: 'new-api.pigeonw.com',
    sessionCookieCount: 2,
  };

  it('accepts the fork answer: a bounce into the console that left a session', () => {
    expect(judgeRedirectCallback(
      { status: 303, location: '/dashboard' },
      options,
    )).toMatchObject({ ok: true, message: 'Linux.do 重新登录完成' });
  });

  it('accepts an absolute landing URL on the same origin', () => {
    expect(judgeRedirectCallback(
      { status: 302, location: 'https://new-api.pigeonw.com/console' },
      options,
    ).ok).toBe(true);
  });

  it('refuses a callback that hands the code to another origin', () => {
    const verdict = judgeRedirectCallback(
      { status: 302, location: 'https://connect.linux.do/oauth2/approve/x' },
      options,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('其他来源');
  });

  it('refuses a bounce back to the signed-out pages', () => {
    const verdict = judgeRedirectCallback(
      { status: 303, location: '/login?error=state_mismatch' },
      { ...options, sessionCookieCount: 0 },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('登录页');
  });

  it('does not read a bounce that left no session behind as a signed-in session', () => {
    // The redirect's own `Set-Cookie` is not readable, so the count is taken
    // from the browser after the bounce; none there means the login did not take.
    const verdict = judgeRedirectCallback(
      { status: 302, location: '/dashboard' },
      { ...options, sessionCookieCount: 0 },
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('没有留下会话 Cookie');
  });

  it('refuses a redirect with no destination at all', () => {
    const verdict = judgeRedirectCallback(
      { status: 302, location: null },
      options,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain('未给出跳转地址');
  });
});
