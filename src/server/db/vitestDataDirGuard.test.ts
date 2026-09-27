import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  guardRepoDatabaseUnderVitest,
  isRepoDefaultSqlitePath,
} from './vitestDataDirGuard.js';

describe('vitest repo database guard', () => {
  it('detects the repository default database path', () => {
    expect(isRepoDefaultSqlitePath(resolve('./data/hub.db'))).toBe(true);
    expect(isRepoDefaultSqlitePath(resolve(tmpdir(), 'metapi-vitest-x', 'hub.db'))).toBe(false);
    expect(isRepoDefaultSqlitePath(':memory:')).toBe(false);
  });

  it('redirects the repository database to an isolated temp path under vitest', () => {
    const guarded = guardRepoDatabaseUnderVitest(resolve('./data/hub.db'));

    expect(isRepoDefaultSqlitePath(guarded)).toBe(false);
    expect(guarded).toContain(tmpdir());
    expect(guarded).toContain('metapi-vitest');
  });

  it('leaves non-repository paths untouched', () => {
    const explicit = resolve(tmpdir(), 'metapi-explicit', 'hub.db');
    expect(guardRepoDatabaseUnderVitest(explicit)).toBe(explicit);
  });
});
