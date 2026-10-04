import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      await seedSite({ name: 'OpenAI Site', url: 'https://openai.example.com', platform: 'openai' });

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
});
