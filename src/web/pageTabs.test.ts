import { describe, expect, it, vi } from 'vitest';
import {
  HOME_TAB_PATH,
  MAX_PAGE_TABS,
  PAGE_TAB_LABELS,
  PAGE_TABS_STORAGE_KEY,
  closeAllPageTabs,
  closeOtherPageTabs,
  closePageTab,
  normalizePageTabList,
  normalizeTabPath,
  openPageTab,
  readStoredPageTabs,
  resolveActivePathAfterClose,
  resolvePageTabLabel,
  writeStoredPageTabs,
} from './pageTabs.js';

function createStorage(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    dump: () => new Map(store),
  };
}

describe('normalizeTabPath', () => {
  it('drops query, hash and trailing slashes', () => {
    expect(normalizeTabPath('/sites?create=1#top')).toBe('/sites');
    expect(normalizeTabPath('/sites/')).toBe('/sites');
    expect(normalizeTabPath('/settings/notify?tab=1')).toBe('/settings/notify');
  });

  it('treats empty or root paths as the home tab', () => {
    expect(normalizeTabPath('/')).toBe(HOME_TAB_PATH);
    expect(normalizeTabPath('')).toBe(HOME_TAB_PATH);
    expect(normalizeTabPath(undefined)).toBe(HOME_TAB_PATH);
    expect(normalizeTabPath('/   ')).toBe(HOME_TAB_PATH);
  });

  it('adds a leading slash for relative looking paths', () => {
    expect(normalizeTabPath('logs')).toBe('/logs');
  });
});

describe('resolvePageTabLabel', () => {
  it('maps known menu paths to their sidebar title', () => {
    expect(resolvePageTabLabel('/')).toBe('仪表盘');
    expect(resolvePageTabLabel('/logs')).toBe('使用日志');
    expect(resolvePageTabLabel('/settings/import-export')).toBe('导入/导出');
    expect(resolvePageTabLabel('/model-forwarding?x=1')).toBe('模型转发');
  });

  it('builds a title for parameterised routes', () => {
    expect(resolvePageTabLabel('/assisted-login/github')).toBe('github 快捷登录');
    expect(resolvePageTabLabel('/assisted-login/linux.do')).toBe('linux.do 快捷登录');
  });

  it('returns null for paths that are not menus', () => {
    expect(resolvePageTabLabel('/not-a-page')).toBeNull();
    expect(resolvePageTabLabel('/assisted-login')).toBeNull();
  });
});

describe('normalizePageTabList', () => {
  it('always keeps the home tab first and drops duplicates', () => {
    expect(normalizePageTabList(['/logs', '/', '/logs'])).toEqual(['/', '/logs']);
  });

  it('ignores unknown paths and non-string entries', () => {
    expect(normalizePageTabList(['/logs', '/nope', 42, null])).toEqual(['/', '/logs']);
  });

  it('caps the list and drops the oldest non-home tabs', () => {
    const knownPaths = Object.keys(PAGE_TAB_LABELS);
    expect(knownPaths.length).toBeGreaterThan(MAX_PAGE_TABS);

    const tabs = normalizePageTabList(knownPaths);

    expect(tabs).toHaveLength(MAX_PAGE_TABS);
    expect(tabs[0]).toBe(HOME_TAB_PATH);
    expect(tabs[tabs.length - 1]).toBe(knownPaths[knownPaths.length - 1]);
    expect(tabs).not.toContain(knownPaths[1]);
  });

  it('falls back to the home tab for broken input', () => {
    expect(normalizePageTabList(null)).toEqual([HOME_TAB_PATH]);
    expect(normalizePageTabList('not-an-array')).toEqual([HOME_TAB_PATH]);
  });
});

describe('openPageTab', () => {
  it('appends new menus and keeps the previous order', () => {
    const first = openPageTab([HOME_TAB_PATH], '/logs');
    const second = openPageTab(first, '/monitor');

    expect(first).toEqual([HOME_TAB_PATH, '/logs']);
    expect(second).toEqual([HOME_TAB_PATH, '/logs', '/monitor']);
  });

  it('keeps an already open tab in place and reuses the same array', () => {
    const tabs = [HOME_TAB_PATH, '/logs', '/monitor'];

    expect(openPageTab(tabs, '/logs?q=1')).toBe(tabs);
  });

  it('ignores paths that are not menus', () => {
    const tabs = [HOME_TAB_PATH];

    expect(openPageTab(tabs, '/not-a-page')).toBe(tabs);
  });
});

