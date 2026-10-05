import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('PromptLibrary 提示词管理', () => {
  const page = read('src/web/pages/PromptLibrary.tsx');
  const caseEditor = read('src/web/pages/prompt-library/CaseEditorModal.tsx');
  const presetModal = read('src/web/pages/prompt-library/PresetImportModal.tsx');
  const types = read('src/web/pages/prompt-library/types.ts');
  const app = read('src/web/App.tsx');
  const api = read('src/web/api.ts');

  it('顶层页面只做编排，弹窗都拆到 prompt-library/ 子目录', () => {
    expect(page).toContain("from './prompt-library/SuiteEditorModal.js'");
    expect(page).toContain("from './prompt-library/CaseEditorModal.js'");
    expect(page).toContain("from './prompt-library/PresetImportModal.js'");
    expect(page).toContain("from './prompt-library/CaseTable.js'");
    // 页面里不该出现第二套 modal 骨架。
    expect(page).not.toContain('modal-backdrop');
    expect(page).not.toContain('createPortal');
  });

  it('题目编辑器同时登记标准答案和评分要点，答案允许留空', () => {
    expect(caseEditor).toContain('prompt-library-case-answer');
    expect(caseEditor).toContain('prompt-library-case-notes');
    expect(caseEditor).toContain('expectedAnswer: expectedAnswer.trim() || null');
    expect(caseEditor).toContain('answerNotes: answerNotes.trim() || null');
    expect(caseEditor).toContain('主观题留空');
  });

  it('支持四种判定方式，并默认人工评分', () => {
    for (const mode of ['exact', 'contains', 'regex', 'manual']) {
      expect(types).toContain(`value: '${mode}'`);
    }
    expect(caseEditor).toContain("setJudgeMode(promptCase?.judgeMode ?? 'manual')");
  });

  it('内置题库可以一键导入，重复导入只补缺失题目', () => {
    expect(presetModal).toContain('data-preset-import={preset.slug}');
    expect(presetModal).toContain("preset.imported ? '补齐缺失题目' : '导入'");
    expect(page).toContain('api.importPromptPreset(slug)');
    expect(page).toContain("tr('导入内置题库')");
  });

  it('路由、侧边栏和 API 方法都已接线', () => {
    expect(app).toContain("const PromptLibrary = lazy(() => import('./pages/PromptLibrary.js'));");
    expect(app).toContain('<Route path="/prompts" element={<PromptLibrary />} />');
    expect(app).toContain("{ to: '/prompts', label: '提示词管理'");
    expect(api).toContain('"/api/prompt-suites"');
    expect(api).toContain('`/api/prompt-suites/${suiteId}/cases`');
    expect(api).toContain('`/api/prompt-cases/${caseId}`');
    expect(api).toContain('"/api/prompt-presets"');
    expect(api).toContain('`/api/prompt-presets/${encodeURIComponent(slug)}/import`');
  });
});
