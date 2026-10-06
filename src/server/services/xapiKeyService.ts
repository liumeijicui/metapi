import type { Page, Response as BrowserResponse } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { db, schema } from '../db/index.js';
import { assistedLoginSessions } from './assistedLogin/sessionRegistry.js';
import { locateChallengeWidget, clickWithRealPointer, passCloudflareChallenge } from './assistedLogin/cloudflareChallenge.js';
import { ensureDefaultTokenForAccount } from './accountTokenService.js';
import { refreshModelsForAccount } from './modelService.js';

/**
 * X-API (x-api.cfd) hands out a conversation key that expires on its own:
 * the site voids a key that has been idle for `idleHours` (24 by default) and
 * only ever prints the plaintext once, at the moment of issuance. Daily manual
 * re-issuance is therefore the site's intended workflow, and it is what this
 * service automates.
 *
 * The signing step cannot be replayed over HTTP: `/auth/linuxdo/start` answers
 * `400 turnstile_required`, and the issuance dialog carries a second Turnstile.
 * Both are answered in the managed Linux.do browser profile — the same profile
 * that already holds the forum session the OAuth handshake needs — so the whole
 * flow runs in a real page instead of a request client.
 *
 * The site allows a single active key at a time ("已达有效 Key 上限"), so the
 * previous key is revoked right before the new one is signed; otherwise the
 * issue button stays disabled and nothing can be minted.
 */

const XAPI_HOSTS: readonly string[] = ['x-api.cfd'];
const KEYS_CONSOLE_PATH = '/console/keys';
const ME_PATH = '/api/me';
const KEYS_API_PATH = '/api/keys';
const ISSUE_BUTTON_TEXT = /^\s*签发\s*$/;
const CONFIRM_BUTTON_TEXT = /确认签发/;
const LOGIN_BUTTON_TEXT = /继续\s*Linux\s*Do\s*登录|使用\s*Linux\s*Do\s*登录/;
const AUTHORIZE_BUTTON_TEXT = /允许|授权|Authorize|Allow/i;
const RELOAD_CAPTCHA_TEXT = /重新加载验证/;
/** The issued key carries this prefix; anything else is not a key. */
const XAPI_KEY_PREFIX = 'xapi_';

const NAVIGATION_TIMEOUT_MS = 45_000;
const CAPTCHA_TIMEOUT_MS = 40_000;
const SIGN_IN_ROUNDS = 10;
const SIGN_IN_ROUND_SETTLE_MS = 4_000;
const CAPTCHA_SETTLE_MS = 5_000;
const ISSUE_RESPONSE_TIMEOUT_MS = 60_000;
/** extraConfig key remembering when the automation last minted a key. */
const ISSUED_AT_CONFIG_KEY = 'xapiKeyAutoIssuedAt';

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;

export type XApiKeyIssueResult = {
  ok: boolean;
  key: string | null;
  message: string;
  /** 本次作废掉的旧 Key id（站点只允许 1 个有效 Key）。 */
  revokedKeyIds: string[];
  /** 本次是否重新走了一遍 Linux.do 登录（会话还在时为 false）。 */
  signedIn: boolean;
};

export type XApiKeyTarget = {
  siteId: number;
  siteName: string;
  siteUrl: string;
  accountId: number;
  accountName: string;
};

export type XApiKeyRefreshSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  targets: number;
  issued: number;
  skipped: number;
  failed: number;
  /** 站点被删除/改平台后没有可刷目标时为 true：任务空转，不再打上游。 */
  idle: boolean;
  results: Array<{
    siteId: number;
    siteName: string;
    accountId: number;
    status: 'issued' | 'skipped' | 'failed';
    message: string;
  }>;
};

/** True when the URL is the X-API deployment (never a look-alike host). */
export function isXApiSiteUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    return XAPI_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

/** The platform name X-API is bound under, including the legacy alias. */
export function isXApiPlatform(platform: string | null | undefined): boolean {
  const normalized = (platform || '').trim().toLowerCase();
  return normalized === 'xapi' || normalized === 'x-api';
}

/**
 * Reads the one-time plaintext out of the issuance answer.
 *
 * The response is the only place the key ever exists in cleartext; a masked echo
 * or an empty body means nothing was minted, and reporting it as a key would
 * store a credential that can never work.
 */