describe('closePageTab', () => {
  it('removes a tab and keeps the rest in order', () => {
    expect(closePageTab([HOME_TAB_PATH, '/logs', '/monitor'], '/logs')).toEqual([HOME_TAB_PATH, '/monitor']);
  });

  it('never closes the pinned home tab', () => {
    const tabs = [HOME_TAB_PATH, '/logs'];

    expect(closePageTab(tabs, '/')).toBe(tabs);
  });

  it('is a no-op for tabs that are not open', () => {
    const tabs = [HOME_TAB_PATH, '/logs'];

    expect(closePageTab(tabs, '/monitor')).toBe(tabs);
  });
});

describe('closeOtherPageTabs / closeAllPageTabs', () => {
  it('keeps only the home tab and the picked one', () => {
    expect(closeOtherPageTabs([HOME_TAB_PATH, '/logs', '/monitor', '/sites'], '/monitor'))
      .toEqual([HOME_TAB_PATH, '/monitor']);
  });

  it('keeps the home tab when the picked tab is the home tab', () => {
    expect(closeOtherPageTabs([HOME_TAB_PATH, '/logs', '/monitor'], '/'))
      .toEqual([HOME_TAB_PATH]);
  });

  it('leaves only the home tab after closing everything', () => {
    expect(closeAllPageTabs()).toEqual([HOME_TAB_PATH]);
  });
});

describe('resolveActivePathAfterClose', () => {
  const tabs = [HOME_TAB_PATH, '/logs', '/monitor', '/sites'];

  it('falls to the right neighbour first', () => {
    expect(resolveActivePathAfterClose(tabs, '/monitor', '/monitor')).toBe('/sites');
  });

  it('falls back to the left neighbour for the last tab', () => {
    expect(resolveActivePathAfterClose(tabs, '/sites', '/sites')).toBe('/monitor');
  });

  it('keeps the current tab when closing another one', () => {
    expect(resolveActivePathAfterClose(tabs, '/logs', '/sites')).toBe('/sites');
  });

  it('returns home when nothing is left', () => {
    expect(resolveActivePathAfterClose(['/', '/logs'], '/logs', '/logs')).toBe(HOME_TAB_PATH);
  });
});

describe('stored page tabs', () => {
  it('round-trips through storage', () => {
    const storage = createStorage();

    writeStoredPageTabs(storage, [HOME_TAB_PATH, '/logs']);

    expect(readStoredPageTabs(storage)).toEqual([HOME_TAB_PATH, '/logs']);
    expect(JSON.parse(storage.dump().get(PAGE_TABS_STORAGE_KEY) || '[]')).toEqual([HOME_TAB_PATH, '/logs']);
  });

  it('sanitises whatever is stored', () => {
    const storage = createStorage({
      [PAGE_TABS_STORAGE_KEY]: JSON.stringify(['/logs', '/logs', '/nope', 7]),
    });

    expect(readStoredPageTabs(storage)).toEqual([HOME_TAB_PATH, '/logs']);
  });

  it('falls back to the home tab for missing or broken data', () => {
    expect(readStoredPageTabs(createStorage())).toEqual([HOME_TAB_PATH]);
    expect(readStoredPageTabs(createStorage({ [PAGE_TABS_STORAGE_KEY]: 'not json' }))).toEqual([HOME_TAB_PATH]);
    expect(readStoredPageTabs(null)).toEqual([HOME_TAB_PATH]);
  });

  it('swallows storage failures instead of breaking the shell', () => {
    const setItem = vi.fn(() => {
      throw new Error('quota exceeded');
    });
    const getItem = vi.fn(() => {
      throw new Error('blocked');
    });

    expect(() => writeStoredPageTabs({ getItem, setItem }, ['/logs'])).not.toThrow();
    expect(readStoredPageTabs({ getItem, setItem })).toEqual([HOME_TAB_PATH]);
  });
});
