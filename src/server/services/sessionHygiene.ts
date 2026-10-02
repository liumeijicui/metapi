/**
 * Retires the sign-in sessions an account is no longer using.
 *
 * Some New API forks cap how many sessions one account may hold. The cap only
 * ever bites at the worst moment: the stored session has gone stale, so the
 * scheduled re-login runs, and the site refuses it with `409 AUTH_SESSION_LIMIT`
 * because the browser sessions from previous manual sign-ins are still counted.
 * The account then reads as unusable even though the password is right, and the
 * only way out is for the operator to sign those sessions out by hand.
 *
 * A re-login is the natural moment to clear them: it has just created a fresh
 * session, so every other entry in the list is by definition not one the
 * running system needs. The current session is never touched — losing it would
 * make the re-login pointless — and a list the site returns without marking any
 * session as current is treated as unreadable rather than guessed at.
 */
import type { PlatformAdapter, SiteSessionInfo } from './platforms/base.js';

export type SessionPruneOutcome =
  | { status: 'unsupported' }
  | { status: 'skipped'; reason: 'disabled' | 'unknown-current-session' | 'no-other-session' }
  | { status: 'pruned'; removed: number; kept: number }
  | { status: 'failed'; reason: string };

/** Reads the `sid` claim new-api puts in its access token, when it has one. */
function readSessionIdFromToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const sid = payload?.sid;
    return typeof sid === 'string' && sid.trim() ? sid.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Decides which sessions are safe to drop.
 *
 * Both signals are used: the `current` flag is what the site believes, and the
 * token's own `sid` is what this process knows. A session is only dropped when
 * *neither* identifies it as the one being used, so a site that mislabels the
 * list cannot cost the account its live credential.
 */
export function selectSessionsToRevoke(
  sessions: SiteSessionInfo[],
  currentSid: string | null,
): SiteSessionInfo[] | null {
  const identified = sessions.filter((session) => session.current || (currentSid !== null && session.sid === currentSid));
  if (identified.length === 0) return null;
  return sessions.filter((session) => !identified.includes(session));
}

export async function pruneOtherSessions(params: {
  adapter: PlatformAdapter | null | undefined;
  siteUrl: string;
  accessToken: string;
  platformUserId?: number;
  enabled?: boolean;
}): Promise<SessionPruneOutcome> {
  const { adapter, siteUrl, accessToken, platformUserId } = params;
  if (params.enabled === false) return { status: 'skipped', reason: 'disabled' };
  if (!adapter?.listSessions || !adapter.revokeSession) return { status: 'unsupported' };

  let sessions: SiteSessionInfo[] | null;
  try {
    sessions = await adapter.listSessions(siteUrl, accessToken, platformUserId);
  } catch (err: any) {
    return { status: 'failed', reason: err?.message || 'list failed' };
  }
  if (!sessions || sessions.length === 0) return { status: 'skipped', reason: 'no-other-session' };

  const targets = selectSessionsToRevoke(sessions, readSessionIdFromToken(accessToken));
  if (!targets) return { status: 'skipped', reason: 'unknown-current-session' };
  if (targets.length === 0) return { status: 'skipped', reason: 'no-other-session' };

  let removed = 0;
  for (const session of targets) {
    try {
      if (await adapter.revokeSession(siteUrl, accessToken, platformUserId, session.sid)) removed += 1;
    } catch {
      // One stubborn entry must not stop the rest: the cap counts whatever is
      // left, and a partial cleanup still buys the account room to sign in.
    }
  }

  return { status: 'pruned', removed, kept: sessions.length - removed };
}
