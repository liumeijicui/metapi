import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { config } from '../../config.js';
import { resolveChromiumExecutable } from './chromeLocator.js';
import { PORT_WINDOW_SIZE, isWithinWindow, resolvePortWindow } from './profilePorts.js';

export type ManagedBrowserState = {
  running: boolean;
  executablePath: string | null;
  executableLabel: string | null;
  profileDir: string;
  debuggingPort: number | null;
  connected: boolean;
  launchedAt: string | null;
};

export type ManagedBrowser = {
  getBrowserProfileDir: () => string;
  getBrowserExecutablePath: () => string;
  hasManagedBrowserProfile: () => boolean;
  ensureManagedBrowserContext: () => Promise<BrowserContext>;
  getManagedBrowserState: () => ManagedBrowserState;
  closeManagedBrowser: () => Promise<void>;
};

type Runtime = {
  process: ChildProcess | null;
  browser: Browser | null;
  context: BrowserContext | null;
  port: number | null;
  launchedAt: number | null;
};

const PORT_FILE_NAME = 'debug-port';

/**
 * A cookie that records which profile owns a browser. It lives on a hostname
 * that is never navigated to, so it is invisible to the sites the user visits
 * and cannot be confused with a real login cookie.
 */
const PROFILE_MARKER_COOKIE = 'metapi_profile';
const PROFILE_MARKER_HOST = 'metapi-profile.invalid';
const PROFILE_MARKER_URL = `http://${PROFILE_MARKER_HOST}/`;
const PROFILE_MARKER_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

/**
 * Each assisted-login provider owns a dedicated Chrome profile so that two
 * providers cannot clobber each other's cookies (for example a Linux.do
 * session and a GitHub session in the same profile).
 *
 * Each profile also owns a *disjoint* debugging-port window (see profilePorts).
 * A single shared search range would let two profiles remember the same port,
 * after which the loser reattached to the winner's browser and reported a false
 * "session expired" because it was reading the wrong cookie jar.
 */
