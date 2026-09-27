/**
 * Persists a rotated refresh cookie back onto its account row.
 *
 * `new_api_refresh` is a rolling credential: every successful exchange returns a
 * brand-new secret in `Set-Cookie` and retires the old one. Anything that parses
 * only the response body silently throws that secret away, so the account works
 * exactly once and then reports AUTH_SESSION_REVOKED forever.
 *
 * The write is a compare-and-set: it only lands when the stored credential still
 * contains the secret we just spent, so two concurrent exchanges cannot clobber
 * each other's newer value.
 */
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';

export type RotatedCookiePersistInput = {
  /** Absent while a row is still being created; there is nothing to update yet. */
  accountId?: number;
  siteId: number;
  cookieName: string;
  previousValue: string;
  nextValue: string;
};

export type RotatedCookiePersistResult = 'updated' | 'skipped_no_account' | 'skipped_stale' | 'error';

const COOKIE_PAIR_PATTERN = (name: string) => new RegExp(`(^|;\\s*)${name}=([^;]*)`, 'i');

function replaceCookieValue(cookieHeader: string, name: string, value: string): string {
  const pattern = COOKIE_PAIR_PATTERN(name);
  if (!pattern.test(cookieHeader)) return `${cookieHeader}; ${name}=${value}`;

  return cookieHeader.split(/;\s*/).map((pair) => {
    const eq = pair.indexOf('=');
    if (eq <= 0) return pair;
    const pairName = pair.slice(0, eq).trim();
    return pairName.toLowerCase() === name.toLowerCase() ? `${pairName}=${value}` : pair;
  }).join('; ');
}

/**
 * Rewrites `token` so it carries the newest secret observed during the flow.
 *
 * Bind/verify chains exchange a rolling credential more than once, and only the
 * last exchange holds a live secret. The value captured from the browser is dead
 * by then, so storing it verbatim produces an account that fails on first use.
 */
export function applyRotatedCredential(
  token: string,
  rotated: { cookieName: string; value: string } | undefined,
): string {
  if (!rotated?.value) return token;
  return replaceCookieValue(token, rotated.cookieName, rotated.value);
}

export async function persistRotatedRefreshCookie(
  input: RotatedCookiePersistInput,
): Promise<RotatedCookiePersistResult> {
  if (!input.nextValue || input.nextValue === input.previousValue) return 'skipped_stale';
  if (!input.accountId) return 'skipped_no_account';

  try {
    const account = await db.select().from(schema.accounts)
      .where(and(
        eq(schema.accounts.id, input.accountId),
        eq(schema.accounts.siteId, input.siteId),
      ))
      .get();
    if (!account) return 'skipped_no_account';

    const current = String(account.accessToken || '');
    // Another exchange already stored a newer secret; keep theirs.
    if (input.previousValue && !current.includes(input.previousValue)) return 'skipped_stale';

    const next = replaceCookieValue(current, input.cookieName, input.nextValue);
    await db.update(schema.accounts)
      .set({ accessToken: next, updatedAt: new Date().toISOString() })
      .where(eq(schema.accounts.id, input.accountId))
      .run();
    return 'updated';
  } catch {
    return 'error';
  }
}
