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

  it('uses separate browser profiles per provider', () => {
    const linuxdo = getAssistedLoginProvider('linuxdo')!;
    const github = getAssistedLoginProvider('github')!;

    expect(linuxdo.origin).not.toBe(github.origin);
    expect(linuxdo.entryNamePattern.test('使用 Linux.do 登录')).toBe(true);
    expect(github.entryNamePattern.test('Sign in with GitHub')).toBe(true);
    expect(github.entryNamePattern.test('使用 Linux.do 登录')).toBe(false);
  });
});