export function parseIssuedXApiKey(bodyText: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const key = typeof (payload as { key?: unknown })?.key === 'string'
    ? ((payload as { key: string }).key).trim()
    : '';
  if (!key.startsWith(XAPI_KEY_PREFIX) || key.includes('*') || key.length <= XAPI_KEY_PREFIX.length) {
    return null;
  }
  return key;
}

/** Ids of keys that are still usable; revoked ones cannot be used or re-revoked. */
export function collectActiveXApiKeyIds(payload: unknown): string[] {
  const keys = (payload as { keys?: unknown })?.keys;
  if (!Array.isArray(keys)) return [];
  const ids: string[] = [];
  for (const entry of keys) {
    const record = entry as { id?: unknown; revoked_at?: unknown };
    const id = record?.id == null ? '' : String(record.id).trim();
    if (!id) continue;
    if (record?.revoked_at == null || record.revoked_at === '') ids.push(id);
  }
  return ids;
}

/**
 * Daily cadence: refresh once per day, on or after the configured hour.
 *
 * A key minted earlier today (by the scheduler or by hand) is left alone, so a
 * restart does not mint a second key and burn the site's one-active-key budget.
 */
export function isXApiKeyRefreshDue(
  lastIssuedAt: string | null | undefined,
  now: Date,
  refreshHour: number,
): boolean {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), refreshHour, 0, 0, 0);
  if (now.getTime() < today.getTime()) return false;
  if (!lastIssuedAt) return true;
  const parsed = Date.parse(lastIssuedAt);
  if (!Number.isFinite(parsed)) return true;
  return parsed < today.getTime();
}

/**
 * Picks the site/account pairs worth refreshing.
 *
 * Evaluated against the rows that exist *right now*, not a cached list: if the
 * site is deleted or re-platformed, the target set empties out and the daily job
 * has nothing to act on, which is what retires the task alongside the site.
 */
export function selectXApiKeyTargets(sites: SiteRow[], accounts: AccountRow[]): XApiKeyTarget[] {
  const targets: XApiKeyTarget[] = [];
  for (const site of sites) {
    if (site.status !== 'active') continue;
    if (!isXApiPlatform(site.platform) && !isXApiSiteUrl(site.url)) continue;
    const account = accounts.filter((row) => row.siteId === site.id).sort((a, b) => a.id - b.id)[0];
    if (!account) continue;
    targets.push({
      siteId: site.id,
      siteName: site.name,
      siteUrl: site.url,
      accountId: account.id,
      accountName: account.username || `account#${account.id}`,
    });
  }
  return targets;
}

export function readLastIssuedAt(extraConfig: string | null | undefined): string | null {
  try {
    const parsed = JSON.parse(extraConfig || '{}') as Record<string, unknown>;
    const value = parsed?.[ISSUED_AT_CONFIG_KEY];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

// --- browser flow -----------------------------------------------------------

type InPageJson = { status: number; payload: unknown; snippet: string };

async function readJsonInPage(page: Page, path: string): Promise<InPageJson> {
  return page
    .evaluate(async (requestPath: string) => {
      try {
        const res = await fetch(requestPath, { headers: { Accept: 'application/json' } });
        const text = await res.text();
        try {
          return { status: res.status, payload: JSON.parse(text), snippet: '' };
        } catch {
          return { status: res.status, payload: null, snippet: text.slice(0, 120) };
        }
      } catch (error) {
        return {
          status: 0,
          payload: null,
          snippet: (error instanceof Error ? error.message : String(error)).slice(0, 120),
        };
      }
    }, path)
    .catch(() => ({ status: 0, payload: null, snippet: '页面读取失败' }));
}

async function postJsonInPage(page: Page, path: string, body: unknown): Promise<InPageJson> {
  return page
    .evaluate(async (input: { path: string; body: unknown }) => {
      try {
        const res = await fetch(input.path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input.body ?? {}),
        });
        const text = await res.text();
        try {
          return { status: res.status, payload: JSON.parse(text), snippet: '' };
        } catch {
          return { status: res.status, payload: null, snippet: text.slice(0, 120) };
        }
      } catch (error) {
        return {
          status: 0,
          payload: null,
          snippet: (error instanceof Error ? error.message : String(error)).slice(0, 120),
        };
      }
    }, { path, body })
    .catch(() => ({ status: 0, payload: null, snippet: '页面请求失败' }));
}

