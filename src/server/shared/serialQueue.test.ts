import { describe, expect, it } from 'vitest';
import { createSerialQueue } from './serialQueue.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createSerialQueue', () => {
  it('never runs more tasks at once than the configured width', async () => {
    const queue = createSerialQueue(1);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () => queue.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
      })),
    );

    expect(peak).toBe(1);
  });

  it('runs tasks in call order', async () => {
    const queue = createSerialQueue(1);
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3].map((value) => queue.run(async () => {
        await sleep(value === 1 ? 15 : 1);
        order.push(value);
      })),
    );

    expect(order).toEqual([1, 2, 3]);
  });

  it('releases the slot when a task rejects, so the queue keeps draining', async () => {
    const queue = createSerialQueue(1);
    const finished: string[] = [];

    const failing = queue.run(async () => {
      throw new Error('boom');
    }).catch(() => 'caught');
    const following = queue.run(async () => {
      finished.push('next');
    });

    await expect(failing).resolves.toBe('caught');
    await following;
    expect(finished).toEqual(['next']);
    expect(queue.size()).toBe(0);
  });

  it('allows the configured width when it is greater than one', async () => {
    const queue = createSerialQueue(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }, () => queue.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
      })),
    );

    expect(peak).toBe(2);
  });
  it('lets a task that already holds the lane call back into it', async () => {
    // A headed re-login runs the browser check-in inside itself. On a width-1
    // queue that nested call must run inline, or it would wait for the slot its
    // own caller is holding and the whole flow would hang.
    const queue = createSerialQueue(1);
    let nestedRan = false;

    const outer = await queue.run(async () => {
      const inner = await queue.run(async () => {
        nestedRan = true;
        return 'inner';
      });
      return `outer:${inner}`;
    });

    expect(nestedRan).toBe(true);
    expect(outer).toBe('outer:inner');
    expect(queue.size()).toBe(0);
  });

  it('still queues work started outside the lane', async () => {
    const queue = createSerialQueue(1);
    const order: string[] = [];

    await queue.run(async () => {
      // Started from the lane, so it runs inline rather than queueing.
      await queue.run(async () => { order.push('nested'); });
      order.push('outer');
    });
    await queue.run(async () => { order.push('after'); });

    expect(order).toEqual(['nested', 'outer', 'after']);
  });
});
