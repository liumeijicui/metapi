import { createAssistedLoginWatcher, type AssistedLoginWatchHandle } from './sessionWatchScheduler.js';
import { assistedLoginSessions } from './sessionRegistry.js';
import type { AssistedLoginProviderId } from './types.js';

const watchers = new Map<AssistedLoginProviderId, AssistedLoginWatchHandle>();

for (const session of assistedLoginSessions.all()) {
  // GitHub is the one provider whose session the server can re-earn on its own,
  // because the operator can store a username/password for it. Every other
  // provider is cookie-only, so the watcher keeps reporting the expiry.
  const renewSession = session.provider.id === 'github'
    ? async () => {
      const { renewGitHubSessionIfConfigured } = await import('./sites/githubPasswordLogin.js');
      return renewGitHubSessionIfConfigured();
    }
    : undefined;
  watchers.set(session.provider.id, createAssistedLoginWatcher(session, { renewSession }));
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
