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
  const service = read('src/server/services/modelForwardService.ts');

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

  it('页面按顺序展示转发目标，并提供置顶 / 上移 / 下移 / 启停操作', () => {
    expect(page).toContain("tr('置顶')");
    expect(page).toContain("tr('上移')");
    expect(page).toContain("tr('下移')");
    expect(page).toContain("tr('顺序')");
    expect(page).toContain('handleMoveTarget');
    expect(page).toContain('handleToggleTarget');
    expect(page).toContain('api.moveModelForwardTarget');
    expect(page).toContain('api.setModelForwardTargetEnabled');
    expect(api).toContain('/targets/${targetId}/move');
    expect(api).toContain('/targets/${targetId}/enabled');
  });

  it('置顶 / 上移 / 下移对每一行都可点，不再按首尾位置禁用', () => {
    for (const action of ['top', 'up', 'down']) {
      expect(page).toContain(`data-testid={\`forward-target-${action}-$\{target.id}\`}`);
    }
    // 三个按钮只在本行操作进行中禁用，不再白按 isFirst / isLast 灰掉。
    expect(page).not.toContain('disabled={targetBusy || isFirst}');
    expect(page).not.toContain('disabled={targetBusy || isLast}');
    expect(page).not.toContain('const isFirst = index === 0;');
    expect(page).not.toContain('const isLast = index === rule.targets.length - 1;');
  });

  it('页面明确告知「顺序即默认调用顺序」', () => {
    expect(page).toContain('forward-target-order-hint-');
    expect(page).toContain('顺序即默认调用顺序');
    expect(page).toContain('调用顺序：数字越小越先被调用');
  });

  it('调整顺序后立即丢掉路由器进程内缓存，新顺序立即生效', () => {
    expect(service).toContain("import { invalidateTokenRouterCache } from './tokenRouter.js';");
    // syncModelForwardRule（含移动 / 启停用 / 新增删除）收尾都要失效缓存。
    const syncBody = service.slice(service.indexOf('export async function syncModelForwardRule'), service.indexOf('export async function createModelForwardRule'));
    expect(syncBody).toContain('invalidateTokenRouterCache();');
    const deleteBody = service.slice(service.indexOf('export async function deleteModelForwardRule'));
    expect(deleteBody).toContain('invalidateTokenRouterCache();');
  });

  it('对外模型名大小写不敏感查重，顺序同步为通道优先级', () => {
    const service = read('src/server/services/modelForwardService.ts');
    expect(service).toContain('findRuleByModelName');
    expect(service).toContain('lower(${schema.modelForwardRules.modelName})');
    expect(service).toContain('moveModelForwardTarget');
    expect(service).toContain('setModelForwardTargetEnabled');
    expect(service).toContain('const priority = index;');
  });

  it('站点与上游模型名都能搜索 + 直接输入（Combobox）', () => {
    const combobox = read('src/web/components/Combobox.tsx');
    expect(editor).toContain("from '../../components/Combobox.js'");
    expect(editor).toContain('data-testid={`model-forward-site-${index}`}');
    expect(editor).toContain('data-testid={`model-forward-upstream-${index}`}');
    expect(editor).toContain('allowCustom');
    // 组件本身：可输入、可过滤、可自由填写。
    expect(combobox).toContain('allowCustom');
    expect(combobox).toContain('visibleOptions');
  });

  it('模型监控页可以一键把「站点 + 模型」挂到对外模型末尾', () => {
    const monitor = read('src/web/pages/ModelMonitor.tsx');
    expect(monitor).toContain('attachModelForwardTarget');
    expect(monitor).toContain("tr('挂到转发')");
    expect(monitor).toContain('data-testid="model-monitor-attach-combobox"');
    expect(monitor).toContain("tr('挂到末尾')");
    expect(api).toContain('"/api/model-forward-attach"');
    expect(service).toContain('attachModelForwardTarget');
    expect(service).toContain('nextSortOrder');
  });

  it('弹窗会即时提示对外模型名重复，并把它接进保存校验', () => {
    expect(editor).toContain('existingRuleNames');
    expect(editor).toContain('duplicatedModelName');
    expect(editor).toContain('模型名不能重复');
    expect(page).toContain('existingRuleNames={rules');
    expect(page).toContain('rule.id !== editingRule?.id');
  });
});
