import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A tiny FIFO gate that runs async work with a fixed concurrency.
 *
 * The browser-driven flows are the reason this exists. A Chromium run costs
 * hundreds of megabytes and drives a fixed window geometry with synthetic X11
 * input, so two of them at once do not merely slow each other down: they fight
 * over the profile directory, the display and the machine's memory. Serialising
 * them costs latency nothing here depends on, and removes a whole class of
 * "browser would not start" failures.
 *
 * The gate is re-entrant. One of these flows genuinely calls into another - a
 * headed re-login ends up running the browser check-in - and on a width-1 queue
 * a nested acquisition would wait forever for the slot its own caller is
 * holding. Work started by a task that already owns the lane therefore runs
 * inline, which is also what the inner caller means: it is not asking for a new
 * browser, only for the one its caller already has.
 */
export type SerialQueue = {
  /** Runs `task` once the gate is free, in call order. */
  run: <T>(task: () => Promise<T>) => Promise<T>;
  /** Number of tasks waiting plus the ones currently running. */
  size: () => number;
};

export function createSerialQueue(concurrency = 1): SerialQueue {
  const limit = Math.max(1, Math.floor(concurrency));
  const owner = new AsyncLocalStorage<symbol>();
  const token = Symbol('serialQueue');

  let active = 0;
  const waiting: Array<() => void> = [];

  function acquire(): Promise<void> {
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolveAcquire) => {
      waiting.push(() => {
        active += 1;
        resolveAcquire();
      });
    });
  }

  function release(): void {
    active -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (owner.getStore() === token) return task();
      await acquire();
      try {
        return await owner.run(token, task);
      } finally {
        release();
      }
    },
    size: () => active + waiting.length,
  };
}
