import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  buildDesktopServerEnv,
  createDesktopServerUrl,
  isFatalServerExit,
  resolveDesktopDefaultPort,
  resolveDesktopEdgeMode,
  resolveDesktopServerEntryRelativePath,
  resolveDesktopServerPort,
  resolveDesktopServerWorkingDir,
  waitForServerReady,
} from './runtime.js';

describe('desktop runtime helpers', () => {
  it('builds desktop server env with external listen host and app directories', () => {
    const env = buildDesktopServerEnv({
      inheritedEnv: {
        AUTH_TOKEN: 'admin-token',
        PROXY_TOKEN: 'proxy-token',
      },
      userDataDir: '/tmp/metapi-data',
      logsDir: '/tmp/metapi-logs',
      port: 4312,
    });

    expect(env.HOST).toBe('0.0.0.0');
    expect(env.PORT).toBe('4312');
    expect(env.DATA_DIR).toBe('/tmp/metapi-data');
    expect(env.METAPI_LOG_DIR).toBe('/tmp/metapi-logs');
    expect(env.AUTH_TOKEN).toBe('admin-token');
    expect(env.PROXY_TOKEN).toBe('proxy-token');
  });

  it('边缘版环境强制回环监听并打开边缘闸门', () => {
    const env = buildDesktopServerEnv({
      inheritedEnv: { HOST: '0.0.0.0' },
      userDataDir: '/tmp/metapi-edge-data',
      logsDir: '/tmp/metapi-edge-logs',
      port: 4312,
      edgeMode: true,
    });

    expect(env.HOST).toBe('127.0.0.1');
    expect(env.METAPI_EDGE_MODE).toBe('1');
    expect(env.DATA_DIR).toBe('/tmp/metapi-edge-data');
  });

  it('边缘版使用独立入口与端口', () => {
    expect(resolveDesktopDefaultPort(true)).toBe(30086);
    expect(resolveDesktopDefaultPort(false)).toBe(4000);
    expect(resolveDesktopServerEntryRelativePath(true)).toBe('dist/server/edge/main.js');
    expect(resolveDesktopServerEntryRelativePath(false)).toBe('dist/server/index.js');
    expect(resolveDesktopServerPort({}, resolveDesktopDefaultPort(true))).toBe(30086);
    expect(resolveDesktopServerPort({ METAPI_DESKTOP_SERVER_PORT: '4312' }, 30086)).toBe(4312);
  });

  it('按打包元数据或环境变量判定边缘版', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metapi-desktop-edge-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ metapiBuildVariant: 'edge' }), 'utf8');
      expect(resolveDesktopEdgeMode({ appPath: dir })).toBe(true);
      expect(resolveDesktopEdgeMode({ appPath: dir, env: { METAPI_DESKTOP_EDGE_MODE: '0' } })).toBe(false);

      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'metapi' }), 'utf8');
      expect(resolveDesktopEdgeMode({ appPath: dir })).toBe(false);
      expect(resolveDesktopEdgeMode({ appPath: dir, env: { METAPI_DESKTOP_EDGE_MODE: '1' } })).toBe(true);
      expect(resolveDesktopEdgeMode({ appPath: join(dir, 'missing') })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the browser URL from the local desktop port', () => {
    expect(createDesktopServerUrl(4312)).toBe('http://127.0.0.1:4312');
  });

  it('defaults desktop backend port to 4000', () => {
    expect(resolveDesktopServerPort({})).toBe(4000);
  });

  it('honors explicit desktop backend port override', () => {
    expect(resolveDesktopServerPort({
      METAPI_DESKTOP_SERVER_PORT: '4312',
    })).toBe(4312);
  });

  it('uses resources path as backend cwd for packaged desktop builds', () => {
    expect(resolveDesktopServerWorkingDir({
      appPath: 'C:/Users/test/AppData/Local/Programs/Metapi/resources/app.asar',
      resourcesPath: 'C:/Users/test/AppData/Local/Programs/Metapi/resources',
      isPackaged: true,
    })).toBe('C:/Users/test/AppData/Local/Programs/Metapi/resources');

    expect(resolveDesktopServerWorkingDir({
      appPath: '/workspace/metapi',
      resourcesPath: '/tmp/electron/resources',
      isPackaged: false,
    })).toBe('/workspace/metapi');
  });

  it('waits until the health probe returns ok', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });

    await expect(waitForServerReady({
      url: 'http://127.0.0.1:4312/api/desktop/health',
      fetcher,
      timeoutMs: 250,
      intervalMs: 1,
    })).resolves.toBeUndefined();

    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('fails when the health probe never becomes ready', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: false });

    await expect(waitForServerReady({
      url: 'http://127.0.0.1:4312/api/desktop/health',
      fetcher,
      timeoutMs: 10,
      intervalMs: 1,
    })).rejects.toThrow('Timed out waiting for metapi desktop server');
  });

  it('treats non-zero non-signal exits as fatal', () => {
    expect(isFatalServerExit({ code: 1, signal: null })).toBe(true);
    expect(isFatalServerExit({ code: 0, signal: null })).toBe(false);
    expect(isFatalServerExit({ code: null, signal: 'SIGTERM' })).toBe(false);
  });
});
