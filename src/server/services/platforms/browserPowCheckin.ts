/**
 * Daily check-in for "小天签到系统" style welfare sites.
 *
 * These deployments are separate from the relay and gate `POST /api/checkin`
 * with two browser-only factors: a Cloudflare Turnstile widget and a
 * proof-of-work challenge. The token only exists inside a real browser, so the
 * captcha half runs in the managed profile (which also keeps the welfare site's
 * `linuxdo_checkin_session` cookie between days).
 *
 * The PoW is solved here in Node instead of by `checkin-pow.js`: the page's
 * pure-JS SHA-256 needs minutes for an 18-bit target, while Node's native hash
 * does the same work in under a second. The page's own success callback is
 * deliberately swallowed after capturing the token, otherwise it would request
 * a second task and trip the site's "请求过于频繁" (HTTP 429) guard.
 */
import { createHash } from 'node:crypto';
import type { Page } from 'playwright-core';
import { browserLane } from '../../shared/browserLane.js';
import { assistedLoginSessions } from '../assistedLogin/sessionRegistry.js';
import {
  clickWithRealPointer,
  locateChallengeWidget,
  passCloudflareChallenge,
} from '../assistedLogin/cloudflareChallenge.js';
import type { CheckinResult } from './base.js';

const NAVIGATION_TIMEOUT_MS = 60_000;
const CHALLENGE_TIMEOUT_MS = 120_000;
const CAPTCHA_TIMEOUT_MS = 120_000;
const POW_TIMEOUT_MS = 240_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_TURNSTILE_CLICKS = 5;
const TASK_RATE_LIMIT_RETRIES = 3;
const TASK_RATE_LIMIT_WAIT_MS = 20_000;
const QUOTA_PER_UNIT = 500000;

/**
 * The page's own callback is suppressed so only this module requests a task.
 * The token is parked on `window` for the Node side to read.
 */
const CAPTCHA_TOKEN_KEY = '__metapiCaptchaToken';

type WelfareInfo = {
  logged_in?: boolean;
  username?: string;
  linux_do_id?: string;
  quota?: number;
  quota_threshold?: number;
  can_checkin?: boolean;
  message?: string;
  error?: string;
  last_checkin?: {
    quota_awarded?: number;
    quota_before?: number;
    quota_after?: number;
    checkin_date?: string;
  } | null;
};

type FetchOutcome = { status: number; body: any; text: string };

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.slice(0, 200) || '未知错误';
}

function isAlreadyCheckedInMessage(message: string | undefined): boolean {
  return /今日已签到|今天已经签到|已签到|already/i.test(message || '');
}

function rewardFromInfo(info: WelfareInfo | null): string | undefined {
  const awarded = Number(info?.last_checkin?.quota_awarded);
  if (!Number.isFinite(awarded) || awarded <= 0) return undefined;
  return `$${(awarded / QUOTA_PER_UNIT).toFixed(2)}`;
}

