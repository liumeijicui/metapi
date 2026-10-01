// Reads and clears one cookie in a Chromium profile's cookie store.
//
// The check-in script drives a real browser because the site refuses anything
// DevTools-driven, which also means the browser is the only place the login
// cookie exists. Chromium writes that store on a deferred timer (~30s) and does
// not flush it on exit, so the flow has to keep the window open until the value
// has landed - hence `wait`. `drop` runs first so what `wait` finds is the value
// this run wrote and not a stale one from an earlier run in the same profile.
//
// `put` is how a session that was earned outside the browser (a New API fork
// whose sign-in is a plain OAuth redirect, or a token the operator pasted) gets
// into the profile before the browser starts, so the flow lands on a signed-in
// page instead of a login form.
//
// Usage: node cookieStore.mjs drop <profileDir> <cookieName>
//        node cookieStore.mjs wait <profileDir> <cookieName> [timeoutSeconds] [mustDifferFrom]
//        node cookieStore.mjs put <profileDir> <cookie> [path] [httpOnly]
//          where <cookie> is "name=value";name2=value2" for the site's host
//
// `wait` prints "landed=<seconds>" and exits 0 once the cookie is stored, and
// exits 1 after the timeout. `mustDifferFrom` is how a seeded session is
// tracked: the planted value is already in the store, so the flow only wants to
// hear about it once the page has rotated it to something else. `drop` prints
// nothing and always exits 0: a profile that cannot be opened yet (first run)
// has nothing to clear.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, pbkdf2Sync } from 'node:crypto';

const [, , command, profileDir, cookieName, timeoutArg, extraArg] = process.argv;
// The fifth argument means something different per command (`httpOnly` for
// `put`, `mustDifferFrom` for `wait`), so it keeps a neutral name.
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

// Reads the cookie back the way Chromium wrote it. `null` means "not there
// yet": a store that is mid-write reports as such and the caller polls again.
const readCookie = async () => {
  let db = null;
  try {
    db = await openStore(true);
    if (!db) return null;
    const row = db
      .prepare('SELECT value, encrypted_value FROM cookies WHERE name = ? LIMIT 1')
      .get(cookieName);
    if (!row) return null;
    if (row.value) return row.value;
    return decryptValue(row.encrypted_value);
  } catch {
    return null;
  } finally {
    closeQuietly(db);
  }
};

// Values are sealed the way Chromium seals them when it runs with
// `--password-store=basic`: `v10` + AES-128-CBC(PKCS#7) under a key derived from
// the well-known store password. browserProfileCredential.ts reads the mirror
// image of this, so the two must stay in step.
const BASIC_STORE_PASSWORD = 'peanuts';
const BASIC_STORE_SALT = 'saltysalt';
const BASIC_STORE_IV = Buffer.alloc(16, 0x20);

const storeKey = () => pbkdf2Sync(BASIC_STORE_PASSWORD, BASIC_STORE_SALT, 1, 16, 'sha1');

function encryptValue(value) {
  const cipher = createCipheriv('aes-128-cbc', storeKey(), BASIC_STORE_IV);
  return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.from(value, 'utf8')), cipher.final()]);
}

/** Mirror image of `encryptValue`; null when the blob is not a `v10` value. */
function decryptValue(buffer) {
  if (!buffer || buffer.length <= 3 || buffer.subarray(0, 3).toString('ascii') !== 'v10') return null;
  try {
    const decipher = createDecipheriv('aes-128-cbc', storeKey(), BASIC_STORE_IV);
    return Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

if (command === 'put') {
  // Chromium stores timestamps as microseconds since 1601-01-01.
  const CHROMIUM_EPOCH_OFFSET_US = 11644473600000000n;
  const sameSiteLax = 1;
  // The planted cookie has to be a persistent one. Chromium drops session
  // cookies it did not create itself - a value with `has_expires=0` is either
  // restored from its own bookkeeping or discarded at startup - so a planted
  // session cookie silently disappears before the first request is made. The
  // sites issue this cookie with an expiry anyway, and the run replaces it with
  // whatever the server sends back, so a long fixed lifetime is a stand-in.
  const plantedLifetimeDays = 30;
  const cookiePath = (timeoutArg || '/').trim() || '/';
  const httpOnly = extraArg === 'true' ? 1 : 0;
  const domain = (process.env.CHECKIN_COOKIE_HOST || '').trim();
  const nowUs = BigInt(Date.now()) * 1000n + CHROMIUM_EPOCH_OFFSET_US;
  const expiresUs = nowUs + BigInt(plantedLifetimeDays) * 24n * 3600n * 1000000n;
  if (!domain) {
    console.error('CHECKIN_COOKIE_HOST is required for put');
    process.exit(2);
  }
  let db = null;
  try {
    db = await openStore(false);
    if (!db) {
      console.error('no cookie store to write to');
      process.exit(1);
    }
    const insert = db.prepare(
      `INSERT INTO cookies
         (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc,
          is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite,
          source_scheme, source_port, last_update_utc, source_type, has_cross_site_ancestor)
       VALUES (?, ?, '', ?, '', ?, ?, ?, 1, ?, ?, 1, 1, 1, ?, 2, 443, ?, 3, 1)`,
    );
    const remove = db.prepare('DELETE FROM cookies WHERE host_key = ? AND name = ? AND path = ?');
    let written = 0;
    for (const pair of String(cookieName || '').split(';')) {
      const index = pair.indexOf('=');
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!name || !value) continue;
      remove.run(domain, name, cookiePath);
      insert.run(
        nowUs, domain, name, encryptValue(value), cookiePath, Number(expiresUs),
        httpOnly, nowUs, sameSiteLax, nowUs,
      );
      written += 1;
    }
    console.log(`stored=${written}`);
  } catch (error) {
    console.error(`put failed: ${error?.message || error}`);
    process.exit(1);
  } finally {
    closeQuietly(db);
  }
  process.exit(0);
}

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
  const mustDifferFrom = (extraArg ?? '').trim();
  for (let elapsed = 0; elapsed <= timeoutSeconds; elapsed += 1) {
    const stored = await readCookie();
    if (stored !== null && stored !== mustDifferFrom) {
      console.log(`landed=${elapsed}`);
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.exit(1);
}

console.error(`unknown command: ${command}`);
process.exit(2);
