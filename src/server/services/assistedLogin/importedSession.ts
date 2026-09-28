/**
 * Provider sessions imported by hand instead of harvested from the managed browser.
 *
 * A Linux.do / GitHub session cookie is the only input the assisted-login handoff
 * truly needs. Servers that cannot afford a resident Chrome can therefore paste
 * the cookie once and keep re-running the handoff without a browser, which also
 * removes the Cloudflare-in-a-headless-browser problem entirely.
 */
import { eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { config } from '../../config.js';
import { db, schema } from '../../db/index.js';
import { upsertSetting } from '../../db/upsertSetting.js';
import { decryptAccountPassword, encryptAccountPassword } from '../accountCredentialService.js';
import { withExplicitProxyRequestInit } from '../siteProxy.js';
import type { AssistedLoginProvider, AssistedLoginProviderId, LoginState, ProviderHttpFetch } from './types.js';

type ProviderCookieSpec = {
  /** At least one of these must be present for the paste to be usable. */
  required: string[];
  /** Session companions worth keeping (Cloudflare clearance, CSRF carriers, ...). */
  optional: string[];
};

const PROVIDER_COOKIES: Record<AssistedLoginProviderId, ProviderCookieSpec> = {
  linuxdo: {
    required: ['_t'],
    optional: ['_forum_session', 'cf_clearance'],
  },
  github: {
    required: ['user_session', '__Host-user_session_same_site'],
    optional: ['_gh_sess', 'logged_in', 'dotcom_user'],
  },
};

const PROBE_TIMEOUT_MS = 20_000;

/**
 * Cloudflare binds `cf_clearance` to the browser that earned it, so the probe has
 * to look like that browser rather than like a script.
 */
const IMPORTED_SESSION_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export type ParsedProviderSession = {
  cookieHeader: string;
  cookieNames: string[];
  csrfToken: string | null;
};

export type ImportedProviderSession = ParsedProviderSession & {
  savedAt: string;
  /** Identity reported by the last probe that verified this session. */
  verifiedUsername: string | null;
  verifiedUserId: number | null;
};

type StoredImportedSession = {
  cookieHeaderCipher: string;
  csrfTokenCipher: string | null;
  cookieNames: string[];
  savedAt: string;
  verifiedUsername?: string | null;
  verifiedUserId?: number | null;
};

function settingKey(providerId: AssistedLoginProviderId): string {
  return `${providerId}_session_import`;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchCookie(text: string, name: string): string | null {
  const pattern = new RegExp(`(?:^|[;,\\s"'])${escapeForRegExp(name)}=([^;"'\\s]+)`);
  const match = pattern.exec(text);
  return match ? match[1].trim() || null : null;
}

function extractCsrfToken(providerId: AssistedLoginProviderId, text: string): string | null {
  const pattern = providerId === 'github'
    ? /authenticity_token["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{16,})/
    : /x-csrf-token["']?\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{16,})/i;
  return pattern.exec(text)?.[1] ?? null;
}

/**
 * Picks the one line of the paste that provider cookies should be read from.
 *
 * A multi-request "Copy all as cURL" dump also carries Cloudflare challenge
 * traffic, and the challenge host hands out its own `cf_clearance`. Collecting
 * each cookie independently from the whole paste would mix that foreign
 * clearance into the provider jar and make every probe look blocked, so the
 * scan is narrowed to one Cookie-carrying line that already holds a required
 * cookie.
 */
function selectCookieSourceLine(rawText: string, required: string[]): string | null {
  for (const line of rawText.split(/\r?\n/)) {
    const normalizedLine = line.replace(/[\^\\]/g, '');
    if (!required.some((name) => matchCookie(normalizedLine, name))) continue;
    if (/^\s*(?:-b\s|(?:-H\s+)?["']?cookie:)/i.test(normalizedLine)) return normalizedLine;
  }
  return null;
}

/**
 * Pulls the provider cookies out of whatever the operator pasted: a DevTools
 * "Copy as cURL" block, a bare `Cookie:` header, or a raw cookie string.
 *
 * cmd.exe escapes quotes, carets, and percent signs in the cURL copy, and none of
 * those characters can appear inside a cookie value, so stripping them is a safe
 * normalization before the name/value scan.
 */
export function parsePastedProviderSession(
  providerId: AssistedLoginProviderId,
  rawText: unknown,
): ParsedProviderSession | null {
  const spec = PROVIDER_COOKIES[providerId];
  if (!spec || typeof rawText !== 'string' || !rawText.trim()) return null;

  const normalized = rawText.replace(/[\^\\]/g, '');
  const source = selectCookieSourceLine(rawText, spec.required) ?? normalized;
  const collected: Array<[string, string]> = [];

  for (const name of [...spec.required, ...spec.optional]) {
    const value = matchCookie(source, name);
    if (value) collected.push([name, value]);
  }

  const hasRequired = spec.required.some((name) => collected.some(([key]) => key === name));
  if (!hasRequired) return null;

  return {
    cookieHeader: collected.map(([name, value]) => `${name}=${value}`).join('; '),
    cookieNames: collected.map(([name]) => name),
    csrfToken: extractCsrfToken(providerId, normalized),
  };
}

/** Stores the parsed session encrypted, keyed per provider. */
export async function saveImportedSession(
  providerId: AssistedLoginProviderId,
  parsed: ParsedProviderSession,
  verification?: { username: string | null; userId: number | null },
): Promise<ImportedProviderSession> {
  const savedAt = new Date().toISOString();
  const verifiedUsername = verification?.username ?? null;
  const verifiedUserId = verification?.userId ?? null;
  const row: StoredImportedSession = {
    cookieHeaderCipher: encryptAccountPassword(parsed.cookieHeader),
    csrfTokenCipher: parsed.csrfToken ? encryptAccountPassword(parsed.csrfToken) : null,
    cookieNames: parsed.cookieNames,
    savedAt,
    verifiedUsername,
    verifiedUserId,
  };
  await upsertSetting(settingKey(providerId), row);
  return { ...parsed, savedAt, verifiedUsername, verifiedUserId };
}

export async function readImportedSession(
  providerId: AssistedLoginProviderId,
): Promise<ImportedProviderSession | null> {
  const row = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, settingKey(providerId)))
    .get();
  if (!row?.value) return null;

  let stored: StoredImportedSession | null = null;
  try {
    stored = JSON.parse(row.value) as StoredImportedSession;
  } catch {
    return null;
  }
  if (!stored?.cookieHeaderCipher) return null;

  const cookieHeader = decryptAccountPassword(stored.cookieHeaderCipher);
  if (!cookieHeader) return null;

  return {
    cookieHeader,
    cookieNames: Array.isArray(stored.cookieNames) ? stored.cookieNames : [],
    csrfToken: stored.csrfTokenCipher ? decryptAccountPassword(stored.csrfTokenCipher) : null,
    savedAt: typeof stored.savedAt === 'string' ? stored.savedAt : '',
    verifiedUsername: typeof stored.verifiedUsername === 'string' ? stored.verifiedUsername : null,
    verifiedUserId: typeof stored.verifiedUserId === 'number' ? stored.verifiedUserId : null,
  };
}

export async function clearImportedSession(providerId: AssistedLoginProviderId): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, settingKey(providerId))).run();
}

/**
 * Remembers the identity reported by a successful probe, so a later transient
 * failure can keep reporting "available" with the last verified user instead of
 * surfacing as a logout.
 */
export async function recordImportedSessionVerification(
  providerId: AssistedLoginProviderId,
  verification: { username: string | null; userId: number | null },
): Promise<void> {
  const row = await db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, settingKey(providerId)))
    .get();
  if (!row?.value) return;

  let stored: StoredImportedSession | null = null;
  try {
    stored = JSON.parse(row.value) as StoredImportedSession;
  } catch {
    return;
  }
  if (!stored?.cookieHeaderCipher) return;
  if (stored.verifiedUsername === verification.username && stored.verifiedUserId === verification.userId) return;

  await upsertSetting(settingKey(providerId), {
    ...stored,
    verifiedUsername: verification.username,
    verifiedUserId: verification.userId,
  });
}

