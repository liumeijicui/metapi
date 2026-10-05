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

  it('对话走后端测试代理并固定到当前站点模型', () => {
    expect(modal).toContain('api.getModelMonitorChatChannels(target.siteId, target.modelName)');
    expect(modal).toContain("path: '/v1/chat/completions'");
    expect(modal).toContain("requestKind: 'json'");
    expect(modal).toContain('stream: true');
    expect(modal).toContain('forcedChannelId');
    expect(modal).toContain('api.proxyTestStream(');
    // 默认固定到第一个可用通道，没通道时走自动路由。
    expect(modal).toContain('setForcedChannelId(list.length ? list[0].channelId : null)');
  });

  it('日志里会标明是测试流量', () => {
    expect(modal).toContain("tr('测试流量，日志里标记为「模型测试」')");
  });

  it('对话时可以快捷选提示词或手动输入', () => {
    expect(modal).toContain('api.getPromptCases()');
    expect(modal).toContain("tr('快捷提示词')");
    expect(modal).toContain('applyPrompt');
    expect(modal).toContain('filteredPrompts.map');
    // 手动输入框仍然保留
    expect(modal).toContain('<textarea');
  });
});
