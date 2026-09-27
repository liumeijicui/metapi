import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { threadId } from 'node:worker_threads';

/**
 * True when the current process is a vitest worker.
 */
export function isVitestRuntime(): boolean {
  if ((process.env.VITEST_POOL_ID || '').trim()) return true;
  if ((process.env.VITEST_WORKER_ID || '').trim()) return true;
  const runtimeArgs = [...process.argv, ...process.execArgv]
    .map((value) => String(value || '').toLowerCase());
  return runtimeArgs.some((value) => value.includes('vitest'));
}

export function isRepoDefaultSqlitePath(sqlitePath: string): boolean {
  if (!sqlitePath || sqlitePath === ':memory:') return false;
  return resolve(sqlitePath) === resolve('./data/hub.db');
}

function vitestFallbackPath(): string {
  const workerTag = process.env.VITEST_POOL_ID
    || process.env.VITEST_WORKER_ID
    || `${process.pid}-${threadId}`;
  return resolve(tmpdir(), `metapi-vitest-${workerTag}`, 'hub.db');
}

/**
 * Tests must never read or write the developer's real `./data/hub.db`.
 *
 * Config values (including DATA_DIR) are captured when the config module is first
 * imported, which happens during test-file module evaluation -- before a suite's
 * `beforeAll` can point DATA_DIR at a temp directory. A test that sets DATA_DIR
 * late therefore still resolves the repo database and can silently wipe real
 * sites and accounts. This guard is keyed on the resolved path instead of on the
 * env var, so the repo database is protected no matter how late the suite acts.
 */
export function guardRepoDatabaseUnderVitest(sqlitePath: string): string {
  if (!isVitestRuntime()) return sqlitePath;
  if (!isRepoDefaultSqlitePath(sqlitePath)) return sqlitePath;
  console.warn(
    '[db] Refusing to use the repository database during tests; '
      + 'falling back to an isolated temp database.',
  );
  return vitestFallbackPath();
}
