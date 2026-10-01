import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  settingsRowMock,
  upsertMock,
  deleteRunMock,
  saveSessionMock,
  ensureContextMock,
  pageMock,
} = vi.hoisted(() => ({
  settingsRowMock: vi.fn(),
  upsertMock: vi.fn(),
  deleteRunMock: vi.fn(),
  saveSessionMock: vi.fn(),
  ensureContextMock: vi.fn(),
  pageMock: {
    goto: vi.fn(),
    evaluate: vi.fn(),
    locator: vi.fn(),
    fill: vi.fn(),
    click: vi.fn(),
    waitForLoadState: vi.fn(),
    waitForTimeout: vi.fn(),
    close: vi.fn(),
    url: vi.fn(() => 'https://github.com/login'),
  },
}));

vi.mock('../../../db/index.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ get: settingsRowMock }) }) }),
    delete: () => ({ where: () => ({ run: deleteRunMock }) }),
  },
  schema: { settings: { key: 'key' } },
}));
vi.mock('../../../db/upsertSetting.js', () => ({ upsertSetting: upsertMock }));
// The credential cipher needs the deployment key, which a unit test does not have.
vi.mock('../../accountCredentialService.js', () => ({
  encryptAccountPassword: (value: string) => `cipher:${value}`,
  decryptAccountPassword: (value: string) => (value.startsWith('cipher:') ? value.slice(7) : null),
}));
vi.mock('../importedSession.js', () => ({ saveImportedSession: saveSessionMock }));
vi.mock('../sessionRegistry.js', () => ({
  assistedLoginSessions: {
    get: () => ({ browser: { ensureManagedBrowserContext: ensureContextMock } }),
  },
}));

import {
  clearGitHubAutoLogin,
  getGitHubAutoLoginState,
  renewGitHubSession,
  renewGitHubSessionIfConfigured,
  saveGitHubAutoLogin,
} from './githubPasswordLogin.js';

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    value: JSON.stringify({
      username: 'liumeijicui',
      passwordCipher: 'cipher:liyaodong7238508',
      savedAt: '2026-10-01T00:00:00.000Z',
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastMessage: null,
      consecutiveFailures: 0,
      ...overrides,
    }),
  };
}

/** A signed-in page renders the `user-login` meta tag; a signed-out one has none. */
function signedIn(login: string) {
  pageMock.evaluate.mockResolvedValue({ login, userId: '112645313' });
}

function signedOut() {
  pageMock.evaluate.mockResolvedValue({ login: '', userId: '' });
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureContextMock.mockResolvedValue({
    newPage: async () => pageMock,
    cookies: async () => [
      { name: 'user_session', value: 'session-value' },
      { name: 'logged_in', value: 'yes' },
    ],
  });
  pageMock.locator.mockReturnValue({ count: async () => 1 });
  pageMock.close.mockResolvedValue(undefined);
  pageMock.waitForLoadState.mockResolvedValue(undefined);
  upsertMock.mockResolvedValue(undefined);
  saveSessionMock.mockResolvedValue(undefined);
});

