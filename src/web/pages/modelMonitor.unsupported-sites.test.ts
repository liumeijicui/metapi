import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelMonitor unsupported sites', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelMonitor.tsx'), 'utf8');

  it('keeps "site has no metrics endpoint" out of the failure list', () => {
    // 「站点不支持 / 仅模型列表」都是已知状态，不该和真正的采集失败混在一起。
    expect(source).toContain(
      "const isKnownLimited = (status: string) => status === 'unsupported' || status === 'models_only';",
    );
    expect(source).toContain(
      "const failedSites = sites.filter((site) => site.status !== 'ok' && !isKnownLimited(site.status));",
    );
    expect(source).toContain("const unsupportedSites = sites.filter((site) => site.status === 'unsupported');");
  });

  it('「仅模型列表」站点标注为每天刷新一次', () => {
    expect(source).toContain('modelListRefreshHour');
    expect(source).toContain('每天早上刷新一次');
  });

  it('没有监控接口的站点降级成「仅模型列表」：隐藏指标、单独归类', () => {
    expect(source).toContain("const modelsOnlySites = sites.filter((site) => site.status === 'models_only');");
    expect(source).toContain("if (status === 'models_only') return '仅模型列表';");
    expect(source).toContain('metricsAvailable');
    expect(source).toContain('站点未提供监控指标');
    expect(source).toContain('model-monitor-unsupported-list');
  });

  it('folds unsupported sites into a collapsed row and excludes them from coverage', () => {
    expect(source).toContain("const [showUnsupported, setShowUnsupported] = useState(false);");
    expect(source).toContain('const unsupported = sites.filter((site) => site.status === \'unsupported\').length;');
    expect(source).toContain('totalSites: sites.length - unsupported,');
    expect(source).toContain('model-monitor-unsupported-head');
    // 站点下拉里用「（不支持）」标出来，省得点进去才发现是空站点。
    expect(source).toContain("site.status === 'unsupported'");
    expect(source).toContain("${tr('（不支持）')}");
  });

  it('模型名与站点名都是「直接打字就能筛」的下拉', () => {
    expect(source).toContain('model-monitor-model-select');
    expect(source).toContain('model-monitor-site-select');
    // 用 Combobox（触发框本身就是输入框）而不是 ModernSelect：后者得先点开面板、
    // 再点进面板里的搜索框才能打字。筛选框一多这一步很烦。
    expect(source).toContain('model-monitor-family-select');
    expect(source).not.toContain('ModernSelect');
    // 打字提示直接落在触发框的 placeholder 上。
    expect(source).toContain("placeholder={tr('搜索模型名')}");
    expect(source).toContain("placeholder={tr('搜索站点名')}");
    expect(source).toContain("placeholder={tr('搜索模型类型')}");
  });

  it('站点名可点开原站、模型名点击即复制', () => {
    // 站点名走链接，新标签打开站点首页。
    expect(source).toContain('href={model.siteUrl}');
    expect(source).toContain('rel="noreferrer"');
    // 模型名点击复制，复制完给一个短提示。
    expect(source).toContain('copyModelName');
    expect(source).toContain('navigator.clipboard');
  });

  it('展示站点价目表的输入 / 输出单价', () => {
    expect(source).toContain('formatModelPrice');
    expect(source).toContain("tr('输入')");
    expect(source).toContain("tr('输出')");
    expect(source).toContain('pricingUnit');
  });
});
