/**
 * Remote-browser login for providers whose session can only be earned in a real
 * browser.
 *
 * The server already owns a managed Chrome for assisted login, but nothing could
 * previously show that browser to the operator, so the only way to hand over a
 * provider session was to paste a cookie header copied from another machine. On a
 * phone that is impractical.
 *
 * This module exposes the running browser as a pollable JPEG frame plus an input
 * channel. The client fetches a frame, maps a tap to browser coordinates, and
 * posts the resulting click or keystroke back. Frames are polled over plain HTTP
 * rather than streamed over a socket: a login form needs well under one frame per
 * second, and HTTP keeps the feature on the existing authenticated API surface
 * instead of adding a second, hand-rolled WebSocket transport.
 *
 * The page is deliberately separate from the session's probe tab. `getLoginState`
 * navigates the probe tab to the provider origin on every check, which would
 * yank a half-filled login form out from under the operator.
 */
import type { Page } from 'playwright-core';
import { assistedLoginSessions } from './sessionRegistry.js';
import {
  getProviderRequiredCookieNames,
  probeImportedSession,
  saveImportedSession,
  type ParsedProviderSession,
} from './importedSession.js';
import type { AssistedLoginProviderId } from './types.js';

const UNKNOWN_PROVIDER_MESSAGE = '未知的快捷登录提供方';
const NAVIGATION_TIMEOUT_MS = 45_000;
/** A login window left open forever would pin a Chromium on a small server. */
const IDLE_CLOSE_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;
const FRAME_QUALITY = 55;
const MAX_TEXT_LENGTH = 512;
const MAX_COORDINATE = 20_000;

/** Only keys a login form actually needs, so a bad key name cannot throw mid-typing. */
const ALLOWED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ' ',
]);

export type LiveLoginInput =
  | { type: 'click'; x: number; y: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'down' }
  | { type: 'up' }
  | { type: 'scroll'; deltaY: number }
  | { type: 'text'; value: string }
  | { type: 'key'; value: string };

type LiveLoginSession = {
  providerId: string;
  page: Page;
  startedAt: number;
  lastTouchAt: number;
};

const liveSessions = new Map<string, LiveLoginSession>();
let sweeper: NodeJS.Timeout | null = null;

function providerSession(providerId: string) {
  const session = assistedLoginSessions.get(providerId);
  if (!session) throw new Error(UNKNOWN_PROVIDER_MESSAGE);
  return session;
}

function requireLive(providerId: string): LiveLoginSession {
  const live = liveSessions.get(providerId);
  if (!live || live.page.isClosed()) {
    throw new Error('远程登录窗口未打开或已关闭，请重新启动');
  }
  live.lastTouchAt = Date.now();
  return live;
}

function clampCoordinate(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(Math.round(parsed), 0), MAX_COORDINATE);
}

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [providerId, live] of liveSessions) {
      if (now - live.lastTouchAt > IDLE_CLOSE_MS) void stopLiveLogin(providerId);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref?.();
}

export async function startLiveLogin(
  providerId: string,
  targetUrl?: string,
): Promise<{ url: string; title: string }> {
  const session = providerSession(providerId);
  // One live window per provider: a second start replaces the first rather than
  // leaving an orphaned page holding a half-finished login.
  await stopLiveLogin(providerId);

  const context = await session.browser.ensureManagedBrowserContext();
  const page = await context.newPage();
  const fallback = `${session.provider.origin}${session.provider.loginPath || '/'}`;
  const requested = (targetUrl || '').trim();
  const url = requested || fallback;

  await page
    .goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
    .catch(() => undefined);

  const live: LiveLoginSession = {
    providerId,
    page,
    startedAt: Date.now(),
    lastTouchAt: Date.now(),
  };
  page.on('close', () => {
    if (liveSessions.get(providerId) === live) liveSessions.delete(providerId);
  });
  liveSessions.set(providerId, live);
  ensureSweeper();

  return { url: page.url() || url, title: await page.title().catch(() => '') };
}

export function getLiveLoginStatus(providerId: string): {
  active: boolean;
  url: string | null;
  startedAt: string | null;
} {
  const live = liveSessions.get(providerId);
  if (!live || live.page.isClosed()) return { active: false, url: null, startedAt: null };
  return {
    active: true,
    url: live.page.url(),
    startedAt: new Date(live.startedAt).toISOString(),
  };
}