export function createManagedBrowser(input: {
  profileDirName: string;
  executableEnvVar: string;
  missingBrowserMessage: (platform: NodeJS.Platform) => string;
}): ManagedBrowser {
  const runtime: Runtime = {
    process: null,
    browser: null,
    context: null,
    port: null,
    launchedAt: null,
  };

  let launchPromise: Promise<BrowserContext> | null = null;

  function getBrowserProfileDir(): string {
    return resolve(config.dataDir, input.profileDirName);
  }

  function getPortFilePath(): string {
    return join(getBrowserProfileDir(), PORT_FILE_NAME);
  }

  function getPortWindowBase(): number {
    return resolvePortWindow(input.profileDirName);
  }

  /**
   * The managed Chrome outlives a metapi restart, so the debugging port has to be
   * remembered on disk. Otherwise a restart would pick a fresh port, fail to see
   * the live browser, and then trip over the locked user-data-dir.
   */
  function readRememberedPort(): number | null {
    try {
      const raw = readFileSync(getPortFilePath(), 'utf8').trim();
      const port = Number.parseInt(raw, 10);
      return Number.isFinite(port) && port > 0 && port < 65536 ? port : null;
    } catch {
      return null;
    }
  }

  function rememberPort(port: number): void {
    try {
      writeFileSync(getPortFilePath(), String(port), 'utf8');
    } catch {
      // best effort: a missing port file only costs a cold start
    }
  }

  function getBrowserExecutablePath(): string {
    return (process.env[input.executableEnvVar] || '').trim();
  }

  /** Stamps the running profile so later reattaches can prove it is ours. */
  async function installProfileMarker(context: BrowserContext): Promise<void> {
    try {
      const cookies = await context.cookies();
      const existing = cookies.find((cookie) => cookie.name === PROFILE_MARKER_COOKIE);
      if (existing?.value === input.profileDirName) return;
      await context.addCookies([
        {
          name: PROFILE_MARKER_COOKIE,
          value: input.profileDirName,
          url: PROFILE_MARKER_URL,
          expires: Math.floor(Date.now() / 1000) + PROFILE_MARKER_TTL_SECONDS,
        },
      ]);
    } catch {
      // A missing marker only weakens the check; it never blocks the browser.
    }
  }

  /**
   * Answers "is the browser listening on this port actually this profile's?".
   *
   * `foreign` means positive evidence of a different metapi profile, which is
   * exactly the case that used to masquerade as an expired Linux.do session.
   * Anything else is adopted: browsers started by an older metapi version carry
   * no marker, and the disjoint port windows already make a mix-up impossible.
   */
  async function verifyAdoption(context: BrowserContext): Promise<'match' | 'unknown' | 'foreign'> {
    try {
      const cookies = await context.cookies();
      const marker = cookies.find((cookie) => cookie.name === PROFILE_MARKER_COOKIE);
      if (marker) return marker.value === input.profileDirName ? 'match' : 'foreign';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  async function tryAttach(port: number, timeoutMs: number): Promise<Browser | null> {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: timeoutMs });
      return browser.isConnected() ? browser : null;
    } catch {
      return null;
    }
  }

  /**
   * Searches only inside this profile's own window. Falling outside it would
   * reintroduce the cross-profile mix-up the windows exist to prevent.
   */
  async function findFreePort(windowBase: number): Promise<number> {
    for (let offset = 0; offset < PORT_WINDOW_SIZE; offset += 1) {
      const port = windowBase + offset;
      const available = await new Promise<boolean>((resolvePort) => {
        const probe = createServer();
        probe.once('error', () => resolvePort(false));
        probe.once('listening', () => probe.close(() => resolvePort(true)));
        probe.listen(port, '127.0.0.1');
      });
      if (available) return port;
    }
    throw new Error(
      `No free local port available in the managed browser window ${windowBase}-${windowBase + PORT_WINDOW_SIZE - 1}`,
    );
  }

  function buildLaunchArgs(port: number, profileDir: string): string[] {
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=TranslateUI',
      '--window-size=1280,900',
    ];

    const proxyUrl = (config.systemProxyUrl || '').trim();
    if (proxyUrl) {
      args.push(`--proxy-server=${proxyUrl}`);
      if (proxyUrl.startsWith('socks')) {
        args.push('--proxy-bypass-list=<-loopback>');
      }
    }

    args.push('about:blank');
    return args;
  }

  async function connectWithRetry(port: number, deadlineMs: number): Promise<Browser> {
    let lastError: unknown = null;
    while (Date.now() < deadlineMs) {
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5_000 });
      } catch (error) {
        lastError = error;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`Unable to attach to the managed browser: ${(lastError as Error)?.message || 'timeout'}`);
  }

  function isRuntimeUsable(): boolean {
    return !!runtime.browser?.isConnected() && !!runtime.context;
  }

  async function ensureManagedBrowserContext(): Promise<BrowserContext> {
    if (isRuntimeUsable()) return runtime.context as BrowserContext;
    if (launchPromise) return launchPromise;

    launchPromise = (async () => {
      const located = resolveChromiumExecutable(process.platform, process.env, getBrowserExecutablePath());
      if (!located) {
        throw new Error(input.missingBrowserMessage(process.platform));
      }

      // Cloudflare rejects headless Chromium, so the browser must run with a real
      // display. A headless Linux server therefore needs a virtual display.
      if (process.platform === 'linux' && !process.env.DISPLAY) {
        throw new Error(
          '当前环境没有可用显示器（DISPLAY 为空）。Cloudflare 校验要求有界面的浏览器，'
            + '请在服务器上安装并使用虚拟显示运行，例如：apt install -y xvfb && xvfb-run -a npm start',
        );
      }

      const profileDir = getBrowserProfileDir();
      mkdirSync(profileDir, { recursive: true });

      const windowBase = getPortWindowBase();

      // Reattach to a browser left running by a previous metapi process before
      // starting a new one; its profile directory is locked, so a second launch
      // would fail outright. The remembered port is only trusted inside this
      // profile's window, and the live browser must also prove it is ours.
      const rememberedPort = readRememberedPort();
      if (rememberedPort && isWithinWindow(rememberedPort, windowBase)) {
        const adopted = await tryAttach(rememberedPort, 3_000);
        const adoptedContext = adopted?.contexts()[0];
        if (adopted && adoptedContext) {
          const identity = await verifyAdoption(adoptedContext);
          if (identity !== 'foreign') {
            await installProfileMarker(adoptedContext);
            runtime.process = null;
            runtime.browser = adopted;
            runtime.context = adoptedContext;
            runtime.port = rememberedPort;
            runtime.launchedAt = Date.now();
            return adoptedContext;
          }
          // Another metapi profile owns this port. Disconnecting only closes the
          // CDP link (it does not kill that browser), so its real profile and
          // cookies stay untouched.
          await adopted.close().catch(() => undefined);
        }
      }

      const port = await findFreePort(windowBase);
      rememberPort(port);

      const child = spawn(located.path, buildLaunchArgs(port, profileDir), {
        detached: false,
        stdio: 'ignore',
      });
      child.on('exit', () => {
        runtime.process = null;
        runtime.browser = null;
        runtime.context = null;
        runtime.port = null;
        runtime.launchedAt = null;
      });
      child.unref();

      const browser = await connectWithRetry(port, Date.now() + 30_000);
      const context = browser.contexts()[0];
      if (!context) {
        throw new Error('Managed browser started without a usable browser context');
      }

      await installProfileMarker(context);

      runtime.process = child;
      runtime.browser = browser;
      runtime.context = context;
      runtime.port = port;
      runtime.launchedAt = Date.now();
      return context;
    })();

    try {
      return await launchPromise;
    } finally {
      launchPromise = null;
    }
  }

  function getManagedBrowserState(): ManagedBrowserState {
    const located = resolveChromiumExecutable(process.platform, process.env, getBrowserExecutablePath());
    return {
      // An adopted browser has no local child handle but is definitely running.
      running: (!!runtime.process && !runtime.process.killed) || isRuntimeUsable(),
      executablePath: located?.path ?? null,
      executableLabel: located?.label ?? null,
      profileDir: getBrowserProfileDir(),
      debuggingPort: runtime.port,
      connected: isRuntimeUsable(),
      launchedAt: runtime.launchedAt ? new Date(runtime.launchedAt).toISOString() : null,
    };
  }

  async function closeManagedBrowser(): Promise<void> {
    const browser = runtime.browser;
    runtime.browser = null;
    runtime.context = null;
    runtime.port = null;
    runtime.launchedAt = null;

    try {
      await browser?.close();
    } catch {
      // ignore: browser may already be gone
    }

    const child = runtime.process;
    runtime.process = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
  }

  return {
    getBrowserProfileDir,
    getBrowserExecutablePath,
    // True once the browser has been launched at least once, which is the cheapest
    // durable signal that the user has actually adopted this feature.
    hasManagedBrowserProfile: () => readRememberedPort() !== null,
    ensureManagedBrowserContext,
    getManagedBrowserState,
    closeManagedBrowser,
  };
}
