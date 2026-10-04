import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config.js';

/**
 * Kills Chromium processes that use one of this install's managed profiles.
 *
 * The managed browser is meant to be owned by exactly one process: whoever
 * started it closes it when it goes idle, and a restarted metapi re-attaches to
 * a surviving one. Neither rule survives a crash or a restart of the thing that
 * launched it - the browser keeps running with `init` as its parent, holding
 * hundreds of megabytes, and the new service only ever learns about it if and
 * when some flow happens to ask for the browser (at which point it adopts the
 * process and arms the idle timer again).
 *
 * A leftover profile browser is therefore pure waste, and on a small host it is
 * the difference between headroom and swap. At startup nothing of ours can be
 * legitimately running yet, so any Chromium pointing at a profile under this
 * data directory is by definition stranded: reap it before serving traffic.
 */

/** Matches the `--user-data-dir=` argument a managed browser is launched with. */
const USER_DATA_DIR_FLAG = '--user-data-dir=';

function readCmdline(pid: string): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ');
  } catch {
    return '';
  }
}

function listProcessIds(): string[] {
  try {
    return readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch {
    return [];
  }
}

/** True when the process is not the caller and drives a profile under dataDir. */
function isStrandedManagedBrowser(pid: string, dataDirPrefix: string): boolean {
  const cmdline = readCmdline(pid);
  // A Chromium is only launched with this flag by us; the check keeps an
  // unrelated browser someone else started on the host out of scope.
  if (!cmdline.includes(USER_DATA_DIR_FLAG)) return false;
  if (!cmdline.includes('chrom')) return false;
  const match = cmdline.match(/--user-data-dir=(\S+)/);
  if (!match) return false;
  return resolve(match[1]).startsWith(dataDirPrefix);
}

/**
 * Reaps stranded managed browsers. Never throws: a host where `/proc` is not
 * readable should still start and serve.
 *
 * Returns the number of processes asked to exit.
 */
export function reapStrandedManagedBrowsers(): number {
  if (process.platform !== 'linux') return 0;

  const dataDirPrefix = resolve(config.dataDir);
  const selfPid = String(process.pid);
  let reaped = 0;

  for (const pid of listProcessIds()) {
    if (pid === selfPid) continue;
    // Only touch processes we can signal; permission errors are expected when
    // metapi runs unprivileged and simply mean "not ours".
    if (!isStrandedManagedBrowser(pid, dataDirPrefix)) continue;
    try {
      // SIGTERM lets Chromium drop its profile lock cleanly; the caller's next
      // browser launch then does not have to wait for a stale lock to clear.
      process.kill(Number(pid), 'SIGTERM');
      reaped += 1;
    } catch {
      // already gone, or not permitted
    }
  }

  return reaped;
}

/**
 * True when the process still exists. Used to decide whether the gentle signal
 * was enough before escalating.
 */
function isAlive(pid: string): boolean {
  try {
    readlinkSync(`/proc/${pid}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reaps, then escalates to SIGKILL for anything still standing after a grace
 * period. Chromium occasionally ignores `SIGTERM` while a renderer is wedged,
 * and a process that survives the sweep would sit there for another restart.
 */
export async function reapStrandedManagedBrowsersAndWait(graceMs = 3_000): Promise<number> {
  if (process.platform !== 'linux') return 0;

  const dataDirPrefix = resolve(config.dataDir);
  const selfPid = String(process.pid);
  const targets = listProcessIds().filter(
    (pid) => pid !== selfPid && isStrandedManagedBrowser(pid, dataDirPrefix),
  );
  if (targets.length === 0) return 0;

  for (const pid of targets) {
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      // already gone
    }
  }

  await new Promise((resolveWait) => setTimeout(resolveWait, graceMs));

  for (const pid of targets) {
    if (!isAlive(pid)) continue;
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // already gone
    }
  }

  return targets.length;
}
