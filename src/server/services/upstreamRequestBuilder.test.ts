import { describe, expect, it } from 'vitest';

import {
  buildClaudeCountTokensUpstreamRequest,
  buildUpstreamEndpointRequest,
} from './upstreamRequestBuilder.js';

describe('upstreamRequestBuilder', () => {
  it('agentrouter 的推理请求会自动带上它要求的客户端标识', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'deepseek-v4-flash',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'agentrouter',
      siteUrl: 'https://agentrouter.org',
      openaiBody: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
      downstreamFormat: 'openai',
      downstreamHeaders: {},
    });

    // 缺了这个 UA，站点会回 401 unauthorized client detected。
    expect(request.headers['User-Agent']).toBe('claude-cli/2.0.30 (external, cli)');
    expect(request.path).toBe('/v1/chat/completions');
  });

  it('下游客户端自带的 User-Agent 会被站点指纹替换掉', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'deepseek-v4-flash',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'agentrouter',
      siteUrl: 'https://agentrouter.org',
      openaiBody: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
      downstreamFormat: 'openai',
      downstreamHeaders: { 'user-agent': 'codex_cli_rs/0.50.0 (Mac OS 15.0; arm64)' },
    });

    // Codex / Claude Code 客户端自己带的 UA 正是 agentrouter 要拒的：把下游透传
    // 的 UA 当“已经指定过”而放行，结果就是每个 codex 请求都 401
    // unauthorized client detected（实测踩过，见 siteProfiles 的注释）。
    expect(request.headers['User-Agent']).toBe('claude-cli/2.0.30 (external, cli)');
    expect(request.headers['user-agent']).toBeUndefined();
  });

  it('站点/账号上人工配置的 User-Agent 优先，保留手工兜底通道', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'deepseek-v4-flash',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'agentrouter',
      siteUrl: 'https://agentrouter.org',
      openaiBody: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
      downstreamFormat: 'openai',
      downstreamHeaders: { 'user-agent': 'codex_cli_rs/0.50.0 (Mac OS 15.0; arm64)' },
      providerHeaders: { 'User-Agent': 'my-own-client/9.9' },
    });

    expect(request.headers['User-Agent']).toBe('my-own-client/9.9');
  });

  it('其它站点不会被注入客户端标识', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'kimi-k3',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'new-api',
      siteUrl: 'https://happycoding.xyz',
      openaiBody: { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }], stream: true },
      downstreamFormat: 'openai',
      downstreamHeaders: {},
    });

    expect(request.headers['User-Agent']).toBeUndefined();
  });

  it('routes Gemini official chat tool history through native generateContent with signed functionCall parts', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'gemini-3.5-flash',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'gemini',
      siteUrl: 'https://generativelanguage.googleapis.com',
      openaiBody: {
        model: 'gemini-3.5-flash',
        stream: true,
        messages: [
          { role: 'system', content: 'You are concise.' },
          { role: 'user', content: 'List files.' },
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_read',
                type: 'function',
                function: {
                  name: 'read',
                  arguments: '{"path":"/tmp/a"}',
                },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_read', content: 'file content' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        tool_choice: 'auto',
      },
      downstreamFormat: 'openai',
    });

    expect(request.path).toBe('/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=sk-test');
    expect(request.headers.Authorization).toBeUndefined();
    expect(request.runtime).toMatchObject({
      executor: 'gemini-native',
      action: 'streamGenerateContent',
      modelName: 'gemini-3.5-flash',
      stream: true,
    });
    expect(request.body).toHaveProperty('contents');
    expect(request.body).not.toHaveProperty('messages');

    const contents = request.body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const functionCallParts = contents
      .flatMap((content) => content.parts)
      .filter((part) => 'functionCall' in part);

    expect(functionCallParts).toHaveLength(1);
    expect(functionCallParts[0].thoughtSignature).toEqual(expect.any(String));
  });

  it('normalizes single-message OpenAI requests to structured responses input', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('application/json');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.store).toBe(false);
  });

  it('rejects insecure URLs before embedding a Gemini API key in a native path', () => {
    expect(() => buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'gemini-3.5-flash',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'gemini',
      siteUrl: 'http://generativelanguage.googleapis.com',
      openaiBody: {
        model: 'gemini-3.5-flash',
        messages: [
          { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        ],
      },
      downstreamFormat: 'openai',
    })).toThrow('HTTPS');
  });

  it('forces store=false for sub2api native responses passthrough bodies', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {},
      downstreamFormat: 'responses',
      responsesOriginalBody: {
        model: 'gpt-5.2',
        input: 'hello',
        store: true,
      },
    });

    expect(request.path).toBe('/v1/responses');
    expect(request.headers.accept).toBe('text/event-stream');
    expect(request.body.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
    expect(request.body.stream).toBe(true);
    expect(request.body.store).toBe(false);
  });

  it('overrides downstream Accept so responses transport mode wins', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'upstream-gpt',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'openai',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
      },
    });

    expect(request.headers.accept).toBe('text/event-stream');
  });

  it('applies a sub2api-style allowlist to generic passthrough headers', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'chat',
      modelName: 'upstream-gpt',
      stream: false,
      tokenValue: 'sk-test',
      sitePlatform: 'sub2api',
      siteUrl: 'https://example.com',
      openaiBody: {
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamFormat: 'openai',
      downstreamHeaders: {
        accept: 'application/json',
        'accept-language': 'zh-CN',
        'user-agent': 'client-ua/1.0',
        originator: 'codex_cli_rs',
        session_id: 'session-123',
        conversation_id: 'conversation-123',
        'x-codex-turn-state': 'turn-state',
        'x-codex-turn-metadata': 'turn-metadata',
        origin: 'https://client.example',
        referer: 'https://client.example/chat',
        'x-forwarded-for': '203.0.113.1',
        'x-real-ip': '203.0.113.2',
        version: '0.202.0',
        'x-test-header': 'drop-me',
      },
    });

    expect(request.headers.accept).toBe('application/json');
    expect(request.headers['accept-language']).toBe('zh-CN');
    expect(request.headers['user-agent']).toBe('client-ua/1.0');
    expect(request.headers.originator).toBe('codex_cli_rs');
    expect(request.headers.session_id).toBe('session-123');
    expect(request.headers.conversation_id).toBe('conversation-123');
    expect(request.headers['x-codex-turn-state']).toBe('turn-state');
    expect(request.headers['x-codex-turn-metadata']).toBe('turn-metadata');

    expect(request.headers.origin).toBeUndefined();
    expect(request.headers.referer).toBeUndefined();
    expect(request.headers['x-forwarded-for']).toBeUndefined();
    expect(request.headers['x-real-ip']).toBeUndefined();
    expect(request.headers.version).toBeUndefined();
    expect(request.headers['x-test-header']).toBeUndefined();
  });

  it('drops responses-style continuation fields before proxying Claude count_tokens upstream', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        max_tokens: 256,
        previous_response_id: 'resp_prev_1',
        prompt_cache_key: 'cache-key-1',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(request.body).toMatchObject({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user' }],
    });
    expect(request.body).not.toHaveProperty('previous_response_id');
    expect(request.body).not.toHaveProperty('prompt_cache_key');
    expect(request.body).not.toHaveProperty('max_tokens');
    expect(request.body).not.toHaveProperty('maxTokens');
  });

  it('merges body betas with existing anthropic-beta headers for Claude count_tokens', () => {
    const request = buildClaudeCountTokensUpstreamRequest({
      modelName: 'claude-opus-4-6',
      tokenValue: 'sk-test',
      sitePlatform: 'claude',
      claudeBody: {
        model: 'claude-opus-4-6',
        betas: ['beta-from-body'],
        messages: [{ role: 'user', content: 'hello' }],
      },
      downstreamHeaders: {
        'anthropic-beta': 'header-beta',
      },
    });

    expect(request.headers['anthropic-beta']).toContain('header-beta');
    expect(request.headers['anthropic-beta']).toContain('beta-from-body');
  });
  it('agentrouter 的 Responses 请求会把不认的 custom 工具降级成 function', () => {
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'deepseek-v4-flash',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'agentrouter',
      siteUrl: 'https://agentrouter.org',
      openaiBody: {
        model: 'deepseek-v4-flash',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        tools: [{ type: 'function', name: 'exec', parameters: { type: 'object' } }],
      },
      downstreamFormat: 'responses',
      downstreamHeaders: {},
      responsesOriginalBody: {
        model: 'deepseek-v4-flash',
        stream: true,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        tools: [
          { type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'start: SOURCE' } },
          { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: PATCH' } },
        ],
      },
    });

    expect(request.path).toBe('/v1/responses');
    const tools = (request.body as any).tools;
    // 站点只认 apply_patch，exec 必须变成 function，否则源站回
    // 400 Unsupported custom tool: 'exec'。
    expect(tools.find((tool: any) => tool.name === 'exec')).toMatchObject({ type: 'function' });
    expect(tools.find((tool: any) => tool.name === 'apply_patch')).toMatchObject({ type: 'custom' });
  });

  it('不限制自定义工具的站点保持 custom 声明不变', () => {
    const originalBody = {
      model: 'kimi-k3',
      stream: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{ type: 'custom', name: 'exec', format: { type: 'grammar', syntax: 'lark', definition: 'start: SOURCE' } }],
    };
    const request = buildUpstreamEndpointRequest({
      endpoint: 'responses',
      modelName: 'kimi-k3',
      stream: true,
      tokenValue: 'sk-test',
      sitePlatform: 'new-api',
      siteUrl: 'https://happycoding.xyz',
      openaiBody: { model: 'kimi-k3', input: originalBody.input, tools: originalBody.tools },
      downstreamFormat: 'responses',
      downstreamHeaders: {},
      responsesOriginalBody: originalBody,
    });

    expect((request.body as any).tools[0]).toMatchObject({ type: 'custom', name: 'exec' });
  });
});
