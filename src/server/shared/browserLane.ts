import { createSerialQueue } from './serialQueue.js';

/**
 * The single lane every headed-browser flow must pass through.
 *
 * All of them ultimately drive Chromium on one virtual X display, so running
 * two at once does not merely halve the speed - they take turns stealing input
 * focus, fight over the same profile directory, and on a small host each run
 * costs hundreds of megabytes. Unbounded fan-out is exactly what turned the
 * hourly jobs into a wave of "browser would not start" and `session_rejected`
 * failures: dozens of accounts were walking into the browser at the same
 * instant.
 *
 * One at a time is enough. These runs happen on an hourly or daily schedule and
 * nothing waits on their latency, so the queue is a pure win: it removes the
 * contention class of failure and puts a ceiling on peak memory.
 */
export const browserLane = createSerialQueue(1);
