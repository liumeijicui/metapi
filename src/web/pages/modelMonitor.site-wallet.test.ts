import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelMonitor site wallet', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelMonitor.tsx'), 'utf8');

  it('展示站点余额与今日签到状态', () => {
    expect(source).toContain('SiteWalletBadges');
    expect(source).toContain('model-monitor-site-wallet');
    expect(source).toContain('formatSiteBalance');
    expect(source).toContain('todayCheckedInCount');
    expect(source).toContain("tr('未开启签到')");
    expect(source).toContain("tr('未绑定')");
  });

  it('卡片、表格和站点筛选都能看到余额与签到', () => {
    expect(source).toContain('model-monitor-card-site-row');
    expect(source).toContain('model-monitor-table-site');
    expect(source).toContain('buildSiteFilterLabel');
    expect(source).toContain('siteById.get(model.siteId)');
  });

  it('顶部统计汇总站点总余额和今日签到站点数', () => {
    expect(source).toContain("tr('站点余额')");
    expect(source).toContain("tr('今日签到')");
    expect(source).toContain('totalBalance');
    expect(source).toContain('checkedInSites');
  });
});
