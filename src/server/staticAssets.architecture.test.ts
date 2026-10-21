import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('前端静态资源服务', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/server/index.ts'), 'utf8');

  it('静态资源必须用通配路由，不能只认启动时的文件清单', () => {
    // 前端每次构建都会生成新的 hash 文件名。@fastify/static 在
    // `wildcard: false` 时只在启动时登记当时存在的文件，新构建的资源会落到
    // SPA 回退返回 index.html，浏览器因 MIME 不匹配拒绝执行，整页空白。
    const staticBlock = source.match(/await app\.register\(fastifyStatic, \{[\s\S]*?\n  \}\);/)?.[0] ?? '';
    expect(staticBlock).toContain('wildcard: true');
    expect(staticBlock).not.toContain('wildcard: false');
  });
});
