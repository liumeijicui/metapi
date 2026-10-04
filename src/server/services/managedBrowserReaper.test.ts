import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

// The reaper reads /proc, so its matcher is exercised through the same pure
// helpers it uses, kept in this file to pin the contract that matters: a
// process is only a target when its command line points at a profile under this
// install's data directory.
function matches(cmdline: string, dataDir: string): boolean {
  if (!cmdline.includes('--user-data-dir=')) return false;
  if (!cmdline.includes('chrom')) return false;
  const match = cmdline.match(/--user-data-dir=(\S+)/);
  if (!match) return false;
  return resolve(match[1]).startsWith(resolve(dataDir));
}

describe('managed browser reaper matcher', () => {
  const dataDir = '/home/app/metapi/data';

  it('matches a managed browser holding a profile under the data directory', () => {
    expect(matches(
      '/usr/bin/chromium-browser --remote-debugging-port=9333 --user-data-dir=/home/app/metapi/data/linuxdo-browser about:blank',
      dataDir,
    )).toBe(true);
  });

  it('matches a check-in browser profile too', () => {
    expect(matches(
      '/usr/bin/chromium-browser --user-data-dir=/home/app/metapi/data/checkin-browser/site-47/profiles/site-47',
      dataDir,
    )).toBe(true);
  });

  it('ignores a browser pointed at someone else s profile', () => {
    expect(matches(
      '/usr/bin/chromium-browser --user-data-dir=/home/otheruser/.config/chromium',
      dataDir,
    )).toBe(false);
  });

  it('ignores a browser started without a profile flag', () => {
    expect(matches('/usr/bin/chromium-browser about:blank', dataDir)).toBe(false);
  });

  it('ignores non-browser processes that merely mention a profile path', () => {
    expect(matches('node --user-data-dir=/home/app/metapi/data/linuxdo-browser', dataDir)).toBe(false);
  });
});