describe('GitHub password keep-alive credentials', () => {
  it('reports unconfigured when nothing has been stored', async () => {
    settingsRowMock.mockResolvedValue(undefined);
    expect(await getGitHubAutoLoginState()).toMatchObject({ configured: false, username: null });
  });

  it('refuses to store a half-filled credential pair', async () => {
    await expect(saveGitHubAutoLogin({ username: 'liumeijicui', password: '' })).rejects.toThrow('密码');
    await expect(saveGitHubAutoLogin({ username: '  ', password: 'secret' })).rejects.toThrow('用户名');
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('stores the password encrypted and never returns it', async () => {
    settingsRowMock.mockResolvedValue(undefined);
    await saveGitHubAutoLogin({ username: 'liumeijicui', password: 'liyaodong7238508' });
    const written = upsertMock.mock.calls[0][1];
    expect(written.passwordCipher).toBe('cipher:liyaodong7238508');
    expect(JSON.stringify(written)).not.toContain('"password":');
  });

  it('clears the stored credentials', async () => {
    await clearGitHubAutoLogin();
    expect(deleteRunMock).toHaveBeenCalled();
  });
});

describe('GitHub session renewal', () => {
  it('skips without touching the browser when no credentials are stored', async () => {
    settingsRowMock.mockResolvedValue(undefined);
    const outcome = await renewGitHubSessionIfConfigured();
    expect(outcome).toMatchObject({ ok: false, skipped: true });
    expect(ensureContextMock).not.toHaveBeenCalled();
  });

  it('types the stored password and keeps the session the browser earns', async () => {
    settingsRowMock.mockResolvedValue(storedRow());
    signedIn('liumeijicui');

    const outcome = await renewGitHubSession({ force: true });

    expect(outcome).toMatchObject({ ok: true, username: 'liumeijicui' });
    expect(pageMock.goto).toHaveBeenCalledWith('https://github.com/login', expect.anything());
    // The session was already live, so the form must not have been replayed.
    expect(pageMock.fill).not.toHaveBeenCalled();
    expect(saveSessionMock).toHaveBeenCalledWith(
      'github',
      expect.objectContaining({ cookieHeader: 'user_session=session-value; logged_in=yes' }),
      { username: 'liumeijicui', userId: 112645313 },
    );
  });

  it('replays the credentials when the page is signed out', async () => {
    settingsRowMock.mockResolvedValue(storedRow());
    pageMock.evaluate
      .mockResolvedValueOnce({ login: '', userId: '' })
      .mockResolvedValueOnce({ login: 'liumeijicui', userId: '112645313' });

    const outcome = await renewGitHubSession({ force: true });

    expect(outcome.ok).toBe(true);
    expect(pageMock.fill).toHaveBeenCalledWith('#login_field', 'liumeijicui');
    expect(pageMock.fill).toHaveBeenCalledWith('#password', 'liyaodong7238508');
    expect(pageMock.click).toHaveBeenCalledWith('input[type="submit"][name="commit"]');
    expect(saveSessionMock).toHaveBeenCalled();
  });

  it('names 2FA as the blocker instead of blaming the password', async () => {
    settingsRowMock.mockResolvedValue(storedRow());
    signedOut();
    // Signed out before the submit, still signed out after it (GitHub answered
    // with a 2FA wall), then the refusal snapshot the classifier reads.
    pageMock.evaluate
      .mockResolvedValueOnce({ login: '', userId: '' })
      .mockResolvedValueOnce({ login: '', userId: '' })
      .mockResolvedValueOnce({
        url: 'https://github.com/sessions/two-factor',
        text: 'Two-factor authentication',
        flash: '',
      });

    const outcome = await renewGitHubSession({ force: true });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('两步验证');
    expect(saveSessionMock).not.toHaveBeenCalled();
  });

  it('cools down instead of replaying a password GitHub just refused', async () => {
    const recentAttempt = new Date(Date.now() - 60_000).toISOString();
    settingsRowMock.mockResolvedValue(storedRow({
      lastAttemptAt: recentAttempt,
      consecutiveFailures: 1,
    }));

    const outcome = await renewGitHubSession();

    expect(outcome).toMatchObject({ ok: false, skipped: true });
    expect(outcome.message).toContain('冷却');
    expect(ensureContextMock).not.toHaveBeenCalled();
  });

  it('backs off for hours once GitHub has refused twice', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    settingsRowMock.mockResolvedValue(storedRow({
      lastAttemptAt: twoHoursAgo,
      consecutiveFailures: 2,
    }));

    const outlook = await getGitHubAutoLoginState();
    expect(outlook.consecutiveFailures).toBe(2);
    // Two hours is past the transient cooldown but well inside the refusal one.
    expect(outlook.nextAttemptAt).not.toBeNull();
    expect(Date.parse(outlook.nextAttemptAt!)).toBeGreaterThan(Date.now());
  });
});
