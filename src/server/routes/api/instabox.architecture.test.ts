import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('instabox integration safeguards', () => {
  it('uses idempotency and confirm-delete headers for mutating calls', () => {
    const source = readFileSync(new URL('../../services/instaboxService.ts', import.meta.url), 'utf8');
    expect(source).toContain("headers['Idempotency-Key']");
    expect(source).toContain("headers['X-Confirm-Delete']");
    expect(source).toContain('idempotencyKey: randomUUID()');
    expect(source).toContain('confirmDelete: machineId');
  });

  it('stores the key under a dedicated encrypted setting scope', () => {
    const source = readFileSync(new URL('../../services/instaboxService.ts', import.meta.url), 'utf8');
    expect(source).toContain("deriveSecuritySeed('instabox-api-key')");
    expect(source).toContain("'instabox_api_key_v1'");
    expect(source).toContain('encryptInstaboxSecret(apiKey)');
  });

  it('does not allow upstream credential failures to log the admin out', () => {
    const source = readSource('./instabox.ts');
    expect(source).toContain('upstreamStatus === 401');
    expect(source).toContain('? 400');
  });

  it('contains no real InstaBox API key literal', () => {
    const sources = [
      readSource('./instabox.ts'),
      readFileSync(new URL('../../services/instaboxService.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../web/pages/InstaBox.tsx', import.meta.url), 'utf8'),
      readFileSync(new URL('../../../web/api.ts', import.meta.url), 'utf8'),
    ].join('\n');
    expect(sources).not.toMatch(/ibk_(?!test-key-for-unit-tests-only)[A-Za-z0-9]{20,}/);
  });
});
