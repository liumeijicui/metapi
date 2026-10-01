/**
 * Password-driven GitHub re-login.
 *
 * The managed browser earns a GitHub session that the whole assisted-login
 * feature depends on, but nothing could restore it once GitHub retired the
 * cookies: `captureHyperGithubCredentials` could only report
 * "GitHub 会话已失效，请重新导入会话" and wait for an operator to paste a fresh
 * cookie from another machine. On a phone that hand-over is impractical, and the
 * remote-login window cannot be used either because GitHub needs a typed
 * password, not a tap.
 *
 * This module closes that gap: the operator stores the GitHub username and
 * password once, and the server replays them in its own managed browser
 * whenever the session is found signed out. The browser run is what defeats the
 * anti-bot checks — the credentials never touch a bare HTTP client, so a
 * challenge page is answered by the real Chrome instead of being misread as a
 * wrong password.
 *
 * The password is encrypted with the same account-credential cipher the rest of
 * the app uses and is never returned by any read API.
 */
import type { Page } from 'playwright-core';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../../db/index.js';
import { upsertSetting } from '../../../db/upsertSetting.js';
import { decryptAccountPassword, encryptAccountPassword } from '../../accountCredentialService.js';
import { saveImportedSession } from '../importedSession.js';
import type { AssistedLoginProviderId } from '../types.js';

const PROVIDER_ID: AssistedLoginProviderId = 'github';
const GITHUB_ORIGIN = 'https://github.com';
const LOGIN_URL = `${GITHUB_ORIGIN}/login`;
const SETTING_KEY = 'github_auto_login_credentials';
const NAVIGATION_TIMEOUT_MS = 60_000;

/**
 * GitHub does not lock an account on one bad password, but replaying a wrong
 * password every keep-alive tick would still burn through its rate limits and
 * could trip an abuse flag. Two refusals therefore back the account off for
 * hours, while a transient failure (network, challenge page) only waits minutes.
 */
const TRANSIENT_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const REFUSED_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const REFUSED_FAILURE_THRESHOLD = 2;

type StoredGitHubAutoLogin = {
  username: string;
  passwordCipher: string;
  savedAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastMessage: string | null;
  consecutiveFailures: number;
};

export type GitHubAutoLoginState = {
  configured: boolean;
  username: string | null;
  savedAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastMessage: string | null;
  consecutiveFailures: number;
  /** When the cooldown ends; null when a renewal may run right now. */
  nextAttemptAt: string | null;
};

export type GitHubRenewalOutcome = {
  ok: boolean;
  /** True when the attempt was skipped (no credentials, or still cooling down). */
  skipped: boolean;
  username?: string | null;
  userId?: number | null;
  message: string;
};

function emptyState(): GitHubAutoLoginState {
  return {
    configured: false,
    username: null,
    savedAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastMessage: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
  };
}

async function readStored(): Promise<StoredGitHubAutoLogin | null> {
  // This module exists to repair a session, so it must never be the reason the
  // session handshake fails. An unreadable settings store degrades to "not
  // configured" and the caller keeps its own verdict.
  let row: { value?: string | null } | undefined;
  try {
    row = await db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, SETTING_KEY))
      .get();
  } catch {
    return null;
  }
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<StoredGitHubAutoLogin>;
    if (typeof parsed?.username !== 'string' || typeof parsed?.passwordCipher !== 'string') return null;
    if (!parsed.username.trim() || !parsed.passwordCipher) return null;
    return {
      username: parsed.username,
      passwordCipher: parsed.passwordCipher,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
      lastAttemptAt: typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
      lastSuccessAt: typeof parsed.lastSuccessAt === 'string' ? parsed.lastSuccessAt : null,
      lastMessage: typeof parsed.lastMessage === 'string' ? parsed.lastMessage : null,
      consecutiveFailures: Number.isInteger(parsed.consecutiveFailures) && Number(parsed.consecutiveFailures) > 0
        ? Number(parsed.consecutiveFailures)
        : 0,
    };
  } catch {
    return null;
  }
}

function cooldownMs(stored: StoredGitHubAutoLogin): number {
  return stored.consecutiveFailures >= REFUSED_FAILURE_THRESHOLD
    ? REFUSED_RETRY_COOLDOWN_MS
    : TRANSIENT_RETRY_COOLDOWN_MS;
}

function nextAttemptAt(stored: StoredGitHubAutoLogin): string | null {
  if (!stored.lastAttemptAt) return null;
  // A success clears the cooldown: the next failure must be judged on its own.
  const attemptedAt = Date.parse(stored.lastAttemptAt);
  if (!Number.isFinite(attemptedAt)) return null;
  return new Date(attemptedAt + cooldownMs(stored)).toISOString();
}

