import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ModelMonitor unsupported sites', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/web/pages/ModelMonitor.tsx'), 'utf8');

  it('keeps "site has no metrics endpoint" out of the failure list', () => {
    // 「站点不支持」是已知状态，不该和真正的采集失败混在同一个列表里。
    expect(source).toContain(
      "const failedSites = sites.filter((site) => site.status !== 'ok' && site.status !== 'unsupported');",
    );
    expect(source).toContain("const unsupportedSites = sites.filter((site) => site.status === 'unsupported');");
  });

  it('folds unsupported sites into a collapsed row and excludes them from coverage', () => {
    expect(source).toContain("const [showUnsupported, setShowUnsupported] = useState(false);");
    expect(source).toContain('const unsupported = sites.filter((site) => site.status === \'unsupported\').length;');
    expect(source).toContain('totalSites: sites.length - unsupported,');
    expect(source).toContain('model-monitor-unsupported-head');
    // 站点下拉里用「（不支持）」标出来，省得点进去才发现是空站点。
    expect(source).toContain("site.status === 'unsupported' ? `${site.siteName}${tr('（不支持）')}` : site.siteName");
  });
});
