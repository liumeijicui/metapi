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

function siteOrigin(value?: string | null): string | null {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase() || null;
  }
}

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

/**
 * Same as `applyRotatedCredential`, but only for a credential that carries the
 * cookie already.
 *
 * The plain helper appends the pair when it is missing, which is right for a
 * captured cookie header and wrong for everything else: appending
 * `new_api_refresh=…` to a JWT or an API key turns a working credential into
 * garbage. A token that never carried the cookie was not the one an exchange
 * spent, so it is returned untouched.
 */
export function applyRotatedCredentialIfCarried(
  token: string,
  rotated: { cookieName: string; value: string } | undefined,
): string {
  if (!rotated?.value) return token;
  if (!COOKIE_PAIR_PATTERN(rotated.cookieName).test(token)) return token;
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

/**
 * Persists a rotation for a caller that cannot name the account row.
 *
 * The exchange retires the secret it spends and returns the replacement only in
 * `Set-Cookie`, so an exchange performed outside an account credential context
 * has nowhere to put that replacement: the row keeps the retired value and the
 * account reads as `AUTH_SESSION_REVOKED` on the next request, forever. Probes
 * issued before a row exists, or by a route that never learned which account it
 * is holding, are exactly this shape, so the row is recovered from the secret
 * being spent instead.
 *
 * The match is exact on the cookie value, and the write stays a compare-and-set,
 * so only the account that actually held the spent secret can be rewritten.
 */
export async function persistRotatedRefreshCookieByCredentials(input: {
  cookieName: string;
  previousValue: string;
  nextValue: string;
  siteUrl?: string | null;
}): Promise<{ status: RotatedCookiePersistResult; accountId?: number }> {
  if (!input.previousValue || !input.nextValue || input.previousValue === input.nextValue) {
    return { status: 'skipped_stale' };
  }

  const origin = siteOrigin(input.siteUrl);
  try {
    const rows = await db
      .select({
        id: schema.accounts.id,
        siteId: schema.accounts.siteId,
        accessToken: schema.accounts.accessToken,
        siteUrl: schema.sites.url,
      })
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .all();

    const candidates = rows.filter((row) => {
      if (!String(row.accessToken || '').includes(input.previousValue)) return false;
      if (!origin) return true;
      return siteOrigin(row.siteUrl) === origin;
    });
    if (candidates.length === 0) return { status: 'skipped_no_account' };

    let last: RotatedCookiePersistResult = 'skipped_no_account';
    for (const row of candidates) {
      const status = await persistRotatedRefreshCookie({
        accountId: row.id,
        siteId: row.siteId,
        cookieName: input.cookieName,
        previousValue: input.previousValue,
        nextValue: input.nextValue,
      });
      if (status === 'updated') return { status, accountId: row.id };
      last = status;
    }
    return { status: last };
  } catch {
    return { status: 'error' };
  }
}
