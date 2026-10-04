import { describe, expect, it } from 'vitest';
import { browserLane } from './browserLane.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('browserLane', () => {
  it('serialises headed-browser work to a single run', async () => {
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 4 }, () => browserLane.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(5);
        active -= 1;
      })),
    );

    expect(peak).toBe(1);
  });

  it('keeps working after a failed run', async () => {
    await browserLane.run(async () => {
      throw new Error('browser run failed');
    }).catch(() => undefined);

    await expect(browserLane.run(async () => 'ok')).resolves.toBe('ok');
  });
  it('does not deadlock when a browser flow runs the browser check-in inside itself', async () => {
    // Exactly the shape of a headed re-login: it takes the lane and then calls
    // the check-in runner, which takes the lane again.
    const result = await browserLane.run(async () =>
      browserLane.run(async () => 'inner-result'));

    expect(result).toBe('inner-result');
    expect(browserLane.size()).toBe(0);
  });
});
