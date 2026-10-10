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

  it('规则生成的路由带 forward: 前缀，派发只认规则、不回落到老路由', () => {
    expect(tokenRouter).toContain('isForwardRoutePattern');
    // 「模型转发」声明过的模型名一旦命中，就只走这条规则：规则没有可派发通道时
    // 如实失败，不再回落到按 model_pattern 命中的老路由。
    expect(tokenRouter).toContain('loadDeclaredForwardModelNames');
    expect(tokenRouter).not.toContain('hasDispatchableChannel');
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

  it('页面明确告知「顺序即调用顺序，永远走第一个启用目标」', () => {
    expect(page).toContain('forward-target-order-hint-');
    expect(page).toContain('顺序即调用顺序：永远只走排在最前面的「启用」目标');
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

  it('转发目标只显示「启用 / 停用」，不再透出冷却 / 降级状态', () => {
    // 后端字段还在（列表接口照样回传），页面只是不再拿它做状态徽标。
    expect(types).toContain('autoDemotedAt: string | null');
    expect(types).toContain('consecutiveUpstreamFailures: number | null');
    expect(service).toContain('autoDemotedAt: row.channel?.autoDemotedAt ?? null');
    expect(service).toContain('consecutiveUpstreamFailures: row.channel?.consecutiveUpstreamFailures ?? null');
    // 只有两种状态：顺序最靠前的启用目标就是每次被调用的那个。
    expect(page).toContain("const state = target.enabled ? tr('启用中') : tr('已停用');");
    expect(page).not.toContain("tr('已降级')");
    expect(page).not.toContain('const demoted = !!target.autoDemotedAt;');
    expect(page).not.toContain('cooling');
    expect(page).toContain('stateTooltip');
  });
  it('手动保存顺序即复位降级状态，且转发通道本身不参与自动降级', () => {
    expect(service).toContain('consecutiveUpstreamFailures: 0');
    expect(service).toContain('autoDemotedAt: null');
    expect(service).toContain('priorityBeforeAutoDemotion: null');
    const config = read('src/server/config.ts');
    expect(config).toContain('proxyAutoDemoteFailureThreshold');
    expect(config).toContain('PROXY_AUTO_DEMOTE_FAILURE_THRESHOLD');
    expect(tokenRouter).toContain('config.proxyAutoDemoteFailureThreshold');
    expect(tokenRouter).toContain('resolveAutoDemotedPriority');
    // 轮询策略本来忽略 priority，降级要在候选排序里显式生效。
    expect(tokenRouter).toContain('demotionOrder');
    // 转发通道跳过自动降级 / 冷却换源：顺序是人工排的。
    expect(tokenRouter).toContain('!isManualForwardRoute(route)');
    expect(tokenRouter).toContain("isForwardRoutePattern(route?.modelPattern)");
    expect(tokenRouter).toContain('filterAvoidedCandidatesForRoute');
  });

  it('exe 放开顺序与启停（只对本机生效），规则增删改仍以服务器为准', () => {
    const localEdits = read('src/server/edge/forwardLocalEdits.ts');
    const localApi = read('src/server/edge/localApiRoutes.ts');
    const configSync = read('src/server/edge/configSync.ts');

    // 页面不再有「只读镜像」这个总开关：exe 里顺序与启停和服务器是同一份代码。
    expect(page).not.toContain('readOnly');
    expect(page).toContain('const edgeMode = edgeStatus?.edgeMode === true;');
    expect(page).toContain('handleMoveTarget');
    expect(page).toContain('handleToggleTarget');
    expect(page).toContain('data-testid="edge-forward-restore-order"');
    expect(page).toContain('api.resetEdgeModelForwardLocalOrder');
    // 规则的增删改仍然只在服务器上做：编辑入口与弹窗对 exe 关闭。
    expect(page).toContain('{edgeMode ? null : (');
    expect(page).toContain('open={editorOpen && !edgeMode}');

    // exe 的本机写接口路径与主服务完全一致，所以前端不用分叉。
    expect(localApi).toContain("'/api/model-forward-rules/:id/enabled'");
    expect(localApi).toContain("'/api/model-forward-rules/:id/targets/:targetId/move'");
    expect(localApi).toContain("'/api/model-forward-rules/:id/targets/:targetId/enabled'");
    expect(localApi).toContain("'/api/edge/model-forward-local-edits/reset'");
    expect(localApi).not.toContain(".delete(");
    expect(api).toContain('/api/edge/model-forward-local-edits/reset');

    // 本机改动落在内存镜像上，并且点完立刻失效路由器缓存。
    expect(localEdits).toContain('invalidateTokenRouterCache()');
    expect(localEdits).toContain('edge_forward_local_edit');
    expect(localEdits).toContain('edge_forward_source_hash');
    // 服务器快照指纹一变，本机改动整份作废。
    expect(localEdits).toContain('const serverChanged = storedHash !== sourceHash;');
    expect(localEdits).toContain('writeEditState({ rules: {} });');
    // 必须在路由重建之后盖回本机顺序，否则重建会把顺序冲掉。
    const reapplyIndex = configSync.indexOf('await reapplyLocalForwardEditsAfterSync(');
    const rebuildIndex = configSync.indexOf('await routeRefreshWorkflow.rebuildRoutesOnly();');
    expect(rebuildIndex).toBeGreaterThan(-1);
    expect(reapplyIndex).toBeGreaterThan(rebuildIndex);
  });

  it('弹窗会即时提示对外模型名重复，并把它接进保存校验', () => {
    expect(editor).toContain('existingRuleNames');
    expect(editor).toContain('duplicatedModelName');
    expect(editor).toContain('模型名不能重复');
    expect(page).toContain('existingRuleNames={rules');
    expect(page).toContain('rule.id !== editingRule?.id');
  });
});
