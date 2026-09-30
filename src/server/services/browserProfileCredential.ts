/**
 * Reads a session cookie back out of a Chromium profile.
 *
 * Some New API forks gate the login endpoint behind Cloudflare Turnstile, so a
 * password login over plain HTTP cannot succeed and the only way to obtain a
 * session is the real browser the check-in already drives. That browser does
 * receive the site's refresh cookie, and it is sitting in the profile's cookie
 * database afterwards; this module turns it back into a credential the HTTP
 * path can exchange (`/api/user/auth/refresh`) and rotate as usual.
 *
 * The check-in browser is launched with `--password-store=basic`, so Chromium
 * seals cookie values with a key derived from the well-known store password
 * rather than the OS keyring. The format is `v10` + AES-128-CBC(PKCS#7) with
 * that key and a fixed IV.
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import Database from 'better-sqlite3';

const BASIC_STORE_PASSWORD = 'peanuts';
const BASIC_STORE_SALT = 'saltysalt';
const KEY_LENGTH = 16;
const IV = Buffer.alloc(16, 0x20);
const V10_PREFIX = 'v10';

export type BrowserProfileCookieQuery = {
  /** Chromium user-data-dir that was used for the run. */
  profileDir: string;
  /** Cookie host, e.g. `api.example.com` (a leading dot is added when needed). */
  host: string;
  /** Cookie name, e.g. `new_api_refresh`. */
  name: string;
};

/** Decrypts one `v10` cookie value produced with Chromium's basic password store. */
export function decryptBasicStoreValue(encrypted: Buffer): string | null {
  if (encrypted.length <= V10_PREFIX.length) return null;
  if (encrypted.subarray(0, V10_PREFIX.length).toString('ascii') !== V10_PREFIX) return null;
  try {
    const key = pbkdf2Sync(BASIC_STORE_PASSWORD, BASIC_STORE_SALT, 1, KEY_LENGTH, 'sha1');
    const decipher = createDecipheriv('aes-128-cbc', key, IV);
    // Chromium pads with PKCS#7 but the block may also be exactly sized, so the
    // padding is stripped by hand instead of by the cipher.
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(encrypted.subarray(V10_PREFIX.length)), decipher.final()]);
    const padding = plain[plain.length - 1];
    const unpadded = padding >= 1 && padding <= 16 ? plain.subarray(0, plain.length - padding) : plain;
    const value = unpadded.toString('utf8');
    return value || null;
  } catch {
    return null;
  }
}

/**
 * Returns the cookie value the most recent run stored, or null when the profile
 * has no such cookie. Chromium keeps the database open, so the file is copied
 * out first and the copy is always removed.
 */
export function readBrowserProfileCookie(query: BrowserProfileCookieQuery): string | null {
  // Network-service builds keep the same database one level deeper.
  const source = ['Default/Cookies', 'Default/Network/Cookies']
    .map((relative) => join(query.profileDir, relative))
    .find((candidate) => existsSync(candidate));
  if (!source) return null;

  const stagingDir = mkdtempSync(join(tmpdir(), 'metapi-profile-cookie-'));
  const copy = join(stagingDir, 'Cookies');
  let connection: Database.Database | null = null;
  try {
    copyFileSync(source, copy);
  } catch {
    rmSync(stagingDir, { recursive: true, force: true });
    return null;
  }

  try {
    connection = new Database(copy, { readonly: true, fileMustExist: true });
    const host = query.host.replace(/^\./, '');
    const row = connection
      .prepare(
        `SELECT encrypted_value AS encrypted FROM cookies
         WHERE name = ? AND (host_key = ? OR host_key = ?)
         ORDER BY last_update_utc DESC LIMIT 1`,
      )
      .get(query.name, host, `.${host}`) as { encrypted?: Buffer } | undefined;
    if (!row?.encrypted) return null;
    return decryptBasicStoreValue(Buffer.from(row.encrypted));
  } catch {
    return null;
  } finally {
    connection?.close();
    rmSync(stagingDir, { recursive: true, force: true });
  }
}
