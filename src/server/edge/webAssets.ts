import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/** 打包后的前端目录（dist/web）：exe 的登录页、模型转发与使用日志都由这里的资源渲染。 */
const EDGE_WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');

/**
 * 托管打包好的前端静态资源。
 * 只做「发文件 + SPA 兜底」，不含任何业务逻辑；/api/ 与 /v1/ 的 404 照旧返回 JSON。
 * 开发态（tsx 直跑、没有 dist/web）直接跳过，方便只调后端。
 */
export async function registerEdgeWebAssets(app: FastifyInstance): Promise<boolean> {
  if (!existsSync(EDGE_WEB_DIR)) return false;

  await app.register(fastifyStatic, {
    root: EDGE_WEB_DIR,
    prefix: '/',
    wildcard: false,
    setHeaders: (res, filePath) => {
      const normalizedPath = normalize(filePath);
      if (normalizedPath.includes(`${sep}assets${sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return;
      }
      if (normalizedPath.endsWith(`${sep}index.html`)) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  });

  // SPA 兜底：前端路由（/model-forwarding、/logs 等）刷新后仍由 index.html 接管。
  app.setNotFoundHandler(async (request, reply) => {
    if (!request.url.startsWith('/api/') && !request.url.startsWith('/v1/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });

  return true;
}
