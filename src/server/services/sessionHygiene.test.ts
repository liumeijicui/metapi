import { describe, expect, it, vi } from 'vitest';
import { pruneOtherSessions, selectSessionsToRevoke } from './sessionHygiene.js';

/** Builds a token whose `sid` claim is `sid`, the way new-api mints them. */
function tokenWithSid(sid: string): string {
  const payload = Buffer.from(JSON.stringify({ sid, sub: '38' })).toString('base64url');
  return `header.${payload}.signature`;
}

function adapter(overrides: Record<string, unknown> = {}) {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    revokeSession: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as any;
}

describe('sessionHygiene', () => {
  it('keeps the session the site calls current and drops the rest', () => {
    const sessions = [
      { sid: 'mine', current: true },
      { sid: 'other', current: false },
    ];
    expect(selectSessionsToRevoke(sessions, 'mine')?.map((s) => s.sid)).toEqual(['other']);
  });

  it('trusts the token sid when the site mislabels the list', () => {
    // A fork that forgets to set `current` would otherwise have every session
    // look droppable — including the one this process is holding.
    const sessions = [
      { sid: 'mine', current: false },
      { sid: 'other', current: false },
    ];
    expect(selectSessionsToRevoke(sessions, 'mine')?.map((s) => s.sid)).toEqual(['other']);
  });

  it('refuses to choose when nothing identifies the live session', () => {
    const sessions = [
      { sid: 'one', current: false },
      { sid: 'two', current: false },
    ];
    expect(selectSessionsToRevoke(sessions, null)).toBeNull();
  });

  it('reports unsupported rather than failing on a site without the API', async () => {
    const outcome = await pruneOtherSessions({
      adapter: { login: vi.fn() } as any,
      siteUrl: 'https://example.com',
      accessToken: tokenWithSid('mine'),
    });
    expect(outcome).toEqual({ status: 'unsupported' });
  });

  it('revokes every non-current session', async () => {
    const mock = adapter({
      listSessions: vi.fn().mockResolvedValue([
        { sid: 'mine', current: true },
        { sid: 'a', current: false },
        { sid: 'b', current: false },
      ]),
    });

    const outcome = await pruneOtherSessions({
      adapter: mock,
      siteUrl: 'https://example.com',
      accessToken: tokenWithSid('mine'),
      platformUserId: 38,
    });

    expect(outcome).toEqual({ status: 'pruned', removed: 2, kept: 1 });
    expect(mock.revokeSession).toHaveBeenCalledWith('https://example.com', expect.any(String), 38, 'a');
    expect(mock.revokeSession).toHaveBeenCalledWith('https://example.com', expect.any(String), 38, 'b');
    expect(mock.revokeSession).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'mine');
  });

  it('still counts the sessions it did remove when one delete fails', async () => {
    const mock = adapter({
      listSessions: vi.fn().mockResolvedValue([
        { sid: 'mine', current: true },
        { sid: 'a', current: false },
        { sid: 'b', current: false },
      ]),
      revokeSession: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });

    const outcome = await pruneOtherSessions({
      adapter: mock,
      siteUrl: 'https://example.com',
      accessToken: tokenWithSid('mine'),
    });

    expect(outcome).toEqual({ status: 'pruned', removed: 1, kept: 2 });
  });

  it('does nothing when the account opted out', async () => {
    const mock = adapter();
    const outcome = await pruneOtherSessions({
      adapter: mock,
      siteUrl: 'https://example.com',
      accessToken: tokenWithSid('mine'),
      enabled: false,
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(mock.listSessions).not.toHaveBeenCalled();
  });

  it('skips an account that only ever had the one session', async () => {
    const mock = adapter({ listSessions: vi.fn().mockResolvedValue([{ sid: 'mine', current: true }]) });
    const outcome = await pruneOtherSessions({
      adapter: mock,
      siteUrl: 'https://example.com',
      accessToken: tokenWithSid('mine'),
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'no-other-session' });
  });
});
