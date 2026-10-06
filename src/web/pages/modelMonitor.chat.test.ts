import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelMonitor 对话按钮', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelMonitor.tsx'), 'utf8');
  const modal = readFileSync(resolve(process.cwd(), 'src/web/components/ModelChatModal.tsx'), 'utf8');

  it('卡片视图和表格视图都提供「对话」入口', () => {
    expect(page).toContain("import ModelChatModal from '../components/ModelChatModal.js';");
    expect(page).toContain('const [chatTarget, setChatTarget] = useState<ModelRow | null>(null);');
    // 卡片视图与表格视图各有一处
    expect(page.split("onClick={() => setChatTarget(model)}").length - 1).toBe(2);
    expect(page).toContain("tr('对话')");
    expect(page).toContain('<ModelChatModal');
  });

  it('对话用站点自己的凭据直连上游，完全不走网关路由', () => {
    expect(modal).toContain('api.getModelMonitorChatChannels(target.siteId, target.modelName)');
    expect(modal).toContain('api.directChatStream(');
    expect(modal).toContain('siteId: target.siteId');
    expect(modal).toContain('accountId: credential.accountId');
    expect(modal).toContain('tokenId: credential.tokenId');
    expect(modal).toContain('model: target.modelName');
    // 不再走测试代理 / 固定通道那条路：那样会依赖 route_channels 配置。
    expect(modal).not.toContain('api.proxyTestStream(');
    expect(modal).not.toContain('forcedChannelId');
    expect(modal).not.toContain('forwardModel');
    expect(modal).not.toContain('<option value="__auto__">');
    // 没有凭据时直接禁止发送。
    expect(modal).toContain("if (!credential) {");
    expect(modal).toContain('disabled={sending || !input.trim() || !activeCredential}');
    // 界面上要能看出来是直连。
    expect(modal).toContain("tr('直连凭据')");
    expect(modal).toContain("tr('直连目标站点')");
    expect(modal).toContain('不经过新路由 / 老路由，也不会转发到其它站点。');
  });

  it('日志里会标明是测试流量', () => {
    expect(modal).toContain("tr('直连目标站点；日志里标记为「模型测试」')");
  });

  it('对话时可以快捷选提示词或手动输入', () => {
    expect(modal).toContain('api.getSimplePromptCases()');
    // 选中题目名称后应把题目描述填进输入框
    expect(modal).toContain("prompt: String(item?.description || '')");
    expect(modal).toContain('setInput(item.prompt)');
    expect(modal).toContain("tr('快捷提示词')");
    expect(modal).toContain('applyPrompt');
    expect(modal).toContain('filteredPrompts.map');
    // 手动输入框仍然保留
    expect(modal).toContain('<textarea');
  });
});
