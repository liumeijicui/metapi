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
 * make the re-login pointless — and it is identified from the credential's own
 * session id rather than from the site's `current` flag, because that flag is
 * computed per fork and one that points at somebody else's session would make
 * the cleanup sign the account out.
 */
import type { PlatformAdapter, SiteSessionInfo } from './platforms/base.js';

export type SessionPruneOutcome =
  | { status: 'unsupported' }
  | { status: 'skipped'; reason: 'disabled' | 'unknown-current-session' | 'no-other-session' }
  | { status: 'pruned'; removed: number; kept: number }
  | { status: 'failed'; reason: string };

/**
 * Reads the session id out of whichever credential the account holds.
 *
 * Two shapes identify themselves. An access token carries the id in its `sid`
 * claim; a refresh cookie is literally `<sid>.<secret>`, which is how the
 * server splits it back apart. Anything else — an opaque session cookie from an
 * older fork — identifies nothing, and the caller has to treat the list as
 * unreadable rather than guess.
 */
export function readSessionIdFromToken(token: string): string | null {
  const trimmed = (token || '').trim();
  if (!trimmed) return null;

  const cookieMatch = trimmed.match(/(?:^|;\s*)new_api_refresh=([^;]+)/i);
  if (cookieMatch) {
    const sid = cookieMatch[1].trim().split('.')[0]?.trim();
    return sid || null;
  }

  const parts = trimmed.split('.');
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
 * The credential's own session id is the primary signal: it says exactly which
 * entry belongs to the account right now. The site's `current` flag is only
 * ever used to *keep more*, never to justify a delete, because a fork that
 * computes it differently (or against a session that is already gone) would
 * otherwise have the cleanup sign the account out — which is the very outage
 * this feature exists to prevent. With no id to match on, nothing is deleted.
 */
export function selectSessionsToRevoke(
  sessions: SiteSessionInfo[],
  currentSid: string | null,
): SiteSessionInfo[] | null {
  if (!currentSid) return null;
  const mine = sessions.filter((session) => session.sid === currentSid);
  if (mine.length === 0) return null;
  const identified = sessions.filter((session) => session.sid === currentSid || session.current);
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

  const currentSid = readSessionIdFromToken(accessToken);
  const targets = selectSessionsToRevoke(sessions, currentSid);
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

  // Confirm the account did not just sign itself out. A fork whose list cannot
  // be trusted is exactly the case this guards, and the operator needs to hear
  // about it rather than discover it as a dead credential later. The second
  // read reuses the access token from the first exchange, so it costs no
  // additional rotation.
  try {
    const remaining = await adapter.listSessions(siteUrl, accessToken, platformUserId);
    if (remaining && !remaining.some((session) => session.sid === currentSid)) {
      return { status: 'failed', reason: 'current-session-lost' };
    }
  } catch {
    // A site that will not answer the follow-up read is left with the count
    // above; the credential itself was not touched by the check.
  }

  return { status: 'pruned', removed, kept: sessions.length - removed };
}
