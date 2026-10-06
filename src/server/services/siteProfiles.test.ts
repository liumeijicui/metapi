import { describe, expect, it } from 'vitest';
import {
  hasExplicitUserAgent,
  resolveSiteInferenceUserAgent,
  siteRequiresSystemProxy,
} from './siteProfiles.js';

describe('siteProfiles', () => {
  it('agentrouter 的推理接口必须带 Claude Code 客户端标识，控制台接口不用', () => {
    const ua = resolveSiteInferenceUserAgent('https://agentrouter.org/v1/chat/completions');
    expect(ua).toBe('claude-cli/2.0.30 (external, cli)');

    // 只有 /v1/* 才算推理接口：签到/登录走的控制台接口不能被动过。
    expect(resolveSiteInferenceUserAgent('https://agentrouter.org/api/status')).toBeNull();
    expect(resolveSiteInferenceUserAgent('https://agentrouter.org/api/log/self')).toBeNull();
    expect(resolveSiteInferenceUserAgent('https://agentrouter.org/')).toBeNull();
  });

  it('上游请求构造器只有站点根地址时也能拿到 UA（否则 UA 根本注入不进去）', () => {
    // 这是实测踩到的坑：site.url 的 pathname 是 '/'，按路径判定会返回 null，
    // 表现为「加了 UA 还是 401」。
    expect(resolveSiteInferenceUserAgent('https://agentrouter.org')).toBeNull();
    expect(
      resolveSiteInferenceUserAgent('https://agentrouter.org', { requireInferencePath: false }),
    ).toBe('claude-cli/2.0.30 (external, cli)');
  });

  it('不认识的站点一律不注入 UA', () => {
    expect(resolveSiteInferenceUserAgent('https://happycoding.xyz/v1/chat/completions')).toBeNull();
    expect(resolveSiteInferenceUserAgent('not-a-url')).toBeNull();
  });

  it('已有显式 User-Agent 时不会被覆盖', () => {
    expect(hasExplicitUserAgent({ 'user-agent': 'x' })).toBe(true);
    expect(hasExplicitUserAgent({ 'User-Agent': 'x' })).toBe(true);
    expect(hasExplicitUserAgent({ Authorization: 'Bearer x' })).toBe(false);
    expect(hasExplicitUserAgent(undefined)).toBe(false);
    expect(hasExplicitUserAgent(new Headers({ 'user-agent': 'x' }))).toBe(true);
  });

  it('agentrouter 走系统代理这条已知事实没被改动', () => {
    expect(siteRequiresSystemProxy('agentrouter.org')).toBe(true);
  });
});
