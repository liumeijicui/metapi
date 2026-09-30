import { describe, expect, it } from 'vitest';
import { normalizeCheckinReward, quotaToUsd, roundUsd } from './quota.js';

describe('quotaToUsd', () => {
  it('scales raw quota with the adapter factor and keeps six decimals', () => {
    expect(quotaToUsd(12341523, 500000)).toBe(24.683046);
    expect(quotaToUsd(14000000, 500000)).toBe(28);
    expect(quotaToUsd(55320, 500000)).toBe(0.11064);
    expect(quotaToUsd(3000000, 1000000)).toBe(3);
  });

  it('coerces numeric strings the way the balance parsers used to', () => {
    expect(quotaToUsd('500000', 500000)).toBe(1);
  });

  it('falls back to zero for unusable input', () => {
    expect(quotaToUsd(undefined, 500000)).toBe(0);
    expect(quotaToUsd(null, 500000)).toBe(0);
    expect(quotaToUsd(123, Number.NaN)).toBe(0);
  });
});

describe('normalizeCheckinReward', () => {
  it('converts a quota award into the dollar value the dashboard shows', () => {
    expect(normalizeCheckinReward(12341523, 500000)).toBe('24.683046');
    expect(normalizeCheckinReward(1787510, 500000)).toBe('3.57502');
    expect(normalizeCheckinReward(2500000, 1000000)).toBe('2.5');
  });

  it('leaves non-numeric payloads for the shared reward parser', () => {
    expect(normalizeCheckinReward('not-a-number', 500000)).toBe('not-a-number');
    expect(normalizeCheckinReward(undefined, 500000)).toBeUndefined();
    expect(normalizeCheckinReward(null, 500000)).toBeUndefined();
  });

  it('does not invent a reward when the site reports none', () => {
    expect(normalizeCheckinReward(0, 500000)).toBe('0');
    expect(normalizeCheckinReward(-5, 500000)).toBe('-5');
  });
});

describe('roundUsd', () => {
  it('rounds to six decimals', () => {
    expect(roundUsd(1.234567891)).toBe(1.234568);
  });
});
