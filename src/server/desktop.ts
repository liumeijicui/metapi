import { createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

import { config } from './config.js';

const DESKTOP_HEALTH_ROUTE = '/api/desktop/health';
const DESKTOP_RELEASES_ROUTE = '/api/desktop/releases';
const DESKTOP_RELEASE_DOWNLOAD_ROUTE = '/api/desktop/releases/download';

/**
 * 下载链接用「带签名的临时 URL」而不是 Authorization 头：
 * 浏览器直接点 <a href> 是原生下载，能带进度，也不会把上百 MB 安装包读进内存
 * （移动端尤其重要）。链接里的签名由登录态接口签发，所以「没登录拿不到链接」。
 */
const RELEASE_TICKET_TTL_MS = 10 * 60 * 1000;

/** 只放安装包出去，不暴露 release 目录下的其他中间产物。 */
const RELEASE_FILE_SUFFIXES = ['.exe', '.msi', '.zip', '.7z', '.dmg', '.appimage', '.deb', '.rpm', '.tar.gz'];

type ReleasePlatform = 'windows' | 'macos' | 'linux' | 'unknown';
type ReleaseVariant = 'desktop' | 'edge';

export interface DesktopReleaseArtifact {
  /** 文件名，同时也是下载接口的 file 参数。 */
  name: string;
  size: number;
  updatedAt: string;
  platform: ReleasePlatform;
  variant: ReleaseVariant;
  url: string;
}

export function isPublicApiRoute(url: string): boolean {
  if (url === DESKTOP_HEALTH_ROUTE) return true;
  if (url.startsWith('/api/oauth/callback/')) return true;
  // 下载走签名校验，凭据在 query 上，不再是全局 auth 中间件能覆盖的形式。
  return url.startsWith(`${DESKTOP_RELEASE_DOWNLOAD_ROUTE}?`);
}

/**
 * 安装包所在目录。默认取仓库根下的 release/（完整版）与 release/edge/（边缘版），
 * 桌面端打包产物就在这两个地方；容器部署时可以用 METAPI_DESKTOP_RELEASES_DIR 指到挂载点。
 */
function resolveReleaseRoot(): string {
  const override = (process.env.METAPI_DESKTOP_RELEASES_DIR || '').trim();
  if (override) return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../release');
}

function isReleaseFileName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) return false;
  return RELEASE_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function detectReleasePlatform(name: string): ReleasePlatform {
  const lower = name.toLowerCase();
  if (lower.includes('win')) return 'windows';
  if (lower.includes('mac') || lower.includes('darwin')) return 'macos';
  if (lower.includes('linux') || lower.includes('appimage') || lower.endsWith('.deb') || lower.endsWith('.rpm')) {
    return 'linux';
  }
  return 'unknown';
}

/** 在 release/ 与 release/edge/ 里找安装包；返回绝对路径与元信息。 */
function locateReleaseFile(name: string): { path: string; size: number } | null {
  // 只认目录里列出来的文件名，天然挡掉 ../ 之类的路径穿越。
  if (!name || name.includes('/') || name.includes('\\') || !isReleaseFileName(name)) return null;
  const root = resolveReleaseRoot();
  for (const dir of [root, join(root, 'edge')]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (!entries.includes(name)) continue;
    const full = join(dir, name);
    try {
      const info = statSync(full);
      if (info.isFile()) return { path: full, size: info.size };
    } catch {
      continue;
    }
  }
  return null;
}

function signReleaseTicket(name: string, expiresAt: number, secret: string): string {
  return createHmac('sha256', secret).update(`${name}\n${expiresAt}`).digest('hex');
}

export function verifyReleaseTicket(
  name: string,
  expiresAt: number,
  signature: string,
  now = Date.now(),
  secret = config.authToken,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = Buffer.from(signReleaseTicket(name, expiresAt, secret), 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

export function buildReleaseDownloadUrl(
  name: string,
  now = Date.now(),
  secret = config.authToken,
): string {
  const expiresAt = now + RELEASE_TICKET_TTL_MS;
  const params = new URLSearchParams({
    file: name,
    expires: String(expiresAt),
    sig: signReleaseTicket(name, expiresAt, secret),
  });
  return `${DESKTOP_RELEASE_DOWNLOAD_ROUTE}?${params.toString()}`;
}

export function listDesktopReleaseArtifacts(now = Date.now()): DesktopReleaseArtifact[] {
  const root = resolveReleaseRoot();
  const artifacts: DesktopReleaseArtifact[] = [];

  for (const [dir, variant] of [[root, 'desktop'], [join(root, 'edge'), 'edge']] as const) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!isReleaseFileName(name)) continue;
      let info;
      try {
        info = statSync(join(dir, name));
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      artifacts.push({
        name,
        size: info.size,
        updatedAt: info.mtime.toISOString(),
        platform: detectReleasePlatform(name),
        variant,
        url: buildReleaseDownloadUrl(name, now),
      });
    }
  }

  return artifacts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function registerDesktopRoutes(app: FastifyInstance) {
  app.get(DESKTOP_HEALTH_ROUTE, async () => ({ ok: true }));

  // 需要登录态：列表里带的是刚刚签发的短期下载链接。
  app.get(DESKTOP_RELEASES_ROUTE, async () => ({ releases: listDesktopReleaseArtifacts() }));

  app.get(DESKTOP_RELEASE_DOWNLOAD_ROUTE, async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    const name = typeof query.file === 'string' ? query.file : '';
    const expiresAt = Number(query.expires);
    const signature = typeof query.sig === 'string' ? query.sig : '';

    const located = locateReleaseFile(name);
    if (located == null) {
      reply.code(404).send({ error: '安装包不存在' });
      return;
    }
    if (!verifyReleaseTicket(name, expiresAt, signature)) {
      reply.code(403).send({ error: '下载链接已失效，请回到页面重新获取' });
      return;
    }

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', String(located.size));
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
    return reply.send(createReadStream(located.path));
  });
}
