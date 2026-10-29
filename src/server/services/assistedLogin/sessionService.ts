import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { createManagedBrowser } from './browserManager.js';
import { passCloudflareChallenge } from './cloudflareChallenge.js';
import { buildEntryLocator } from './entryMatch.js';
import { captureHyperGithubCredentials, supportsHyperGithubLogin } from './sites/hyper.js';
import { pipiImageHintsFor } from './sites/pipiImageSite.js';
import type {
  AssistedLoginProvider,
  CaptureResult,
  CapturedCredentials,
  LoginState,
  StorageCredentialHints,
} from './types.js';

const NAVIGATION_TIMEOUT_MS = 45_000;
const CONSENT_TIMEOUT_MS = 20_000;
/**
 * SPA panels mount their provider buttons after hydration, so the entry click
 * has to outlast the first paint instead of sampling it once.
 */
const ENTRY_TIMEOUT_MS = 15_000;
/** The login dialog is already open on the retry pass, so it needs less slack. */
const ENTRY_DIALOG_TIMEOUT_MS = 10_000;
/** Number of unlock+click rounds; the gate may appear after the first paint. */
const ENTRY_CLICK_ATTEMPTS = 3;
/** How long to wait for a gated entry to mount before ticking the agreement box. */
const AGREEMENT_WAIT_TIMEOUT_MS = 20_000;
const TOKEN_WAIT_TIMEOUT_MS = 40_000;

const ACCESS_TOKEN_KEYS = ['auth_token', 'access_token', 'token', 'jwt', 'jwt_token'];

/**
 * Cookie names that can plausibly hold a login session. The manager polls every
 * open tab, and the provider probe tab also carries cookies, so a loose
 * substring match would happily return the provider's own session cookie as if
 * it were the target site's credential.
 */
const SESSION_COOKIE_NAMES = new Set([
  'session',
  'token',
  'auth_token',
  'access_token',
  'jwt',
  'jwt_token',
  // Newer new-api deployments keep only this refresh cookie in the browser;
  // the access token itself never lands in storage.
  'new_api_refresh',
]);

/** Short values are almost always flags or CSRF nonces, not real credentials. */
const MIN_CREDENTIAL_LENGTH = 12;

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeUserId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  const parsed = Number.parseInt(typeof value === "string" ? value.trim() : '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return '';
  }
}

function storageLookup(records: Array<[string, string]>): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const [rawKey, rawValue] of records) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (key && value && !lookup.has(key)) lookup.set(key, value);
  }
  return lookup;
}

/** Reads the site's numeric user id, preferring the stored user object. */
function extractStoredUserId(
  records: Array<[string, string]>,
  hints?: StorageCredentialHints | null,
): number | null {
  const lookup = storageLookup(records);
  const userRaw = lookup.get('auth_user') || lookup.get('user') || firstPresent(lookup, hints?.userKeys) || '';
  if (userRaw) {
    try {
      const parsedUser = JSON.parse(userRaw) as Record<string, unknown>;
      const fromUser = normalizeUserId(parsedUser?.id ?? parsedUser?.user_id);
      if (fromUser !== null) return fromUser;
    } catch {
      // fall through to the bare uid key
    }
  }
  return normalizeUserId(lookup.get('uid') || firstPresent(lookup, hints?.uidKeys));
}

/** First non-empty value among the given storage keys, in declaration order. */
function firstPresent(lookup: Map<string, string>, keys?: string[]): string {
  for (const key of keys || []) {
    const value = lookup.get(key.trim().toLowerCase());
    if (value) return value;
  }
  return '';
}

/** Reads the display name from the stored user object, when present. */
function extractStoredUsername(
  records: Array<[string, string]>,
  hints?: StorageCredentialHints | null,
): string | null {
  const lookup = storageLookup(records);
  const userRaw = lookup.get('auth_user') || lookup.get('user') || firstPresent(lookup, hints?.userKeys) || '';
  if (!userRaw) return null;
  try {
    const parsedUser = JSON.parse(userRaw) as Record<string, unknown>;
    return normalizeText(parsedUser?.username)
      || normalizeText(parsedUser?.email)
      || normalizeText(parsedUser?.nickname)
      || normalizeText(parsedUser?.name)
      || null;
  } catch {
    // A site may store a bare display name instead of a JSON user object.
    const bare = userRaw.trim();
    return hints?.userKeys?.length ? (bare || null) : null;
  }
}

function withFlowLock<T>(state: { current: Promise<unknown> }, task: () => Promise<T>): Promise<T> {
  const run = state.current.then(task, task);
  state.current = run.catch(() => undefined);
  return run;
}

/**
 * Pulls a credential bundle out of the site's own storage. Exported so the exact
 * key-preference rules stay unit-testable without a browser.
 */
