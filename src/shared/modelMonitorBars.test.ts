import { describe, expect, it } from 'vitest';
import {
  MODEL_MONITOR_SLOT_COUNT,
  buildModelMonitorSlots,
  countModelMonitorHealthySlots,
  isHealthyRate,
  resolveModelRateLevel,
} from './modelMonitorBars.js';

describe('modelMonitorBars', () => {
  it('颜色档位与页面图例一致：≥100 极佳、≥90 良好、≥70 警告、其余严重', () => {
    expect(resolveModelRateLevel(100)).toBe('excellent');
    expect(resolveModelRateLevel(99.99)).toBe('good');
    expect(resolveModelRateLevel(90)).toBe('good');
    expect(resolveModelRateLevel(89.9)).toBe('warning');
    expect(resolveModelRateLevel(70)).toBe('warning');
    expect(resolveModelRateLevel(69.9)).toBe('critical');
    expect(resolveModelRateLevel(0)).toBe('critical');
    expect(resolveModelRateLevel(null)).toBe('unknown');
    expect(resolveModelRateLevel(Number.NaN)).toBe('unknown');
  });

  it('只有前两档（绿色）算「正常」', () => {
    expect(isHealthyRate(100)).toBe(true);
    expect(isHealthyRate(90)).toBe(true);
    expect(isHealthyRate(89.99)).toBe(false);
    expect(isHealthyRate(null)).toBe(false);
  });

  it('给了时间轴就按整点落到对应槽位', () => {
    const windowStart = 1_700_000_000;
    const slots = buildModelMonitorSlots(
      [{ ts: windowStart, rate: 100 }, { ts: windowStart + 3600 * 3, rate: 20 }],
      windowStart,
    );
    expect(slots).toHaveLength(MODEL_MONITOR_SLOT_COUNT);
    expect(slots[0]).toBe(100);
    expect(slots[3]).toBe(20);
    expect(slots[1]).toBeNull();
  });

  it('没有时间轴时按尾部右对齐，保证最近的采样显示在最右', () => {
    const slots = buildModelMonitorSlots(
      [{ ts: null, rate: 10 }, { ts: null, rate: 20 }, { ts: null, rate: 30 }],
      null,
    );
    expect(slots.slice(-3)).toEqual([10, 20, 30]);
    expect(slots.slice(0, -3).every((rate) => rate === null)).toBe(true);
  });

  it('绿格数只数正常的那几格，没采样的格子不算', () => {
    expect(countModelMonitorHealthySlots([], null)).toBe(0);
    expect(countModelMonitorHealthySlots(
      [{ ts: null, rate: 100 }, { ts: null, rate: 95 }, { ts: null, rate: 60 }],
      null,
    )).toBe(2);
    // 30 颗全绿也只数满 24 格，不会溢出。
    expect(countModelMonitorHealthySlots(
      Array.from({ length: 30 }, () => ({ ts: null, rate: 100 })),
      null,
    )).toBe(MODEL_MONITOR_SLOT_COUNT);
  });
});
