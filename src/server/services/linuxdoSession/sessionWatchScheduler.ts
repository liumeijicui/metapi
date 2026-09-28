import { getAssistedLoginWatcher } from '../assistedLogin/watchers.js';
import type { WatchState } from '../assistedLogin/types.js';

export type { WatchState } from '../assistedLogin/types.js';

/**
 * Back-compat facade for the Linux.do session watcher; the implementation is
 * shared with other assisted-login providers in `services/assistedLogin`.
 */
const linuxdoWatcher = getAssistedLoginWatcher('linuxdo');

export function runLinuxDoSessionWatchPass(): Promise<void> {
  return linuxdoWatcher ? linuxdoWatcher.runPass() : Promise.resolve();
}

export function readLinuxDoWatchState(): Promise<WatchState> {
  return linuxdoWatcher
    ? linuxdoWatcher.readState()
    : Promise.resolve({ lastStatus: 'unknown', lastUsername: null, lastCheckedAt: null, lastKeepAliveAt: null });
}

export function seedLinuxDoWatchBaseline(): Promise<void> {
  return linuxdoWatcher ? linuxdoWatcher.seedBaseline() : Promise.resolve();
}

export function startLinuxDoSessionWatchScheduler(): void {
  linuxdoWatcher?.start();
}

export function stopLinuxDoSessionWatchScheduler(): void {
  linuxdoWatcher?.stop();
}