export function pickTokenFromRecords(
  records: Array<[string, string]>,
  hints?: StorageCredentialHints | null,
): CapturedCredentials | null {
  const lookup = new Map<string, string>();
  for (const [rawKey, rawValue] of records) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (key && value && !lookup.has(key)) lookup.set(key, value);
  }

  const accessKey = [...ACCESS_TOKEN_KEYS, ...(hints?.tokenKeys || [])]
    .find((candidate) => lookup.has(candidate.trim().toLowerCase()));
  const accessToken = accessKey ? lookup.get(accessKey) || '' : '';
  if (!accessToken) return null;

  const refreshToken = lookup.get('refresh_token') || null;
  const expiresRaw = lookup.get('token_expires_at') || lookup.get('expires_at') || '';
  const parsedExpires = Number.parseInt(expiresRaw, 10);
  const tokenExpiresAt = Number.isFinite(parsedExpires) && parsedExpires > 0 ? parsedExpires : null;

  let username: string | null = null;
  let platformUserId: number | null = null;
  const userRaw = lookup.get('auth_user') || lookup.get('user') || firstPresent(lookup, hints?.userKeys) || '';
  if (userRaw) {
    try {
      const parsedUser = JSON.parse(userRaw) as Record<string, unknown>;
      username = normalizeText(parsedUser?.username)
        || normalizeText(parsedUser?.email)
        || normalizeText(parsedUser?.nickname)
        || normalizeText(parsedUser?.name)
        || null;
      platformUserId = normalizeUserId(parsedUser?.id ?? parsedUser?.user_id);
    } catch {
      username = extractStoredUsername(records, hints);
    }
  }
  if (platformUserId === null) {
    platformUserId = normalizeUserId(lookup.get('uid') || firstPresent(lookup, hints?.uidKeys));
  }

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt,
    username,
    platformUserId,
    source: 'localStorage',
    harvestedKeys: records.map(([key]) => key),
  };
}

/** The cookie a newer new-api fork keeps as its only durable credential. */
const REFRESH_COOKIE_NAME = 'new_api_refresh';

function isUsableCookie(cookie: { name?: string; value?: string }): boolean {
  return (cookie.value || '').trim().length >= MIN_CREDENTIAL_LENGTH;
}

/**
 * Turns a site's cookie jar into the credential an account row can send.
 *
 * Some sites (e.g. SnowAPI) gate the management API behind a shield that checks
 * the whole jar, so every site-scoped cookie is preserved rather than only the
 * session one. The site's user id lives only in storage, not in a cookie, so it
 * is read here too; without it a `New-Api-User`-style header is missing and the
 * site rejects the credential with 401.
 */
function buildCookieCredential(
  cookies: Array<{ name: string; value: string }>,
  records: Array<[string, string]>,
  hints?: StorageCredentialHints | null,
): CapturedCredentials {
  return {
    accessToken: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    refreshToken: null,
    tokenExpiresAt: null,
    username: extractStoredUsername(records, hints),
    platformUserId: extractStoredUserId(records, hints),
    source: 'cookie',
    harvestedKeys: cookies.map((cookie) => cookie.name),
  };
}

/**
 * Picks the credential to keep when a sign-in left more than one behind.
 *
 * The order is not cosmetic. A newer new-api fork hands the browser a rotatable
 * `new_api_refresh` cookie *and* a 15-minute access JWT, and the JWT is the one
 * the site's own dashboard can reach — so a storage-first harvest stores the
 * JWT, the account signs in again every quarter hour, and every one of those
 * sign-ins mints another server-side session. On a fork that caps concurrent
 * sessions the account then locks itself out with `AUTH_SESSION_LIMIT` — and
 * the operator cannot even log in to clear the list, because the refusal is the
 * login itself. The cookie outlives the JWT by weeks and is exchangeable for
 * access tokens, so it wins whenever it is there.
 */
export function selectHarvestedCredential(input: {
  records: Array<[string, string]>;
  cookies: Array<{ name: string; value: string }>;
  storageHints?: StorageCredentialHints | null;
}): CapturedCredentials | null {
  const { records, storageHints } = input;
  const cookies = input.cookies.filter(isUsableCookie);

  if (cookies.some((cookie) => cookie.name.trim().toLowerCase() === REFRESH_COOKIE_NAME)) {
    return buildCookieCredential(cookies, records, storageHints);
  }

  const fromStorage = pickTokenFromRecords(records, storageHints);
  if (fromStorage) return fromStorage;

  if (cookies.some((cookie) => SESSION_COOKIE_NAMES.has(cookie.name.trim().toLowerCase()))) {
    return buildCookieCredential(cookies, records, storageHints);
  }

  return null;
}