/** Reads the welfare site's own status endpoint from inside its origin. */
async function readInfo(page: Page): Promise<WelfareInfo | null> {
  const value = await page
    .evaluate(async () => {
      try {
        const response = await fetch('/api/info', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        return await response.json();
      } catch {
        return null;
      }
    })
    .catch(() => null);
  return value && typeof value === 'object' ? value as WelfareInfo : null;
}

/**
 * Authorizes this deployment against Linux.do again.
 *
 * `/login` starts the handshake itself when the site already knows which
 * provider to use; some builds render a button instead. Both shapes are
 * handled, and the consent page is answered through its own `允许` link.
 */
async function authorizeWithLinuxDo(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/login`, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await passCloudflareChallenge(page, { timeoutMs: CHALLENGE_TIMEOUT_MS });
  await page.waitForTimeout(1_500);

  if (!/connect\.linux\.do/i.test(page.url())) {
    const entry = page.locator('a,button').filter({ hasText: /Linux\s*Do/i }).first();
    if (await entry.count()) {
      await entry.click({ timeout: 15_000 }).catch(async () => {
        await entry.evaluate((element: HTMLElement) => element.click()).catch(() => undefined);
      });
    }
  }

  const authDeadline = Date.now() + 45_000;
  while (Date.now() < authDeadline && !/connect\.linux\.do/i.test(page.url())) {
    await page.waitForTimeout(500);
  }
  await passCloudflareChallenge(page, { timeoutMs: CHALLENGE_TIMEOUT_MS });

  const allow = page
    .locator('a,button,input[type="submit"]')
    .filter({ hasText: /^(允许|授权|Allow|Authorize)$/i })
    .first();
  if (await allow.count()) {
    await allow.click({ timeout: 15_000 }).catch(async () => {
      await allow.evaluate((element: HTMLElement) => element.click()).catch(() => undefined);
    });
  }

  const landingDeadline = Date.now() + NAVIGATION_TIMEOUT_MS;
  while (Date.now() < landingDeadline) {
    try {
      if (new URL(page.url()).origin === origin) break;
    } catch {
      // still in a redirect
    }
    await page.waitForTimeout(500);
  }
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await passCloudflareChallenge(page, { timeoutMs: CHALLENGE_TIMEOUT_MS });
  await page.waitForTimeout(2_000);
}

/**
 * Captures the Turnstile token without letting the page burn it on its own,
 * much slower PoW run.
 */
async function installCaptchaInterceptor(page: Page): Promise<void> {
  await page.evaluate((tokenKey: string) => {
    const api = (window as any).CheckinCaptcha;
    if (!api || typeof api.init !== 'function' || api.__metapiWrapped) return;
    const original = api.init.bind(api);
    api.init = (config: unknown, _onSuccess: unknown, onError: unknown) => original(
      config,
      (token: string) => { (window as any)[tokenKey] = String(token || ''); },
      onError,
    );
    api.__metapiWrapped = true;
  }, CAPTCHA_TOKEN_KEY).catch(() => undefined);
}

async function readCaptchaToken(page: Page): Promise<string> {
  const token = await page.evaluate((key: string) => (window as any)[key] || '', CAPTCHA_TOKEN_KEY).catch(() => '');
  return typeof token === 'string' ? token : '';
}

function hasLeadingZeroBits(hash: string, bits: number): boolean {
  let remaining = bits;
  for (let index = 0; index < hash.length; index += 2) {
    const byte = Number.parseInt(hash.slice(index, index + 2), 16);
    if (!Number.isFinite(byte)) return false;
    if (remaining >= 8) {
      if (byte !== 0) return false;
      remaining -= 8;
      continue;
    }
    return (byte >> (8 - remaining)) === 0;
  }
  return remaining <= 0;
}

/** Solves the task's PoW with Node's native hash; yields so the process stays responsive. */
async function solveProofOfWork(payload: string, difficulty: number, expiresAt: number): Promise<{ counter: number; hash: string }> {
  const startedAt = Date.now();
  let counter = 0;
  while (true) {
    if (Date.now() >= expiresAt * 1000) throw new Error('PoW 挑战已过期，请刷新页面后重试');
    if (Date.now() - startedAt > POW_TIMEOUT_MS) throw new Error('PoW 计算超时');
    for (let index = 0; index < 20_000; index += 1, counter += 1) {
      const hash = createHash('sha256').update(`${payload}:${counter}`).digest('hex');
      if (hasLeadingZeroBits(hash, difficulty)) return { counter, hash };
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function postJson(page: Page, path: string, body: unknown): Promise<FetchOutcome> {
  return page.evaluate(async ({ path, body }) => {
    try {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch {}
      return { status: response.status, body: parsed, text };
    } catch (error) {
      return { status: 0, body: null, text: (error as Error)?.message || '网络错误' };
    }
  }, { path, body });
}

async function runCheckin(
  page: Page,
  origin: string,
  keepAlive: () => void,
): Promise<CheckinResult> {
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  await passCloudflareChallenge(page, { timeoutMs: CHALLENGE_TIMEOUT_MS });
  await page.waitForTimeout(2_000);

  let info = await readInfo(page);
  if (!info?.logged_in) {
    await authorizeWithLinuxDo(page, origin);
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
    await passCloudflareChallenge(page, { timeoutMs: CHALLENGE_TIMEOUT_MS });
    await page.waitForTimeout(2_000);
    info = await readInfo(page);
  }
  if (!info?.logged_in) {
    return {
      success: false,
      message: info?.error || '签到站未登录，且 Linux.do 自动授权未完成',
    };
  }

  // The status endpoint does not expose "checked in today", so this branch only
  // covers the site's own refusal to run: quota already above the threshold.
  // A same-day repeat is answered by `POST /api/checkin` with "今日已签到".
  if (info.can_checkin === false) {
    return { success: true, message: info.message || '当前无需签到' };
  }

  await installCaptchaInterceptor(page);
  const button = page.getByRole('button', { name: /立即签到/ }).first();
  if (!(await button.isVisible().catch(() => false))) {
    return { success: false, message: info.message || '签到站没有显示“立即签到”按钮' };
  }
  await button.click({ timeout: 15_000 });

  let captchaToken = '';
  let turnstileClicks = 0;
  const captchaDeadline = Date.now() + CAPTCHA_TIMEOUT_MS;
  while (Date.now() < captchaDeadline) {
    captchaToken = await readCaptchaToken(page);
    if (captchaToken) break;
    if (turnstileClicks < MAX_TURNSTILE_CLICKS) {
      const box = await locateChallengeWidget(page).catch(() => null);
      if (box) {
        await clickWithRealPointer(page, box).catch(() => undefined);
        turnstileClicks += 1;
      }
    }
    keepAlive();
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  if (!captchaToken) {
    return { success: false, message: '签到站验证码未通过（Turnstile 等待超时）' };
  }

  let task: FetchOutcome | null = null;
  for (let attempt = 0; attempt <= TASK_RATE_LIMIT_RETRIES; attempt += 1) {
    task = await postJson(page, '/api/checkin/task', { captcha_token: captchaToken });
    if (task.status !== 429) break;
    if (attempt < TASK_RATE_LIMIT_RETRIES) {
      keepAlive();
      await page.waitForTimeout(TASK_RATE_LIMIT_WAIT_MS);
    }
  }
  if (!task) return { success: false, message: '签到站未返回 PoW 任务' };
  if (task.status === 429) {
    return { success: false, message: '签到站限流（HTTP 429：请求过于频繁），本次未完成' };
  }
  if (task.status !== 200 || !task.body) {
    return {
      success: false,
      message: task.body?.error || task.body?.message || `签到站获取任务失败（HTTP ${task.status}）`,
    };
  }

  const taskBody = task.body;
  let fields = { pow_payload: '', pow_signature: '', pow_counter: '', pow_hash: '' };
  if (taskBody.enabled) {
    const payload = String(taskBody.payload || '');
    const signature = String(taskBody.signature || '');
    const difficulty = Number(taskBody.difficulty) || 0;
    const expiresAt = Number(taskBody.expires_at) || 0;
    if (!payload || !signature || !expiresAt) {
      return { success: false, message: '签到站返回的 PoW 任务不完整' };
    }
    const solved = await solveProofOfWork(payload, difficulty, expiresAt);
    fields = {
      pow_payload: payload,
      pow_signature: signature,
      pow_counter: String(solved.counter),
      pow_hash: solved.hash,
    };
  }

  const result = await postJson(page, '/api/checkin', fields);
  const message = String(result.body?.error || result.body?.message || '');
  if (result.body?.success === true || result.body?.last_checkin) {
    return {
      success: true,
      message: message || '签到成功',
      ...(rewardFromInfo(result.body) ? { reward: rewardFromInfo(result.body) } : {}),
    };
  }
  // A repeat run is not an error: the day's grant was already paid, and the
  // site reports it as HTTP 400 with this exact wording.
  if (isAlreadyCheckedInMessage(message)) {
    return { success: true, message: message || '今日已签到' };
  }
  if (message) {
    return { success: false, message: `签到站拒绝：${message}` };
  }
  return {
    success: false,
    message: `签到站未返回结果（HTTP ${result.status}）`,
  };
}

/**
 * Runs one welfare check-in in the managed Linux.do browser profile.
 *
 * The profile carries both the forum session needed to re-authorize and the
 * welfare site's own session cookie, so a browser used on a previous day can
 * sign itself back in without an operator.
 */
export async function runBrowserPowCheckin(externalCheckinUrl: string): Promise<CheckinResult> {
  const base = stripTrailingSlashes((externalCheckinUrl || '').trim());
  if (!base) return { success: false, message: '外部签到站地址为空' };
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { success: false, message: '外部签到站地址无效' };
  }

  const session = assistedLoginSessions.get('linuxdo');
  if (!session) {
    return { success: false, message: 'Linux.do 辅助登录会话未注册，无法运行浏览器签到' };
  }

  return browserLane.run(async () => {
    let context;
    try {
      context = await session.browser.ensureManagedBrowserContext();
    } catch (error) {
      return { success: false, message: `无法启动受管浏览器：${describeError(error)}` };
    }
    const page = await context.newPage();
    try {
      return await runCheckin(page, origin, () => session.browser.keepAlive());
    } catch (error) {
      return { success: false, message: `浏览器签到失败：${describeError(error)}` };
    } finally {
      await page.close().catch(() => undefined);
    }
  });
}
