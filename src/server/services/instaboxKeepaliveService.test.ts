import { afterEach, describe, expect, it } from 'vitest';
import {
  INSTABOX_KEEPALIVE_WINDOWS,
  getInstaboxKeepaliveStatus,
  resetInstaboxKeepaliveStateForTests,
  resolveInstaboxKeepaliveWindow,
  resolveInstaboxScheduleActions,
  resolveNextInstaboxKeepaliveWindowStart,
  resolveRecentInstaboxWindowEnd,
} from './instaboxKeepaliveService.js';

function localTime(hour: number, minute: number): Date {
  return new Date(2026, 10, 3, hour, minute, 0, 0);
}

describe('InstaBox keep-alive windows', () => {
  afterEach(() => {
    resetInstaboxKeepaliveStateForTests();
  });

  it('uses the user-configured windows and treats the end as exclusive', () => {
    expect(INSTABOX_KEEPALIVE_WINDOWS).toEqual([
      { start: '08:20', end: '12:45' },
      { start: '13:55', end: '22:00' },
    ]);

    expect(resolveInstaboxKeepaliveWindow(localTime(8, 19))).toBeNull();
    expect(resolveInstaboxKeepaliveWindow(localTime(8, 20))?.window.start).toBe('08:20');
    expect(resolveInstaboxKeepaliveWindow(localTime(12, 44))?.window.end).toBe('12:45');
    expect(resolveInstaboxKeepaliveWindow(localTime(12, 45))).toBeNull();
    expect(resolveInstaboxKeepaliveWindow(localTime(13, 54))).toBeNull();
    expect(resolveInstaboxKeepaliveWindow(localTime(13, 55))?.window.start).toBe('13:55');
    expect(resolveInstaboxKeepaliveWindow(localTime(21, 59))?.window.end).toBe('22:00');
    expect(resolveInstaboxKeepaliveWindow(localTime(22, 0))).toBeNull();
  });

  it('resolves the next window across the lunch break and midnight', () => {
    expect(resolveNextInstaboxKeepaliveWindowStart(localTime(12, 50))?.getTime())
      .toBe(localTime(13, 55).getTime());
    expect(resolveNextInstaboxKeepaliveWindowStart(localTime(22, 0))?.getTime())
      .toBe(new Date(2026, 10, 4, 8, 20, 0, 0).getTime());
  });

  it('emits a start action at window start and a suspend action at window end', () => {
    const actions = resolveInstaboxScheduleActions(localTime(8, 19), localTime(8, 21));
    expect(actions.map((item) => `${item.action}@${item.at.toLocaleTimeString('zh-CN', { hour12: false })}`))
      .toEqual(['start@08:20:00']);
  });

  it('emits suspend at 12:45 and 22:00, and start at 13:55', () => {
    const actions = resolveInstaboxScheduleActions(localTime(12, 44), localTime(22, 1));
    expect(actions.map((item) => `${item.action}@${item.at.toLocaleTimeString('zh-CN', { hour12: false })}`))
      .toEqual(['suspend@12:45:00', 'start@13:55:00', 'suspend@22:00:00']);
  });

  it('does not repeat actions when no boundary is crossed', () => {
    expect(resolveInstaboxScheduleActions(localTime(9, 0), localTime(9, 1))).toEqual([]);
  });

  it('catches up a missed shutdown shortly after the window ends', () => {
    expect(resolveRecentInstaboxWindowEnd(localTime(12, 50))?.getTime())
      .toBe(localTime(12, 45).getTime());
    expect(resolveRecentInstaboxWindowEnd(localTime(22, 10))?.getTime())
      .toBe(localTime(22, 0).getTime());
    expect(resolveRecentInstaboxWindowEnd(localTime(23, 30))).toBeNull();
    expect(resolveRecentInstaboxWindowEnd(localTime(8, 0))).toBeNull();
  });

  it('is enabled by default and exposes the schedule to the UI', async () => {
    const status = await getInstaboxKeepaliveStatus(localTime(7, 0));
    expect(status.enabled).toBe(true);
    expect(status.intervalMinutes).toBe(20);
    expect(status.inWindow).toBe(false);
    expect(status.nextWindowStart).not.toBeNull();
  });
});
