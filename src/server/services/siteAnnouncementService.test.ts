import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getAdapterMock = vi.fn();
const sendNotificationMock = vi.fn();

vi.mock('./platforms/index.js', () => ({
  getAdapter: (...args: unknown[]) => getAdapterMock(...args),
}));

vi.mock('./notifyService.js', () => ({
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./siteAnnouncementService.js');

describe('siteAnnouncementService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let syncSiteAnnouncements: ServiceModule['syncSiteAnnouncements'];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-site-announcements-service-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    const serviceModule = await import('./siteAnnouncementService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
    syncSiteAnnouncements = serviceModule.syncSiteAnnouncements;
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    getAdapterMock.mockReset();
    sendNotificationMock.mockReset();

    await db.delete(schema.siteAnnouncements).run();
    await db.delete(schema.events).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    vi.useRealTimers();
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

  it('stores first-seen announcements, creates one event, and sends one notification', async () => {
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));

    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'demo-user',
      accessToken: 'jwt-token',
      status: 'active',
    }).run();
    await db.insert(schema.sites).values({
      name: 'Unsupported Site',
      url: 'https://unsupported.example.com',
      platform: 'openai',
      status: 'active',
    }).run();

    getAdapterMock.mockImplementation((platform: string) => {
      if (platform === 'sub2api') {
        return {
          getSiteAnnouncements: vi.fn(async (_baseUrl: string, accessToken: string) => {
            expect(accessToken).toBe('jwt-token');
            return [{
              sourceKey: 'announcement:11',
              title: 'Maintenance',
              content: 'Window starts at 10:00',
              level: 'info',
              rawPayload: { id: 11, title: 'Maintenance' },
            }];
          }),
        };
      }
      return {
        getSiteAnnouncements: undefined,
      };
    });

    const result = await syncSiteAnnouncements();

    expect(result).toMatchObject({
      scannedSites: 2,
      inserted: 1,
      updated: 0,
      unsupported: 1,
      notifications: 1,
      events: 1,
      failed: 0,
    });

    const announcementRows = await db.select().from(schema.siteAnnouncements).all();
    expect(announcementRows).toHaveLength(1);
    expect(announcementRows[0]).toMatchObject({
      siteId: site.id,
      platform: 'sub2api',
      sourceKey: 'announcement:11',
      title: 'Maintenance',
      content: 'Window starts at 10:00',
      level: 'info',
    });

    const eventRows = await db.select().from(schema.events).all();
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0]).toMatchObject({
      type: 'site_notice',
      relatedType: 'site_announcement',
    });
    expect(Number(eventRows[0]?.relatedId)).toBe(Number(announcementRows[0]?.id));

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock.mock.calls[0]?.[0]).toContain('Sub Site');
    expect(sendNotificationMock.mock.calls[0]?.[1]).toContain('Window starts at 10:00');
    expect(sendNotificationMock.mock.calls[0]?.[2]).toBe('info');
  });

  it('只同步最近 2 天的公告：上游返回的老公告会被忽略并从未清理掉', async () => {
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));

    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'demo-user',
      accessToken: 'jwt-token',
      status: 'active',
    }).run();

    getAdapterMock.mockReturnValue({
      getSiteAnnouncements: vi.fn(async () => [
        {
          sourceKey: 'announcement:1',
          title: '今天的公告',
          content: '还在窗口内',
          level: 'info',
          upstreamCreatedAt: '2026-03-20T08:00:00Z',
          rawPayload: { id: 1 },
        },
        {
          sourceKey: 'announcement:2',
          title: '五天前的公告',
          content: '太老了，不该同步',
          level: 'info',
          upstreamCreatedAt: '2026-03-15T08:00:00Z',
          rawPayload: { id: 2 },
        },
      ]),
    });

    const first = await syncSiteAnnouncements({ siteId: site.id });
    expect(first).toMatchObject({ inserted: 1, skippedOld: 1, pruned: 0 });

    const rows = await db.select().from(schema.siteAnnouncements).all();
    expect(rows.map((row) => row.title)).toEqual(['今天的公告']);

    // 模拟「窗口启用前」已经存进来的老公告：下一次同步应该把它清掉。
    await db.insert(schema.siteAnnouncements).values({
      siteId: site.id,
      platform: 'sub2api',
      sourceKey: 'announcement:old',
      title: '历史遗留公告',
      content: '存在很久了',
      level: 'info',
      upstreamCreatedAt: '2026-01-01T00:00:00Z',
      rawPayload: null,
    }).run();

    const second = await syncSiteAnnouncements({ siteId: site.id });
    expect(second).toMatchObject({ inserted: 0, updated: 1, skippedOld: 1, pruned: 1 });
    const remaining = await db.select().from(schema.siteAnnouncements).all();
    expect(remaining.map((row) => row.title)).toEqual(['今天的公告']);
  });

  it('没时间戳的公告代表「当前公告」，不受 2 天窗口影响', async () => {
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));

    const site = await db.insert(schema.sites).values({
      name: 'NewApi Site',
      url: 'https://newapi.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();

    getAdapterMock.mockReturnValue({
      getSiteAnnouncements: vi.fn(async () => [{
        sourceKey: 'notice:hash',
        title: 'Site notice',
        content: '欢迎来到本站',
        level: 'info',
        rawPayload: { data: '欢迎来到本站' },
      }]),
    });

    const first = await syncSiteAnnouncements({ siteId: site.id });
    expect(first).toMatchObject({ inserted: 1, skippedOld: 0, pruned: 0 });

    // 十天后再同步一次也不该被清掉——它没有时间戳，就是站点当前的公告。
    vi.setSystemTime(new Date('2026-03-30T10:00:00Z'));
    const second = await syncSiteAnnouncements({ siteId: site.id });
    expect(second).toMatchObject({ inserted: 0, updated: 1, skippedOld: 0, pruned: 0 });
    expect((await db.select().from(schema.siteAnnouncements).all())).toHaveLength(1);
  });

  it('被更新过的老公告按「最新时间」算，仍在窗口内时会保留', async () => {
    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));

    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();

    getAdapterMock.mockReturnValue({
      getSiteAnnouncements: vi.fn(async () => [{
        sourceKey: 'announcement:9',
        title: '老公告但有维护窗口',
        content: '维护到明天',
        level: 'warning',
        upstreamCreatedAt: '2026-02-01T00:00:00Z',
        upstreamUpdatedAt: '2026-02-02T00:00:00Z',
        endsAt: '2026-03-21T00:00:00Z',
        rawPayload: { id: 9 },
      }]),
    });

    const result = await syncSiteAnnouncements({ siteId: site.id });
    expect(result).toMatchObject({ inserted: 1, skippedOld: 0 });
  });

  it('updates existing announcements without duplicating events or notifications', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'Sub Site',
      url: 'https://sub.example.com',
      platform: 'sub2api',
      status: 'active',
    }).returning().get();
    await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'demo-user',
      accessToken: 'jwt-token',
      status: 'active',
    }).run();

    getAdapterMock.mockReturnValue({
      getSiteAnnouncements: vi.fn(async () => [{
        sourceKey: 'announcement:11',
        title: 'Maintenance',
        content: 'Window starts at 10:00',
        level: 'info',
        rawPayload: { id: 11, title: 'Maintenance' },
      }]),
    });

    vi.setSystemTime(new Date('2026-03-20T10:00:00Z'));
    await syncSiteAnnouncements({ siteId: site.id });
    const firstRow = await db.select().from(schema.siteAnnouncements).get();

    vi.setSystemTime(new Date('2026-03-20T11:00:00Z'));
    const result = await syncSiteAnnouncements({ siteId: site.id });

    expect(result).toMatchObject({
      scannedSites: 1,
      inserted: 0,
      updated: 1,
      notifications: 0,
      events: 0,
      failed: 0,
    });

    const announcementRows = await db.select().from(schema.siteAnnouncements).all();
    expect(announcementRows).toHaveLength(1);
    expect(announcementRows[0]?.firstSeenAt).toBe(firstRow?.firstSeenAt);
    expect(announcementRows[0]?.lastSeenAt).not.toBe(firstRow?.lastSeenAt);

    const eventRows = await db.select().from(schema.events).all();
    expect(eventRows).toHaveLength(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });
});
