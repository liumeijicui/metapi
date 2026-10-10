import { describe, expect, it } from 'vitest';
import { getAssistedLoginProvider, assistedLoginProviderIds } from './index.js';

describe('assisted login provider registry', () => {
  it('registers both Linux.do and GitHub providers', () => {
    expect(assistedLoginProviderIds.slice().sort()).toEqual(['github', 'linuxdo']);
  });

  it('resolves providers case-insensitively and rejects unknown ids', () => {
    expect(getAssistedLoginProvider('GitHub')?.id).toBe('github');
    expect(getAssistedLoginProvider(' linuxdo ')?.id).toBe('linuxdo');
    expect(getAssistedLoginProvider('gitlab')).toBeNull();
  });

  it('scopes provider handoff hosts so a GitHub tab is never treated as Linux.do', () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;
    const github = getAssistedLoginProvider('github')!;

    expect(linuxdo.isHandoffHost('linux.do')).toBe(true);
    expect(linuxdo.isHandoffHost('connect.linux.do')).toBe(true);
    expect(linuxdo.isHandoffHost('github.com')).toBe(false);

    expect(github.isHandoffHost('github.com')).toBe(true);
    expect(github.isHandoffHost('gist.github.com')).toBe(true);
    expect(github.isHandoffHost('linux.do')).toBe(false);
  });

  it('keeps Linux.do community links from being mistaken for the login entry', () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;
    const github = getAssistedLoginProvider('github')!;

    // A landing page announcing a topic with the URL as its anchor text satisfies
    // both the name pattern and the href selector, so the content paths must be denied.
    const entryLike = 'https://linux.do/t/topic/2527847/2117';
    expect(linuxdo.entryNamePattern.test(entryLike)).toBe(true);
    expect(linuxdo.entrySelectors.some((selector) => selector.includes('linux.do'))).toBe(true);
    expect(linuxdo.entryAnchorDenyHrefSubstrings).toContain('linux.do/t/');

    // The real OAuth entry is not on a content path, so it survives the filter.
    for (const entry of ['Continue with LinuxDO', 'https://connect.linux.do/oauth2/authorize?client_id=x']) {
      expect(linuxdo.entryAnchorDenyHrefSubstrings!.some((prefix) => entry.includes(prefix))).toBe(false);
    }

    // GitHub's own content links (repos, users) are its entry targets, so it declares none.
    expect(github.entryAnchorDenyHrefSubstrings ?? []).toEqual([]);
  });

  it('uses separate browser profiles per provider', () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;
    const github = getAssistedLoginProvider('github')!;

    expect(linuxdo.origin).not.toBe(github.origin);
    expect(linuxdo.entryNamePattern.test('使用 Linux.do 登录')).toBe(true);
    expect(github.entryNamePattern.test('Sign in with GitHub')).toBe(true);
    expect(github.entryNamePattern.test('使用 Linux.do 登录')).toBe(false);
  });
});

describe('assisted login HTTP probe error mapping', () => {
  it('reports a Linux.do rate limit as blocked, never as a logout', async () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;

    const state = await linuxdo.probeLoginStateHttp(async () => ({ status: 429, body: 'Just a moment...' }));

    expect(state.loggedIn).toBe(false);
    expect(state.blocked).toBe(true);
    expect(state.message).toContain('HTTP 429');
  });

  it('reports unexpected Linux.do gateway errors as blocked, not as a logout', async () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;

    const state = await linuxdo.probeLoginStateHttp(async () => ({ status: 502, body: '' }));

    expect(state.loggedIn).toBe(false);
    expect(state.blocked).toBe(true);
  });

  it('still reports a rejected Linux.do token (404) as a logged-out session', async () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;

    const state = await linuxdo.probeLoginStateHttp(async () => ({ status: 404, body: '' }));

    expect(state.loggedIn).toBe(false);
    expect(state.blocked).toBe(false);
  });

  it('reports an unrecognised Linux.do 200 body as blocked instead of logged out', async () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;

    const state = await linuxdo.probeLoginStateHttp(async () => ({ status: 200, body: '<html>challenge</html>' }));

    expect(state.loggedIn).toBe(false);
    expect(state.blocked).toBe(true);
  });

  it('reads the username from a valid Linux.do current.json response', async () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;

    const state = await linuxdo.probeLoginStateHttp(async () => ({
      status: 200,
      body: JSON.stringify({ current_user: { username: 'alice', id: 7 } }),
    }));

    expect(state).toMatchObject({ loggedIn: true, username: 'alice', userId: 7, blocked: false });
  });

  it('reports GitHub server errors and network failures as blocked, not as a logout', async () => {
    const github = getAssistedLoginProvider('github')!;

    const serverError = await github.probeLoginStateHttp(async () => ({ status: 500, body: '' }));
    expect(serverError.loggedIn).toBe(false);
    expect(serverError.blocked).toBe(true);

    const networkError = await github.probeLoginStateHttp(async () => {
      throw new Error('network down');
    });
    expect(networkError.loggedIn).toBe(false);
    expect(networkError.blocked).toBe(true);
  });

  it('marks only explicit auth rejections (401) as logged out', async () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;
    const github = getAssistedLoginProvider('github')!;

    const linuxdo401 = await linuxdo.probeLoginStateHttp(async () => ({ status: 401, body: '' }));
    expect(linuxdo401.loggedIn).toBe(false);
    expect(linuxdo401.blocked).toBe(false);
    expect(linuxdo401.message).toContain('401');

    const github401 = await github.probeLoginStateHttp(async () => ({ status: 401, body: '' }));
    expect(github401.loggedIn).toBe(false);
    expect(github401.blocked).toBe(false);
    expect(github401.message).toContain('401');
  });
});
