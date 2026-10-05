import { and, asc, eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';
import { getAdapter } from './platforms/index.js';
import { sendNotification } from './notifyService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import type { SiteAnnouncement } from './platforms/base.js';

export type SiteAnnouncementSyncResult = {
  scannedSites: number;
  inserted: number;
  updated: number;
  unsupported: number;
  notifications: number;
  events: number;
  failed: number;
  /** 上游返回、但时间早于保留窗口、被直接忽略的公告数。 */
  skippedOld: number;
  /** 从库里清掉的、早于保留窗口的历史公告数。 */
  pruned: number;
  failedSites: Array<{ siteId: number; siteName: string; message: string }>;
};

/** 公告保留窗口（天）：只同步/保留最近这么多天的公告。 */
export function resolveSiteAnnouncementRetentionDays(raw: number | undefined): number {
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.trunc(raw as number));
}

function parseAnnouncementTimeMs(raw: string | null | undefined): number | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 公告的时间基准：取上游「创建 / 更新 / 开始 / 结束」里最晚的一个。
 * 这个值用于判断公告是否落在保留窗口内——一条很老的公告如果今天被更新过，
 * 或者维护窗口还没结束，都应该保留。
 *
 * 全部缺失时返回 null：这类没有时间戳的公告（例如 new-api 的站点公告
 * `/api/notice` 只有一段当前文本）代表「当前有效」，不受窗口过滤。
 */
export function resolveAnnouncementTimeMs(input: {
  upstreamCreatedAt?: string | null;
  upstreamUpdatedAt?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}): number | null {
  const candidates = [
    input.upstreamUpdatedAt,
    input.upstreamCreatedAt,
    input.startsAt,
    input.endsAt,
  ]
    .map(parseAnnouncementTimeMs)
    .filter((value): value is number => value !== null);
  return candidates.length ? Math.max(...candidates) : null;
}

/**
 * 删掉这个站点里时间早于保留窗口的公告。时间戳缺失的行不动，
 * 它们代表站点当前公告而不是历史记录。
 */
async function pruneOldSiteAnnouncements(siteId: number, cutoffMs: number): Promise<number> {
  const rows = await db.select({
    id: schema.siteAnnouncements.id,
    upstreamCreatedAt: schema.siteAnnouncements.upstreamCreatedAt,
    upstreamUpdatedAt: schema.siteAnnouncements.upstreamUpdatedAt,
    startsAt: schema.siteAnnouncements.startsAt,
    endsAt: schema.siteAnnouncements.endsAt,
  })
    .from(schema.siteAnnouncements)
    .where(eq(schema.siteAnnouncements.siteId, siteId))
    .all();

  const staleIds = rows
    .filter((row) => {
      const timeMs = resolveAnnouncementTimeMs(row);
      return timeMs !== null && timeMs < cutoffMs;
    })
    .map((row) => row.id);

  if (!staleIds.length) return 0;
  await db.delete(schema.siteAnnouncements)
    .where(inArray(schema.siteAnnouncements.id, staleIds))
    .run();
  return staleIds.length;
}

function toStoredPayload(rawPayload: unknown): string | null {
  if (rawPayload === undefined) return null;
  try {
    return JSON.stringify(rawPayload);
  } catch {
    return null;
  }
}

function buildAnnouncementMessage(row: SiteAnnouncement): string {
  const title = String(row.title || '').trim();
  const content = String(row.content || '').trim();
  if (title && content && title !== content && title.toLowerCase() !== 'site notice') {
    return `${title}\n${content}`;
  }
  return content || title;
}

async function resolveSiteAccessToken(siteId: number, siteApiKey?: string | null): Promise<string> {
  const direct = String(siteApiKey || '').trim();
  if (direct) return direct;

  const account = await db.select()
    .from(schema.accounts)
    .where(and(
      eq(schema.accounts.siteId, siteId),
      eq(schema.accounts.status, 'active'),
    ))
    .orderBy(asc(schema.accounts.id))
    .limit(1)
    .get();

  return String(account?.accessToken || '').trim();
}