export function createAssistedLoginSession(input: {
  provider: AssistedLoginProvider;
  profileDirName: string;
  executableEnvVar: string;
  missingBrowserMessage: (platform: NodeJS.Platform) => string;
  watchStateSettingKey: string;
  watchEnabledSettingKey: string;
}) {
  const { provider } = input;
  const browser = createManagedBrowser({
    profileDirName: input.profileDirName,
    executableEnvVar: input.executableEnvVar,
    missingBrowserMessage: input.missingBrowserMessage,
  });

  const flowLock = { current: Promise.resolve() as Promise<unknown> };
  let probePage: import('playwright-core').Page | null = null;
  let sitePage: import('playwright-core').Page | null = null;

  async function settle(page: import('playwright-core').Page, timeoutMs = 6_000): Promise<void> {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
    } catch {
      // ignore: some SPAs never fire domcontentloaded again
    }
    try {
      await page.waitForTimeout(1_200);
    } catch {
      // ignore
    }
  }

  /**
   * A just-launched browser can fail its first navigation (still warming up), and
   * an edge provider may also answer with an HTTP error on a cold profile.
   * Retrying a few times keeps the very first status call from reporting a
   * misleading error.
   */
  async function navigateWithRetry(page: import('playwright-core').Page, url: string, attempts = 3): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
        return;
      } catch (error) {
        lastError = error;
        await page.waitForTimeout(2_000 + attempt * 2_000).catch(() => undefined);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * The managed Chrome window is shared across purposes, so each concern owns a
   * dedicated tab. Reusing one tab for both the provider session probe and a
   * target-site flow would let one navigation clobber the other.
   */
  async function getSitePage(context: import('playwright-core').BrowserContext) {
    if (sitePage && !sitePage.isClosed()) return sitePage;
    const reusable = context.pages().find(
      (candidate) => !candidate.isClosed() && candidate !== probePage && candidate.url() === 'about:blank',
    );
    const page = reusable ?? (await context.newPage());
    page.on('close', () => {
      if (sitePage === page) sitePage = null;
    });
    sitePage = page;
    return page;
  }

  async function getProbePage(context: import('playwright-core').BrowserContext) {
    if (probePage && !probePage.isClosed()) return probePage;
    const page = await context.newPage();
    page.on('close', () => {
      if (probePage === page) probePage = null;
    });
    probePage = page;
    return page;
  }

  async function getLoginState(): Promise<LoginState> {
    const context = await browser.ensureManagedBrowserContext();
    const page = await getProbePage(context);
    try {
      await navigateWithRetry(page, `${provider.origin}/`);
      await page.waitForTimeout(2_500);
      return await provider.probeLoginState(page);
    } catch (error) {
      return {
        loggedIn: false,
        username: null,
        userId: null,
        blocked: true,
        message: (error as Error)?.message || `无法读取 ${provider.label} 登录状态`,
      };
    }
  }

  async function openLoginWindow(): Promise<{ url: string }> {
    const context = await browser.ensureManagedBrowserContext();
    const page = await getProbePage(context);
    await page.bringToFront().catch(() => undefined);
    const loginUrl = `${provider.origin}${provider.loginPath}`;
    await navigateWithRetry(page, loginUrl).catch(() => undefined);
    return { url: page.url() || loginUrl };
  }

  async function harvestFromPage(
    page: import('playwright-core').Page,
    storageHints?: StorageCredentialHints | null,
  ): Promise<CapturedCredentials | null> {
    // Provider pages (the Linux.do / GitHub handoff and its parked probe tab)
    // store the provider's own session, never a target-site credential.
    const pageHost = safeHost(page.url());
    if (!pageHost || provider.isHandoffHost(pageHost)) return null;

    let records: Array<[string, string]> = [];
    try {
      records = await page.evaluate(() => {
        const entries: Array<[string, string]> = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (!key) continue;
          entries.push([key, window.localStorage.getItem(key) || '']);
        }
        return entries;
      });
    } catch {
      records = [];
    }

    try {
      const context = page.context();
      // Query every cookie the context holds rather than only those visible to
      // the current URL: a refresh cookie is commonly scoped to the auth path
      // (e.g. `/api/user/auth`), so a page-URL lookup would never see it.
      const allCookies = await context.cookies();
      const host = safeHost(page.url());

      // Cookies must belong to the site being captured. The managed browser
      // keeps several sites open at once, so matching against the whole jar
      // would happily return another site's credential as this site's.
      const cookies = allCookies.filter((cookie) => {
        const domain = (cookie.domain || '').replace(/^\./, '').toLowerCase();
        if (!domain) return false;
        if (!host) return true;
        return host === domain || host.endsWith(`.${domain}`);
      });

      return selectHarvestedCredential({ records, cookies, storageHints });
    } catch {
      // Reading the jar can fail on a context that is closing. Storage alone
      // still tells us whether this page holds a token worth keeping.
      return pickTokenFromRecords(records, storageHints);
    }
  }

  /**
   * Candidate login routes. Deployments disagree on the name (`/login` vs
   * `/sign-in`), so the caller walks this list rather than betting on one.
   */
  function buildLoginUrls(siteUrl: string): string[] {
    const trimmed = siteUrl.replace(/\/+$/, '');
    if (/\/(login|sign-in|signin)$/i.test(trimmed)) return [trimmed];
    return [`${trimmed}/sign-in`, `${trimmed}/signin`, `${trimmed}/login`];
  }

  /**
   * Waits for a locator to appear, then clicks it.
   *
   * `locator.isVisible({ timeout })` does NOT wait: Playwright ignores the option
   * and answers immediately. The previous code relied on it, so it raced SPA
   * hydration and reported "login entry not found" on every site whose button
   * renders a moment after load - which is most community relay panels.
   *
   * The wait is on "some copy is visible", not "the first copy is visible".
   * Panels that serve both a mobile and a desktop shell ship two copies of the
   * same button and hide the unused one with `display: none`; `first()` resolves
   * in DOM order, so it kept picking the hidden copy and every wait timed out
   * while a perfectly clickable button sat further down the page (皮皮智绘).
   */
  async function clickWhenVisible(
    locator: import('playwright-core').Locator,
    timeoutMs: number,
  ): Promise<boolean> {
    const target = locator.filter({ visible: true }).first();
    try {
      await target.waitFor({ state: 'visible', timeout: timeoutMs });
    } catch {
      return false;
    }
    // A visible but disabled control never accepts a click, and waiting out the
    // click timeout just wastes the caller's budget. Sites that gate their OAuth
    // buttons behind an agreement checkbox render them exactly like this.
    try {
      const blocked = await target.evaluate(
        (el) =>
          el.getAttribute('aria-disabled') === 'true' ||
          (el as HTMLButtonElement).disabled === true,
      );
      if (blocked) return false;
    } catch {
      // A detached or non-evaluable node still gets a normal click attempt.
    }
    try {
      await target.click({ timeout: 5_000 });
      return true;
    } catch {
      // Playwright refuses a click when anything covers the control, and SPA
      // panels leave such overlays behind by accident: anyrouter.top renders an
      // empty <p> across its "Continue with LinuxDO" button, so the click timed
      // out and the site was reported as having no provider entry at all. The
      // page itself is happy to act on the click, so dispatch it through the DOM
      // as a last resort instead of treating a layout bug as a missing entry.
      return await target
        .evaluate((el) => {
          (el as HTMLElement).click();
          return true;
        })
        .catch(() => false);
    }
  }
  /**
   * Opens the site's own login dialog.
   *
   * Most community relays hide the provider buttons behind a generic "登录"
   * trigger that opens a modal. Without this step the OAuth entry is simply not in
   * the DOM yet, and every such site was reported as having no provider entry.
   */
  async function openLoginDialog(page: import('playwright-core').Page): Promise<boolean> {
    const triggers = [
      page.getByRole('button', { name: /^(登录|登入|登陆|Login|Sign in|Sign-in|登 录)$/i }),
      page.getByRole('link', { name: /^(登录|登入|登陆|Login|Sign in|Sign-in)$/i }),
      page.locator('button:has-text("登录")'),
      page.locator('a:has-text("登录")'),
      page.locator('button:has-text("Login")'),
      page.locator('a:has-text("Login")'),
      page.locator('button:has-text("Sign in")'),
      page.locator('a:has-text("Sign in")'),
    ];
    for (const locator of triggers) {
      if (await clickWhenVisible(locator, 3_000)) {
        await settle(page, 2_500);
        await passLoginSecurityVerification(page);
        return true;
      }
    }
    return false;
  }

  /**
   * Clears the Cloudflare interstitial some sites put between the login button
   * and the login form.
   *
   * 皮皮智绘 answers the click with `/api/v1/security/verify?action=login` - a
   * Turnstile page with no links or buttons of its own. Nothing on it matches an
   * OAuth entry, so the capture used to report "没有找到 Linux.do 登录入口" while
   * the site was simply waiting to be let through. The widget is answered with a
   * real pointer click (the same helper the consent page uses) and the page then
   * redirects to the form on its own.
   */
  async function passLoginSecurityVerification(page: import('playwright-core').Page): Promise<void> {
    if (!/\/security\/verify/i.test(page.url())) return;
    await passCloudflareChallenge(page);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && /\/security\/verify/i.test(page.url())) {
      await page.waitForTimeout(1_000).catch(() => undefined);
    }
    await settle(page, 1_500);
  }

  /** Entry locator; the shape matching and the content-link filter live in `entryMatch`. */
  function entryLocator(page: import('playwright-core').Page): import('playwright-core').Locator {
    return buildEntryLocator(page, provider);
  }

  /**
   * Ticks one unchecked agreement box on the page.
   *
   * Returns `null` when there is nothing to tick, so the caller can tell "no
   * gate here" apart from "the gate refused to open".
   *
   * `termsOnly` drops the last-resort fallback. It is set whenever the provider
   * entry is *enabled*, because that is exactly the case where an unrelated
   * "remember me" box would otherwise be flipped for no reason.
   */
  async function tickConsentBox(
    page: import('playwright-core').Page,
    termsOnly: boolean,
  ): Promise<boolean | null> {
    // The callback is passed as source text on purpose. A real function is run
    // through the TS transpiler, which rewrites nested arrow functions into
    // `__name(...)`-wrapped ones; that helper only exists in the server bundle,
    // so the browser would throw `__name is not defined` and the unlock would
    // silently never happen.
    const result = await page.evaluate(`
      (() => {
        const termsPattern = /同意|协议|条款|我已阅读|隐私|terms|agree|privacy/i;
        const termsOnly = ${termsOnly ? 'true' : 'false'};
        function isChecked(el) {
          return el instanceof HTMLInputElement
            ? el.checked
            : el.getAttribute('aria-checked') === 'true';
        }
        function labelText(el) {
          const wrapper = el.closest('label') || el.parentElement.parentElement;
          const name = el.getAttribute('aria-label') || '';
          return ((wrapper ? wrapper.textContent : '') + ' ' + name).trim();
        }
        const all = Array.from(
          document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'),
        ).filter(function (el) { return !isChecked(el); });
        const inputs = all.filter(function (el) {
          return el instanceof HTMLInputElement;
        });
        const candidates = inputs.length ? inputs : all;
        let target = null;
        for (const el of candidates) {
          if (termsPattern.test(labelText(el))) { target = el; break; }
        }
        if (!target) {
          if (termsOnly) return null;
          target = candidates[candidates.length - 1] || null;
        }
        if (!target) return null;
        if (target instanceof HTMLInputElement) {
          target.click();
        } else {
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return isChecked(target);
      })()
    `);
    return (result ?? null) as boolean | null;
  }

  /**
   * Ticks the site's own "I have read and agree" box when it is what holds the
   * OAuth entry back.
   *
   * Two gates look identical from the outside and are reported the same way:
   *
   * - the entry is rendered `disabled` until the box is ticked (most panels);
   * - the entry *looks* ready but its handler silently refuses the click until
   *   the box is ticked (咕嘎咕嘎 / ai.xmiaom.com). Nothing on the button says
   *   so, the click is swallowed, and the capture reports a missing entry.
   *
   * The second shape is why a tick is attempted even when the button reports
   * itself enabled. Only a box whose surrounding copy reads like a terms or
   * privacy line is accepted there, so "remember me" is left alone.
   *
   * Ticking is retried rather than done once: the checkbox is rendered before
   * React hydrates it, and a click landing in that window flips the DOM state
   * without ever reaching the handler, leaving the button disabled. Looping
   * until the button actually reports itself enabled is what makes the unlock
   * reliable instead of a race.
   */
  async function unlockAgreementCheckbox(page: import('playwright-core').Page): Promise<boolean> {
    try {
      const deadline = Date.now() + AGREEMENT_WAIT_TIMEOUT_MS;
      const visibleEntry = () => entryLocator(page).filter({ visible: true });
      if ((await visibleEntry().count()) === 0) return false;
      let handledSoftGate = false;
      while (Date.now() < deadline) {
        const entry = visibleEntry();
        const blocked = await entry.first().evaluate(
          (el) =>
            el.getAttribute('aria-disabled') === 'true' ||
            (el as HTMLButtonElement).disabled === true,
        );
        if (!blocked) {
          if (handledSoftGate) return true;
          const ticked = await tickConsentBox(page, true);
          if (ticked === null) return true;
          if (!ticked) {
            await page.waitForTimeout(500);
            continue;
          }
          handledSoftGate = true;
          await page.waitForTimeout(600);
          continue;
        }

        const ticked = await tickConsentBox(page, false);
        if (!ticked) {
          await page.waitForTimeout(500);
          continue;
        }
        await page.waitForTimeout(600);
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Waits for the provider entry, unlocks the agreement gate that often holds it
   * disabled, then clicks it. Each round waits for the entry first so the gate is
   * only ticked once the control actually exists: ticking against a not-yet
   * hydrated checkbox flips the DOM without reaching React and leaves the button
   * disabled, which is exactly how a gated site ends up reported as having no
   * entry at all.
   */
  async function tryClickEntryOnPage(
    page: import('playwright-core').Page,
    attempts: number,
    perAttemptTimeoutMs: number,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const entry = entryLocator(page);
      try {
        await entry.filter({ visible: true }).first().waitFor({ state: 'visible', timeout: perAttemptTimeoutMs });
      } catch {
        return false;
      }
      await unlockAgreementCheckbox(page);
      if (await clickWhenVisible(entryLocator(page), 5_000)) return true;
      await page.waitForTimeout(1_000);
    }
    return false;
  }

  async function clickEntry(
    page: import('playwright-core').Page,
    attempts = ENTRY_CLICK_ATTEMPTS,
  ): Promise<boolean> {
    if (await tryClickEntryOnPage(page, attempts, ENTRY_TIMEOUT_MS)) return true;

    // Nothing matched on the landing page; the entry is usually behind a login
    // dialog, so open it and look again.
    if (await openLoginDialog(page)) {
      if (await tryClickEntryOnPage(page, attempts, ENTRY_DIALOG_TIMEOUT_MS)) return true;
    }

    // Last resort: a provider icon rendered without matching text or href.
    try {
      const byDomText = page.locator(
        `button:has-text("${provider.label}"), a:has-text("${provider.label}")`,
      );
      if (await clickWhenVisible(byDomText, 5_000)) return true;
    } catch {
      // ignore
    }

    return false;
  }

  /**
   * Community sites often gate the whole login form behind a "updated terms"
   * dialog; until it is accepted the provider entry stays disabled, so a naive
   * click silently does nothing. Accepting the terms is a normal ToS gate, not a
   * security prompt, so it is handled automatically.
   */
  async function dismissTermsGate(page: import('playwright-core').Page, entry: () => Promise<boolean>): Promise<boolean> {
    try {
      const probe = page.getByRole('button', { name: provider.entryNamePattern }).first();
      try {
        await probe.waitFor({ state: 'visible', timeout: 1_500 });
      } catch {
        return false;
      }
      if (!(await probe.isDisabled())) return false;
    } catch {
      return false;
    }

    const consentButtons = [
      page.getByRole('button', { name: /同意并继续|同意|接受|Accept and continue|Accept/i }),
      page.locator('button:has-text("同意并继续"), button:has-text("同意")'),
    ];
    for (const locator of consentButtons) {
      if (!(await clickWhenVisible(locator, 1_500))) continue;
      await settle(page, 3_000);
      // Accepting the terms only enables the entry; it still has to be
      // clicked to start the OAuth handoff.
      return entry();
    }
    return entry();
  }

  async function clickConsentButton(page: import('playwright-core').Page): Promise<boolean> {
    // The provider answers its consent URL with a Cloudflare interstitial on
    // some days, and that page carries none of the controls below — nor the site
    // storage the caller harvests afterwards. Wait it out first, or the handoff
    // looks broken while the session behind it is perfectly valid.
    await passCloudflareChallenge(page);

    // The consent control is a button on some providers and a plain link on
    // others, so it has to be matched by role as well as by selector. They are
    // unioned into one locator: waiting the full timeout on each shape in turn
    // exhausted the budget before the matching shape was ever tried.
    const candidates = [
      page.getByRole('button', { name: provider.consentButtonNames }),
      page.getByRole('link', { name: provider.consentButtonNames }),
      page.locator(provider.consentSelectors.join(', ')),
      page.locator('a[href*="approve"], a[href*="authorize"]'),
    ];
    const union = candidates.reduce((combined, candidate) => combined.or(candidate));
    return clickWhenVisible(union, CONSENT_TIMEOUT_MS);
  }

  /**
   * Landing back on a sign-in route means the handoff did not complete, so any
   * token left in storage is stale. This is a cheap shape check; the
   * authoritative verification runs in the route layer through the platform
   * adapter, which knows whether the credential is a cookie or a header token.
   */
  function looksSignedOut(rawUrl: string): boolean {
    try {
      const path = new URL(rawUrl).pathname;
      return /(sign-?in|login|register|oauth\/error)/i.test(path);
    } catch {
      return false;
    }
  }

  async function findHandoffPage(
    context: import('playwright-core').BrowserContext,
    pagesBefore: Set<import('playwright-core').Page>,
    initialPage: import('playwright-core').Page,
  ) {
    const deadline = Date.now() + NAVIGATION_TIMEOUT_MS;
    let handoffFallback: import('playwright-core').Page | null = null;

    while (Date.now() < deadline) {
      const live = context.pages().filter((candidate) => !candidate.isClosed());

      // Priority 1: the provider's actual OAuth authorize page. This is the only
      // page we can meaningfully act on.
      for (const candidate of live) {
        if (provider.isAuthorizationUrl(candidate.url())) return candidate;
      }

      // Priority 2: a *newly opened* page on a handoff host, kept as a weaker
      // fallback. Only new pages qualify: the persistent provider probe tab is
      // itself sitting on the handoff host, and treating that pre-existing tab as
      // the handoff page reported every already-signed-in user as signed out.
      if (!handoffFallback) {
        handoffFallback = live.find(
          (candidate) =>
            !pagesBefore.has(candidate) && provider.isHandoffHost(safeHost(candidate.url())),
        ) || null;
      }

      await initialPage.waitForTimeout(600);
    }

    return handoffFallback || initialPage;
  }

  /**
   * After the site-side entry was triggered, follow the OAuth handoff: wait for
   * either a new provider tab or an in-place navigation, auto-consent on the
   * authorize page, then poll for the credentials the site writes back.
   */
  async function finishCapture(
    context: import('playwright-core').BrowserContext,
    pagesBefore: Set<import('playwright-core').Page>,
    initialPage: import('playwright-core').Page,
    storageHints?: StorageCredentialHints | null,
  ): Promise<CaptureResult> {
    const loginPage = await findHandoffPage(context, pagesBefore, initialPage);
    await settle(loginPage);

    // The consent URL is sometimes answered with a Cloudflare interstitial
    // rather than the authorize form. That page holds none of the controls this
    // flow looks for, and judging it as-is reported "provider session expired"
    // while the session behind it was perfectly valid. `passCloudflareChallenge`
    // returns immediately when the page is not a challenge, so this costs
    // nothing on the ordinary path.
    if (provider.isHandoffHost(safeHost(loginPage.url()))) {
      await passCloudflareChallenge(loginPage);
    }

    // Only an actual authorize page means the handoff is in flight. Landing back
    // on the provider homepage means the session is missing.
    if (provider.isHandoffHost(safeHost(loginPage.url())) && !provider.isAuthorizationUrl(loginPage.url())) {
      return {
        status: 'needs_provider_login',
        credentials: null,
        message: provider.messages.needsLogin,
        url: loginPage.url(),
      };
    }

    if (provider.isAuthorizationUrl(loginPage.url())) {
      await clickConsentButton(loginPage);
    } else if (provider.isHandoffHost(safeHost(loginPage.url()))) {
      await clickConsentButton(loginPage);
    }

    const tokenDeadline = Date.now() + TOKEN_WAIT_TIMEOUT_MS;
    while (Date.now() < tokenDeadline) {
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        const harvested = await harvestFromPage(candidate, storageHints);
        if (harvested && !looksSignedOut(candidate.url())) {
          return { status: 'captured', credentials: harvested, url: candidate.url() };
        }
      }
      const currentUrl = loginPage.url();
      if (provider.isHandoffHost(safeHost(currentUrl)) && !provider.isAuthorizationUrl(currentUrl)) {
        return {
          status: 'needs_provider_login',
          credentials: null,
          message: provider.messages.sessionExpired,
          url: currentUrl,
        };
      }
      await loginPage.waitForTimeout(1_000);
    }

    return { status: 'timeout', credentials: null, message: '等待站点返回凭证超时', url: loginPage.url() };
  }

  /**
   * Writes a replacement secret back into the managed browser's cookie jar.
   *
   * A rolling credential is rotated by the *server* on every exchange, so the
   * copy the browser still holds is retired the moment the backend verifies the
   * account. Leaving it alone means the next capture reads a dead value and the
   * site looks logged out even though the user never signed out.
   */
  async function updateSiteCredentialCookie(input: {
    siteUrl: string;
    name: string;
    value: string;
  }): Promise<boolean> {
    // HTTP captures have no browser cookie jar; the account already holds the rotated value.
    if (supportsHyperGithubLogin(input.siteUrl, provider.id)) return false;
    const name = (input.name || '').trim();
    const value = (input.value || '').trim();
    if (!name || !value) return false;

    let host = '';
    try {
      host = new URL(input.siteUrl).host;
    } catch {
      return false;
    }
    if (!host) return false;

    let context: import('playwright-core').BrowserContext;
    try {
      context = await browser.ensureManagedBrowserContext();
    } catch {
      return false;
    }

    // Reuse the attributes of the cookie being replaced: the auth path is often
    // narrower than "/", and a mismatched path would leave two competing copies.
    const existing = (await context.cookies()).find((cookie) => {
      const domain = (cookie.domain || '').replace(/^\./, '').toLowerCase();
      return cookie.name.toLowerCase() === name.toLowerCase()
        && (domain === host.toLowerCase() || domain.endsWith(`.${host.toLowerCase()}`));
    });

    await context.addCookies([{
      name,
      value,
      domain: host,
      path: existing?.path || '/',
      secure: existing?.secure ?? true,
      httpOnly: existing?.httpOnly ?? true,
      sameSite: existing?.sameSite ?? 'Lax',
      ...(typeof existing?.expires === 'number' && existing.expires > 0
        ? { expires: existing.expires }
        : {}),
    }]);
    return true;
  }

  /**
   * Parks the site tab on a blank page once a credential has been captured.
   *
   * A relay's SPA keeps its session alive on its own: it periodically calls the
   * refresh endpoint, which *rotates* the credential and overwrites the cookie.
   * If that tab is left open, the rotating secret the backend is holding is
   * retired behind its back and the account reports AUTH_SESSION_REVOKED within
   * minutes - even though nothing on our side was wrong. Taking the tab off the
   * site stops the SPA from racing us.
   */
  async function parkSiteTab(page: import('playwright-core').Page): Promise<void> {
    try {
      if (!page.isClosed() && page.url() !== 'about:blank') {
        await page.goto('about:blank', { timeout: 5_000 });
      }
    } catch {
      // Parking is best effort; a failed navigation must not fail the capture.
    }
  }

  /**
   * Reads the credential a sign-in performed outside this module left behind.
   *
   * Some flows cannot use `captureSiteCredentials`: the Linux.do OAuth driver
   * signs the profile *out* of the site first (a handshake started while a
   * session is active is read as a bind and refused), so clicking the entry
   * button again would undo the work. What that driver needs is the second half
   * only — turn the browser session it just established into a credential the
   * account row can hold.
   *
   * The tab is parked afterwards for the reason `parkSiteTab` documents: a
   * relay SPA left open rotates the very secret it is showing us.
   */
  async function harvestSiteCredential(siteUrl: string): Promise<CapturedCredentials | null> {
    const context = await browser.ensureManagedBrowserContext();
    const page = await getSitePage(context);
    const storageHints = pipiImageHintsFor(siteUrl);
    try {
      await page.bringToFront().catch(() => undefined);
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
        .catch(() => undefined);
      await settle(page);
      if (looksSignedOut(page.url())) return null;
      return await harvestFromPage(page, storageHints);
    } finally {
      await parkSiteTab(page);
    }
  }

  async function captureSiteCredentials(input: { siteId: number; forceLogin?: boolean }): Promise<CaptureResult> {
    const site = await db
      .select()
      .from(schema.sites)
      .where(eq(schema.sites.id, input.siteId))
      .get();
    if (!site) {
      return { status: 'site_not_found', credentials: null, message: '站点不存在' };
    }

    if (supportsHyperGithubLogin(site.url, provider.id)) {
      return withFlowLock(flowLock, captureHyperGithubCredentials);
    }

    // 站点自己的 storage 键名（皮皮智绘用 `pipi_pc_token`）只有站点模块知道，
    // 通用键表认不出来；这里带上下文进去，采集才能读到凭据。
    const storageHints = pipiImageHintsFor(site.url);

    let context: import('playwright-core').BrowserContext;
    try {
      context = await browser.ensureManagedBrowserContext();
    } catch (error) {
      return { status: 'browser_unavailable', credentials: null, message: (error as Error)?.message || '浏览器不可用' };
    }

    return withFlowLock(flowLock, async () => {
      const page = await getSitePage(context);
      try {
      await page.bringToFront().catch(() => undefined);
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
      await settle(page);

      // A harvested cookie is not proof of a live session: a rolling credential is
      // retired server-side the moment it is exchanged, so the jar can hold a value
      // that is already dead. When the caller knows the previous credential failed,
      // it asks for a fresh OAuth handshake instead of trusting the stale copy.
      const existing = input.forceLogin ? null : await harvestFromPage(page, storageHints);
      if (existing && !looksSignedOut(page.url())) {
        return { status: 'already_authorized', credentials: existing, url: page.url() };
      }

      const pagesBefore = new Set(context.pages());
      let clicked = await clickEntry(page);
      if (!clicked) {
        clicked = await dismissTermsGate(page, () => clickEntry(page));
      }
      if (!clicked) {
        // Some sites hide the entry behind their dedicated login route; try once
        // more there before reporting the entry as missing.
        for (const loginUrl of buildLoginUrls(site.url)) {
          if (loginUrl === page.url()) continue;
          await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
          await settle(page);
          // A 404 page also loads fine, so the entry button is the real signal.
          const retryHarvest = input.forceLogin ? null : await harvestFromPage(page, storageHints);
          if (retryHarvest && !looksSignedOut(page.url())) {
            return { status: 'already_authorized', credentials: retryHarvest, url: page.url() };
          }
          let retryClicked = await clickEntry(page, 1);
          if (!retryClicked) {
            retryClicked = await dismissTermsGate(page, () => clickEntry(page, 1));
          }
          if (retryClicked) {
            return await finishCapture(context, pagesBefore, page, storageHints);
          }
        }
        return {
          status: 'login_button_not_found',
          credentials: null,
          message: provider.messages.entryMissing,
          url: page.url(),
        };
      }

      return await finishCapture(context, pagesBefore, page, storageHints);
      } finally {
        await parkSiteTab(page);
      }
    });
  }

  return {
    provider,
    browser,
    getLoginState,
    openLoginWindow,
    captureSiteCredentials,
    harvestSiteCredential,
    updateSiteCredentialCookie,
  };
}

export type AssistedLoginSession = ReturnType<typeof createAssistedLoginSession>;
