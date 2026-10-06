import { describe, expect, it, vi } from 'vitest';
import {
  collectActiveXApiKeyIds,
  isXApiKeyRefreshDue,
  isXApiPlatform,
  isXApiSiteUrl,
  parseIssuedXApiKey,
  readLastIssuedAt,
  refreshXApiKeys,
  selectXApiKeyTargets,
  type XApiKeyRefreshDeps,
  type XApiKeyTarget,
} from './xapiKeyService.js';

function site(overrides: Record<string, unknown> = {}) {
  return {
    id: 46,
    name: 'X-API',
    url: 'https://x-api.cfd',
    platform: 'xapi',
    status: 'active',
    apiKey: null,
    createdAt: null,
    updatedAt: null,
    isPinned: false,
    sortOrder: 0,
    proxyUrl: null,
    useSystemProxy: false,
    customHeaders: null,
    externalCheckinUrl: null,
    globalWeight: 1,
    postRefreshProbeEnabled: false,
    postRefreshProbeModel: '',
    postRefreshProbeScope: 'single',
    postRefreshProbeLatencyThresholdMs: 0,
    customHeadersOverrideRequestHeaders: false,
    maxConcurrency: 0,
    ...overrides,
  } as never;
}

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 32,
    siteId: 46,
    username: 'linuxdo',
    accessToken: '',
    apiToken: 'xapi_old',
    extraConfig: null,
    status: 'active',
    ...overrides,
  } as never;
}

describe('xapiKeyService / URL and platform guards', () => {
  it('accepts the X-API host and rejects look-alikes', () => {
    expect(isXApiSiteUrl('https://x-api.cfd')).toBe(true);
    expect(isXApiSiteUrl('https://x-api.cfd/console/keys')).toBe(true);
    expect(isXApiSiteUrl('https://evil.example.com/x-api.cfd')).toBe(false);
    expect(isXApiSiteUrl('https://evil.example.com/?next=https://x-api.cfd')).toBe(false);
    expect(isXApiSiteUrl('http://x-api.cfd')).toBe(false);
  });

  it('recognises both the canonical and legacy platform names', () => {
    expect(isXApiPlatform('xapi')).toBe(true);
    expect(isXApiPlatform('X-API')).toBe(true);
    expect(isXApiPlatform('new-api')).toBe(false);
    expect(isXApiPlatform(null)).toBe(false);
  });
});

describe('xapiKeyService / issuance payload parsing', () => {
  it('reads the one-time plaintext key', () => {
    expect(parseIssuedXApiKey(JSON.stringify({ key: 'xapi_abcdefghijklmnop' })))
      .toBe('xapi_abcdefghijklmnop');
  });

  it('refuses a masked echo, an empty body or a non-JSON page', () => {
    expect(parseIssuedXApiKey(JSON.stringify({ key: 'xapi_****' }))).toBeNull();
    expect(parseIssuedXApiKey(JSON.stringify({}))).toBeNull();
    expect(parseIssuedXApiKey('<html>403</html>')).toBeNull();
    expect(parseIssuedXApiKey(JSON.stringify({ key: 'sk-other' }))).toBeNull();
  });

  it('only treats keys the site has not revoked as usable', () => {
    expect(collectActiveXApiKeyIds({
      keys: [
        { id: '9051', revoked_at: null },
        { id: '8726', revoked_at: '2026-10-04T10:11:38.852Z' },
      ],
    })).toEqual(['9051']);
    expect(collectActiveXApiKeyIds(null)).toEqual([]);
    expect(collectActiveXApiKeyIds({ keys: 'nope' })).toEqual([]);
  });
});

describe('xapiKeyService / daily cadence', () => {
  it('is due once per day, on or after the configured hour', () => {
    const now = new Date(2026, 9, 5, 6, 30, 0);
    expect(isXApiKeyRefreshDue(null, now, 5)).toBe(true);
    expect(isXApiKeyRefreshDue(new Date(2026, 9, 5, 5, 10, 0).toISOString(), now, 5)).toBe(false);
    expect(isXApiKeyRefreshDue(new Date(2026, 9, 4, 23, 50, 0).toISOString(), now, 5)).toBe(true);
    expect(isXApiKeyRefreshDue('not-a-date', now, 5)).toBe(true);
  });

  it('is not due before the hour arrives', () => {
    const early = new Date(2026, 9, 5, 3, 0, 0);
    expect(isXApiKeyRefreshDue(null, early, 5)).toBe(false);
  });

  it('reads the last issuance marker out of extraConfig', () => {
    const at = '2026-10-05T06:00:00.000Z';
    expect(readLastIssuedAt(JSON.stringify({ xapiKeyAutoIssuedAt: at }))).toBe(at);
    expect(readLastIssuedAt('{}')).toBeNull();
    expect(readLastIssuedAt('not json')).toBeNull();
  });
});

