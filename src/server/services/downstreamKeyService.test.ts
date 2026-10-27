import { beforeAll, describe, expect, it } from 'vitest';
import { config } from '../config.js';

let service: typeof import('./downstreamKeyService.js');

beforeAll(async () => {
  config.accountCredentialSecret = 'test-only-strong-secret-0123456789abcdef';
  service = await import('./downstreamKeyService.js');
});

describe('downstreamKeyService', () => {
  it('generates a signed high-entropy key', () => {
    const key = service.generateDownstreamSkKey();
    expect(key).toMatch(/^sk-[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{9}$/);
    expect(service.isDownstreamKeySignatureValid(key)).toBe(true);
    expect(service.looksLikeSignedDownstreamSkKey(key)).toBe(true);
  });

  it('rejects tampered payload and signature', () => {
    const key = service.generateDownstreamSkKey();
    const [payload, signature] = key.slice(3).split('.');
    expect(service.isDownstreamKeySignatureValid(`sk-${payload}x.${signature}`)).toBe(false);
    expect(service.isDownstreamKeySignatureValid(`sk-${payload}.${signature.slice(0, -1)}A`)).toBe(false);
  });

  it('keeps legacy unsigned keys compatible', () => {
    const legacy = `sk-${'a'.repeat(64)}`;
    expect(service.looksLikeSignedDownstreamSkKey(legacy)).toBe(false);
    expect(service.isDownstreamKeySignatureValid(legacy)).toBe(true);
    expect(service.validateDownstreamKeyValue(legacy).ok).toBe(true);
  });

  it('validates newly supplied keys', () => {
    const key = service.generateDownstreamSkKey();
    expect(service.validateDownstreamKeyValue(key).ok).toBe(true);
    expect(service.validateDownstreamKeyValue('token-without-prefix').ok).toBe(false);
  });
});
