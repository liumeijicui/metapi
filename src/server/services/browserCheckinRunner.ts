import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CheckinResult } from './platforms/base.js';
import { resolveChromiumExecutable } from './assistedLogin/chromeLocator.js';

/**
 * Runs a check-in inside a real browser on a virtual X display.
 *
 * Some New API forks answer the check-in endpoint with a Cloudflare Turnstile
 * challenge that only a browser can satisfy, and the same sites also refuse
 * DevTools/CDP-driven sessions. metapi therefore drives the flow the same way a
 * person would: a browser window on an X display, synthetic pointer and
 * keyboard input, and screenshots read back as pixels to see the page state.
 *
 * The mechanics live in `scripts/checkin-browser/` so the flow can be changed
 * without touching server code; this module only decides whether the machine
 * can run it and turns its verdict into a `CheckinResult`.
 */

export type BrowserCheckinOutcome =
  | { kind: 'result'; result: CheckinResult; logDir: string; profileDir: string }
  | { kind: 'unavailable'; reason: string };

export type BrowserCheckinInput = {
  siteUrl: string;
  username: string;
  password: string;
  /** Stable per-site key so the browser profile (and its login) is reused. */
  profileKey: string;
  /** Directory the runner creates per-run log/screenshot subfolders in. */
  logDir: string;
  /**
   * Name of the cookie the script must leave in the profile before it exits.
   * Omit it when the caller has no use for the login session; the run is then
   * shorter, because it does not wait for Chromium to commit its cookie store.
   */
  cookieName?: string | null;
  /**
   * Session cookie the caller already holds, in `Cookie`-style form
   * (`new_api_refresh=<value>`). Seeding it into the profile before the browser
   * starts is what lets a site whose sign-in is a plain OAuth redirect reach the
   * check-in card: the run only has to clear the Turnstile widget, and the
   * username/password below are never typed.
   */
  sessionCredential?: string | null;
  proxyUrl?: string | null;
  timeoutMs?: number;
};

type RawCheckinVerdict = {
  ok: boolean;
  already: boolean;
  detail: string;
};

const SCRIPT_RELATIVE_PATH = 'scripts/checkin-browser/newapi-x11-checkin.sh';
const DEFAULT_TIMEOUT_MS = 7 * 60_000;

