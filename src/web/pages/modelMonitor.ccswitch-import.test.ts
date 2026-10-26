import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('模型监控行内操作按钮', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelMonitor.tsx'), 'utf8');
  const modal = readFileSync(
    resolve(process.cwd(), 'src/web/pages/downstream-keys/DownstreamKeyCcSwitchModal.tsx'),
    'utf8',
  );
  const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');

  it('「对话 / 挂到转发 / 导入到 CC Switch / 设为 Codex」都是细边框淡色底的按钮，两种视图一致', () => {
    // 卡片视图 + 表格视图，五个按钮各一处 = 10 处
    expect(page.split('className="btn model-monitor-action-btn"').length - 1).toBe(10);
    expect(page).not.toContain('model-monitor-ccswitch-btn');
    // 不再用纯文字链接样式
    expect(page).not.toContain('btn btn-link');
    expect(css).toContain('.model-monitor-action-btn');
    expect(css).toContain('border: 1px solid color-mix(in srgb, var(--color-primary) 32%, transparent);');
    expect(css).toContain('background: color-mix(in srgb, var(--color-primary) 8%, var(--color-bg-card));');
  });

  it('导入的是原站配置：原站 sk- 密钥 + 站点地址', () => {
    expect(page).toContain('api.getModelMonitorChatChannels(model.siteId, model.modelName)');
    expect(page).toContain("item?.credential === 'api_token'");
    expect(page).toContain('api.getAccountTokenValue(tokenCredential.tokenId)');
    expect(page).toContain("baseUrl: String(model.siteUrl || '').trim()");
    // 没有 sk- 密钥时明确提示，而不是导入一个用不了的配置。
    expect(page).toContain('该站点还没有 sk- 密钥');
    // 弹窗要接受「原站地址」作为初始网关地址。
    expect(modal).toContain('initialBaseUrl');
    expect(modal).toContain("String(initialBaseUrl || '').trim() || resolveDefaultGatewayBaseUrl()");
  });

  it('原站导入带上有该站模型名约束：预填该站模型名，且不允许写对外别名', () => {
    // 原站不认识我们的对外模型名，写别名会直接 503 No available channel。
    expect(page).toContain('mode="origin-site"');
    expect(page).toContain('siteModels={ccSwitchTarget?.siteModels || []}');
    expect(page).toContain("defaultModel={ccSwitchTarget?.item?.supportedModels?.[0] || ''}");
    expect(modal).toContain('resolveCcSwitchCandidateModels');
    expect(modal).toContain('isCcSwitchModelAllowed');
    expect(modal).toContain('No available channel');
  });

  it('「对话 / 挂到转发」入口仍然可用', () => {
    expect(page.split('onClick={() => { setChatAutoTest(false); setChatTarget(model); }}').length - 1).toBe(2);
    expect(page.split('onClick={() => { setChatAutoTest(true); setChatTarget(model); }}').length - 1).toBe(2);
    expect(page.split('onClick={() => void openAttach(model)}').length - 1).toBe(2);
  });

  it('「设为 Codex」使用原站直连账号，并调用服务器配置同步接口', () => {
    expect(page.split('onClick={() => void syncCodexConfig(model)}').length - 1).toBe(2);
    expect(page).toContain('api.getModelMonitorChatChannels(model.siteId, model.modelName)');
    expect(page).toContain('api.syncCodexConfig({');
    expect(page).toContain('tokenId: credential.tokenId == null ? null : Number(credential.tokenId)');
    expect(page).not.toContain('baseUrl: resolveDefaultGatewayBaseUrl');
  });
});
