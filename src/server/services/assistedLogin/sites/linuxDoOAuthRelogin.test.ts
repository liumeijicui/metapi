import { describe, expect, it } from 'vitest';

import { readLegacyOAuthState, readOAuthFlowToken } from './linuxDoOAuthRelogin.js';

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