function findOnPath(binary: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH || '';
  for (const entry of pathValue.split(':')) {
    const candidate = join(entry || '/', binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveScriptPath(): string | null {
  const candidates = [
    resolve(process.cwd(), SCRIPT_RELATIVE_PATH),
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../', SCRIPT_RELATIVE_PATH),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Reports why this machine cannot run a browser check-in, or null when it can.
 *
 * The reason is deliberately user-facing: it explains which package is missing
 * on the server so the failure can be fixed without reading this module.
 */
export function browserCheckinUnavailableReason(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform !== 'linux') {
    return '浏览器签到仅在 Linux 服务器上可用（需要 Xvfb + chromium + xdotool）';
  }
  if (!resolveScriptPath()) return '缺少浏览器签到脚本 scripts/checkin-browser/newapi-x11-checkin.sh';
  for (const [binary, hint] of [
    ['bash', 'bash'],
    ['xdotool', 'xdotool'],
    ['xwd', 'xorg-x11-apps'],
  ] as const) {
    if (!findOnPath(binary, env)) return `未安装 ${binary}（软件包：${hint}）`;
  }
  const hasDisplay = !!(env.DISPLAY || '').trim();
  if (!hasDisplay && !findOnPath('Xvfb', env)) {
    return '既没有可用的 DISPLAY，也没有安装 Xvfb（软件包：xorg-x11-server-Xvfb）';
  }
  const executable = resolveChromiumExecutable('linux', env, env.CHECKIN_BROWSER_PATH);
  if (!executable) return '未找到 chromium，可安装或设置 CHECKIN_BROWSER_PATH 指定路径';
  return null;
}

/** Parses the `METAPI_CHECKIN_RESULT=...` verdict line the script prints. */
export function parseCheckinResultLine(stdout: string): RawCheckinVerdict | null {
  const lines = (stdout || '').split(/\r?\n/).reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('METAPI_CHECKIN_RESULT=')) continue;
    try {
      const parsed = JSON.parse(trimmed.slice('METAPI_CHECKIN_RESULT='.length)) as Partial<RawCheckinVerdict>;
      return {
        ok: parsed.ok === true,
        already: parsed.already === true,
        detail: typeof parsed.detail === 'string' ? parsed.detail : 'unknown',
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Reads one `name=value` pair out of a `Cookie`-style header. */
function readCookieValue(credential: string, name: string): string | null {
  if (!name) return null;
  const match = new RegExp(`(^|;\\s*)${name}=([^;]*)`, 'i').exec(credential);
  return match ? match[2].trim() : null;
}

/** Where Chromium keeps a profile's cookies, across both store layouts. */
function cookieStorePaths(profileDir: string): string[] {
  return [join(profileDir, 'Default', 'Cookies'), join(profileDir, 'Default', 'Network', 'Cookies')];
}

/**
 * Opens a profile once so Chromium creates its cookie store.
 *
 * A profile that has never been started has nowhere to plant a session, and a
 * store written from the outside while Chromium is up is ignored and then
 * overwritten, so the plant below needs a profile that has been opened at least
 * once and is now closed. The start is a throwaway: it is killed by the timeout
 * and the flow then writes into the store it left behind.
 */
function primeProfileStore(executablePath: string, profileDir: string): boolean {
  if (cookieStorePaths(profileDir).some((path) => existsSync(path))) return true;
  try {
    spawnSync(executablePath, [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--password-store=basic',
      '--window-size=400,300',
      'about:blank',
    ], { timeout: 15_000, killSignal: 'SIGKILL', stdio: 'ignore' });
  } catch {
    // A browser that refuses to start leaves no store; the caller falls back
    // to the login path.
  }
  return cookieStorePaths(profileDir).some((path) => existsSync(path));
}

/**
 * Plants an already-earned session in a Chromium profile.
 *
 * Returns true only when at least one cookie was written, which is also the
 * signal that the site can skip its login form.
 */
function seedProfileCookies(
  scriptPath: string,
  profileDir: string,
  siteUrl: string,
  credential: string,
  executablePath: string,
): boolean {
  let host = '';
  let path = '/';
  try {
    host = new URL(siteUrl).hostname;
  } catch {
    return false;
  }
  primeProfileStore(executablePath, profileDir);
  // `new_api_refresh` is path-scoped by the sites that issue it; every other
  // cookie in the credential is scoped to the whole origin. The name is
  // duplicated from browserSessionCredential.ts on purpose: importing it back
  // would close a module cycle.
  if (credential.includes('new_api_refresh=')) path = '/api/user/auth';
  try {
    const result = spawnSync(
      process.execPath,
      [join(dirname(scriptPath), 'cookieStore.mjs'), 'put', profileDir, credential, path, 'true'],
      { env: { ...process.env, CHECKIN_COOKIE_HOST: host }, encoding: 'utf8', timeout: 20_000 },
    );
    if (result.status === 0) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Turns the script verdict into the shared check-in result shape.
 *
 * An "already checked in" day is reported as a non-success carrying the
 * already-checked wording, because the caller classifies the message and keeps
 * treating that day as done.
 */
export function mapCheckinVerdict(verdict: RawCheckinVerdict): CheckinResult {
  if (verdict.ok && verdict.already) {
    return { success: false, message: 'already checked in (browser check-in)' };
  }
  if (verdict.ok) {
    return { success: true, message: '浏览器签到成功（已通过站点人机校验）' };
  }
  return { success: false, message: `浏览器签到未完成：${verdict.detail}` };
}

let runQueue: Promise<unknown> = Promise.resolve();

/**
 * Serializes browser runs: they share one X display and one Chromium profile
 * per site, and two windows on the same display would fight over input focus.
 */
export async function runBrowserCheckin(input: BrowserCheckinInput): Promise<BrowserCheckinOutcome> {
  const unavailable = browserCheckinUnavailableReason();
  if (unavailable) return { kind: 'unavailable', reason: unavailable };

  const scriptPath = resolveScriptPath();
  if (!scriptPath) return { kind: 'unavailable', reason: 'missing browser check-in script' };

  const run = runQueue.then(() => executeBrowserCheckin(input, scriptPath));
  runQueue = run.catch(() => undefined);
  return run;
}

async function executeBrowserCheckin(
  input: BrowserCheckinInput,
  scriptPath: string,
): Promise<BrowserCheckinOutcome> {
  const executable = resolveChromiumExecutable('linux', process.env, process.env.CHECKIN_BROWSER_PATH);
  if (!executable) return { kind: 'unavailable', reason: 'chromium not found' };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const baseDir = resolve(input.logDir);
  const logDir = join(baseDir, 'runs', `${input.profileKey}-${stamp}`);
  const profileDir = join(baseDir, 'profiles', input.profileKey);
  mkdirSync(logDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CHECKIN_SITE_URL: input.siteUrl,
    CHECKIN_USERNAME: input.username,
    CHECKIN_PASSWORD: input.password,
    CHECKIN_PROFILE_DIR: profileDir,
    CHECKIN_LOG_DIR: logDir,
    CHECKIN_HELPER: join(dirname(scriptPath), 'regionStats.mjs'),
    CHROMIUM_BIN: executable.path,
    NODE_BIN: process.execPath,
  };
  const cookieName = (input.cookieName || '').trim();
  if (cookieName) env.CHECKIN_COOKIE_NAME = cookieName;

  // A caller that already holds a session (a token the operator pasted, or the
  // OAuth handshake this account signed in with) hands it over here. Writing it
  // into the profile first means the browser boots straight into the site
  // instead of the sign-in form, which matters when the site has no password
  // field to drive. Best effort: a first run on a fresh profile still has no
  // cookie store to write to, and the script's own login path covers that.
  const sessionCredential = (input.sessionCredential || '').trim();
  const sessionSeeded = sessionCredential
    ? seedProfileCookies(scriptPath, profileDir, input.siteUrl, sessionCredential, executable.path)
    : false;
  if (sessionSeeded) {
    // A seeded profile opens on the signed-in page, so the script must not fall
    // back to typing a sign-in form that these builds do not have.
    env.CHECKIN_SESSION_SEEDED = '1';
    // `new_api_refresh` is rolling: the site rotates it on the first exchange
    // the page makes, and only the rotated value is still good. Handing the
    // planted value to the script lets it tell "the cookie is there" (the value
    // we wrote) apart from "the page signed in and stored a new one".
    const seededValue = readCookieValue(sessionCredential, cookieName);
    if (seededValue) env.CHECKIN_COOKIE_PREVIOUS = seededValue;
  }
  const proxyUrl = (input.proxyUrl || '').trim();
  if (proxyUrl) env.CHECKIN_PROXY_URL = proxyUrl;

  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
  const outcome = await new Promise<{ stdout: string; stderr: string; timedOut: boolean }>((resolveRun) => {
    const child = spawn('bash', [scriptPath], {
      cwd: dirname(scriptPath),
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (target: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (target === 'out') stdout = (stdout + text).slice(-16_384);
      else stderr = (stderr + text).slice(-16_384);
    };
    child.stdout?.on('data', (chunk: Buffer) => append('out', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('err', chunk));

    const timer = setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      resolveRun({ stdout, stderr, timedOut: true });
    }, timeoutMs);

    child.on('error', () => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, timedOut: false });
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, timedOut: false });
    });
  });

  const verdict = parseCheckinResultLine(outcome.stdout);
  if (!verdict) {
    const detail = outcome.timedOut ? 'timeout' : 'no_verdict';
    return {
      kind: 'result',
      result: { success: false, message: `浏览器签到未完成：${detail}` },
      logDir,
      profileDir,
    };
  }
  return { kind: 'result', result: mapCheckinVerdict(verdict), logDir, profileDir };
}
