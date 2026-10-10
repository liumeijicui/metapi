/** 卡片上一行画几个整点槽位。 */
export declare const MODEL_MONITOR_SLOT_COUNT: number;

/** 一个采样点。`ts` 为空表示上游没给时间轴，此时按尾部右对齐铺。 */
export type ModelMonitorSample = { ts: number | null; rate: number };

export type ModelMonitorRateLevel = 'excellent' | 'good' | 'warning' | 'critical' | 'unknown';

export declare function resolveModelRateLevel(rate: number | null | undefined): ModelMonitorRateLevel;

export declare function isHealthyRate(rate: number | null | undefined): boolean;

export declare function buildModelMonitorSlots(
  samples: ModelMonitorSample[],
  windowStart: number | null,
): Array<number | null>;

export declare function countModelMonitorHealthySlots(
  samples: ModelMonitorSample[],
  windowStart: number | null,
): number;
