import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type DbModule = typeof import('../../db/index.js');

describe('prompt library routes', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-prompt-library-routes-'));
    process.env.DATA_DIR = dataDir;

    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./promptLibrary.js');
    db = dbModule.db;
    schema = dbModule.schema;

    app = Fastify();
    await app.register(routesModule.promptLibraryRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.promptCases).run();
    await db.delete(schema.promptSuites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  it('可以创建题库和题目，并在列表里返回统计', async () => {
    const suiteResponse = await app.inject({
      method: 'POST',
      url: '/api/prompt-suites',
      payload: { name: '我的题库', category: '自定义', tags: ['a', 'a', 'b'] },
    });
    expect(suiteResponse.statusCode).toBe(201);
    const suite = suiteResponse.json().suite;
    expect(suite.tags).toEqual(['a', 'b']);

    const caseResponse = await app.inject({
      method: 'POST',
      url: '/api/prompt-cases',
      payload: {
        suiteId: suite.id,
        title: '有答案的题',
        prompt: '1+1=?',
        expectedAnswer: '2',
        judgeMode: 'exact',
      },
    });
    expect(caseResponse.statusCode).toBe(201);
    expect(caseResponse.json().case.expectedAnswer).toBe('2');

    const listResponse = await app.inject({ method: 'GET', url: '/api/prompt-suites' });
    expect(listResponse.statusCode).toBe(200);
    const [row] = listResponse.json().suites;
    expect(row.caseCount).toBe(1);
    expect(row.enabledCaseCount).toBe(1);

    const casesResponse = await app.inject({ method: 'GET', url: `/api/prompt-suites/${suite.id}/cases` });
    expect(casesResponse.json().cases).toHaveLength(1);
  });

  it('同名题目、空名称、非法 ID 都会被判为 400', async () => {
    const suite = (await app.inject({
      method: 'POST',
      url: '/api/prompt-suites',
      payload: { name: '题库' },
    })).json().suite;

    await app.inject({
      method: 'POST',
      url: '/api/prompt-cases',
      payload: { suiteId: suite.id, title: '重复题', prompt: 'p' },
    });
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/prompt-cases',
      payload: { suiteId: suite.id, title: '重复题', prompt: 'p2' },
    });
    expect(duplicate.statusCode).toBe(400);

    const emptyName = await app.inject({
      method: 'POST',
      url: '/api/prompt-suites',
      payload: { name: '   ' },
    });
    expect(emptyName.statusCode).toBe(400);

    const badId = await app.inject({ method: 'GET', url: '/api/prompt-suites/abc' });
    expect(badId.statusCode).toBe(400);

    const missing = await app.inject({ method: 'GET', url: '/api/prompt-suites/999999' });
    expect(missing.statusCode).toBe(404);
  });

  it('内置预设可以查询和幂等导入', async () => {
    const presetResponse = await app.inject({ method: 'GET', url: '/api/prompt-presets' });
    expect(presetResponse.statusCode).toBe(200);
    const presets = presetResponse.json().presets;
    expect(presets.map((item: { slug: string }) => item.slug)).toEqual([
      'pelican-benchmark',
      'candy-count',
      'classic-reasoning',
    ]);
    expect(presets.every((item: { imported: boolean }) => item.imported === false)).toBe(true);
    expect(presets.find((item: { slug: string }) => item.slug === 'candy-count').cases[0].expectedAnswer).toBe('21');

    const first = await app.inject({ method: 'POST', url: '/api/prompt-presets/candy-count/import' });
    expect(first.statusCode).toBe(200);
    expect(first.json().casesCreated).toBe(2);

    const second = await app.inject({ method: 'POST', url: '/api/prompt-presets/candy-count/import' });
    expect(second.json().casesCreated).toBe(0);
    expect(second.json().casesSkipped).toBe(2);

    const notFound = await app.inject({ method: 'POST', url: '/api/prompt-presets/unknown/import' });
    expect(notFound.statusCode).toBe(400);
  });

  it('删除题库会连带清掉题目', async () => {
    const imported = (await app.inject({ method: 'POST', url: '/api/prompt-presets/pelican-benchmark/import' })).json();
    const casesBefore = await app.inject({ method: 'GET', url: `/api/prompt-suites/${imported.suiteId}/cases` });
    expect(casesBefore.json().cases).toHaveLength(3);

    const remove = await app.inject({ method: 'DELETE', url: `/api/prompt-suites/${imported.suiteId}` });
    expect(remove.statusCode).toBe(200);

    const casesAfter = await app.inject({ method: 'GET', url: `/api/prompt-suites/${imported.suiteId}/cases` });
    expect(casesAfter.json().cases).toHaveLength(0);
  });
});
