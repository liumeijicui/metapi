import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildReleaseDownloadUrl,
  isPublicApiRoute,
  listDesktopReleaseArtifacts,
  verifyReleaseTicket,
} from './desktop.js';

const tempDirs: string[] = [];

function makeReleaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'metapi-release-'));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.METAPI_DESKTOP_RELEASES_DIR;
});

describe('desktop release downloads', () => {
  it('只放行带签名参数的下载地址，列表接口仍然要登录', () => {
    expect(isPublicApiRoute('/api/desktop/releases/download?file=a.exe&expires=1&sig=x')).toBe(true);
    expect(isPublicApiRoute('/api/desktop/releases')).toBe(false);
    expect(isPublicApiRoute('/api/desktop/releases/download')).toBe(false);
  });

  it('下载票据校验过期时间与签名', () => {
    const now = 1_700_000_000_000;
    const url = buildReleaseDownloadUrl('metapi-edge-1.3.0-win-x64.exe', now, 'secret');
    const parsed = new URL(url, 'http://localhost');
    const expires = Number(parsed.searchParams.get('expires'));
    const sig = String(parsed.searchParams.get('sig'));

    expect(verifyReleaseTicket('metapi-edge-1.3.0-win-x64.exe', expires, sig, now, 'secret')).toBe(true);
    // 换个密钥、换个文件名、或者过期之后都应该被拒
    expect(verifyReleaseTicket('metapi-edge-1.3.0-win-x64.exe', expires, sig, now, 'other-secret')).toBe(false);
    expect(verifyReleaseTicket('other.exe', expires, sig, now, 'secret')).toBe(false);
    expect(verifyReleaseTicket('metapi-edge-1.3.0-win-x64.exe', expires, sig, expires + 1, 'secret')).toBe(false);
    expect(verifyReleaseTicket('metapi-edge-1.3.0-win-x64.exe', expires, 'not-hex', now, 'secret')).toBe(false);
  });

  it('扫描 release 与 release/edge，只认安装包后缀', () => {
    const root = makeReleaseRoot();
    mkdirSync(join(root, 'edge'), { recursive: true });
    writeFileSync(join(root, 'edge', 'metapi-edge-1.3.0-win-x64.exe'), 'x');
    writeFileSync(join(root, 'metapi-1.3.0-mac-arm64.dmg'), 'x');
    // 这些都不该出现在列表里
    writeFileSync(join(root, 'builder-debug.yml'), 'x');
    writeFileSync(join(root, 'metapi-1.3.0-x64.nsis.7z.tmp'), 'x');
    mkdirSync(join(root, 'win-unpacked'), { recursive: true });

    process.env.METAPI_DESKTOP_RELEASES_DIR = root;
    const releases = listDesktopReleaseArtifacts();

    expect(releases.map((item) => item.name).sort()).toEqual([
      'metapi-1.3.0-mac-arm64.dmg',
      'metapi-edge-1.3.0-win-x64.exe',
    ]);
    const edge = releases.find((item) => item.name.endsWith('.exe'));
    expect(edge?.platform).toBe('windows');
    expect(edge?.variant).toBe('edge');
    expect(edge?.url.startsWith('/api/desktop/releases/download?')).toBe(true);
    const mac = releases.find((item) => item.name.endsWith('.dmg'));
    expect(mac?.platform).toBe('macos');
    expect(mac?.variant).toBe('desktop');
  });
});
