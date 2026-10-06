import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('列表菜单字段查询筛选', () => {
  const sites = read('src/web/pages/Sites.tsx');
  const downstreamKeys = read('src/web/pages/DownstreamKeys.tsx');
  const tokens = read('src/web/pages/Tokens.tsx');

  it('站点管理支持关键词 / 平台 / 签到状态 / 余额筛选', () => {
    expect(sites).toContain('data-testid="sites-filter-panel"');
    expect(sites).toContain('data-testid="sites-filter-search"');
    expect(sites).toContain('sitePlatformFilterOptions');
    expect(sites).toContain("setCheckinFilter(nextValue as 'all' | 'checked' | 'unchecked')");
    expect(sites).toContain("setBalanceFilter(nextValue as 'all' | 'has' | 'none')");
    // 排序要作用在筛选后的集合上。
    expect(sites).toContain('sortItemsForDisplay(filteredSites, sortMode');
    // 重置筛选要清空全部条件。
    expect(sites).toContain('const resetSiteFilters = () => {');
  });

  it('下游密钥在既有搜索外补充群组范围 / 模型范围 / 有效期筛选', () => {
    expect(downstreamKeys).toContain("useState<'all' | 'bound' | 'unbound'>('all')");
    expect(downstreamKeys).toContain("useState<'all' | 'restricted' | 'unrestricted'>('all')");
    expect(downstreamKeys).toContain("useState<'all' | 'expired' | 'soon' | 'none'>('all')");
    expect(downstreamKeys).toContain("if (routeFilter === 'bound' && (item.allowedRouteIds || []).length === 0) return false;");
    expect(downstreamKeys).toContain("if (modelFilter === 'restricted' && (item.supportedModels || []).length === 0) return false;");
    expect(downstreamKeys).toContain("setRouteFilter('all'); setModelFilter('all'); setExpireFilter('all');");
  });

  it('账号令牌支持关键词 / 站点 / 分组 / 状态筛选，并作用到列表', () => {
    expect(tokens).toContain('data-testid="tokens-filter-panel"');
    expect(tokens).toContain('data-testid="tokens-filter-search"');
    expect(tokens).toContain('tokenSiteFilterOptions');
    expect(tokens).toContain('tokenGroupFilterOptions');
    expect(tokens).toContain("useState<'all' | 'enabled' | 'disabled' | 'pending'>('all')");
    expect(tokens).toContain('const filteredTokens = useMemo(() => {');
    expect(tokens).toContain('return [...filteredTokens].sort(');
    expect(tokens).toContain('const resetTokenFilters = () => {');
  });
});
