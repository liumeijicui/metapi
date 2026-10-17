import { describe, expect, it } from 'vitest';
import { describeProxyFailureClient } from './alertService.js';

describe('describeProxyFailureClient', () => {
  it('把来源 IP、客户端标识、路径与下游 Key 一起写进通知', () => {
    expect(describeProxyFailureClient({
      ip: '116.147.251.163',
      userAgent: 'Codex/0.48.0 (windows)',
      kind: 'codex',
      path: '/v1/responses',
      keyId: 2,
      session: '01a143d6-23bd-7b73-9b2f-6556932a5556',
    })).toBe('；来源：客户端=codex，路径=/v1/responses，Key=#2，会话=01a143d6-23bd-7b73-9b2f-6556932a5556，IP=116.147.251.163，UA=Codex/0.48.0 (windows)');
  });

  it('没有来源信息时不追加任何后缀', () => {
    expect(describeProxyFailureClient(null)).toBe('');
    expect(describeProxyFailureClient({})).toBe('');
  });

  it('数组形式的 user-agent 取第一个值，超长会被截断', () => {
    const suffix = describeProxyFailureClient({
      userAgent: [`${'x'.repeat(120)}`],
    });
    expect(suffix).toContain('UA=x');
    expect(suffix.length).toBeLessThan(120);
  });
});