async function listTargetSites(siteId?: number | null) {
  if (siteId && Number.isFinite(siteId) && siteId > 0) {
    return await db.select()
      .from(schema.sites)
      .where(eq(schema.sites.id, siteId))
      .all();
  }

  return await db.select()
    .from(schema.sites)
    .where(eq(schema.sites.status, 'active'))
    .all();
}

export async function syncSiteAnnouncements(options?: { siteId?: number | null }): Promise<SiteAnnouncementSyncResult> {
  const result: SiteAnnouncementSyncResult = {
    scannedSites: 0,
    inserted: 0,
    updated: 0,
    unsupported: 0,
    notifications: 0,
    events: 0,
    failed: 0,
    skippedOld: 0,
    pruned: 0,
    failedSites: [],
  };

  const retentionDays = resolveSiteAnnouncementRetentionDays(config.siteAnnouncementRetentionDays);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const sites = await listTargetSites(options?.siteId ?? null);

  for (const site of sites) {
    result.scannedSites += 1;
    const adapter = getAdapter(String(site.platform || ''));
    if (!adapter || typeof adapter.getSiteAnnouncements !== 'function') {
      result.unsupported += 1;
      continue;
    }

    try {
      const accessToken = await resolveSiteAccessToken(site.id, site.apiKey);
      const announcements = await adapter.getSiteAnnouncements(site.url, accessToken);
      const seenAt = formatUtcSqlDateTime(new Date());

      for (const announcement of announcements) {
        // 上游会把很久以前的公告一起返回，只留最近 N 天，老公告直接不落库。
        const announcementTimeMs = resolveAnnouncementTimeMs(announcement);
        if (announcementTimeMs !== null && announcementTimeMs < cutoffMs) {
          result.skippedOld += 1;
          continue;
        }

        const existing = await db.select()
          .from(schema.siteAnnouncements)
          .where(and(
            eq(schema.siteAnnouncements.siteId, site.id),
            eq(schema.siteAnnouncements.sourceKey, announcement.sourceKey),
          ))
          .limit(1)
          .get();

        const patch = {
          platform: String(site.platform || '').trim(),
          title: announcement.title,
          content: announcement.content,
          level: announcement.level,
          sourceUrl: announcement.sourceUrl ?? null,
          startsAt: announcement.startsAt ?? null,
          endsAt: announcement.endsAt ?? null,
          upstreamCreatedAt: announcement.upstreamCreatedAt ?? null,
          upstreamUpdatedAt: announcement.upstreamUpdatedAt ?? null,
          lastSeenAt: seenAt,
          rawPayload: toStoredPayload(announcement.rawPayload),
        };

        if (existing) {
          await db.update(schema.siteAnnouncements)
            .set(patch)
            .where(eq(schema.siteAnnouncements.id, existing.id))
            .run();
          result.updated += 1;
          continue;
        }

        const inserted = await db.insert(schema.siteAnnouncements).values({
          siteId: site.id,
          sourceKey: announcement.sourceKey,
          firstSeenAt: seenAt,
          ...patch,
        }).run();
        const announcementId = requireInsertedRowId(
          inserted,
          `failed to create site announcement for site ${site.id}`,
        );
        result.inserted += 1;

        const title = `站点公告：${site.name}`;
        const message = buildAnnouncementMessage(announcement);
        await db.insert(schema.events).values({
          type: 'site_notice',
          title,
          message,
          level: announcement.level,
          relatedId: announcementId,
          relatedType: 'site_announcement',
          createdAt: seenAt,
        }).run();
        result.events += 1;

        await sendNotification(title, message, announcement.level);
        result.notifications += 1;
      }

      // 顺手清掉这个站点之前已经存进来的历史公告（首次启用窗口时用得上）。
      result.pruned += await pruneOldSiteAnnouncements(site.id, cutoffMs);
    } catch (error) {
      result.failed += 1;
      result.failedSites.push({
        siteId: site.id,
        siteName: site.name,
        message: error instanceof Error && error.message ? error.message : 'unknown error',
      });
    }
  }

  return result;
}
