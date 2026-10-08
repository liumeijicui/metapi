import { describe, expect, it } from 'vitest';
import { parseWindowsSystemProxy } from './localSystemProxy.js';

function registryOutput(proxyEnable: string, proxyServer: string): string {
  return [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    `    ProxyEnable    REG_DWORD    ${proxyEnable}`,
    `    ProxyServer    REG_SZ    ${proxyServer}`,
    '    ProxyOverride    REG_SZ    localhost;127.*;<local>',
    '',
  ].join('\r\n');
}

describe('本机系统代理探测', () => {
  it('启用时把 host:port 补成 http 代理 URL', () => {
    expect(parseWindowsSystemProxy(registryOutput('0x1', '127.0.0.1:7897'))).toBe('http://127.0.0.1:7897');
  });

  it('多协议写法取 http 那份', () => {
    expect(parseWindowsSystemProxy(registryOutput('0x1', 'http=127.0.0.1:7897;https=127.0.0.1:7897')))
      .toBe('http://127.0.0.1:7897');
  });

  it('只配了 socks 时给出 socks5 URL', () => {
    expect(parseWindowsSystemProxy(registryOutput('0x1', 'socks=127.0.0.1:1080'))).toBe('socks5://127.0.0.1:1080');
  });

  it('已经是完整 URL 的原样返回', () => {
    expect(parseWindowsSystemProxy(registryOutput('0x1', 'https://proxy.example.com:3128')))
      .toBe('https://proxy.example.com:3128');
  });

  it('没启用或没配地址时返回空串', () => {
    expect(parseWindowsSystemProxy(registryOutput('0x0', '127.0.0.1:7897'))).toBe('');
    expect(parseWindowsSystemProxy('    ProxyEnable    REG_DWORD    0x1')).toBe('');
  });
});

