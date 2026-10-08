import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 本机（Windows）系统代理的探测。
 *
 * 服务器上的 `system_proxy_url` 指向服务器自己的代理（开发者机器上的 127.0.0.1:7890），
 * 本地照抄必然连接失败；而 siteProfiles 里声明「只能走系统代理」的站点
 * （agentrouter.org、anyrouter.top 这类）在本地又确实需要代理。
 * 所以边缘实例用本机自己那份设置：读注册表里的 WinINET 代理。
 */

/** WinINET 代理设置所在的注册表键。 */
const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** 注册表 ProxyServer 里的多协议写法（http=...;https=...）里优先取哪几个协议。 */
const PROXY_PROTOCOL_ORDER = ['http', 'https'];

function normalizeProxyEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) return '';
  // 已经是完整 URL 的照原样返回（http/https/socks5 都支持）。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/**
 * 解析 `reg query` 的输出。ProxyEnable 为 0、缺值或没配 ProxyServer 时返回空串。
 * 支持「127.0.0.1:7897」和「http=127.0.0.1:7897;https=...」两种写法。
 */
export function parseWindowsSystemProxy(registryOutput: string): string {
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(registryOutput);
  const server = /ProxyServer\s+REG_SZ\s+([^\r\n]+)/i.exec(registryOutput);
  if (!enabled || !server) return '';
  if (Number.parseInt(enabled[1], 16) === 0) return '';

  const raw = server[1].trim();
  const byProtocol = new Map<string, string>();
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    byProtocol.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
  }

  if (byProtocol.size === 0) return normalizeProxyEntry(raw);

  for (const protocol of PROXY_PROTOCOL_ORDER) {
    const entry = byProtocol.get(protocol);
    if (entry) return normalizeProxyEntry(entry);
  }
  const socks = byProtocol.get('socks') || byProtocol.get('socks5');
  return socks ? `socks5://${socks}` : '';
}

/**
 * 读本机系统代理 URL；非 Windows、读不到或没启用时返回空串（等于不配代理）。
 * 每次同步时再读一次，中途开代理也能在下一轮同步生效。
 */
export function detectLocalSystemProxyUrl(): string {
  if (process.platform !== 'win32') return '';

  const regPath = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  const reg = existsSync(regPath) ? regPath : 'reg';
  try {
    const output = execFileSync(reg, ['query', INTERNET_SETTINGS_KEY], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    return parseWindowsSystemProxy(output);
  } catch {
    // 探测失败就当作没有系统代理：本地直连能跑的站点照旧能跑。
    return '';
  }
}

