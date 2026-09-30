// Reads and clears one cookie in a Chromium profile's cookie store.
//
// The check-in script drives a real browser because the site refuses anything
// DevTools-driven, which also means the browser is the only place the login
// cookie exists. Chromium writes that store on a deferred timer (~30s) and does
// not flush it on exit, so the flow has to keep the window open until the value
// has landed - hence `wait`. `drop` runs first so what `wait` finds is the value
// this run wrote and not a stale one from an earlier run in the same profile.
//
// Usage: node cookieStore.mjs drop <profileDir> <cookieName>
//        node cookieStore.mjs wait <profileDir> <cookieName> [timeoutSeconds]
//
// `wait` prints "landed=<seconds>" and exits 0 once the cookie is stored, and
// exits 1 after the timeout. `drop` prints nothing and always exits 0: a profile
// that cannot be opened yet (first run) has nothing to clear.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , command, profileDir, cookieName, timeoutArg] = process.argv;
if (!command || !profileDir || !cookieName) {
  console.error('usage: cookieStore.mjs drop|wait <profileDir> <cookieName> [timeoutSeconds]');
  process.exit(2);
}

// Network-service builds keep the same database one level deeper.
const cookieDbPath = () => {
  for (const candidate of ['Default/Cookies', 'Default/Network/Cookies']) {
    const full = join(profileDir, candidate);
    if (existsSync(full)) return full;
  }
  return null;
};

const openStore = async (readonly) => {
  const path = cookieDbPath();
  if (!path) return null;
  const { default: Database } = await import('better-sqlite3');
  return new Database(path, { readonly, fileMustExist: true });
};

const closeQuietly = (db) => {
  try {
    db?.close();
  } catch {
    // The database disappears with the profile on a failed run; nothing to do.
  }
};

const hasCookie = async () => {
  let db = null;
  try {
    db = await openStore(true);
    if (!db) return false;
    return !!db
      .prepare('SELECT 1 FROM cookies WHERE name = ? LIMIT 1')
      .get(cookieName);
  } catch {
    // A store that is mid-write reports as "not yet" and the caller polls again.
    return false;
  } finally {
    closeQuietly(db);
  }
};

if (command === 'drop') {
  let db = null;
  try {
    db = await openStore(false);
    db?.prepare('DELETE FROM cookies WHERE name = ?').run(cookieName);
  } catch {
    // Best effort: a missing or locked store simply leaves the old value behind.
  } finally {
    closeQuietly(db);
  }
  process.exit(0);
}

if (command === 'wait') {
  const timeoutSeconds = Number.parseInt(timeoutArg ?? '60', 10) || 60;
  for (let elapsed = 0; elapsed <= timeoutSeconds; elapsed += 1) {
    if (await hasCookie()) {
      console.log(`landed=${elapsed}`);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.exit(1);
}

console.error(`unknown command: ${command}`);
process.exit(2);
