import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EDGE_DIR = 'src/server/edge';

/**
 * 边缘入口绝不允许引入的模块。
 * = src/server/index.ts:281-312 启动的那批调度器 + 会拉起受管浏览器的模块。
 * 刻意用子串匹配而不是精确 import 路径，这样相对路径、别名、动态 import() 都能覆盖到；
 * reloadBackupWebdavScheduler 是函数名匹配，防止有人直接调它去传 WebDAV 备份。
 */
const FORBIDDEN_MODULES = [
  'startScheduler',
  'reloadBackupWebdavScheduler',
  'checkinScheduler',
  'managedBrowserReaper',
  'siteAnnouncementPollingService',
  'modelAvailabilityProbeService',
  'modelMonitorService',
  'xapiKeyService',
  'channelRecoveryProbeService',
  'sub2apiRefreshScheduler',
  'assistedLogin/watchers',
  'updateCenterPollingService',
  'usageAggregationService',
  'adminSnapshotWarmService',
  'oauth/localCallbackServer',
  'proxyLogRetentionService',
  'proxyFileRetentionService',
];

/**
 * 边缘入口不该做的事：跑主服务的初始化逻辑、清理受管浏览器。
 * 前端托管单独放在 webAssets.ts（exe 需要登录页 + 两个页面），入口只调用它，见最后一个用例。
 */
const FORBIDDEN_ENTRY_SNIPPETS = [
  'registerDesktopRoutes',
  'ensureDefaultSitesSeeded',
  'repairStoredCreatedAtValues',
  'migrateSiteApiKeysToAccounts',
  'reapStrandedManagedBrowsers',
];

function listEdgeSourceFiles(): string[] {
  return readdirSync(EDGE_DIR).flatMap((entry) => {
    const full = join(EDGE_DIR, entry);
    if (statSync(full).isDirectory()) {
      return readdirSync(full).flatMap((nested) => {
        const nestedFull = join(full, nested);
        return nestedFull.endsWith('.ts') && !nestedFull.endsWith('.test.ts') ? [nestedFull] : [];
      });
    }
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('edge relay 边界', () => {
  it('边缘子项目不得引入任何调度器/后台任务模块', () => {
    const offenders: string[] = [];
    for (const file of listEdgeSourceFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_MODULES) {
        if (source.includes(forbidden)) offenders.push(`${file} -> ${forbidden}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('主服务入口不得引入边缘子项目', () => {
    const indexSource = readFileSync('src/server/index.ts', 'utf8');
    expect(indexSource.includes("'./edge/")).toBe(false);
  });

  it('边缘实例只拉取配置，不对配置源做任何写请求', () => {
    const syncSource = readFileSync(join(EDGE_DIR, 'configSync.ts'), 'utf8');
    // 同步源一律用 GET（fetch 默认就是 GET），出现 method: 或写动词即视为回写服务器。
    expect(/\bmethod\s*:/.test(syncSource)).toBe(false);
    expect(/['\"](POST|PUT|PATCH|DELETE)['\"]/.test(syncSource)).toBe(false);
  });

  it('边缘入口不跑主服务的初始化逻辑', () => {
    const mainSource = readFileSync(join(EDGE_DIR, 'main.ts'), 'utf8');
    const offenders = FORBIDDEN_ENTRY_SNIPPETS.filter((snippet) => mainSource.includes(snippet));
    expect(offenders).toEqual([]);
  });

  it('前端静态资源只由 webAssets.ts 托管，且不掺业务逻辑', () => {
    const mainSource = readFileSync(join(EDGE_DIR, 'main.ts'), 'utf8');
    // 入口只调用 registerEdgeWebAssets，自己不认识 fastifyStatic。
    expect(mainSource).not.toContain('fastifyStatic');

    const webAssets = readFileSync(join(EDGE_DIR, 'webAssets.ts'), 'utf8');
    expect(webAssets).toContain("'../../web'");
    // 只发静态文件：不得引入服务、路由、数据库或调度器模块。
    expect(/from '\.\.\/(services|routes|db)\//.test(webAssets)).toBe(false);
    expect(webAssets).not.toContain('authMiddleware');
  });
});