function isCoolingDown(stored: StoredGitHubAutoLogin): boolean {
  const next = nextAttemptAt(stored);
  return !!next && Date.parse(next) > Date.now();
}

/** Status for the settings page. The password is deliberately absent. */
export async function getGitHubAutoLoginState(): Promise<GitHubAutoLoginState> {
  const stored = await readStored();
  if (!stored) return emptyState();
  const next = isCoolingDown(stored) ? nextAttemptAt(stored) : null;
  return {
    configured: true,
    username: stored.username,
    savedAt: stored.savedAt || null,
    lastAttemptAt: stored.lastAttemptAt,
    lastSuccessAt: stored.lastSuccessAt,
    lastMessage: stored.lastMessage,
    consecutiveFailures: stored.consecutiveFailures,
    nextAttemptAt: next,
  };
}

export async function saveGitHubAutoLogin(input: {
  username: unknown;
  password: unknown;
}): Promise<GitHubAutoLoginState> {
  const username = typeof input.username === 'string' ? input.username.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username) throw new Error('请填写 GitHub 用户名');
  if (!password) throw new Error('请填写 GitHub 密码');

  const previous = await readStored();
  const row: StoredGitHubAutoLogin = {
    username,
    passwordCipher: encryptAccountPassword(password),
    savedAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: previous?.lastSuccessAt ?? null,
    lastMessage: null,
    // New credentials invalidate the old failure count: the operator just fixed
    // the thing the counter was reacting to.
    consecutiveFailures: 0,
  };
  await safeUpsert(row, 'save-credentials');
  return await getGitHubAutoLoginState();
}

export async function clearGitHubAutoLogin(): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, SETTING_KEY)).run();
}

/** Never let a bookkeeping write undo a renewal that already succeeded. */
async function safeUpsert(row: Record<string, unknown>, operation: string): Promise<void> {
  try {
    await upsertSetting(SETTING_KEY, row);
  } catch {
    console.warn(`[github-auto-login] 写入设置失败（${operation}）`);
  }
}

async function recordAttempt(input: {
  ok: boolean;
  message: string;
  username?: string | null;
}): Promise<void> {
  const stored = await readStored();
  if (!stored) return;
  const now = new Date().toISOString();
  await safeUpsert({
    ...stored,
    lastAttemptAt: now,
    lastSuccessAt: input.ok ? now : stored.lastSuccessAt,
    lastMessage: input.message.slice(0, 300),
    consecutiveFailures: input.ok ? 0 : stored.consecutiveFailures + 1,
    ...(input.ok && input.username ? { username: input.username } : {}),
  } satisfies StoredGitHubAutoLogin, 'record-attempt');
}

type SignedInIdentity = { login: string; userId: number | null };

async function readSignedInIdentity(page: Page): Promise<SignedInIdentity> {
  const raw = await page.evaluate(() => {
    const login = document.querySelector('meta[name="user-login"]')?.getAttribute('content') || '';
    const userId = document.querySelector('meta[name="octolytics-dimension-user_id"]')?.getAttribute('content') || '';
    return { login, userId };
  }).catch(() => ({ login: '', userId: '' }));
  const login = typeof raw?.login === 'string' ? raw.login.trim() : '';
  const parsed = Number.parseInt(typeof raw?.userId === 'string' ? raw.userId : '', 10);
  return { login, userId: Number.isFinite(parsed) ? parsed : null };
}

/**
 * Classifies a failed submit. GitHub answers with a redirect to a dedicated page
 * for the checks it wants a human to pass, and with an inline flash for a plain
 * refusal, so both the URL and the visible text are read.
 */
async function describeRefusal(page: Page): Promise<string> {
  const snapshot = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    return {
      url: location.href,
      text: text.slice(0, 4000),
      flash: (document.querySelector('.flash-error, .flash-warn, [role="alert"], #js-flash-container')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 200),
    };
  }).catch(() => ({ url: page.url(), text: '', flash: '' }));

  const url = String(snapshot?.url || '');
  const text = String(snapshot?.text || '');
  const flash = String(snapshot?.flash || '');
  const combined = `${url} ${flash} ${text}`;

  if (/two-factor|two_factor|authentication code/i.test(combined) || /\/sessions\/two-factor/.test(url)) {
    return 'GitHub 要求两步验证（2FA）验证码，服务器无法自动完成；请改用「远程登录」窗口手动完成一次，或先在 GitHub 关闭 2FA';
  }
  if (/verified-device|device verification|verify your device|check your email/i.test(combined)
    || /\/sessions\/verified-device/.test(url)) {
    return 'GitHub 要求设备验证（会向邮箱发验证码），服务器无法自动完成；请在 GitHub 上把本设备设为可信，或用「远程登录」窗口手动完成一次';
  }
  if (/captcha|verify you are human|are you a robot/i.test(combined) || /\/sessions\/captcha/.test(url)) {
    return 'GitHub 弹出人机验证，需要人工在浏览器里点一次';
  }
  if (/rate limit|too many (?:requests|attempts)/i.test(combined)) {
    return 'GitHub 提示请求过于频繁（限流），稍后会自动重试';
  }
  if (flash) return `GitHub 拒绝了本次登录：${flash}`;
  if (/incorrect username or password/i.test(text)) return 'GitHub 拒绝了本次登录：用户名或密码不正确，请重新保存凭据';
  return `GitHub 登录未完成（当前页面：${url || '未知'}）`;
}

