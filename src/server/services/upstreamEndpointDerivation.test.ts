import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchModelPricingCatalogMock = vi.fn(async (_arg?: unknown, _opts?: unknown): Promise<any> => null);

vi.mock('./modelPricingService.js', () => ({
  fetchModelPricingCatalog: (arg: unknown, opts: unknown) => fetchModelPricingCatalogMock(arg, opts),
}));

import { resolveUpstreamEndpointCandidates } from './upstreamEndpointDerivation.js';
import { resetUpstreamEndpointRuntimeState } from './upstreamEndpointRuntimeMemory.js';

const baseContext = {
  site: {
    id: 1,
    url: 'https://upstream.example.com',
    platform: 'new-api',
    apiKey: null,
  },
  account: {
    id: 2,
    accessToken: 'token-demo',
    apiToken: null,
  },
};

describe('upstreamEndpointDerivation', () => {
  beforeEach(() => {
    fetchModelPricingCatalogMock.mockReset();
    fetchModelPricingCatalogMock.mockResolvedValue(null);
    resetUpstreamEndpointRuntimeState();
  });

  it('derives compact requests directly to responses from the service owner', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
      undefined,
      undefined,
      {
        requestKind: 'responses-compact',
      },
    );

    expect(order).toEqual(['responses']);
  });

  it('derives codex oauth openai requests as responses-first without surface-local reordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'openai',
      undefined,
      undefined,
      {
        oauthProvider: 'codex',
      },
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('prefers chat when the site rejects some of the custom tools', async () => {
    // agentrouter 的 Responses 接口只认 apply_patch，带 exec 过去必然 400
    // （`Unsupported custom tool: 'exec'`），所以让 chat 端点先上。
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'deepseek-v4-flash',
      'responses',
      undefined,
      undefined,
      {
        unsupportedResponsesCustomTools: true,
      },
    );

    expect(order).toEqual(['chat', 'messages', 'responses']);
  });

  it('keeps the usual responses-first order when every custom tool is supported', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'deepseek-v4-flash',
      'responses',
      undefined,
      undefined,
      {
        unsupportedResponsesCustomTools: false,
      },
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('keeps explicit openai platforms on responses-first ordering even for claude-family models', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-opus-4-6',
      'openai',
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });

  it('keeps antigravity non-gemini compatibility requests on messages-first ordering', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'antigravity',
        },
      },
      'claude-opus-4-6',
      'openai',
      undefined,
      {
        hasNonImageFileInput: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('keeps claude-family file-url requests messages-first for claude upstreams', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'claude',
        },
      },
      'claude-opus-4-6',
      'responses',
      undefined,
      {
        hasNonImageFileInput: true,
      },
      {
        requiresNativeResponsesFileUrl: true,
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('derives claude count_tokens requests as messages-only when the upstream supports messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'openai',
        },
      },
      'claude-sonnet-4-5-20250929',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual(['messages']);
  });

  it('returns no candidates for claude count_tokens when the upstream does not support messages', async () => {
    const order = await resolveUpstreamEndpointCandidates(
      {
        ...baseContext,
        site: {
          ...baseContext.site,
          platform: 'codex',
          url: 'https://chatgpt.com/backend-api/codex',
        },
      },
      'gpt-5.4',
      'claude',
      undefined,
      undefined,
      {
        requestKind: 'claude-count-tokens',
      },
    );

    expect(order).toEqual([]);
  });

  it('reorders endpoints from a cached pricing catalog', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue({
      models: [
        {
          modelName: 'gpt-5.3',
          supportedEndpointTypes: ['/v1/chat/completions'],
        },
      ],
    });

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
    );

    // 默认顺序是 responses 优先；价目表只声明支持 chat，于是 chat 被提到最前。
    expect(order).toEqual(['chat', 'responses', 'messages']);
    // 请求路径必须走「只读缓存」，不等待抓取。
    expect(fetchModelPricingCatalogMock).toHaveBeenCalledWith(
      expect.anything(),
      { cacheOnly: true },
    );
  });

  it('falls back to the default order when the catalog cache is empty', async () => {
    fetchModelPricingCatalogMock.mockResolvedValue(null);

    const order = await resolveUpstreamEndpointCandidates(
      baseContext,
      'gpt-5.3',
      'responses',
    );

    expect(order).toEqual(['responses', 'chat', 'messages']);
  });
});
