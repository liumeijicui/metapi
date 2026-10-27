import { afterEach, describe, expect, it } from 'vitest';
import { getBrowserFingerprint, resetBrowserFingerprintCacheForTests } from './fingerprint.js';

/**
 * 这些用例运行在 jsdom 下：canvas / WebGL 都不可用，正好覆盖降级路径——
 * 指纹采集必须在缺少这些 API 时仍然返回稳定结果，绝不能阻断登录。
 */
describe('browser fingerprint', () => {
  afterEach(() => {
    resetBrowserFingerprintCacheForTests();
  });

  it('returns a stable hash and detail even without canvas/webgl', async () => {
    const first = await getBrowserFingerprint();
    expect(first.hash).toMatch(/^[a-f0-9]{64}$|^fnv1a[0-9a-f]{8}$/);
    expect(Object.keys(first.detail).length).toBeGreaterThanOrEqual(3);
    expect(first.detail.timezone).toBeTypeOf('string');

    const second = await getBrowserFingerprint();
    expect(second.hash).toBe(first.hash);
  });

  it('does not include anything that looks like a credential', async () => {
    const { detail } = await getBrowserFingerprint();
    const serialized = JSON.stringify(detail).toLowerCase();
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
  });
});
