import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import App from './App.js';
import { HOME_TAB_PATH, PAGE_TABS_STORAGE_KEY } from './pageTabs.js';

const { apiMock, authSessionMock, pageMounts } = vi.hoisted(() => ({
  apiMock: {
    getEvents: vi.fn(),
  },
  authSessionMock: {
    hasValidAuthSession: vi.fn(),
    persistAuthSession: vi.fn(),
    clearAuthSession: vi.fn(),
  },
  pageMounts: { logs: 0, sites: 0 },
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: (node: unknown) => node,
  };
});

vi.mock('./api.js', () => ({ api: apiMock }));

vi.mock('./authSession.js', () => ({
  hasValidAuthSession: authSessionMock.hasValidAuthSession,
  persistAuthSession: authSessionMock.persistAuthSession,
  clearAuthSession: authSessionMock.clearAuthSession,
}));

vi.mock('./components/SearchModal.js', () => ({ default: () => null }));
vi.mock('./components/NotificationPanel.js', () => ({ default: () => null }));
vi.mock('./components/TooltipLayer.js', () => ({ default: () => null }));
vi.mock('./components/useAnimatedVisibility.js', () => ({
  useAnimatedVisibility: (open: boolean) => ({ shouldRender: open, isVisible: open }),
}));
vi.mock('./i18n.js', () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children,
  useI18n: () => ({ language: 'zh', toggleLanguage: vi.fn(), t: (text: string) => text }),
}));

vi.mock('./pages/Dashboard.js', () => ({ default: () => <div>DashboardPage</div> }));
vi.mock('./pages/ModelMonitor.js', () => ({ default: () => <div>ModelMonitorPage</div> }));

// 这两个页面各自数一次「挂载次数」，用来验证双击页签确实重新挂了组件。
vi.mock('./pages/Sites.js', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    default: () => {
      React.useEffect(() => {
        pageMounts.sites += 1;
      }, []);
      return React.createElement('div', null, 'SitesPage');
    },
  };
});

vi.mock('./pages/ProxyLogs.js', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    default: () => {
      React.useEffect(() => {
        pageMounts.logs += 1;
      }, []);
      return React.createElement('div', null, 'ProxyLogsPage');
    },
  };
});

let navigateRef: ((to: string) => void) | null = null;
function NavigateProbe() {
  navigateRef = useNavigate();
  return null;
}

function createLocalStorage(initial?: Record<string, string>) {
  const store = new Map<string, string>([
    ['metapi.theme.mode', 'light'],
    ['metapi.firstUseDocReminder', '1'],
    ...Object.entries(initial ?? {}),
  ]);
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    dump: () => new Map(store),
  };
}

function setupRuntime(width = 1440) {
  const matchMedia = (query: string) => ({
    matches: query.includes('prefers-color-scheme') ? false : width <= 768,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  });
  const documentElementAttributes = new Map<string, string>();

  vi.stubGlobal('localStorage', createLocalStorage());
  vi.stubGlobal('window', {
    innerWidth: width,
    matchMedia,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('document', {
    body: { style: {} },
    documentElement: {
      setAttribute: (name: string, value: string) => {
        documentElementAttributes.set(name, value);
      },
      getAttribute: (name: string) => documentElementAttributes.get(name) ?? null,
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderApp(path = '/') {
  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={[path]}>
        <App />
        <NavigateProbe />
      </MemoryRouter>,
    );
  });
  await flush();
  return root;
}

function tabPaths(root: WebTestRenderer): string[] {
  return root.root
    .findAll((node) => typeof node.props['data-page-tab'] === 'string')
    .map((node) => node.props['data-page-tab'] as string);
}

describe('App page tabs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigateRef = null;
    pageMounts.logs = 0;
    pageMounts.sites = 0;
    apiMock.getEvents.mockResolvedValue([]);
    authSessionMock.hasValidAuthSession.mockReturnValue(true);
    setupRuntime();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('adds a tab for the current menu and for menus opened later', async () => {
    const root = await renderApp('/');

    expect(tabPaths(root)).toEqual([HOME_TAB_PATH]);

    await act(async () => {
      navigateRef?.('/logs');
    });
    await flush();

    expect(tabPaths(root)).toEqual([HOME_TAB_PATH, '/logs']);
    expect(JSON.parse(String(localStorage.getItem(PAGE_TABS_STORAGE_KEY)))).toEqual([HOME_TAB_PATH, '/logs']);

    await act(async () => {
      root.unmount();
    });
  });

  it('restores tabs from localStorage on load', async () => {
    setupRuntime();
    localStorage.setItem(PAGE_TABS_STORAGE_KEY, JSON.stringify(['/', '/logs', '/sites']));

    const root = await renderApp('/sites');

    expect(tabPaths(root)).toEqual([HOME_TAB_PATH, '/logs', '/sites']);

    await act(async () => {
      root.unmount();
    });
  });

  it('closes other tabs and keeps the picked one', async () => {
    setupRuntime();
    localStorage.setItem(PAGE_TABS_STORAGE_KEY, JSON.stringify(['/', '/logs', '/sites']));

    const root = await renderApp('/sites');
    const sitesTab = root.root.find((node) => node.props['data-page-tab'] === '/sites');

    await act(async () => {
      sitesTab.props.onContextMenu({ preventDefault: vi.fn(), clientX: 12, clientY: 34 });
    });

    const menuItems = root.root
      .find((node) => node.props['data-page-tabs-menu'] === true)
      .findAll((node) => node.type === 'button');
    const closeOthers = menuItems.find((item) => item.children.join('') === '关闭其他标签');
    await act(async () => {
      closeOthers?.props.onClick();
    });
    await flush();

    expect(tabPaths(root)).toEqual([HOME_TAB_PATH, '/sites']);

    await act(async () => {
      root.unmount();
    });
  });

  it('reloads the page when a tab is double clicked', async () => {
    setupRuntime();
    localStorage.setItem(PAGE_TABS_STORAGE_KEY, JSON.stringify(['/', '/logs']));

    const root = await renderApp('/logs');
    expect(pageMounts.logs).toBe(1);

    await act(async () => {
      root.root.find((node) => node.props['data-page-tab'] === '/logs').props.onDoubleClick();
    });
    await flush();

    // 换 key 重新挂载 = 页面重新拉一次数据
    expect(pageMounts.logs).toBe(2);

    await act(async () => {
      root.unmount();
    });
  });

  it('hides the tab bar on mobile layouts', async () => {
    setupRuntime(520);

    const root = await renderApp('/');

    expect(root.root.findAll((node) => node.props['data-page-tabs'] === true)).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });
});
