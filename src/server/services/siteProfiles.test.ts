import { describe, expect, it } from 'vitest';
import {
  applySiteInferenceUserAgent,
  hasExplicitUserAgent,
  resolveSiteAnthropicBetaHeaders,
  resolveSiteInferenceUserAgent,
  resolveUnsupportedResponsesCustomToolNames,
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

  it('下游客户端自带 UA 时也要换成站点指纹，只有人工配置的 UA 才保留', () => {
    const headers: Record<string, string> = {
      accept: '*/*',
      'user-agent': 'codex_cli_rs/0.50.0 (Mac OS 15.0; arm64)',
    };
    applySiteInferenceUserAgent(headers, 'https://agentrouter.org', { requireInferencePath: false });
    expect(headers['User-Agent']).toBe('claude-cli/2.0.30 (external, cli)');
    // 透传下来的小写键必须清掉，否则 undici 会不会用旧值取决于键顺序。
    expect(Object.keys(headers).some((key) => key.toLowerCase() === 'user-agent' && key !== 'User-Agent'))
      .toBe(false);

    // 站点里人工配了 UA 时不动它（手工兜底通道）。
    const configured: Record<string, string> = { 'user-agent': 'claude-cli/2.1.40 (external, cli)' };
    applySiteInferenceUserAgent(configured, 'https://agentrouter.org', {
      requireInferencePath: false,
      configuredUserAgent: true,
    });
    expect(configured['user-agent']).toBe('claude-cli/2.1.40 (external, cli)');

    // 不卡指纹的站点什么都不做。
    const other: Record<string, string> = { 'user-agent': 'happy/1.0' };
    applySiteInferenceUserAgent(other, 'https://happycoding.xyz', { requireInferencePath: false });
    expect(other['user-agent']).toBe('happy/1.0');
  });

  it('agentrouter 的 Responses 接口只认 apply_patch，别的自定义工具要降级', () => {
    expect(resolveUnsupportedResponsesCustomToolNames('https://agentrouter.org', [])).toEqual([]);
    expect(resolveUnsupportedResponsesCustomToolNames('https://agentrouter.org', ['apply_patch'])).toEqual([]);
    expect(
      resolveUnsupportedResponsesCustomToolNames('https://agentrouter.org', ['apply_patch', 'exec']),
    ).toEqual(['exec']);
    expect(resolveUnsupportedResponsesCustomToolNames('https://agentrouter.org', ['exec'])).toEqual(['exec']);
    // 重复的名字只报一次。
    expect(resolveUnsupportedResponsesCustomToolNames('https://agentrouter.org', ['exec', 'exec'])).toEqual(['exec']);

    // 别的站点不做这个限制判断。
    expect(resolveUnsupportedResponsesCustomToolNames('https://happycoding.xyz', ['exec'])).toEqual([]);
    expect(resolveUnsupportedResponsesCustomToolNames('not-a-url', ['exec'])).toEqual([]);
  });

  it('anyrouter 的 messages 端点必须补上 1M 上下文的 opt-in beta', () => {
    // 不带这个头，站点会对 claude 模型回一句和真实原因无关的
    // 400「1m 上下文已经全量可用，请启用 1m 上下文后重试」。
    expect(resolveSiteAnthropicBetaHeaders('https://anyrouter.top')).toEqual(['context-1m-2025-08-07']);
    expect(resolveSiteAnthropicBetaHeaders('https://anyrouter.top/v1/messages'))
      .toEqual(['context-1m-2025-08-07']);
    // 子域同样命中。
    expect(resolveSiteAnthropicBetaHeaders('https://api.anyrouter.top/v1/messages'))
      .toEqual(['context-1m-2025-08-07']);
    // 其它站点不注入，坏 URL 也不能抛。
    expect(resolveSiteAnthropicBetaHeaders('https://happycoding.xyz/v1/messages')).toEqual([]);
    expect(resolveSiteAnthropicBetaHeaders('not-a-url')).toEqual([]);
    expect(resolveSiteAnthropicBetaHeaders(null)).toEqual([]);
  });
});
