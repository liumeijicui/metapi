import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('模型监控「导入到 CC Switch」', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelMonitor.tsx'), 'utf8');
  const modal = readFileSync(
    resolve(process.cwd(), 'src/web/pages/downstream-keys/DownstreamKeyCcSwitchModal.tsx'),
    'utf8',
  );

  it('卡片视图和表格视图都在「挂到转发」后面提供入口，且是细边框淡色按钮', () => {
    expect(page.split('className="btn model-monitor-ccswitch-btn"').length - 1).toBe(2);
    expect(page).toContain("tr('导入到 CC Switch')");
    expect(page).toContain('<DownstreamKeyCcSwitchModal');
    const css = readFileSync(resolve(process.cwd(), 'src/web/index.css'), 'utf8');
    expect(css).toContain('.model-monitor-ccswitch-btn');
    expect(css).toContain('border: 1px solid color-mix(in srgb, var(--color-primary) 32%, transparent);');
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
});
