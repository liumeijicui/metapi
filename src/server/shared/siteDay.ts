/**
 * The business day these relays stamp their daily grants with.
 *
 * Every site in this fleet records its day in Asia/Shanghai, and the container
 * usually has no `TZ` set — so local-midnight arithmetic reads the host clock as
 * UTC and lands eight hours early. That direction matters: a grant arriving at
 * 00:11 +08 is stamped 16:11 the previous day in UTC, so it falls outside a
 * "today" window built from the host clock and looks like yesterday's entry.
 * The offset is therefore pinned to the site's timezone instead of inherited
 * from the host.
 */
export const SITE_UTC_OFFSET_SECONDS = 8 * 3600;

const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

/** First second of the site's current day, as a Unix timestamp in seconds. */
export function startOfSiteDaySeconds(now: Date = new Date()): number {
  const shifted = Math.floor(now.getTime() / 1000) + SITE_UTC_OFFSET_SECONDS;
  return Math.floor(shifted / SECONDS_PER_DAY) * SECONDS_PER_DAY - SITE_UTC_OFFSET_SECONDS;
}

/** First millisecond of the site's current day. */
export function startOfSiteDayMs(now: Date = new Date()): number {
  return startOfSiteDaySeconds(now) * 1000;
}

/** The site's current day as `YYYY-MM-DD`, for use on anything that stores a day key. */
export function siteDayKey(now: Date = new Date()): string {
  const shiftedMs = now.getTime() + SITE_UTC_OFFSET_SECONDS * 1000;
  return new Date(shiftedMs - (shiftedMs % MS_PER_DAY)).toISOString().slice(0, 10);
}