/**
 * Replays the stored credentials in the managed browser and persists the session
 * it earns, so the browser-free HTTP keep-alive can take over again.
 */
export async function renewGitHubSession(options?: { force?: boolean }): Promise<GitHubRenewalOutcome> {
  const stored = await readStored();
  if (!stored) {
    return { ok: false, skipped: true, message: '未配置 GitHub 账号密码，无法自动重新登录' };
  }
  if (!options?.force && isCoolingDown(stored)) {
    return {
      ok: false,
      skipped: true,
      message: `距离上次自动登录尝试不足冷却时间，将在 ${nextAttemptAt(stored)} 后重试`,
    };
  }

  const password = decryptAccountPassword(stored.passwordCipher);
  if (!password) {
    await recordAttempt({ ok: false, message: '已保存的 GitHub 密码无法解密，请重新保存凭据' });
    return { ok: false, skipped: false, message: '已保存的 GitHub 密码无法解密，请重新保存凭据' };
  }

  // Imported lazily: the registry pulls in the whole session stack, and this
  // module is reachable from the site drivers that stack already imports.
  let page: Page | null = null;
  try {
    const { assistedLoginSessions } = await import('../sessionRegistry.js');
    const session = assistedLoginSessions.get(PROVIDER_ID);
    if (!session) {
      return { ok: false, skipped: false, message: 'GitHub 快捷登录未初始化' };
    }
    const context = await session.browser.ensureManagedBrowserContext();
    page = await context.newPage();

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });

    let identity = await readSignedInIdentity(page);
    if (!identity.login) {
      // `/login` redirects to the dashboard when a session already exists, so a
      // missing form is not automatically an error — but a form-less signed-out
      // page means GitHub served a block/challenge instead of the login form.
      const hasForm = await page.locator('#login_field').count();
      if (!hasForm) {
        const message = await describeRefusal(page);
        await recordAttempt({ ok: false, message });
        return { ok: false, skipped: false, message };
      }
      await page.fill('#login_field', stored.username);
      await page.fill('#password', password);
      await page.click('input[type="submit"][name="commit"]');
      await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
      await page.waitForTimeout(2_000);
      identity = await readSignedInIdentity(page);
    }

    if (!identity.login) {
      const message = await describeRefusal(page);
      await recordAttempt({ ok: false, message });
      return { ok: false, skipped: false, message };
    }

    const cookies = (await context.cookies(GITHUB_ORIGIN)).filter((cookie) => cookie.name && cookie.value);
    if (cookies.length === 0) {
      const message = 'GitHub 已登录，但浏览器中没有可用的 Cookie';
      await recordAttempt({ ok: false, message });
      return { ok: false, skipped: false, message };
    }

    await saveImportedSession(
      PROVIDER_ID,
      {
        cookieHeader: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        cookieNames: cookies.map((cookie) => cookie.name),
        csrfToken: null,
      },
      { username: identity.login, userId: identity.userId },
    );

    const message = `GitHub 会话已自动恢复（${identity.login}）`;
    await recordAttempt({ ok: true, message, username: identity.login });
    return { ok: true, skipped: false, username: identity.login, userId: identity.userId, message };
  } catch (error) {
    const message = `GitHub 自动重新登录失败：${error instanceof Error ? error.message : '浏览器不可用'}`;
    await recordAttempt({ ok: false, message });
    return { ok: false, skipped: false, message };
  } finally {
    await page?.close().catch(() => undefined);
  }
}

/** Renewal that only runs when the operator actually stored credentials. */
export async function renewGitHubSessionIfConfigured(): Promise<GitHubRenewalOutcome> {
  const stored = await readStored();
  if (!stored) return { ok: false, skipped: true, message: '未配置 GitHub 账号密码' };
  return renewGitHubSession();
}
