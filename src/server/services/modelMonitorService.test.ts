import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';

const getAdapterMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapterMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./modelMonitorService.js');

function model(name: string, overrides: Record<string, unknown> = {}) {
  return {
    modelName: name,
    avgLatencyMs: 1500,
    successRate: 99,
    avgTps: 42,
    recentSuccess: [{ ts: null, rate: 100 }],
    ...overrides,
  };
}

describe('modelMonitorService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let service: ServiceModule;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-monitor-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    service = await import('./modelMonitorService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
  });

  beforeEach(async () => {
    getAdapterMock.mockReset();
    service.__resetModelMonitorStateForTests();
    // 价格走的是真实 HTTP，单测里换成桩：不关心价格的用例一律「读不到」。
    service.__setModelMonitorPricingLoaderForTests(async () => null);
    await db.delete(schema.siteModelMonitorModels).run();
    await db.delete(schema.siteModelMonitorSites).run();
    await db.delete(schema.routeChannels).run();
    await db.delete(schema.tokenRoutes).run();
    await db.delete(schema.accountTokens).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    if (typeof closeDbConnections === 'function') {
      await closeDbConnections();
    }
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
    delete process.env.DATA_DIR;
  });

  describe('isModelMonitorWindowOpen', () => {
    it('只把 [start, end) 小时区间算作开放', () => {
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 6, 59), 7, 12)).toBe(false);
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 7, 0), 7, 12)).toBe(true);
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 11, 59), 7, 12)).toBe(true);
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 12, 0), 7, 12)).toBe(false);
    });

    it('支持跨夜窗口，start === end 视为全天', () => {
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 23, 0), 22, 6)).toBe(true);
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 3, 0), 22, 6)).toBe(true);
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 12, 0), 22, 6)).toBe(false);
      expect(service.isModelMonitorWindowOpen(new Date(2026, 9, 4, 12, 0), 8, 8)).toBe(true);
    });
  });

  describe('isModelListDailyRefreshDue', () => {
    it('当天刷新点之后刷过就不算到期，之前的算到期', () => {
      const now = new Date(2026, 9, 5, 9, 30); // 10-05 09:30
      const boundary = new Date(2026, 9, 5, 7, 0).toISOString();
      expect(service.isModelListDailyRefreshDue(boundary, now, 7)).toBe(false);
      expect(service.isModelListDailyRefreshDue(new Date(2026, 9, 5, 8, 0).toISOString(), now, 7)).toBe(false);
      // 今天 06:59 刷的，还没到 7 点，需要再来一次。
      expect(service.isModelListDailyRefreshDue(new Date(2026, 9, 5, 6, 59).toISOString(), now, 7)).toBe(true);
      // 昨天刷的，今天还没刷。
      expect(service.isModelListDailyRefreshDue(new Date(2026, 9, 4, 23, 0).toISOString(), now, 7)).toBe(true);
    });

    it('没有记录或时间戳不可解析时按需要刷新处理', () => {
      const now = new Date(2026, 9, 5, 9, 30);
      expect(service.isModelListDailyRefreshDue(null, now, 7)).toBe(true);
      expect(service.isModelListDailyRefreshDue(undefined, now, 7)).toBe(true);
      expect(service.isModelListDailyRefreshDue('not-a-date', now, 7)).toBe(true);
    });
  });

  describe('parseStoredRecentSuccess', () => {
    it('解析存下来的采样点并丢弃坏数据', () => {
      expect(service.parseStoredRecentSuccess('[{"ts":100,"rate":99.5},{"ts":null,"rate":"70"},{"rate":"x"}]'))
        .toEqual([{ ts: 100, rate: 99.5 }, { ts: null, rate: 70 }]);
      expect(service.parseStoredRecentSuccess('not-json')).toEqual([]);
      expect(service.parseStoredRecentSuccess(null)).toEqual([]);
    });
  });

  describe('runModelMonitorFetch', () => {
    async function seedSite(overrides: Record<string, unknown> = {}) {
      const site = await db.insert(schema.sites).values({
        name: 'Demo Site',
        url: 'https://demo.example.com',
        platform: 'new-api',
        status: 'active',
        ...overrides,
      }).returning().get();
      return site;
    }

    async function seedAccount(siteId: number, overrides: Record<string, unknown> = {}) {
      return db.insert(schema.accounts).values({
        siteId,
        username: 'demo',
        accessToken: 'jwt-token',
        status: 'active',
        ...overrides,
      }).returning().get();
    }

    it('优先用 active 账号，全部过期时也会照试一次（好让页面显示真实原因）', async () => {
      const site = await seedSite();
      await seedAccount(site.id, { status: 'expired', accessToken: 'expired-token' });
      const seen: string[] = [];
      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async (_url: string, token: string) => {
          seen.push(token);
          return { ok: false, unsupported: false, message: 'HTTP 401：站点判定当前凭据无效' };
        }),
      }));

      const summary = await service.runModelMonitorFetch();

      expect(seen).toEqual(['expired-token']);
      expect(summary.status.error).toBe(1);
      const siteRow = await db.select().from(schema.siteModelMonitorSites).all();
      expect(siteRow[0]).toMatchObject({
        status: 'error',
        message: 'HTTP 401：站点判定当前凭据无效',
      });
    });

    it('采集成功时写入模型行与站点状态，不支持的平台单独归类', async () => {
      const demo = await seedSite();
      await seedAccount(demo.id);
      const openaiSite = await seedSite({ name: 'OpenAI Site', url: 'https://openai.example.com', platform: 'openai' });
      await seedAccount(openaiSite.id);

      getAdapterMock.mockImplementation((platform: string) => {
        if (platform !== 'new-api') return { platformName: platform };
        return {
          platformName: platform,
          getPerfMetricsSummary: vi.fn(async (_url: string, token: string) => {
            expect(token).toBe('jwt-token');
            return {
              ok: true,
              data: {
                summary: { avgLatencyMs: 900, successRate: 98, avgTps: 40 },
                windowStart: 1791010800,
                windowEnd: 1791097200,
                showThroughput: true,
                models: [model('gpt-5.5'), model('deepseek-v4-flash', { successRate: 91.5, avgTps: 120 })],
              },
            };
          }),
        };
      });

      const summary = await service.runModelMonitorFetch();

      expect(summary.scannedSites).toBe(2);
      expect(summary.status).toMatchObject({ ok: 1, unsupported: 1, error: 0, empty: 0 });
      expect(summary.models).toBe(2);

      const models = await db.select().from(schema.siteModelMonitorModels).all();
      expect(models).toHaveLength(2);
      expect(models.map((row) => row.modelName).sort()).toEqual(['deepseek-v4-flash', 'gpt-5.5']);
      expect(models[0].fetchedAt).toBeTruthy();
      expect(service.parseStoredRecentSuccess(models[0].recentSuccess)).toEqual([{ ts: null, rate: 100 }]);

      const siteRows = await db.select().from(schema.siteModelMonitorSites).all();
      expect(siteRows).toHaveLength(2);
      const okSite = siteRows.find((row) => row.status === 'ok');
      expect(okSite).toMatchObject({ modelsCount: 2, credentialKind: 'account', summaryAvgTps: 40 });
      const unsupported = siteRows.find((row) => row.status === 'unsupported');
      expect(unsupported?.message).toContain('没有模型监控接口');
    });

    it('上一轮有、这一轮没有的模型会被删掉（表里只留最新）', async () => {
      const site = await seedSite();
      await seedAccount(site.id);
      let round = 0;
      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async () => {
          round += 1;
          return {
            ok: true,
            data: {
              summary: null,
              windowStart: null,
              windowEnd: null,
              showThroughput: null,
              models: round === 1 ? [model('a'), model('b')] : [model('b')],
            },
          };
        }),
      }));

      await service.runModelMonitorFetch();
      expect((await db.select().from(schema.siteModelMonitorModels).all())).toHaveLength(2);

      await service.runModelMonitorFetch();
      const rows = await db.select().from(schema.siteModelMonitorModels).all();
      expect(rows.map((row) => row.modelName)).toEqual(['b']);
    });

    it('把站点价目表里的输入 / 输出单价一起写进模型行', async () => {
      const site = await seedSite();
      await seedAccount(site.id);
      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async () => ({
          ok: true,
          data: {
            summary: null,
            windowStart: null,
            windowEnd: null,
            showThroughput: null,
            models: [model('gpt-5.5'), model('按次计费模型')],
          },
        })),
      }));
      service.__setModelMonitorPricingLoaderForTests(async () => ({
        models: [
          {
            modelName: 'gpt-5.5',
            quotaType: 0,
            modelDescription: null,
            tags: [],
            supportedEndpointTypes: [],
            ownerBy: null,
            enableGroups: ['default'],
            groupPricing: {
              default: { quotaType: 0, inputPerMillion: 75, outputPerMillion: 150 },
            },
          },
          {
            modelName: '按次计费模型',
            quotaType: 1,
            modelDescription: null,
            tags: [],
            supportedEndpointTypes: [],
            ownerBy: null,
            enableGroups: ['default'],
            // new-api 的按次计费只给总价。
            groupPricing: {
              default: { quotaType: 1, perCallTotal: 0.03 },
            },
          },
        ],
        groupRatio: { default: 1 },
      }));

      await service.runModelMonitorFetch();

      const rows = await db.select().from(schema.siteModelMonitorModels).all();
      const byName = new Map(rows.map((row) => [row.modelName, row]));
      expect(byName.get('gpt-5.5')).toMatchObject({
        pricingUnit: 'token',
        inputPrice: 75,
        outputPrice: 150,
      });
      expect(byName.get('按次计费模型')).toMatchObject({
        pricingUnit: 'call',
        inputPrice: 0.03,
        outputPrice: null,
      });
    });

    it('价目表读不到时不影响采集：只是没有价格', async () => {
      const site = await seedSite();
      await seedAccount(site.id);
      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async () => ({
          ok: true,
          data: {
            summary: null,
            windowStart: null,
            windowEnd: null,
            showThroughput: null,
            models: [model('a')],
          },
        })),
      }));
      service.__setModelMonitorPricingLoaderForTests(async () => {
        throw new Error('pricing down');
      });

      const summary = await service.runModelMonitorFetch();

      expect(summary.status.ok).toBe(1);
      const rows = await db.select().from(schema.siteModelMonitorModels).all();
      expect(rows[0].pricingUnit).toBeNull();
      expect(rows[0].inputPrice).toBeNull();
    });

    it('采集失败时保留上一轮数据，并把原因写到站点行', async () => {
      const site = await seedSite();
      await seedAccount(site.id);
      let round = 0;
      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async () => {
          round += 1;
          if (round === 1) {
            return {
              ok: true,
              data: {
                summary: null,
                windowStart: null,
                windowEnd: null,
                showThroughput: null,
                models: [model('a')],
              },
            };
          }
          return { ok: false, unsupported: false, message: 'HTTP 401：站点判定当前凭据无效' };
        }),
      }));

      await service.runModelMonitorFetch();
      const summary = await service.runModelMonitorFetch();

      expect(summary.status.error).toBe(1);
      const siteRow = await db.select().from(schema.siteModelMonitorSites).all();
      expect(siteRow[0]).toMatchObject({
        status: 'error',
        message: 'HTTP 401：站点判定当前凭据无效',
        modelsCount: 0,
        credentialKind: 'account',
      });
      // 上一轮的数据还在，页面不会因为一次失败就显示空白。
      expect(await db.select().from(schema.siteModelMonitorModels).all()).toHaveLength(1);
    });

    it('单飞：采集未结束时再次调用复用同一轮', async () => {
      const site = await seedSite();
      await seedAccount(site.id);
      let resolveRun: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => { resolveRun = resolve; });
      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async () => {
          await gate;
          return {
            ok: true,
            data: { summary: null, windowStart: null, windowEnd: null, showThroughput: null, models: [] },
          };
        }),
      }));

      const first = service.runModelMonitorFetch();
      const second = service.runModelMonitorFetch();
      expect(service.isModelMonitorRunning()).toBe(true);
      expect(second).toBe(first);

      resolveRun?.();
      await first;
      expect(service.isModelMonitorRunning()).toBe(false);
    });

    it('平台没有监控接口时降级用密钥读模型名：指标留空并标记为仅模型列表', async () => {
      const site = await seedSite({ platform: 'sub2api' });
      const account = await seedAccount(site.id, { accessToken: 'jwt-session-token' });
      // 同时存在账号 JWT 和 sk- 令牌时，降级要优先用 sk- 令牌。
      await db.insert(schema.accountTokens).values({
        accountId: account.id,
        name: 'default',
        token: 'sk-demo-key',
        isDefault: true,
        valueStatus: 'ready',
        enabled: true,
      }).run();
      const calls: unknown[][] = [];
      const getModels = vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return ['gpt-4o', 'claude-3', 'gpt-4o', '  '];
      });
      getAdapterMock.mockImplementation(() => ({
        platformName: 'sub2api',
        getModels,
      }));

      const summary = await service.runModelMonitorFetch();

      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toContain('demo.example.com');
      // 第一份就是 sk- 令牌（不是账号 JWT），也说明成功一次就停止重试。
      expect(calls[0][1]).toBe('sk-demo-key');
      expect(summary.status).toMatchObject({ ok: 0, modelsOnly: 1, empty: 0, unsupported: 0, error: 0 });
      expect(summary.models).toBe(2);

      const siteRow = (await db.select().from(schema.siteModelMonitorSites).all())[0];
      expect(siteRow).toMatchObject({ status: 'models_only', modelsCount: 2 });
      expect(siteRow.message).toContain('仅展示模型列表');

      const rows = await db.select().from(schema.siteModelMonitorModels).all();
      expect(rows.map((row) => row.modelName).sort()).toEqual(['claude-3', 'gpt-4o']);
      // 指标读不到就留空，不能编造 0。
      expect(rows.every((row) => (
        row.successRate === null && row.avgLatencyMs === null && row.avgTps === null
      ))).toBe(true);
      expect(service.parseStoredRecentSuccess(rows[0].recentSuccess)).toEqual([]);

      const overview = await service.loadModelMonitorOverview();
      expect(overview.sites[0].status).toBe('models_only');
      expect(overview.models).toHaveLength(2);
      expect(overview.models.every((model) => model.metricsAvailable === false)).toBe(true);
      expect(overview.models.every((model) => model.successRate === null && model.avgLatencyMs === null)).toBe(true);
    });

    it('监控接口 404（老版本）时也降级；密钥也读不到模型时保持站点不支持', async () => {
      const fallbackSite = await seedSite({ name: 'Old Site', url: 'https://old.example.com' });
      await seedAccount(fallbackSite.id);
      const unsupported = { ok: false as const, unsupported: true, message: '站点没有 /api/perf-metrics 接口（版本较旧）' };

      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async () => unsupported),
        getModels: vi.fn(async () => ['deepseek-v4-flash']),
      }));
      const summary = await service.runModelMonitorFetch();
      expect(summary.status).toMatchObject({ modelsOnly: 1, unsupported: 0 });
      const siteRow = (await db.select().from(schema.siteModelMonitorSites).all())[0];
      expect(siteRow).toMatchObject({ status: 'models_only', modelsCount: 1 });

      // 换一个读不到模型列表的站点：结论要回到「不支持」，而不是假装成功。
      await db.delete(schema.siteModelMonitorModels).run();
      await db.delete(schema.siteModelMonitorSites).run();
      getAdapterMock.mockImplementation(() => ({
        platformName: 'new-api',
        getPerfMetricsSummary: vi.fn(async () => unsupported),
        getModels: vi.fn(async () => []),
      }));
      const second = await service.runModelMonitorFetch();
      expect(second.status).toMatchObject({ modelsOnly: 0, unsupported: 1, error: 0 });
      const row = (await db.select().from(schema.siteModelMonitorSites).all())[0];
      expect(row.status).toBe('unsupported');
      // 失败原因要说清楚：接口没有 + 密钥也没读回模型，而不是笼统一句失败。
      expect(row.message).toContain('版本较旧');
      expect(row.message).toContain('没读回任何模型');
      expect((await db.select().from(schema.siteModelMonitorModels).all())).toHaveLength(0);
    });

    it('「仅模型列表」站点当天刷过就跳过，第二天 7 点后才会再刷', async () => {
      const site = await seedSite({ platform: 'sub2api' });
      await seedAccount(site.id);
      const getModelsCalls: string[] = [];
      getAdapterMock.mockImplementation(() => ({
        platformName: 'sub2api',
        getModels: vi.fn(async () => {
          getModelsCalls.push('call');
          return ['gpt-4o'];
        }),
      }));

      // 先把站点标记成「今天 07:30 已经用密钥刷过」。
      const todayAt0730 = new Date();
      todayAt0730.setHours(7, 30, 0, 0);
      await db.insert(schema.siteModelMonitorSites).values({
        siteId: site.id,
        status: 'models_only',
        message: '站点没有模型监控接口，仅展示模型列表（指标无法获取）',
        modelsCount: 1,
        fetchedAt: todayAt0730.toISOString(),
      }).run();
      await db.insert(schema.siteModelMonitorModels).values({
        siteId: site.id,
        modelName: 'gpt-4o',
        fetchedAt: todayAt0730.toISOString(),
      }).run();

      const summary = await service.runModelMonitorFetch();
      expect(summary.scannedSites).toBe(0);
      expect(summary.skippedModelListSites).toBe(1);
      // 跳过的站点不再打上游，也不清掉上一轮的数据。
      expect(getModelsCalls).toHaveLength(0);
      expect((await db.select().from(schema.siteModelMonitorModels).all())).toHaveLength(1);
      const siteRow = (await db.select().from(schema.siteModelMonitorSites).all())[0];
      expect(siteRow.fetchedAt).toBe(todayAt0730.toISOString());

      // 把刷新时间改成昨天：应该重新拉一次。
      const yesterdayAt0730 = new Date();
      yesterdayAt0730.setDate(yesterdayAt0730.getDate() - 1);
      yesterdayAt0730.setHours(7, 30, 0, 0);
      await db.update(schema.siteModelMonitorSites)
        .set({ fetchedAt: yesterdayAt0730.toISOString() })
        .run();
      const next = await service.runModelMonitorFetch();
      expect(next.skippedModelListSites).toBe(0);
      expect(next.scannedSites).toBe(1);
      expect(getModelsCalls).toHaveLength(1);
      // 刷完时间戳被推进到今天。
      const refreshed = (await db.select().from(schema.siteModelMonitorSites).all())[0];
      expect(Date.parse(refreshed.fetchedAt || '')).toBeGreaterThan(yesterdayAt0730.getTime());
    });

    it('正常监控站点不受每日刷新限制，每轮照跑', async () => {
      const site = await seedSite();
      await seedAccount(site.id);
      const perf = vi.fn(async () => ({
        ok: true as const,
        data: { summary: null, windowStart: null, windowEnd: null, showThroughput: null, models: [model('a')] },
      }));
      getAdapterMock.mockImplementation(() => ({ platformName: 'new-api', getPerfMetricsSummary: perf }));

      await service.runModelMonitorFetch();
      const second = await service.runModelMonitorFetch();
      expect(second.scannedSites).toBe(1);
      expect(second.skippedModelListSites).toBe(0);
      expect(perf).toHaveBeenCalledTimes(2);
    });
  });

  describe('startModelMonitorScheduler', () => {
    async function seedSiteWithAccount(name: string) {
      const site = await db.insert(schema.sites).values({
        name,
        url: `https://${name}.example.com`,
        platform: 'new-api',
        status: 'active',
      }).returning().get();
      await db.insert(schema.accounts).values({
        siteId: site.id, username: 'u', accessToken: 't', status: 'active',
      }).run();
      return site;
    }

    /** 每个站点一轮采集会调用一次适配器，用它数「跑了几轮」。 */
    function stubAdapter(impl?: () => Promise<unknown>) {
      getAdapterMock.mockImplementation(() => ({
        getPerfMetricsSummary: vi.fn(impl ?? (async () => ({
          models: [model('gpt-5.5')],
          windowStart: 0,
          windowEnd: 0,
          showThroughput: true,
        }))),
      }));
    }

    beforeEach(() => {
      vi.useFakeTimers();
      // 固定到窗口内的本地时间（默认 07:00-23:00）。
      vi.setSystemTime(new Date(2026, 9, 5, 8, 0, 0));
      stubAdapter();
    });

    afterEach(() => {
      service.stopModelMonitorScheduler();
      vi.useRealTimers();
    });

    it('进窗口后立刻补一轮，之后按 interval 走', async () => {
      await seedSiteWithAccount('sched-a');

      const state = service.startModelMonitorScheduler();
      expect(state.enabled).toBe(true);
      expect(state.windowEndHour).toBe(23);
      expect(state.nextRunAt).not.toBeNull();

      // 启动即在窗口内 → 立刻起跑一轮。
      await vi.advanceTimersByTimeAsync(0);
      expect(getAdapterMock).toHaveBeenCalledTimes(1);
      expect(service.getModelMonitorSchedulerState().lastRunStartedAt).not.toBeNull();

      // 还不到 interval：tick 再多次也不重复跑。
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(getAdapterMock).toHaveBeenCalledTimes(1);

      // 跨过 interval：再跑一轮。
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(getAdapterMock).toHaveBeenCalledTimes(2);
    });

    it('窗口外不采集，进窗口后的第一次 tick 立刻补一轮', async () => {
      await seedSiteWithAccount('sched-b');
      vi.setSystemTime(new Date(2026, 9, 5, 6, 0, 0));

      service.startModelMonitorScheduler();
      await vi.advanceTimersByTimeAsync(0);
      expect(getAdapterMock).toHaveBeenCalledTimes(0);

      // 6:00 → 7:01，跨过窗口起点后应立刻起跑。
      await vi.advanceTimersByTimeAsync(61 * 60_000);
      expect(getAdapterMock).toHaveBeenCalledTimes(1);
    });

    it('上一轮没跑完时跳过本次，不排队也不并发', async () => {
      await seedSiteWithAccount('sched-c');
      // 放大超时，让这一轮一直挂在进行中。
      const originalTimeout = config.modelMonitorTimeoutMs;
      config.modelMonitorTimeoutMs = 24 * 60 * 60 * 1000;
      let releaseRun: (() => void) | null = null;
      const hanging = new Promise<never>((resolve) => { releaseRun = () => resolve(undefined as never); });
      stubAdapter(() => hanging);

      try {
        service.startModelMonitorScheduler();
        await vi.advanceTimersByTimeAsync(0);
        expect(getAdapterMock).toHaveBeenCalledTimes(1);
        expect(service.isModelMonitorRunning()).toBe(true);

        // 下一个 slot 到点时上一轮还挂着 → 跳过，且不会并发起第二轮。
        await vi.advanceTimersByTimeAsync(16 * 60_000);
        expect(getAdapterMock).toHaveBeenCalledTimes(1);
        expect(service.getModelMonitorSchedulerState().skippedRuns).toBeGreaterThan(0);

        releaseRun?.();
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        config.modelMonitorTimeoutMs = originalTimeout;
      }
    });

    it('关闭开关时不启动调度器', () => {
      const originalEnabled = config.modelMonitorEnabled;
      config.modelMonitorEnabled = false;
      try {
        const state = service.startModelMonitorScheduler();
        expect(state.enabled).toBe(false);
        expect(state.nextRunAt).toBeNull();
      } finally {
        config.modelMonitorEnabled = originalEnabled;
      }
    });
  });

  describe('loadModelMonitorOverview', () => {
    beforeEach(async () => {
      const site = await db.insert(schema.sites).values({
        name: 'Alpha',
        url: 'https://alpha.example.com',
        platform: 'new-api',
        status: 'active',
      }).returning().get();
      const other = await db.insert(schema.sites).values({
        name: 'Beta',
        url: 'https://beta.example.com',
        platform: 'new-api',
        status: 'active',
      }).returning().get();
      await db.insert(schema.siteModelMonitorModels).values([
        { siteId: site.id, modelName: 'gpt-5.5', successRate: 50, avgLatencyMs: 3000, avgTps: 10, pricingUnit: 'token', inputPrice: 75, outputPrice: 150, fetchedAt: '2026-10-04T01:00:00.000Z' },
        { siteId: site.id, modelName: 'claude-opus-5', successRate: 99, avgLatencyMs: 800, avgTps: 90, fetchedAt: '2026-10-04T01:00:00.000Z' },
        { siteId: other.id, modelName: 'gpt-5.5-mini', successRate: 95, avgLatencyMs: 500, avgTps: 200, fetchedAt: '2026-10-04T02:00:00.000Z' },
      ]).run();
      await db.insert(schema.siteModelMonitorSites).values([
        { siteId: site.id, status: 'ok', modelsCount: 2, fetchedAt: '2026-10-04T01:00:00.000Z' },
        { siteId: other.id, status: 'error', message: 'boom', modelsCount: 0, fetchedAt: '2026-10-04T02:00:00.000Z' },
      ]).run();
    });

    it('按模型名 / 站点 / 最低成功率筛选，并回传最近更新时间', async () => {
      const filtered = await service.loadModelMonitorOverview({ model: 'gpt-5.5' });
      expect(filtered.models.map((row) => row.modelName).sort()).toEqual(['gpt-5.5']);
      expect(filtered.models[0].siteUrl).toBe('https://alpha.example.com');
      expect(filtered.sites[0].url).toBeTruthy();
      expect(filtered.updatedAt).toBe('2026-10-04T02:00:00.000Z');

      const priced = filtered.models.find((row) => row.modelName === 'gpt-5.5');
      expect(priced).toMatchObject({
        pricingUnit: 'token',
        inputPrice: 75,
        outputPrice: 150,
        siteUrl: 'https://alpha.example.com',
      });

      const byRate = await service.loadModelMonitorOverview({ minSuccessRate: 96 });
      expect(byRate.models.map((row) => row.modelName)).toEqual(['claude-opus-5']);

      const alphaId = filtered.models.find((row) => row.siteName === 'Alpha')?.siteId;
      const bySite = await service.loadModelMonitorOverview({ siteId: alphaId });
      expect(bySite.models).toHaveLength(2);
      expect(bySite.sites.map((row) => row.status).sort()).toEqual(['error', 'ok']);
    });

    it('支持按成功率 / 延迟 / 吞吐 / 站点排序', async () => {
      const byLatency = await service.loadModelMonitorOverview({ sort: 'latency' });
      expect(byLatency.models[0].modelName).toBe('gpt-5.5-mini');

      const byTps = await service.loadModelMonitorOverview({ sort: 'tps' });
      expect(byTps.models[0].modelName).toBe('gpt-5.5-mini');

      const bySuccess = await service.loadModelMonitorOverview();
      expect(bySuccess.models[0].modelName).toBe('claude-opus-5');

      const bySite = await service.loadModelMonitorOverview({ sort: 'site' });
      expect(bySite.models[0].siteName).toBe('Alpha');
    });
  });

  describe('listChatChannelsForSiteModel', () => {
    async function seedSite(name = 'Chat Site') {
      return db.insert(schema.sites).values({
        name,
        url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example.com`,
        platform: 'new-api',
        status: 'active',
      }).returning().get();
    }

    async function seedAccount(siteId: number, username = 'demo') {
      return db.insert(schema.accounts).values({
        siteId,
        username,
        accessToken: 'jwt-token',
        status: 'active',
      }).returning().get();
    }

    async function seedRoute(modelPattern: string, displayName: string | null, enabled = true) {
      return db.insert(schema.tokenRoutes).values({
        modelPattern,
        displayName,
        routeMode: 'pattern',
        enabled,
      }).returning().get();
    }

    async function seedChannel(routeId: number, accountId: number, sourceModel: string | null, enabled = true) {
      return db.insert(schema.routeChannels).values({
        routeId,
        accountId,
        sourceModel,
        enabled,
      }).returning().get();
    }

    it('按站点+模型精确匹配普通路由，并带上上游模型名', async () => {
      const site = await seedSite();
      const account = await seedAccount(site.id, 'alice');
      const route = await seedRoute('deepseek-v4.1-flash', null);
      await seedChannel(route.id, account.id, 'deepseek-v4.1-flash');

      const channels = await service.listChatChannelsForSiteModel(site.id, 'deepseek-v4.1-flash');
      expect(channels).toHaveLength(1);
      expect(channels[0]).toMatchObject({
        routeId: route.id,
        accountName: 'alice',
        sourceModel: 'deepseek-v4.1-flash',
        upstreamModel: 'deepseek-v4.1-flash',
      });
    });

    it('转发路由用 display_name 命中，upstreamModel 取 source_model', async () => {
      const site = await seedSite();
      const account = await seedAccount(site.id, 'bob');
      const route = await seedRoute('forward:gpt-6-astra', 'gpt-6-astra');
      await seedChannel(route.id, account.id, 'deepseek-v4.1-flash');

      const channels = await service.listChatChannelsForSiteModel(site.id, 'gpt-6-astra');
      expect(channels).toHaveLength(1);
      expect(channels[0]).toMatchObject({
        routeId: route.id,
        routeName: 'gpt-6-astra',
        sourceModel: 'deepseek-v4.1-flash',
        upstreamModel: 'deepseek-v4.1-flash',
      });

      // 别的对外名不会命中这条转发路由
      expect(await service.listChatChannelsForSiteModel(site.id, 'gpt-5-astra')).toHaveLength(0);
    });

    it('过滤掉别的站点、已禁用通道与不匹配模型', async () => {
      const site = await seedSite('Site A');
      const otherSite = await seedSite('Site B');
      const account = await seedAccount(site.id, 'carol');
      const otherAccount = await seedAccount(otherSite.id, 'dave');

      const route = await seedRoute('deepseek-v4.1-flash', null);
      await seedChannel(route.id, account.id, 'deepseek-v4.1-flash');

      // 同站点但通道被禁用
      const disabledRoute = await seedRoute('deepseek-v4.1-flash', null);
      await seedChannel(disabledRoute.id, account.id, 'deepseek-v4.1-flash', false);

      // 别的站点的同模型通道
      const otherRoute = await seedRoute('deepseek-v4.1-flash', null);
      await seedChannel(otherRoute.id, otherAccount.id, 'deepseek-v4.1-flash');

      const channels = await service.listChatChannelsForSiteModel(site.id, 'deepseek-v4.1-flash');
      expect(channels).toHaveLength(1);
      expect(channels[0].accountName).toBe('carol');

      expect(await service.listChatChannelsForSiteModel(site.id, 'unknown-model')).toHaveLength(0);
      expect(await service.listChatChannelsForSiteModel(0, 'deepseek-v4.1-flash')).toHaveLength(0);
      expect(await service.listChatChannelsForSiteModel(site.id, '')).toHaveLength(0);
    });
  });
});
