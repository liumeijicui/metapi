import { browserLane } from '../shared/browserLane.js';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { assistedLoginSessions } from './assistedLogin/sessionRegistry.js';
import { passCloudflareChallenge } from './assistedLogin/cloudflareChallenge.js';
import { invalidateSiteProxyCache, normalizeSiteUrl } from './siteProxy.js';
import { parseSiteCustomHeadersInput } from './siteCustomHeaders.js';

/**
 * Keeps a Cloudflare-shielded site's `cf_clearance` fresh.
 *
 * A site behind Cloudflare's managed challenge answers every request from a
 * client it has not cleared with a `Just a moment...` page. Only a real browser
 * can pass that, and the clearance it earns is bound to the exit IP *and* the
 * browser's own User-Agent — so the cookie has to be captured together with the
 * UA that earned it, and replayed with the same UA or Cloudflare rejects it.
 *
 * Clearance is also invalidated whenever Cloudflare decides to challenge the
 * address again, which makes any value an operator pasted by hand a temporary
 * one. That is why this refresher exists: when a request comes back as a
 * challenge, the managed browser re-clears the site and the fresh pair is
 * written back onto the site record, instead of the account simply going dark
 * until a human notices.
 */

const CLEARANCE_COOKIE_NAME = 'cf_clearance';
/**
 * Minimum gap between two refreshes for one host. A challenge that survives a
 * refresh would otherwise start a browser run on every single API call, and the
 * managed browser takes tens of seconds and answers one run at a time.
 */
const REFRESH_COOLDOWN_MS = 60_000;
const NAVIGATION_TIMEOUT_MS = 60_000;
/**
 * Budget for the interstitial itself. It normally clears in seconds, but a site
 * that has just decided to re-challenge takes noticeably longer, and giving up
 * early turns a slow challenge into a permanent failure.
 */
const CHALLENGE_TIMEOUT_MS = 120_000;

type RefreshResult = {
  ok: boolean;
  cookieHeader?: string;
  userAgent?: string;
  message?: string;
};

const inflight = new Map<string, Promise<RefreshResult>>();
const lastAttemptAt = new Map<string, number>();

/** True when the body is Cloudflare's interstitial rather than the site's own answer. */
export function isCloudflareChallengeResponse(input: {
  contentType?: string | null;
  body?: string | null;
  mitigated?: string | null;
}): boolean {
  if ((input.mitigated || '').toLowerCase().includes('challenge')) return true;
  const contentType = (input.contentType || '').toLowerCase();
  const body = input.body || '';
  if (!body) return false;
  if (!contentType.includes('text/html')) return false;
  return (
    /just a moment/i.test(body)
    || /challenges\.cloudflare\.com/i.test(body)
    || /__cf_chl/i.test(body)
    || /cf-mitigated/i.test(body)
  );
}

function normalizeHostName(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Replaces `cf_clearance=` in a Cookie header, keeping the other pairs. */
function upsertClearanceCookie(cookieHeader: string | undefined, value: string): string {
  const pairs = (cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${CLEARANCE_COOKIE_NAME}=`));
  pairs.push(`${CLEARANCE_COOKIE_NAME}=${value}`);
  return pairs.join('; ');
}

async function findSiteByUrl(requestUrl: string) {
  const normalized = normalizeSiteUrl(requestUrl);
  if (!normalized) return null;
  const host = normalizeHostName(normalized);
  if (!host) return null;
  const rows = await db.select().from(schema.sites).all();
  let best: (typeof rows)[number] | null = null;
  for (const row of rows) {
    const rowHost = normalizeHostName(row.url);
    if (!rowHost) continue;
    if (host !== rowHost && !host.endsWith(`.${rowHost}`)) continue;
    if (!best || row.url.length > best.url.length) best = row;
  }
  return best;
}

async function persistClearance(site: { id: number; customHeaders: string | null }, cookieHeader: string, userAgent: string): Promise<void> {
  // The stored headers are normalized through `Headers` on read, so the keys are
  // already lowercase; writing the same shape keeps later merges predictable.
  const parsed = parseSiteCustomHeadersInput(site.customHeaders);
  const existing = parsed.valid ? (parsed.headers || {}) : {};
  const next: Record<string, string> = {
    ...existing,
    cookie: upsertClearanceCookie(existing.cookie, cookieHeader.replace(`${CLEARANCE_COOKIE_NAME}=`, '')),
    'user-agent': userAgent,
  };
  await db
    .update(schema.sites)
    .set({
      customHeaders: JSON.stringify(next),
      // Cloudflare binds the clearance to the User-Agent that earned it, and the
      // adapters send their own UA by default. Without site priority the fresh
      // pair is sent with the wrong UA and the challenge simply repeats.
      customHeadersOverrideRequestHeaders: true,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.sites.id, site.id))
    .run();
  invalidateSiteProxyCache();
}

async function runRefresh(siteUrl: string): Promise<RefreshResult> {
  const session = assistedLoginSessions.get('linuxdo');
  if (!session) return { ok: false, message: 'Linux.do 辅助登录会话未注册，无法过 Cloudflare 验证' };

  let context;
  try {
    context = await session.browser.ensureManagedBrowserContext();
  } catch (error) {
    return { ok: false, message: `无法启动受管浏览器：${(error as Error)?.message || '未知错误'}` };
  }

  const origin = new URL(siteUrl).origin;
  const page = await context.newPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    await passCloudflareChallenge(page, { timeoutMs: CHALLENGE_TIMEOUT_MS });
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const cookie = (await context.cookies(origin)).find((item) => item.name === CLEARANCE_COOKIE_NAME);
    const value = (cookie?.value || '').trim();
    if (!value) return { ok: false, message: '过验证后仍未取得 cf_clearance' };
    return { ok: true, cookieHeader: `${CLEARANCE_COOKIE_NAME}=${value}`, userAgent };
  } catch (error) {
    return { ok: false, message: `Cloudflare 验证失败：${(error as Error)?.message || '未知错误'}` };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * Re-clears `siteUrl` in the managed browser and stores the new clearance.
 *
 * Calls for the same host share one browser run, and a host that was refreshed
 * within the cooldown answers from the previous result instead of starting
 * another: a shield that keeps challenging must not turn every API call into a
 * browser run.
 */
export async function refreshCloudflareClearance(siteUrl: string): Promise<RefreshResult> {
  const host = normalizeHostName(siteUrl);
  if (!host) return { ok: false, message: '站点地址无效' };

  const existing = inflight.get(host);
  if (existing) return existing;

  const last = lastAttemptAt.get(host) || 0;
  if (Date.now() - last < REFRESH_COOLDOWN_MS) {
    return { ok: false, message: 'Cloudflare 验证冷却中，请稍后重试' };
  }
  lastAttemptAt.set(host, Date.now());

  const task = (async (): Promise<RefreshResult> => {
    const site = await findSiteByUrl(siteUrl);
    if (!site) return { ok: false, message: '未找到匹配的站点记录' };
    // The managed browser is shared with the login flows, so a shield that
    // re-challenges mid-burst must not open a second window alongside them.
    const result = await browserLane.run(() => runRefresh(site.url));
    if (result.ok && result.cookieHeader && result.userAgent) {
      await persistClearance(site, result.cookieHeader, result.userAgent);
    }
    return result;
  })();

  inflight.set(host, task);
  try {
    return await task;
  } finally {
    inflight.delete(host);
  }
}
