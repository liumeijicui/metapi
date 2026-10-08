import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type SettingsEntry = { key: string; value: unknown };

describe('边缘实例本地设置策略', () => {
  let dataDir = '';
  let buildLocalPreferencesPayload: (input: {
    version?: unknown;
    settings: SettingsEntry[];
    timestamp: number;
  }) => { preferences: { settings: SettingsEntry[] } };
  let detectLocalSystemProxyUrl: () => string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-edge-settings-'));
    process.env.DATA_DIR = dataDir;
    process.env.DB_URL = ':memory:';
    process.env.METAPI_EDGE_MODE = '1';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '30086';

    buildLocalPreferencesPayload = (await import('./localSettingsPolicy.js')).buildLocalPreferencesPayload;
    detectLocalSystemProxyUrl = (await import('./localSystemProxy.js')).detectLocalSystemProxyUrl;
  }, 120_000);

  afterAll(() => {
    delete process.env.DATA_DIR;
    delete process.env.DB_URL;
    delete process.env.METAPI_EDGE_MODE;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('服务器那份系统代理换成本机探测结果，通知与本地令牌照旧清掉', () => {
    const payload = buildLocalPreferencesPayload({
      version: '2.1',
      timestamp: 1,
      settings: [
        // 服务器那份指向服务器自己的代理，本地不能照抄。
        { key: 'system_proxy_url', value: 'http://10.9.9.9:7890' },
        { key: 'auth_token', value: 'server-token' },
        { key: 'admin_ip_allowlist', value: '1.2.3.4' },
        { key: 'webhook_enabled', value: true },
        { key: 'sticky_session_ttl', value: 120 },
      ],
    });

    const settings = payload.preferences.settings;
    const systemProxy = settings.filter((entry) => entry.key === 'system_proxy_url');
    expect(systemProxy).toHaveLength(1);
    expect(systemProxy[0].value).toBe(detectLocalSystemProxyUrl());
    expect(settings.some((entry) => entry.key === 'auth_token')).toBe(false);
    expect(settings.find((entry) => entry.key === 'admin_ip_allowlist')?.value).toBe('');
    expect(settings.find((entry) => entry.key === 'webhook_enabled')?.value).toBe(false);
    expect(settings.find((entry) => entry.key === 'sticky_session_ttl')?.value).toBe(120);
  });
});

