import { describe, expect, it, vi } from 'vitest';
import { buildEntryAnchorDenySelector, buildEntryLocator } from './entryMatch.js';
import type { AssistedLoginProvider } from './types.js';

/** Minimal Locator stand-in: records the composition calls, returns itself. */
function makeLocator(label: string) {
  const calls: string[] = [];
  const locator: any = {
    label,
    calls,
    or: vi.fn((other: any) => {
      calls.push(`or(${other.label})`);
      return locator;
    }),
    and: vi.fn((other: any) => {
      calls.push(`and(${other.label})`);
      return locator;
    }),
  };
  return locator;
}

function makePage() {
  const locators: Record<string, any> = {};
  const getByRole = vi.fn((role: string, options: { name: RegExp }) => {
    const key = `role:${role}:${options.name.source}`;
    locators[key] ??= makeLocator(key);
    return locators[key];
  });
  const locator = vi.fn((selector: string) => {
    locators[selector] ??= makeLocator(selector);
    return locators[selector];
  });
  return { page: { getByRole, locator } as any, locators, getByRole, locator };
}

function makeProvider(extra: Partial<AssistedLoginProvider> = {}): AssistedLoginProvider {
  return {
    id: 'linuxdo',
    label: 'Linux.do',
    origin: 'https://linux.do',
    loginPath: '/login',
    isHandoffHost: () => true,
    isAuthorizationUrl: () => true,
    probeLoginState: async () => ({ loggedIn: false, username: null, userId: null, blocked: false }),
    probeLoginStateHttp: async () => ({ loggedIn: false, username: null, userId: null, blocked: false }),
    entryNamePattern: /linuxdo/i,
    entrySelectors: ['[href*="linux.do"]'],
    entryTextSelectors: ['a:has-text("Linux.do")'],
    consentButtonNames: /allow/i,
    consentSelectors: ['button:has-text("Allow")'],
    messages: { needsLogin: 'a', sessionExpired: 'b', entryMissing: 'c', blocked: 'd' },
    ...extra,
  };
}

describe('buildEntryAnchorDenySelector', () => {
  it('returns null when the provider declares no content links', () => {
    expect(buildEntryAnchorDenySelector([])).toBeNull();
    expect(buildEntryAnchorDenySelector(['   ', ''])).toBeNull();
  });

  it('matches every element that is not an anchor on a declared content path', () => {
    expect(buildEntryAnchorDenySelector(['linux.do/t/', 'linux.do/u/']))
      .toBe('*:not([href*="linux.do/t/"]):not([href*="linux.do/u/"])');
  });

  it('escapes quotes and backslashes so the selector cannot break out', () => {
    expect(buildEntryAnchorDenySelector(['a"b', 'c\\d']))
      .toBe('*:not([href*="a\\"b"]):not([href*="c\\\\d"])');
  });
});

describe('buildEntryLocator', () => {
  it('intersects every candidate with the deny filter when content links are declared', () => {
    const { page, locators, locator } = makePage();
    buildEntryLocator(page, makeProvider({ entryAnchorDenyHrefSubstrings: ['linux.do/t/'] }));

    const deny = locators['*:not([href*="linux.do/t/"])'];
    expect(deny).toBeDefined();
    expect(locator).toHaveBeenCalledTimes(3); // 1 text selector + 1 href selector + the deny filter
    // The role-based candidates (button + link) and both selector candidates are intersected.
    expect(locators['role:button:linuxdo'].and).toHaveBeenCalledWith(deny);
    expect(locators['role:link:linuxdo'].and).toHaveBeenCalledWith(deny);
    expect(locators['a:has-text("Linux.do")'].and).toHaveBeenCalledWith(deny);
    expect(locators['[href*="linux.do"]'].and).toHaveBeenCalledWith(deny);
  });

  it('leaves the union untouched when the provider declares no content links', () => {
    const { page, locators, locator } = makePage();
    buildEntryLocator(page, makeProvider());

    expect(locator).toHaveBeenCalledTimes(2); // only the two selector candidates
    expect(locators['role:button:linuxdo'].and).not.toHaveBeenCalled();
    expect(locators['role:link:linuxdo'].and).not.toHaveBeenCalled();
    expect(locators['role:button:linuxdo'].or).toHaveBeenCalled();
  });
});