/**
 * Drives the page until `/api/me` answers 200.
 *
 * The console answers an anonymous visitor with a login gate, and the gate is
 * itself gated by a Turnstile; both the gate and Cloudflare's consent-page
 * interstitial are answered in turn, so the loop reacts to whichever one is on
 * screen instead of assuming a fixed order.
 */
async function ensureSignedIn(page: Page, keepAlive: () => void): Promise<boolean> {
  for (let round = 1; round <= SIGN_IN_ROUNDS; round += 1) {
    keepAlive();
    const me = await readJsonInPage(page, ME_PATH);
    if (me.status === 200) return true;

    await passCloudflareChallenge(page, { timeoutMs: CAPTCHA_TIMEOUT_MS }).catch(() => undefined);

    const authorize = page.locator('button, a, input[type=submit]').filter({ hasText: AUTHORIZE_BUTTON_TEXT }).first();
    if (await authorize.count().catch(() => 0)) {
      await authorize.click({ timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(SIGN_IN_ROUND_SETTLE_MS);
      continue;
    }

    const login = page.locator('button, a').filter({ hasText: LOGIN_BUTTON_TEXT }).first();
    if (await login.count().catch(() => 0)) {
      if (await login.isEnabled().catch(() => false)) {
        await login.click({ timeout: 20_000 }).catch(() => undefined);
        await page.waitForTimeout(SIGN_IN_ROUND_SETTLE_MS);
        continue;
      }
    }

    const widget = await locateChallengeWidget(page);
    if (widget) {
      keepAlive();
      await clickWithRealPointer(page, widget).catch(() => undefined);
      await page.waitForTimeout(CAPTCHA_SETTLE_MS);
      continue;
    }

    const reload = page.locator('button, a').filter({ hasText: RELOAD_CAPTCHA_TEXT }).first();
    if (await reload.count().catch(() => 0)) {
      await reload.click({ timeout: 15_000 }).catch(() => undefined);
    }

    await page.waitForTimeout(SIGN_IN_ROUND_SETTLE_MS);
  }
  return (await readJsonInPage(page, ME_PATH)).status === 200;
}

/** Waits for the issuance POST and returns its raw body. */
function captureIssueResponse(page: Page): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      page.off('response', onResponse);
      resolve(null);
    }, ISSUE_RESPONSE_TIMEOUT_MS);
    timeout.unref?.();

    const onResponse = (response: BrowserResponse): void => {
      if (response.request().method() !== 'POST') return;
      let pathname = '';
      try {
        pathname = new URL(response.url()).pathname;
      } catch {
        return;
      }
      if (pathname !== KEYS_API_PATH) return;
      clearTimeout(timeout);
      page.off('response', onResponse);
      void response.text().then((body) => resolve(body)).catch(() => resolve(null));
    };
    page.on('response', onResponse);
  });
}

async function clickFirst(page: Page, text: RegExp, timeoutMs: number): Promise<boolean> {
  const target = page.locator('button, a').filter({ hasText: text }).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await target.count().catch(() => 0)) {
      if (await target.isEnabled().catch(() => false) && await target.isVisible().catch(() => false)) {
        await target.click({ timeout: 15_000 }).catch(() => undefined);
        return true;
      }
    }
    await page.waitForTimeout(1_000);
  }
  return false;
}

/**
 * Signs a fresh key in the managed browser and returns its plaintext.
 *
 * The plaintext never leaves this function except through its return value: it is
 * never logged, and a failure reports why instead of echoing a half-finished key.
 */
