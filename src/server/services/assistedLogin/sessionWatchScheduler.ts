import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { sendNotification } from '../notifyService.js';
import { createAssistedLoginSession } from './sessionService.js';
import { probeImportedSession, readImportedSession } from './importedSession.js';
import type { AssistedLoginProviderId, LoginState, WatchState } from './types.js';

const SESSION_WATCH_INTERVAL_MS = 30 * 60 * 1000;
const SETTLE_TIMEOUT_MS = 90_000;

function buildUsernameFingerprint(username: string | null): string {
  if (!username) return '';
  return createHash('sha256').update(username).digest('hex').slice(0, 16);
}

async function readWatchState(key: string): Promise<WatchState> {
  const row = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  if (!row?.value) {
    return { lastStatus: 'unknown', lastUsername: null, lastCheckedAt: null };
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<WatchState>;
    const lastStatus = parsed.lastStatus === 'logged_in' || parsed.lastStatus === 'logged_out'
      ? parsed.lastStatus
      : 'unknown';
    return {
      lastStatus,
      lastUsername: typeof parsed.lastUsername === 'string' ? parsed.lastUsername : null,
      lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : null,
    };
  } catch {
    return { lastStatus: 'unknown', lastUsername: null, lastCheckedAt: null };
  }
}

async function writeWatchState(key: string, state: WatchState): Promise<void> {
  await upsertSetting(key, state);
}

function sessionStateKey(id: AssistedLoginProviderId): string {
  return `${id}_session_watch_state`;
}

export type AssistedLoginWatchHandle = {
  id: AssistedLoginProviderId;
  label: string;
  readState: () => Promise<WatchState>;
  runPass: () => Promise<void>;
  seedBaseline: (state?: LoginState) => Promise<void>;
  start: () => void;
  stop: () => void;
};

/**
 * Watches one provider's persisted session so an expiry can be reported instead
 * of silently breaking every dependent site's assisted sign-in.
 */
export function createAssistedLoginWatcher(
  session: ReturnType<typeof createAssistedLoginSession>,
): AssistedLoginWatchHandle {
  const { provider, browser } = session;
  const key = sessionStateKey(provider.id);
  let timer: ReturnType<typeof setInterval> | null = null;
  let passInFlight: Promise<void> | null = null;

  /**
   * Resolves the live login state without forcing a browser to exist.
   *
   * An imported session is probed over plain HTTP, so a server that cannot host
   * Chrome still reports a real status instead of spawning a browser every tick.
   * A browser-held session is only checked while that browser is already
   * attached: a background tick must never launch one.
   */
  async function readLoginState(): Promise<LoginState | null> {
    const imported = await readImportedSession(provider.id);
    if (imported) {
      try {
        return await probeImportedSession(provider, imported.cookieHeader);
      } catch {
        return null;
      }
    }

    // The managed browser is never launched from a background tick. Restarting it
    // to keep watching is exactly the resident-Chrome cost the imported session
    // path exists to avoid, so a closed browser simply ends the watch.
    if (!browser.getManagedBrowserState().connected) return null;

    try {
      return await session.getLoginState();
    } catch {
      return null;
    }
  }

  async function runPass(): Promise<void> {
    const previous = await readWatchState(key);

    // Only police sessions the user actually established. Without this, a fresh
    // install would either spawn a browser or probe nothing on every tick.
    const state = await readLoginState();
    if (!state) return;

    // An edge block is infrastructure noise, not a credential expiry. Keep the
    // last known status so a transient block cannot masquerade as a logout.
    if (state.blocked) return;

    const nextStatus = state.loggedIn ? 'logged_in' : 'logged_out';
    const nextFingerprint = buildUsernameFingerprint(state.username);

    await writeWatchState(key, {
      lastStatus: nextStatus,
      lastUsername: nextFingerprint || previous.lastUsername,
      lastCheckedAt: new Date().toISOString(),
    });

    if (previous.lastStatus === 'logged_in' && nextStatus === 'logged_out') {
      await sendNotification(
        `${provider.label} 会话已失效`,
        `${provider.label} 登录状态已失效，依赖该会话的站点快捷登录将无法自动完成。\n`
          + `请打开 metapi 的「${provider.label} 快捷登录」页面，重新粘贴一次浏览器 Cookie 导入会话即可恢复。`,
        'warning',
      );
    }
  }

  function schedulePass(): void {
    if (passInFlight) return;
    passInFlight = runPass()
      .catch(() => undefined)
      .finally(() => {
        passInFlight = null;
      });
  }

  return {
    id: provider.id,
    label: provider.label,
    readState: () => readWatchState(key),
    runPass,
    /**
     * Refresh the baseline when a login is observed as healthy, so the next pass
     * compares against the current session instead of a stale one. A caller that
     * already probed the session passes that state to avoid a duplicate request.
     */
    seedBaseline: async (state?: LoginState) => {
      const resolved = state ?? (await readLoginState());
      if (!resolved || resolved.blocked) return;
      await writeWatchState(key, {
        lastStatus: resolved.loggedIn ? 'logged_in' : 'logged_out',
        lastUsername: buildUsernameFingerprint(resolved.username) || (await readWatchState(key)).lastUsername,
        lastCheckedAt: new Date().toISOString(),
      });
    },
    start: () => {
      if (timer) return;
      timer = setInterval(schedulePass, SESSION_WATCH_INTERVAL_MS);
      timer.unref?.();

      // Seed the baseline shortly after boot so a restart does not fire a false
      // "session expired" notification before the first real check.
      setTimeout(schedulePass, SETTLE_TIMEOUT_MS).unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
  };
}
