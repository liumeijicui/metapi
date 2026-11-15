import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INSTABOX_SSH_RENEW_BEFORE_MS,
  buildInstaboxSshCommand,
  isInstaboxSshTokenExpiring,
} from './instaboxSshService.js';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('instabox SSH auto-renewal', () => {
  it('builds the exact command shown by InstaBox', () => {
    expect(buildInstaboxSshCommand('ibssh_test-token', 'api.instabox.sh', 2222))
      .toBe('ssh -p 2222 ibssh_test-token@api.instabox.sh');
  });

  it('renews seven days before expiry and not earlier', () => {
    const now = Date.parse('2026-11-03T00:00:00Z');
    const eightDays = new Date(now + 8 * 24 * 60 * 60 * 1_000).toISOString();
    const sixDays = new Date(now + 6 * 24 * 60 * 60 * 1_000).toISOString();
    expect(isInstaboxSshTokenExpiring(eightDays, now)).toBe(false);
    expect(isInstaboxSshTokenExpiring(sixDays, now)).toBe(true);
    expect(INSTABOX_SSH_RENEW_BEFORE_MS).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it('never revokes existing tokens during automatic rotation', () => {
    const source = readFileSync(new URL('./instaboxSshService.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('revokeInstaboxSshToken');
    expect(source).toContain("'instabox_ssh_tokens_v1'");
    expect(source).toContain('encryptInstaboxSecret(created.token)');
    expect(source).toContain('INSTABOX_SSH_CHECK_INTERVAL_MS');
  });

  it('exposes authenticated page and manual refresh routes', () => {
    const source = readSource('../routes/api/instabox.ts');
    expect(source).toContain("'/api/instabox/machines/:id/ssh'");
    expect(source).toContain("'/api/instabox/machines/:id/ssh/refresh'");
    expect(source).toContain("'/api/instabox/machines/:id/files'");
    expect(source).toContain('bodyLimit: INSTABOX_UPLOAD_MAX_BYTES');
  });
});
