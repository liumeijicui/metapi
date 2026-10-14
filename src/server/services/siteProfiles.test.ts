import { describe, expect, it } from 'vitest';
import {
  applySiteInferenceUserAgent,
  hasExplicitUserAgent,
  resolveResponsesToolOutputMediaPolicy,
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
    const agentrouterUrl = 'https://agentrouter.org';
    const agentrouterPlatform = 'agentroute';
    expect(resolveUnsupportedResponsesCustomToolNames(agentrouterUrl, [], agentrouterPlatform)).toEqual([]);
    expect(
      resolveUnsupportedResponsesCustomToolNames(agentrouterUrl, ['apply_patch'], agentrouterPlatform),
    ).toEqual([]);
    expect(
      resolveUnsupportedResponsesCustomToolNames(agentrouterUrl, ['apply_patch', 'exec'], agentrouterPlatform),
    ).toEqual(['exec']);
    expect(
      resolveUnsupportedResponsesCustomToolNames(agentrouterUrl, ['exec'], agentrouterPlatform),
    ).toEqual(['exec']);
    // 重复的名字只报一次。
    expect(
      resolveUnsupportedResponsesCustomToolNames(agentrouterUrl, ['exec', 'exec'], agentrouterPlatform),
    ).toEqual(['exec']);
  });

  it('转发站的 Responses 端点默认不认 custom 工具，全部降级；原生 Responses 平台才透传', () => {
    // happycoding（new-api）实测把 tools 原样转给只认 Chat Completions 的上游，
    // `type: "custom"` 会被上游 422（unknown variant `custom`, expected `function`），
    // 改写成 function 后回 200 —— 所以这个平台上的 custom 声明一律降级。
    expect(
      resolveUnsupportedResponsesCustomToolNames('https://happycoding.xyz', ['apply_patch', 'exec'], 'new-api'),
    ).toEqual(['apply_patch', 'exec']);
    // sub2api / 未知平台同样按「不认 custom」处理（安全默认）。
    expect(
      resolveUnsupportedResponsesCustomToolNames('https://example.com', ['exec'], 'sub2api'),
    ).toEqual(['exec']);
    expect(resolveUnsupportedResponsesCustomToolNames('not-a-url', ['exec'])).toEqual(['exec']);

    // 原生 Responses 实现原样透传。
    expect(
      resolveUnsupportedResponsesCustomToolNames('https://api.openai.com', ['apply_patch', 'exec'], 'openai'),
    ).toEqual([]);
    expect(
      resolveUnsupportedResponsesCustomToolNames('https://chatgpt.com/backend-api/codex', ['exec'], 'codex'),
    ).toEqual([]);
    // host 白名单优先于平台判定：agentrouter 上的 apply_patch 仍然是自定义工具。
    expect(
      resolveUnsupportedResponsesCustomToolNames('https://agentrouter.org', ['apply_patch'], 'new-api'),
    ).toEqual([]);
  });

  it('工具结果里的图片只有「君の公益 + deepseek-v4.1-flash」才搬运，别的站点/模型一律不改', () => {
    // 唯一命中的组合（实测那条 400）。
    expect(
      resolveResponsesToolOutputMediaPolicy('https://muyuan.do', 'new-api', 'deepseek-v4.1-flash'),
    ).toBe('hoist');
    // 子域同样命中。
    expect(
      resolveResponsesToolOutputMediaPolicy('https://api.muyuan.do/v1', 'new-api', 'deepseek-v4.1-flash'),
    ).toBe('hoist');
    // 同一个站点、别的模型：不动。
    expect(
      resolveResponsesToolOutputMediaPolicy('https://muyuan.do', 'new-api', 'gpt-6.1-sol'),
    ).toBe('passthrough');
    // 别的站点：不动，哪怕模型名一样。
    expect(
      resolveResponsesToolOutputMediaPolicy('https://happycoding.xyz', 'new-api', 'deepseek-v4.1-flash'),
    ).toBe('passthrough');
    // 平台对不上也不动（host 白名单只在它自己那条记录上生效，不跨平台放宽）。
    expect(
      resolveResponsesToolOutputMediaPolicy('https://api.openai.com', 'openai', 'deepseek-v4.1-flash'),
    ).toBe('passthrough');
    // 缺模型名时按「不确定」处理：不放行。
    expect(resolveResponsesToolOutputMediaPolicy('https://muyuan.do', 'new-api')).toBe('passthrough');
    expect(resolveResponsesToolOutputMediaPolicy('https://muyuan.do', 'new-api', '')).toBe('passthrough');
    // 坏 URL 不能抛，也不能误命中。
    expect(resolveResponsesToolOutputMediaPolicy('not-a-url', 'new-api', 'deepseek-v4.1-flash'))
      .toBe('passthrough');
    expect(resolveResponsesToolOutputMediaPolicy(null, 'new-api', 'deepseek-v4.1-flash'))
      .toBe('passthrough');
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
