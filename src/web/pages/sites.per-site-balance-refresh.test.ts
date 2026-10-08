import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('站点列表：只刷新单个站点的余额', () => {
  const page = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');

  it('总余额后面有单站点刷新按钮，且两种视图都有', () => {
    expect(page).toContain('data-testid={`site-refresh-balance-${siteId}`}');
    expect(page).toContain("const label = '只刷新该站点的余额';");
    // 表格视图 + 移动端卡片各一处
    expect(page.split('<SiteBalanceRefreshButton').length - 1).toBe(2);
  });

  it('只刷新当前站点：复用后台任务，只传这一个 id', () => {
    expect(page).toContain('const refreshSingleSiteBalance = async (site: SiteRow) => {');
    expect(page).toContain('await api.refreshSiteBalances([site.id]);');
    expect(page).toContain('setRefreshOutcome((prev) => ({ ...prev, [site.id]: moved }));');
    // 行点击会切换选中，刷新按钮不能顺带改选中。
    expect(page).toContain('event.stopPropagation();');
  });
});
