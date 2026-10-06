import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type ProxyTestRequestEnvelope } from './api.js';
import { persistAuthSession } from './authSession.js';

function createMemoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
  };
}

function installPendingFetch() {
  const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api proxy test timeout handling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('localStorage', createMemoryStorage());
    persistAuthSession(globalThis.localStorage as Storage, 'token-1');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('直连对话收到上游 401 时不会清掉本地登录态（否则一对话就被踢下线）', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: '上游站点拒绝了这次调用（HTTP 401）：unauthorized client detected' } }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await api.directChatStream({
      siteId: 35,
      accountId: 19,
      tokenId: 13,
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(response.status).toBe(502);
    // 关键：请求必须带着「别按会话过期处理」的开关，cookie/token 要还在。
    expect(globalThis.localStorage.getItem('auth_token')).toBe('token-1');
  });

  it('直连对话把上游 401 真实回传时，也不会把自己当作会话过期清 token', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: { message: 'unauthorized client detected' } }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await api.directChatStream({
      siteId: 35,
      accountId: 19,
      tokenId: 13,
      model: 'gpt-5',
      messages: [{ role: 'user', content: 'hi' }],
    });

    // 服务端已经改成 502；万一以后这里又漏出 401，前端也不能把用户踢下线。
    expect(response.status).toBe(401);
    expect(globalThis.localStorage.getItem('auth_token')).toBe('token-1');
  });

  it('keeps image generation proxy tests alive past the default 30 second timeout', async () => {
    installPendingFetch();

    const payload: ProxyTestRequestEnvelope = {
      method: 'POST',
      path: '/v1/images/generations',
      requestKind: 'json',
      jsonBody: {
        model: 'gemini-imagen',
        prompt: 'banana cat',
      },
    };

    let settled = false;
    const promise = api.proxyTest(payload);
    const handled = promise
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected image generation proxy test to time out');
    }
    expect(result.error.message).toBe('请求超时（150s）');
  });

  it('still uses the default 30 second timeout for generic proxy tests', async () => {
    installPendingFetch();

    const payload: ProxyTestRequestEnvelope = {
      method: 'POST',
      path: '/v1/embeddings',
      requestKind: 'json',
      jsonBody: {
        model: 'text-embedding-3-small',
        input: 'hello',
      },
    };

    const promise = api.proxyTest(payload).catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toMatchObject({ message: '请求超时（30s）' });
  });

  it('keeps all-model site probes alive past the default 30 second timeout', async () => {
    installPendingFetch();

    let settled = false;
    const promise = api.probeSiteNow(1, { scope: 'all' });
    const handled = promise
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(90_000);
    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected all-model site probe to time out');
    }
    expect(result.error.message).toBe('请求超时（120s）');
  });

  it('times out replay hydration file-content fetches after 30 seconds', async () => {
    installPendingFetch();

    const getProxyFileContentDataUrl = (api as Record<string, any>).getProxyFileContentDataUrl;
    let settled = false;
    const handled = getProxyFileContentDataUrl?.('file-metapi-123')
      .then(() => ({ ok: true as const }))
      .catch((error: Error) => ({ ok: false as const, error }))
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);

    const result = await handled;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected replay hydration file-content fetch to time out');
    }
    expect(result.error.message).toBe('请求超时（30s）');
  });

  it('loads proxy file content as a data URL for replay hydration', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Blob([Buffer.from('PDF')], { type: 'application/pdf' }),
      {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'inline; filename="brief.pdf"',
        },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const getProxyFileContentDataUrl = (api as Record<string, any>).getProxyFileContentDataUrl;
    const result = await getProxyFileContentDataUrl?.('file-metapi-123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/v1/files/file-metapi-123/content');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('GET');
    expect(init?.headers).toBeInstanceOf(Headers);
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer token-1');
    expect(result).toEqual({
      filename: 'brief.pdf',
      mimeType: 'application/pdf',
      data: 'data:application/pdf;base64,UERG',
    });
  });

  it('reuses the same proxy test implementations for legacy aliases', () => {
    expect(api.proxyTest).toBe(api.testProxy);
    expect(api.proxyTestStream).toBe(api.testProxyStream);
  });
});