export async function issueXApiKeyForSite(input: {
  siteUrl: string;
  siteLabel?: string;
}): Promise<XApiKeyIssueResult> {
  const label = input.siteLabel || input.siteUrl;
  if (!isXApiSiteUrl(input.siteUrl)) {
    return { ok: false, key: null, message: `仅允许对 X-API 站点执行自动签发（${label}）`, revokedKeyIds: [], signedIn: false };
  }
  const session = assistedLoginSessions.get('linuxdo');
  if (!session) {
    return { ok: false, key: null, message: 'Linux.do 辅助登录会话未注册', revokedKeyIds: [], signedIn: false };
  }

  let context;
  try {
    context = await session.browser.ensureManagedBrowserContext();
  } catch (error) {
    return {
      ok: false,
      key: null,
      message: `无法启动受管浏览器：${describeError(error)}`,
      revokedKeyIds: [],
      signedIn: false,
    };
  }

  const keepAlive = () => session.browser.keepAlive();
  const origin = new URL(input.siteUrl).origin;
  const page = await context.newPage();
  try {
    await page.goto(`${origin}${KEYS_CONSOLE_PATH}`, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    const signedIn = await ensureSignedIn(page, keepAlive);
    if (!signedIn) {
      return {
        ok: false,
        key: null,
        message: 'X-API 未登录（Linux.do 快捷登录没走完）',
        revokedKeyIds: [],
        signedIn: false,
      };
    }

    // The site keeps one active key: revoke the current one, then reload so the
    // console recalculates the cap and re-enables the issue button.
    const listing = await readJsonInPage(page, `${KEYS_API_PATH}?page=1&page_size=50`);
    const activeKeyIds = collectActiveXApiKeyIds(listing.payload);
    const revokedKeyIds: string[] = [];
    for (const keyId of activeKeyIds) {
      keepAlive();
      const revoked = await postJsonInPage(page, `${KEYS_API_PATH}/${encodeURIComponent(keyId)}/revoke`, {});
      if (revoked.status >= 200 && revoked.status < 300) revokedKeyIds.push(keyId);
    }
    if (revokedKeyIds.length > 0) {
      await page.goto(`${origin}${KEYS_CONSOLE_PATH}`, {
        waitUntil: 'domcontentloaded',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      await page.waitForTimeout(2_000);
    }

    const responseBody = captureIssueResponse(page);
    keepAlive();
    if (!await clickFirst(page, ISSUE_BUTTON_TEXT, 30_000)) {
      return {
        ok: false,
        key: null,
        message: '未找到可用的「签发」按钮（站点仍认为已达有效 Key 上限？）',
        revokedKeyIds,
        signedIn: true,
      };
    }

    // The dialog's own Turnstile has to be answered before the confirm button
    // unlocks; the widget lives in the page's frame list, same as the login one.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      keepAlive();
      if (await confirmEnabled(page)) break;
      const widget = await locateChallengeWidget(page);
      if (widget) {
        await clickWithRealPointer(page, widget).catch(() => undefined);
        await page.waitForTimeout(CAPTCHA_SETTLE_MS);
        continue;
      }
      await page.waitForTimeout(2_000);
    }

    if (!await confirmEnabled(page)) {
      return {
        ok: false,
        key: null,
        message: '签发对话框的人机验证没有通过，未能确认签发',
        revokedKeyIds,
        signedIn: true,
      };
    }
    await clickFirst(page, CONFIRM_BUTTON_TEXT, 20_000);

    const body = await responseBody;
    const key = body ? parseIssuedXApiKey(body) : null;
    if (!key) {
      return {
        ok: false,
        key: null,
        message: '签发请求没有返回明文密钥',
        revokedKeyIds,
        signedIn: true,
      };
    }
    return { ok: true, key, message: 'X-API 密钥已自动签发', revokedKeyIds, signedIn: true };
  } catch (error) {
    return {
      ok: false,
      key: null,
      message: `自动签发失败：${describeError(error)}`,
      revokedKeyIds: [],
      signedIn: false,
    };
  } finally {
    keepAlive();
    await page.close().catch(() => undefined);
  }
}

async function confirmEnabled(page: Page): Promise<boolean> {
  const confirm = page.locator('button, a').filter({ hasText: CONFIRM_BUTTON_TEXT }).first();
  if (!(await confirm.count().catch(() => 0))) return false;
  return confirm.isEnabled().catch(() => false);
}

// --- persistence ------------------------------------------------------------

/**
 * Stores a freshly minted key as the account's default credential.
 *
 * The site voids the predecessor, so every other token this account still holds
 * is provably dead. They are disabled rather than deleted: the router ignores
 * them, and the row history stays auditable.
 */
export async function persistIssuedXApiKey(accountId: number, key: string): Promise<void> {
  const tokenId = await ensureDefaultTokenForAccount(accountId, key, {
    name: 'metapi',
    source: 'xapi-auto',
    tokenGroup: 'default',
  });
  const now = new Date().toISOString();
  if (tokenId != null) {
    const rows = await db.select().from(schema.accountTokens).all();
    for (const row of rows) {
      if (row.accountId !== accountId || row.id === tokenId || !row.enabled) continue;
      if (row.token === key) continue;
      await db.update(schema.accountTokens)
        .set({ enabled: false, updatedAt: now })
        .where(eq(schema.accountTokens.id, row.id))
        .run();
    }
  }
  await patchExtraConfig(accountId, ISSUED_AT_CONFIG_KEY, now);
}

async function patchExtraConfig(accountId: number, key: string, value: unknown): Promise<void> {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  if (!account) return;
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(account.extraConfig || '{}') as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed[key] = value;
  await db.update(schema.accounts)
    .set({ extraConfig: JSON.stringify(parsed), updatedAt: new Date().toISOString() })
    .where(eq(schema.accounts.id, accountId))
    .run();
}

// --- daily refresh ----------------------------------------------------------

async function loadXApiKeyTargets(): Promise<XApiKeyTarget[]> {
  const sites = await db.select().from(schema.sites).all();
  const accounts = await db.select().from(schema.accounts).all();
  return selectXApiKeyTargets(sites, accounts);
}

async function loadLastIssuedAt(accountId: number): Promise<string | null> {
  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
  return readLastIssuedAt(account?.extraConfig);
}

export type XApiKeyRefreshDeps = {
  loadTargets: () => Promise<XApiKeyTarget[]>;
  loadLastIssuedAt: (accountId: number) => Promise<string | null>;
  issueKey: (target: XApiKeyTarget) => Promise<XApiKeyIssueResult>;
  persistKey: (target: XApiKeyTarget, key: string) => Promise<void>;
  refreshModels: (target: XApiKeyTarget) => Promise<void>;
  now: () => Date;
  log: (message: string) => void;
};

const defaultDeps: XApiKeyRefreshDeps = {
  loadTargets: loadXApiKeyTargets,
  loadLastIssuedAt,
  issueKey: (target) => issueXApiKeyForSite({ siteUrl: target.siteUrl, siteLabel: target.siteName }),
  persistKey: (target, key) => persistIssuedXApiKey(target.accountId, key),
  refreshModels: async (target) => {
    await refreshModelsForAccount(target.accountId, { allowInactive: true });
  },
  now: () => new Date(),
  log: (message) => console.log(message),
};

/**
 * One refresh pass: for every bound X-API site, mint today's key.
 *
 * A site that has been deleted, disabled or re-platformed simply stops appearing
 * in `loadTargets()`, so nothing is contacted on its behalf — the task retires
 * with the site instead of pointing at an address that no longer belongs to it.
 */
export async function refreshXApiKeys(
  overrides: Partial<XApiKeyRefreshDeps> = {},
): Promise<XApiKeyRefreshSummary> {
  const deps: XApiKeyRefreshDeps = { ...defaultDeps, ...overrides };
  const startedMs = Date.now();
  const startedAt = deps.now().toISOString();
  const summary: XApiKeyRefreshSummary = {
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
    targets: 0,
    issued: 0,
    skipped: 0,
    failed: 0,
    idle: false,
    results: [],
  };

  const targets = await deps.loadTargets();
  summary.targets = targets.length;
  if (targets.length === 0) {
    summary.idle = true;
    deps.log('[Scheduler] X-API key refresh idle: no x-api site bound');
    summary.finishedAt = deps.now().toISOString();
    summary.durationMs = Date.now() - startedMs;
    return summary;
  }

  for (const target of targets) {
    const lastIssuedAt = await deps.loadLastIssuedAt(target.accountId);
    if (!isXApiKeyRefreshDue(lastIssuedAt, deps.now(), config.xapiKeyRefreshHour)) {
      summary.skipped += 1;
      summary.results.push({
        siteId: target.siteId,
        siteName: target.siteName,
        accountId: target.accountId,
        status: 'skipped',
        message: '今天已经签过，跳过',
      });
      continue;
    }

    const issued = await deps.issueKey(target);
    if (!issued.ok || !issued.key) {
      summary.failed += 1;
      summary.results.push({
        siteId: target.siteId,
        siteName: target.siteName,
        accountId: target.accountId,
        status: 'failed',
        message: issued.message,
      });
      continue;
    }

    try {
      await deps.persistKey(target, issued.key);
      await deps.refreshModels(target).catch(() => undefined);
      summary.issued += 1;
      summary.results.push({
        siteId: target.siteId,
        siteName: target.siteName,
        accountId: target.accountId,
        status: 'issued',
        message: `${issued.message}（作废旧 Key ${issued.revokedKeyIds.length} 个）`,
      });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({
        siteId: target.siteId,
        siteName: target.siteName,
        accountId: target.accountId,
        status: 'failed',
        message: `密钥保存失败：${describeError(error)}`,
      });
    }
  }

  summary.finishedAt = deps.now().toISOString();
  summary.durationMs = Date.now() - startedMs;
  return summary;
}

// --- scheduler --------------------------------------------------------------

export type XApiKeySchedulerState = {
  enabled: boolean;
  refreshHour: number;
  running: boolean;
  skippedRuns: number;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
};

const SCHEDULER_TICK_MS = 10 * 60 * 1000;

let schedulerTimer: NodeJS.Timeout | null = null;
let runInFlight: Promise<XApiKeyRefreshSummary> | null = null;
let lastRunStartedAtIso: string | null = null;
let lastRunFinishedAtIso: string | null = null;
let skippedRuns = 0;

export function isXApiKeyRefreshRunning(): boolean {
  return runInFlight !== null;
}

export function runXApiKeyRefresh(): Promise<XApiKeyRefreshSummary> {
  if (runInFlight) return runInFlight;
  const startedAtIso = new Date().toISOString();
  lastRunStartedAtIso = startedAtIso;
  runInFlight = refreshXApiKeys()
    .catch((error: unknown) => {
      console.error('[Scheduler] X-API key refresh error:', error);
      const nowIso = new Date().toISOString();
      return {
        startedAt: startedAtIso,
        finishedAt: nowIso,
        durationMs: Date.parse(nowIso) - Date.parse(startedAtIso),
        targets: 0,
        issued: 0,
        skipped: 0,
        failed: 1,
        idle: false,
        results: [],
      } satisfies XApiKeyRefreshSummary;
    })
    .finally(() => {
      lastRunFinishedAtIso = new Date().toISOString();
      runInFlight = null;
    });
  return runInFlight;
}

export function startXApiKeyScheduler(): XApiKeySchedulerState {
  stopXApiKeyScheduler();
  if (!config.xapiKeyEnabled) {
    console.log('[Scheduler] X-API key refresh disabled (XAPI_KEY_ENABLED=false)');
    return getXApiKeySchedulerState();
  }

  const tick = () => {
    if (isXApiKeyRefreshRunning()) {
      skippedRuns += 1;
      console.log(`[Scheduler] X-API key refresh skipped: previous run still in flight (skipped=${skippedRuns})`);
      return;
    }
    if (!isXApiKeyRefreshDue(lastRunFinishedAtIso, new Date(), config.xapiKeyRefreshHour)) return;
    void runXApiKeyRefresh().then((summary) => {
      console.log(
        `[Scheduler] X-API key refresh complete: targets=${summary.targets} issued=${summary.issued} `
        + `skipped=${summary.skipped} failed=${summary.failed} in ${summary.durationMs}ms`
        + (summary.idle ? ' (idle)' : ''),
      );
    });
  };

  tick();
  schedulerTimer = setInterval(tick, SCHEDULER_TICK_MS);
  schedulerTimer.unref?.();
  return getXApiKeySchedulerState();
}

export function stopXApiKeyScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export function getXApiKeySchedulerState(): XApiKeySchedulerState {
  return {
    enabled: config.xapiKeyEnabled,
    refreshHour: config.xapiKeyRefreshHour,
    running: isXApiKeyRefreshRunning(),
    skippedRuns,
    lastRunStartedAt: lastRunStartedAtIso,
    lastRunFinishedAt: lastRunFinishedAtIso,
  };
}

export function __resetXApiKeyStateForTests(): void {
  stopXApiKeyScheduler();
  runInFlight = null;
  lastRunStartedAtIso = null;
  lastRunFinishedAtIso = null;
  skippedRuns = 0;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 160) || '未知错误';
}