export async function getLiveLoginFrame(
  providerId: string,
): Promise<{ frame: Buffer; url: string } | null> {
  const live = liveSessions.get(providerId);
  if (!live || live.page.isClosed()) return null;
  live.lastTouchAt = Date.now();
  // Painting a frame is activity: keep the underlying Chrome from being reaped
  // while the operator is still working in it.
  providerSession(providerId).browser.keepAlive();
  const frame = await live.page.screenshot({ type: 'jpeg', quality: FRAME_QUALITY });
  return { frame, url: live.page.url() };
}

export async function sendLiveLoginInput(
  providerId: string,
  rawInput: unknown,
): Promise<{ url: string }> {
  const live = requireLive(providerId);
  providerSession(providerId).browser.keepAlive();
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const kind = String(input.type || '');
  const page = live.page;

  switch (kind) {
    case 'click':
      await page.mouse.click(clampCoordinate(input.x), clampCoordinate(input.y));
      break;
    case 'move':
      await page.mouse.move(clampCoordinate(input.x), clampCoordinate(input.y));
      break;
    case 'down':
      await page.mouse.down();
      break;
    case 'up':
      await page.mouse.up();
      break;
    case 'scroll': {
      const delta = typeof input.deltaY === 'number' ? input.deltaY : Number.parseFloat(String(input.deltaY ?? '0'));
      await page.mouse.wheel(0, Number.isFinite(delta) ? delta : 0);
      break;
    }
    case 'text': {
      const value = typeof input.value === 'string' ? input.value : '';
      if (!value) break;
      await page.keyboard.insertText(value.slice(0, MAX_TEXT_LENGTH));
      break;
    }
    case 'key': {
      const value = typeof input.value === 'string' ? input.value : '';
      if (!ALLOWED_KEYS.has(value)) throw new Error(`不支持的按键：${value}`);
      await page.keyboard.press(value);
      break;
    }
    default:
      throw new Error(`不支持的输入类型：${kind}`);
  }

  return { url: page.url() };
}

/**
 * Harvests the provider cookies the operator just earned and stores them as the
 * imported session, so every later handoff runs browser-free.
 */
export async function finishLiveLogin(providerId: string): Promise<{
  loggedIn: boolean;
  saved: boolean;
  verified: boolean;
  username: string | null;
  message: string;
}> {
  const session = providerSession(providerId);
  const context = await session.browser.ensureManagedBrowserContext();

  // Cheap local gate first. `getLoginState` loads the provider's home page, and
  // the client polls this endpoint while someone is typing a password, so an
  // unconditional probe would hammer github.com/login from a hidden tab.
  const currentCookies = await context.cookies(session.provider.origin);
  const required = getProviderRequiredCookieNames(session.provider.id);
  const hasSessionCookie = required.some((name) =>
    currentCookies.some((cookie) => cookie.name === name && cookie.value));
  if (!hasSessionCookie) {
    return {
      loggedIn: false,
      saved: false,
      verified: false,
      username: null,
      message: '尚未检测到登录，请在窗口中完成登录后重试',
    };
  }

  const state = await session.getLoginState();
  if (!state.loggedIn) {
    return {
      loggedIn: false,
      saved: false,
      verified: false,
      username: null,
      message: state.message || '尚未检测到登录，请在窗口中完成登录后重试',
    };
  }

  // The jar was already read for the gate above; re-reading it here would only
  // widen the window in which a rotation could land between the two reads.
  const usable = currentCookies.filter((cookie) => cookie.name && cookie.value);
  if (usable.length === 0) {
    return {
      loggedIn: true,
      saved: false,
      verified: false,
      username: state.username,
      message: '浏览器中未找到可用的 Cookie',
    };
  }

  const cookieHeader = usable.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  const parsed: ParsedProviderSession = {
    cookieHeader,
    cookieNames: usable.map((cookie) => cookie.name),
    csrfToken: null,
  };
  // Verification is reported, not enforced: the browser just proved the login by
  // rendering a signed-in page, so a transient probe failure must not discard it.
  const verification = await probeImportedSession(session.provider, cookieHeader).catch(() => null);
  await saveImportedSession(
    providerId as AssistedLoginProviderId,
    parsed,
    { username: state.username, userId: state.userId },
  );

  return {
    loggedIn: true,
    saved: true,
    verified: verification?.loggedIn ?? false,
    username: state.username,
    message: `已保存 ${session.provider.label} 会话`,
  };
}

export async function stopLiveLogin(providerId: string): Promise<void> {
  const live = liveSessions.get(providerId);
  if (!live) return;
  liveSessions.delete(providerId);
  await live.page.close().catch(() => undefined);
}
