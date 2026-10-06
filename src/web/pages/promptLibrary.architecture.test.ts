import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('PromptLibrary 提示词管理（简化版）', () => {
  const page = read('src/web/pages/PromptLibrary.tsx');
  const simpleEditor = read('src/web/pages/prompt-library/SimpleCaseEditorModal.tsx');
  const presetModal = read('src/web/pages/prompt-library/PresetImportModal.tsx');
  const app = read('src/web/App.tsx');
  const api = read('src/web/api.ts');

  it('顶层页面只做编排，弹窗都拆到 prompt-library/ 子目录', () => {
    expect(page).toContain("from './prompt-library/SimpleCaseEditorModal.js'");
    expect(page).toContain("from './prompt-library/PresetImportModal.js'");
    // 页面里不该出现第二套 modal 骨架。
    expect(page).not.toContain('modal-backdrop');
    expect(page).not.toContain('createPortal');
  });

  it('只保留题目名称 / 题目描述 / 答案三个字段', () => {
    expect(simpleEditor).toContain('prompt-simple-title');
    expect(simpleEditor).toContain('prompt-simple-description');
    expect(simpleEditor).toContain('prompt-simple-answer');
    expect(simpleEditor).toContain('测试时选中该题目名称，会自动把这段描述填进对话框。');
    // 不再暴露题库 / 判分模式 / 标签 / 排序等旧字段。
    expect(simpleEditor).not.toContain('judgeMode');
    expect(simpleEditor).not.toContain('expectedAnswer');
    expect(simpleEditor).not.toContain('answerNotes');
    expect(simpleEditor).not.toContain('sortOrder');
    expect(simpleEditor).not.toContain('tags');
  });

  it('页面平铺展示题目，不再出现题库概念', () => {
    expect(page).toContain('api.getSimplePromptCases()');
    expect(page).toContain('api.createSimplePromptCase(');
    expect(page).toContain('api.updateSimplePromptCase(');
    expect(page).not.toContain('createPromptSuite');
    expect(page).not.toContain('updatePromptSuite');
    expect(page).not.toContain('listPromptSuites');
  });

  it('内置题库可以一键导入', () => {
    expect(presetModal).toContain('data-preset-import={preset.slug}');
    expect(presetModal).toContain("preset.imported ? '补齐缺失题目' : '导入'");
    expect(page).toContain('api.importPromptPreset(slug)');
    expect(page).toContain("tr('导入内置题库')");
  });

  it('对话弹窗按题目名称带出题目描述', () => {
    const chatModal = read('src/web/components/ModelChatModal.tsx');
    expect(chatModal).toContain('api.getSimplePromptCases()');
    expect(chatModal).toContain('String(item?.description || \'\')');
    expect(chatModal).not.toContain('suiteName');
  });

  it('路由、侧边栏和 API 方法都已接线', () => {
    expect(app).toContain("const PromptLibrary = lazy(() => import('./pages/PromptLibrary.js'));");
    expect(app).toContain('<Route path="/prompts" element={<PromptLibrary />} />');
    expect(app).toContain("{ to: '/prompts', label: '提示词管理'");
    expect(api).toContain('"/api/prompt-library/cases"');
    expect(api).toContain('`/api/prompt-library/cases/${caseId}`');
    expect(api).toContain('"/api/prompt-presets"');
    expect(api).toContain('`/api/prompt-presets/${encodeURIComponent(slug)}/import`');
  });
});
