import { describe, expect, it } from 'vitest';
import { siteDayKey, startOfSiteDayMs, startOfSiteDaySeconds } from './siteDay.js';

describe('site day', () => {
  it('keeps a 00:11 +08 grant inside today instead of stamping it as yesterday', () => {
    // 2026-08-27 00:11 +08 == 2026-08-26 16:11 UTC, which is the case that made
    // the host-clock version read the grant as yesterday's.
    const now = new Date('2026-08-26T16:11:00.000Z');
    expect(siteDayKey(now)).toBe('2026-08-27');
    expect(new Date(startOfSiteDaySeconds(now) * 1000).toISOString()).toBe('2026-08-26T16:00:00.000Z');
  });

  it('rolls over at the site midnight, not at UTC midnight', () => {
    expect(siteDayKey(new Date('2026-08-26T15:59:59.999Z'))).toBe('2026-08-26');
    expect(siteDayKey(new Date('2026-08-26T16:00:00.000Z'))).toBe('2026-08-27');
    expect(siteDayKey(new Date('2026-08-27T00:00:00.000Z'))).toBe('2026-08-27');
  });

  it('agrees between the second-, millisecond- and string-shaped helpers', () => {
    const now = new Date('2026-10-09T04:30:00.000Z');
    expect(startOfSiteDayMs(now)).toBe(startOfSiteDaySeconds(now) * 1000);
    expect(new Date(startOfSiteDayMs(now)).toISOString().slice(0, 10)).toBe('2026-10-08');
    expect(siteDayKey(now)).toBe('2026-10-09');
  });
});
