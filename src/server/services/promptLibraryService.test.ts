import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./promptLibraryService.js');

describe('promptLibraryService', () => {
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let service: ServiceModule;
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-prompt-library-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    db = dbModule.db;
    schema = dbModule.schema;
    service = await import('./promptLibraryService.js');
  });

  beforeEach(async () => {
    await db.delete(schema.promptCases).run();
    await db.delete(schema.promptSuites).run();
  });

  afterAll(() => {
    delete process.env.DATA_DIR;
  });

  it('创建题库/题目时会归一化标签、判定方式和空答案', async () => {
    const suite = await service.createPromptSuite({
      name: '自定义题库',
      category: '测试',
      tags: '视觉, SVG, SVG',
    });
    expect(suite.slug.startsWith('suite-')).toBe(true);
    expect(suite.tags).toEqual(['视觉', 'SVG']);

    const promptCase = await service.createPromptCase({
      suiteId: suite.id,
      title: '主观题',
      prompt: '画个东西',
      judgeMode: '不存在的模式',
      tags: ['主观', '主观', '视觉'],
    });

    expect(promptCase.expectedAnswer).toBeNull();
    expect(promptCase.judgeMode).toBe('manual');
    expect(promptCase.tags).toEqual(['主观', '视觉']);
    expect(promptCase.enabled).toBe(true);

    const suites = await service.listPromptSuites();
    expect(suites).toHaveLength(1);
    expect(suites[0].caseCount).toBe(1);
    expect(suites[0].enabledCaseCount).toBe(1);
  });

  it('拒绝重复的题库标识和同题库下的同名题目', async () => {
    const suite = await service.createPromptSuite({ name: '题库 A', slug: 'dup-suite' });
    await expect(service.createPromptSuite({ name: '题库 B', slug: 'dup-suite' }))
      .rejects.toBeInstanceOf(service.PromptLibraryError);

    await service.createPromptCase({ suiteId: suite.id, title: '同一题', prompt: 'p1' });
    await expect(service.createPromptCase({ suiteId: suite.id, title: '同一题', prompt: 'p2' }))
      .rejects.toBeInstanceOf(service.PromptLibraryError);
  });

  it('内置题库导入是幂等的，并且能补齐被删掉的题目', async () => {
    const first = await service.importBuiltinPromptPreset('candy-count');
    expect(first.suiteCreated).toBe(true);
    expect(first.casesCreated).toBe(2);
    expect(first.casesSkipped).toBe(0);

    const second = await service.importBuiltinPromptPreset('candy-count');
    expect(second.suiteCreated).toBe(false);
    expect(second.suiteId).toBe(first.suiteId);
    expect(second.casesCreated).toBe(0);
    expect(second.casesSkipped).toBe(2);

    const cases = await service.listPromptCases(first.suiteId);
    const roundCandy = cases.find((item) => item.title === '圆形糖果有多少颗');
    expect(roundCandy?.expectedAnswer).toBe('9');
    expect(roundCandy?.judgeMode).toBe('exact');

    await service.deletePromptCase(roundCandy!.id);
    const third = await service.importBuiltinPromptPreset('candy-count');
    expect(third.casesCreated).toBe(1);
    expect(third.casesSkipped).toBe(1);

    const presets = await service.listBuiltinPromptPresets();
    const candyPreset = presets.find((item) => item.slug === 'candy-count');
    expect(candyPreset?.imported).toBe(true);
    expect(candyPreset?.suiteId).toBe(first.suiteId);
  });

  it('鹈鹕测试每道题都只登记评分要点、没有标准答案', async () => {
    const result = await service.importBuiltinPromptPreset('pelican-benchmark');
    const cases = await service.listPromptCases(result.suiteId);
    expect(cases).toHaveLength(3);
    for (const item of cases) {
      expect(item.expectedAnswer).toBeNull();
      expect(item.judgeMode).toBe('manual');
      expect(String(item.answerNotes || '').length).toBeGreaterThan(0);
    }
  });

  it('删除题库会连带删除其下题目', async () => {
    const result = await service.importBuiltinPromptPreset('classic-reasoning');
    expect((await service.listPromptCases(result.suiteId)).length).toBeGreaterThan(0);

    await service.deletePromptSuite(result.suiteId);
    expect(await service.listPromptCases(result.suiteId)).toEqual([]);
    expect(await service.getPromptSuite(result.suiteId)).toBeNull();
    await expect(service.deletePromptSuite(result.suiteId))
      .rejects.toBeInstanceOf(service.PromptLibraryError);
  });

  it('没有对应的内置题库时导入会报错', async () => {
    await expect(service.importBuiltinPromptPreset('not-exist'))
      .rejects.toBeInstanceOf(service.PromptLibraryError);
  });
});
