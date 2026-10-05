import { describe, expect, it, vi } from 'vitest';

vi.mock('../../components/BrandIcon.js', () => ({
  getBrand: () => null,
  normalizeBrandIconKey: (icon: string) => icon.trim().toLowerCase(),
}));

import {
  ROUTE_ICON_NONE_VALUE,
  hasIncompleteModelMappingEntries,
  normalizeModelMappingValue,
  normalizeRouteDisplayIconValue,
  parseModelMappingEntries,
  resolveRouteIcon,
  serializeModelMappingEntries,
} from './utils.js';

describe('token route icon helpers', () => {
  it('preserves the explicit no-icon sentinel during normalization', () => {
    expect(normalizeRouteDisplayIconValue(ROUTE_ICON_NONE_VALUE)).toBe(ROUTE_ICON_NONE_VALUE);
  });

  it('treats the explicit no-icon sentinel as no icon', () => {
    expect(resolveRouteIcon({ displayIcon: ROUTE_ICON_NONE_VALUE })).toEqual({ kind: 'none' });
  });
});

describe('token route model mapping helpers', () => {
  it('parses a valid mapping record', () => {
    expect(parseModelMappingEntries('{"gpt-6-astra":"deepseek-v4.1-flash"}')).toEqual([
      { from: 'gpt-6-astra', to: 'deepseek-v4.1-flash' },
    ]);
  });

  it('returns no entries for empty or malformed payloads', () => {
    expect(parseModelMappingEntries('')).toEqual([]);
    expect(parseModelMappingEntries(null)).toEqual([]);
    expect(parseModelMappingEntries('not-json')).toEqual([]);
    expect(parseModelMappingEntries('["gpt-6-astra"]')).toEqual([]);
  });

  it('serializes entries back to a canonical JSON string', () => {
    expect(serializeModelMappingEntries([
      { from: ' gpt-6-astra ', to: ' deepseek-v4.1-flash ' },
      { from: '', to: 'ignored' },
    ])).toBe('{"gpt-6-astra":"deepseek-v4.1-flash"}');
    expect(serializeModelMappingEntries([])).toBeNull();
  });

  it('normalizes and detects incomplete mapping rows', () => {
    expect(normalizeModelMappingValue('{"gpt-6-astra":"deepseek-v4.1-flash"}')).toBe('{"gpt-6-astra":"deepseek-v4.1-flash"}');
    expect(normalizeModelMappingValue('{}')).toBeNull();
    expect(hasIncompleteModelMappingEntries('{"gpt-6-astra":""}')).toBe(true);
    expect(hasIncompleteModelMappingEntries('{"gpt-6-astra":"deepseek-v4.1-flash"}')).toBe(false);
  });
});