/**
 * A transient probe failure (rate limit, edge block, network error, unexpected
 * response) says nothing about the credential. The imported session was verified
 * when it was saved, so the last verified identity is kept and the failure is
 * appended as an annotation instead of surfacing as a logout. Only providers'
 * explicit rejection verdicts (e.g. 401/404) are left untouched.
 */
export function applyTransientFallback(
  state: LoginState,
  lastKnown: { verifiedUsername: string | null; verifiedUserId: number | null },
): LoginState {
  if (!state.blocked) return state;
  return {
    loggedIn: true,
    username: lastKnown.verifiedUsername,
    userId: lastKnown.verifiedUserId,
    blocked: false,
    message: `本次探测异常：${state.message || '未知错误'}；已沿用上次验证结果，登录状态不受影响`,
  };
}

/**
 * Reads the provider login state over plain HTTP. This is the browser-free path:
 * it never touches the managed Chrome, so an expired session is reported without
 * waking a browser on a server that cannot host one.
 */
export async function probeImportedSession(
  provider: AssistedLoginProvider,
  cookieHeader: string,
): Promise<LoginState> {
  const fetchWithSession: ProviderHttpFetch = async (path, options) => {
    const init = withExplicitProxyRequestInit(config.systemProxyUrl, {
      headers: {
        Accept: options?.accept || '*/*',
        'User-Agent': IMPORTED_SESSION_USER_AGENT,
        Cookie: cookieHeader,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const response = await fetch(new URL(path, provider.origin).toString(), init);
    return { status: response.status, body: await response.text() };
  };

  return provider.probeLoginStateHttp(fetchWithSession);
}
