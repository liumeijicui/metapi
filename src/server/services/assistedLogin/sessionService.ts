import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { createManagedBrowser } from './browserManager.js';
import { passCloudflareChallenge } from './cloudflareChallenge.js';
import { captureHyperGithubCredentials, supportsHyperGithubLogin } from './sites/hyper.js';
import type { AssistedLoginProvider, CaptureResult, CapturedCredentials, LoginState } from './types.js';

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
function extractStoredUserId(records: Array<[string, string]>): number | null {
  const lookup = storageLookup(records);
  const userRaw = lookup.get('auth_user') || lookup.get('user') || '';
  if (userRaw) {
    try {
      const parsedUser = JSON.parse(userRaw) as Record<string, unknown>;
      const fromUser = normalizeUserId(parsedUser?.id ?? parsedUser?.user_id);
      if (fromUser !== null) return fromUser;
    } catch {
      // fall through to the bare uid key
    }
  }
  return normalizeUserId(lookup.get('uid'));
}

/** Reads the display name from the stored user object, when present. */
function extractStoredUsername(records: Array<[string, string]>): string | null {
  const lookup = storageLookup(records);
  const userRaw = lookup.get('auth_user') || lookup.get('user') || '';
  if (!userRaw) return null;
  try {
    const parsedUser = JSON.parse(userRaw) as Record<string, unknown>;
    return normalizeText(parsedUser?.username) || normalizeText(parsedUser?.email) || null;
  } catch {
    return null;
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
export function pickTokenFromRecords(records: Array<[string, string]>): CapturedCredentials | null {
  const lookup = new Map<string, string>();
  for (const [rawKey, rawValue] of records) {
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.trim();
    if (key && value && !lookup.has(key)) lookup.set(key, value);
  }

  const accessKey = ACCESS_TOKEN_KEYS.find((candidate) => lookup.has(candidate));
  const accessToken = accessKey ? lookup.get(accessKey) || '' : '';
  if (!accessToken) return null;

  const refreshToken = lookup.get('refresh_token') || null;
  const expiresRaw = lookup.get('token_expires_at') || lookup.get('expires_at') || '';
  const parsedExpires = Number.parseInt(expiresRaw, 10);
  const tokenExpiresAt = Number.isFinite(parsedExpires) && parsedExpires > 0 ? parsedExpires : null;

  let username: string | null = null;
  let platformUserId: number | null = null;
  const userRaw = lookup.get('auth_user') || lookup.get('user') || '';
  if (userRaw) {
    try {
      const parsedUser = JSON.parse(userRaw) as Record<string, unknown>;
      username = normalizeText(parsedUser?.username) || normalizeText(parsedUser?.email) || null;
      platformUserId = normalizeUserId(parsedUser?.id ?? parsedUser?.user_id);
    } catch {
      username = null;
    }
  }
  if (platformUserId === null) platformUserId = normalizeUserId(lookup.get('uid'));

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

  async function harvestFromPage(page: import('playwright-core').Page): Promise<CapturedCredentials | null> {
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

    const fromStorage = pickTokenFromRecords(records);
    if (fromStorage) return fromStorage;

    try {
      const context = page.context();
      // Query every cookie the context holds rather than only those visible to
      // the current URL: a refresh cookie is commonly scoped to the auth path
      // (e.g. `/api/user/auth`), so a page-URL lookup would never see it.
      const allCookies = await context.cookies();
      const host = safeHost(page.url());

      const matchSessionCookie = (candidates: typeof allCookies) => candidates.find((cookie) => {
        const name = (cookie.name || '').trim().toLowerCase();
        if (!SESSION_COOKIE_NAMES.has(name)) return false;
        return (cookie.value || '').trim().length >= MIN_CREDENTIAL_LENGTH;
      });

      // Cookies must belong to the site being captured. The managed browser
      // keeps several sites open at once, so matching against the whole jar
      // would happily return another site's credential as this site's.
      const cookies = allCookies.filter((cookie) => {
        const domain = (cookie.domain || '').replace(/^\./, '').toLowerCase();
        if (!domain) return false;
        if (!host) return true;
        return host === domain || host.endsWith(`.${domain}`);
      });
      const sessionCookie = matchSessionCookie(cookies);

      if (sessionCookie?.value) {
        // Some sites (e.g. SnowAPI) gate the management API behind a shield that
        // checks the whole cookie jar, so every site-scoped cookie is preserved
        // rather than only the session one.
        // The site's user id lives only in storage, not in the cookie, so it is
        // read here too; without it a `New-Api-User`-style header is missing and
        // the site rejects the credential with 401.
        const cookieHeader = cookies
          .filter((cookie) => (cookie.value || '').trim())
          .map((cookie) => `${cookie.name}=${cookie.value}`)
          .join('; ');
        return {
          accessToken: cookieHeader || `${sessionCookie.name}=${sessionCookie.value}`,
          refreshToken: null,
          tokenExpiresAt: null,
          username: extractStoredUsername(records),
          platformUserId: extractStoredUserId(records),
          source: 'cookie',
          harvestedKeys: cookies.map((cookie) => cookie.name),
        };
      }
    } catch {
      // ignore
    }

    return null;
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
   */
  async function clickWhenVisible(
    locator: import('playwright-core').Locator,
    timeoutMs: number,
  ): Promise<boolean> {
    const target = locator.first();
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
        return true;
      }
    }
    return false;
  }

  /**
   * Builds one union locator covering every entry shape.
   *
   * Waiting on the candidates *sequentially* spent the full timeout on each one,
   * so a site whose entry lives behind its own login dialog burned ~180s before
   * the fallback ran and the caller had already given up. A single union waits
   * once and resolves as soon as any shape appears.
   */
  function entryLocator(page: import('playwright-core').Page): import('playwright-core').Locator {
    const candidates = [
      page.getByRole('button', { name: provider.entryNamePattern }),
      page.getByRole('link', { name: provider.entryNamePattern }),
      ...provider.entryTextSelectors.map((selector) => page.locator(selector)),
      ...provider.entrySelectors.map((selector) => page.locator(selector)),
    ];
    return candidates.reduce((combined, candidate) => combined.or(candidate));
  }

  /**
   * Ticks the site's own "I have read and agree" box when it is what holds the
   * OAuth entry disabled.
   *
   * Several panels ship the provider buttons in a permanently disabled state
   * until that agreement box is ticked. The button still *looks* ready, so the
   * handoff silently never starts and the capture reports a missing entry.
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
      if ((await entryLocator(page).count()) === 0) return false;
      while (Date.now() < deadline) {
        const entry = entryLocator(page);
        const blocked = await entry.first().evaluate(
          (el) =>
            el.getAttribute('aria-disabled') === 'true' ||
            (el as HTMLButtonElement).disabled === true,
        );
        if (!blocked) return true;

        // The callback is passed as source text on purpose. A real function is
        // run through the TS transpiler, which rewrites nested arrow functions
        // into `__name(...)`-wrapped ones; that helper only exists in the server
        // bundle, so the browser would throw `__name is not defined` and the
        // unlock would silently never happen.
        const ticked = await page.evaluate(`
          (() => {
            const termsPattern = /同意|协议|条款|我已阅读|terms|agree/i;
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
            if (!target) target = candidates[candidates.length - 1];
            if (!target) return false;
            if (target instanceof HTMLInputElement) {
              target.click();
            } else {
              target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            return isChecked(target);
          })()
        `);
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
        await entry.first().waitFor({ state: 'visible', timeout: perAttemptTimeoutMs });
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
        const harvested = await harvestFromPage(candidate);
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
      const existing = input.forceLogin ? null : await harvestFromPage(page);
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
          const retryHarvest = input.forceLogin ? null : await harvestFromPage(page);
          if (retryHarvest && !looksSignedOut(page.url())) {
            return { status: 'already_authorized', credentials: retryHarvest, url: page.url() };
          }
          let retryClicked = await clickEntry(page, 1);
          if (!retryClicked) {
            retryClicked = await dismissTermsGate(page, () => clickEntry(page, 1));
          }
          if (retryClicked) {
            return await finishCapture(context, pagesBefore, page);
          }
        }
        return {
          status: 'login_button_not_found',
          credentials: null,
          message: provider.messages.entryMissing,
          url: page.url(),
        };
      }

      return await finishCapture(context, pagesBefore, page);
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
    updateSiteCredentialCookie,
  };
}

export type AssistedLoginSession = ReturnType<typeof createAssistedLoginSession>;