describe('xapiKeyService / target selection', () => {
  it('picks active X-API sites and ignores everything else', () => {
    const targets = selectXApiKeyTargets(
      [
        site(),
        site({ id: 39, name: 'Columbina', url: 'https://newapi.columbina.eu.org', platform: 'new-api' }),
        site({ id: 50, name: 'disabled', status: 'disabled' }),
        site({ id: 51, name: 'look-alike', url: 'https://evil.example.com/x-api.cfd', platform: 'new-api' }),
      ],
      [account(), account({ id: 99, siteId: 39 })],
    );
    expect(targets.map((target) => target.siteId)).toEqual([46]);
    expect(targets[0]).toMatchObject({ accountId: 32, siteName: 'X-API' });
  });

  it('returns nothing once the site is deleted, which retires the task', () => {
    expect(selectXApiKeyTargets([], [])).toEqual([]);
    expect(selectXApiKeyTargets([site({ id: 46, url: 'https://other.example.com', platform: 'new-api' })], [account()]))
      .toEqual([]);
  });

  it('skips a site that has no bound account', () => {
    expect(selectXApiKeyTargets([site()], [])).toEqual([]);
  });
});

describe('xapiKeyService / refresh pass', () => {
  const target: XApiKeyTarget = {
    siteId: 46,
    siteName: 'X-API',
    siteUrl: 'https://x-api.cfd',
    accountId: 32,
    accountName: 'linuxdo',
  };

  function deps(overrides: Partial<XApiKeyRefreshDeps> = {}): XApiKeyRefreshDeps {
    return {
      loadTargets: async () => [target],
      loadLastIssuedAt: async () => null,
      issueKey: async () => ({ ok: true, key: 'xapi_newkey123456', message: 'ok', revokedKeyIds: ['9051'], signedIn: true }),
      persistKey: async () => undefined,
      refreshModels: async () => undefined,
      now: () => new Date(2026, 9, 5, 6, 0, 0),
      log: () => undefined,
      ...overrides,
    };
  }

  it('issues, persists and refreshes when due', async () => {
    const persistKey = vi.fn(async () => undefined);
    const refreshModels = vi.fn(async () => undefined);
    const summary = await refreshXApiKeys(deps({ persistKey, refreshModels }));
    expect(summary).toMatchObject({ targets: 1, issued: 1, failed: 0, skipped: 0, idle: false });
    expect(persistKey).toHaveBeenCalledWith(target, 'xapi_newkey123456');
    expect(refreshModels).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the site disappears', async () => {
    const issueKey = vi.fn();
    const summary = await refreshXApiKeys(deps({ loadTargets: async () => [], issueKey }));
    expect(summary).toMatchObject({ targets: 0, issued: 0, idle: true });
    expect(issueKey).not.toHaveBeenCalled();
  });

  it('leaves a key minted earlier today alone', async () => {
    const issueKey = vi.fn();
    const summary = await refreshXApiKeys(deps({
      loadLastIssuedAt: async () => new Date(2026, 9, 5, 5, 30, 0).toISOString(),
      issueKey,
    }));
    expect(summary).toMatchObject({ targets: 1, issued: 0, skipped: 1, idle: false });
    expect(issueKey).not.toHaveBeenCalled();
  });

  it('reports the real reason and keeps the old key when signing fails', async () => {
    const persistKey = vi.fn();
    const summary = await refreshXApiKeys(deps({
      issueKey: async () => ({ ok: false, key: null, message: 'X-API 未登录', revokedKeyIds: [], signedIn: false }),
      persistKey,
    }));
    expect(summary).toMatchObject({ issued: 0, failed: 1 });
    expect(summary.results[0].message).toContain('未登录');
    expect(persistKey).not.toHaveBeenCalled();
  });

  it('never stores a half-finished key when the body has no plaintext', async () => {
    const persistKey = vi.fn();
    const summary = await refreshXApiKeys(deps({
      issueKey: async () => ({ ok: false, key: null, message: '签发请求没有返回明文密钥', revokedKeyIds: [], signedIn: true }),
      persistKey,
    }));
    expect(summary.failed).toBe(1);
    expect(persistKey).not.toHaveBeenCalled();
  });
});
