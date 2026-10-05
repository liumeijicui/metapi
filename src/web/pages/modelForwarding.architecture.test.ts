import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('ModelForwarding 模型转发页', () => {
  const page = read('src/web/pages/ModelForwarding.tsx');
  const editor = read('src/web/pages/model-forwarding/RuleEditorModal.tsx');
  const types = read('src/web/pages/model-forwarding/types.ts');
  const app = read('src/web/App.tsx');
  const api = read('src/web/api.ts');
  const tokensRoute = read('src/server/routes/api/tokens.ts');
  const tokenRouter = read('src/server/services/tokenRouter.ts');

  it('顶层页面只做编排，弹窗拆到 model-forwarding/ 子目录', () => {
    expect(page).toContain("from './model-forwarding/RuleEditorModal.js'");
    expect(page).toContain("from './model-forwarding/types.js'");
    expect(page).not.toContain('modal-backdrop');
    expect(page).not.toContain('createPortal');
  });

  it('弹窗支持选站点、填上游模型名并多选账号', () => {
    expect(editor).toContain('onLoadSiteModels');
    expect(editor).toContain("tr('站点')");
    expect(editor).toContain("tr('上游模型名')");
    expect(editor).toContain('accountIds');
    expect(types).toContain('accountIds: number[]');
    expect(editor).toContain("tr('+ 添加目标')");
  });

  it('规则生成的路由带 forward: 前缀并隐藏于路由页面', () => {
    expect(tokenRouter).toContain('isForwardRoutePattern');
    expect(tokenRouter).toContain('hasDispatchableChannel');
    expect(tokensRoute).toContain('.filter((route) => !isForwardRoutePattern(route.modelPattern))');
  });

  it('路由、侧边栏和 API 方法都已接线', () => {
    expect(app).toContain("const ModelForwarding = lazy(() => import('./pages/ModelForwarding.js'));");
    expect(app).toContain('<Route path="/model-forwarding" element={<ModelForwarding />} />');
    expect(app).toContain("{ to: '/model-forwarding', label: '模型转发'");
    expect(api).toContain('"/api/model-forward-rules"');
    expect(api).toContain('`/api/model-forward-rules/${id}/enabled`');
    expect(api).toContain('/api/model-forward-options');
  });
});
