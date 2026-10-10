/**
 * 模型监控卡片上那排「整点格子」的口径。
 *
 * 前端拿它画格子（每个槽位一格，颜色按成功率分级），后端拿它数绿格做排序。
 * 两边各写一份迟早会漂：页面把 ≥90% 画成绿格、后端却按别的阈值数格子，排序
 * 就会与眼睛看到的不一致，所以这一段放在 shared 里只留一份。
 *
 * 这里是 `.js`：`src/shared` 下能被服务端引用的模块只能是 `.js` + `.d.ts`
 * （服务端 tsconfig 的 rootDir 是 src/server，构建时只把 .js/.d.ts 拷进 dist）。
 */

/** 卡片上一行画几个整点槽位。 */
export const MODEL_MONITOR_SLOT_COUNT = 24;

/**
 * 与页面图例一致：≥100% 极佳、≥90% 良好、≥70% 警告、其余严重。
 *
 * 前两档都是绿色（`is-excellent` #10b981 / `is-good` #34d399），所以「正常」
 * 的判定就是 ≥90%。
 */
export function resolveModelRateLevel(rate) {
  if (rate == null || !Number.isFinite(rate)) return 'unknown';
  if (rate >= 100) return 'excellent';
  if (rate >= 90) return 'good';
  if (rate >= 70) return 'warning';
  return 'critical';
}

/** 是否是绿色（正常）的那一档。 */
export function isHealthyRate(rate) {
  const level = resolveModelRateLevel(rate);
  return level === 'excellent' || level === 'good';
}

/** 把上游的采样点铺进 24 个整点槽位；上游没给时间轴时按尾部右对齐。 */
export function buildModelMonitorSlots(samples, windowStart) {
  const slots = new Array(MODEL_MONITOR_SLOT_COUNT).fill(null);
  if (!samples.length) return slots;
  const allHaveTs = samples.every((sample) => sample.ts != null);
  if (windowStart != null && allHaveTs) {
    for (const sample of samples) {
      const index = Math.floor((sample.ts - windowStart) / 3600);
      if (index >= 0 && index < MODEL_MONITOR_SLOT_COUNT) slots[index] = sample.rate;
    }
    return slots;
  }
  const tail = samples.slice(-MODEL_MONITOR_SLOT_COUNT);
  for (let index = 0; index < tail.length; index += 1) {
    slots[MODEL_MONITOR_SLOT_COUNT - tail.length + index] = tail[index].rate;
  }
  return slots;
}

/**
 * 绿色格子数：卡片上显示为「正常」的槽位数，排序主键。
 *
 * 没有采样的槽位不算绿 —— 「一格都没有」和「24 格全绿」不是一回事，前者不该
 * 排在有数据的前面。
 */
export function countModelMonitorHealthySlots(samples, windowStart) {
  return buildModelMonitorSlots(samples, windowStart)
    .reduce((count, rate) => (isHealthyRate(rate) ? count + 1 : count), 0);
}
