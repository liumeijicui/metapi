import { describe, expect, it } from 'vitest';
import { isWithinDaytimeWindow, nextKeepAliveDelayMs } from './sessionWatchScheduler.js';

const DAYTIME_MIN_MS = 30 * 60 * 1000;
const DAYTIME_MAX_MS = 60 * 60 * 1000;
const NIGHT_MIN_MS = 2 * 60 * 60 * 1000;
const NIGHT_MAX_MS = 3 * 60 * 60 * 1000;

function localTime(hour: number, minute = 0): Date {
  return new Date(2026, 8, 28, hour, minute, 0);
}

describe('assisted login keep-alive cadence', () => {
  it('treats 10:00–21:00 as the daytime window', () => {
    expect(isWithinDaytimeWindow(localTime(9, 59))).toBe(false);
    expect(isWithinDaytimeWindow(localTime(10))).toBe(true);
    expect(isWithinDaytimeWindow(localTime(20, 59))).toBe(true);
    expect(isWithinDaytimeWindow(localTime(21))).toBe(false);
    expect(isWithinDaytimeWindow(localTime(3))).toBe(false);
  });

  it('randomises the daytime keep-alive delay between 30 and 60 minutes', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const delay = nextKeepAliveDelayMs(localTime(14));
      expect(delay).toBeGreaterThanOrEqual(DAYTIME_MIN_MS);
      expect(delay).toBeLessThanOrEqual(DAYTIME_MAX_MS);
    }
  });

  it('slows the night keep-alive delay down to 2–3 hours', () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const delay = nextKeepAliveDelayMs(localTime(2));
      expect(delay).toBeGreaterThanOrEqual(NIGHT_MIN_MS);
      expect(delay).toBeLessThanOrEqual(NIGHT_MAX_MS);
    }
  });
});
