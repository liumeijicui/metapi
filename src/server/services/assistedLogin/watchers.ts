import { createAssistedLoginWatcher, type AssistedLoginWatchHandle } from './sessionWatchScheduler.js';
import { assistedLoginSessions } from './sessionRegistry.js';
import type { AssistedLoginProviderId } from './types.js';

const watchers = new Map<AssistedLoginProviderId, AssistedLoginWatchHandle>();

for (const session of assistedLoginSessions.all()) {
  watchers.set(session.provider.id, createAssistedLoginWatcher(session));
}

export function getAssistedLoginWatcher(id: string): AssistedLoginWatchHandle | null {
  const normalized = (id || '').trim().toLowerCase() as AssistedLoginProviderId;
  return watchers.get(normalized) || null;
}

export function assistedLoginWatcherIds(): AssistedLoginProviderId[] {
  return [...watchers.keys()];
}

export function startAssistedLoginWatchSchedulers(): void {
  for (const watcher of watchers.values()) watcher.start();
}

export function stopAssistedLoginWatchSchedulers(): void {
  for (const watcher of watchers.values()) watcher.stop();
}
