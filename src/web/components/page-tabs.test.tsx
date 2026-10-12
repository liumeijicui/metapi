import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import PageTabs from './PageTabs.js';
import { HOME_TAB_PATH, resolvePageTabLabel } from '../pageTabs.js';

function stubRuntime() {
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

type Handlers = {
  onSelect: ReturnType<typeof vi.fn>;
  onRefresh: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onCloseOthers: ReturnType<typeof vi.fn>;
  onCloseAll: ReturnType<typeof vi.fn>;
};

async function renderTabs(tabs: string[], activePath: string): Promise<{ root: WebTestRenderer; handlers: Handlers }> {
  const handlers: Handlers = {
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseAll: vi.fn(),
  };

  let root!: WebTestRenderer;
  await act(async () => {
    root = create(
      <PageTabs
        tabs={tabs}
        activePath={activePath}
        labelOf={(path) => resolvePageTabLabel(path) ?? path}
        onSelect={handlers.onSelect}
        onRefresh={handlers.onRefresh}
        onClose={handlers.onClose}
        onCloseOthers={handlers.onCloseOthers}
        onCloseAll={handlers.onCloseAll}
        t={(text) => text}
      />,
    );
  });

  return { root, handlers };
}

function findTab(root: WebTestRenderer, path: string) {
  return root.root.find((node) => node.props['data-page-tab'] === path);
}

describe('PageTabs', () => {
  beforeEach(() => {
    stubRuntime();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders one tab per opened menu and marks the active one', async () => {
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs', '/monitor'], '/logs');

    const tabPaths = root.root
      .findAll((node) => typeof node.props['data-page-tab'] === 'string')
      .map((node) => node.props['data-page-tab'] as string);

    expect(tabPaths).toEqual([HOME_TAB_PATH, '/logs', '/monitor']);

    const active = findTab(root, '/logs');
    expect(active.props.className).toContain('active');
    expect(active.props['aria-selected']).toBe(true);
    expect(findTab(root, '/monitor').props['aria-selected']).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it('switches on click and refreshes on double click', async () => {
    const { root, handlers } = await renderTabs([HOME_TAB_PATH, '/logs'], '/');

    await act(async () => {
      findTab(root, '/logs').props.onClick();
    });
    await act(async () => {
      findTab(root, '/logs').props.onDoubleClick();
    });

    expect(handlers.onSelect).toHaveBeenCalledWith('/logs');
    expect(handlers.onRefresh).toHaveBeenCalledWith('/logs');

    await act(async () => {
      root.unmount();
    });
  });

  it('closes a tab from its own close button without switching to it', async () => {
    const { root, handlers } = await renderTabs([HOME_TAB_PATH, '/logs', '/monitor'], '/monitor');

    const stopPropagation = vi.fn();
    const closeButton = findTab(root, '/logs').find((node) => (
      node.type === 'button' && String(node.props.className).includes('page-tab-close')
    ));
    await act(async () => {
      closeButton.props.onClick({ stopPropagation });
    });

    expect(stopPropagation).toHaveBeenCalled();
    expect(handlers.onClose).toHaveBeenCalledWith('/logs');
    expect(handlers.onSelect).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('does not render a close button on the pinned home tab', async () => {
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs'], '/');

    const homeCloseButtons = findTab(root, HOME_TAB_PATH)
      .findAll((node) => String(node.props.className).includes('page-tab-close'));

    expect(homeCloseButtons).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it('opens the tab menu on right click with refresh / close / close others / close all', async () => {
    const { root, handlers } = await renderTabs([HOME_TAB_PATH, '/logs', '/monitor'], '/monitor');

    await act(async () => {
      findTab(root, '/logs').props.onContextMenu({
        preventDefault: vi.fn(),
        clientX: 40,
        clientY: 80,
      });
    });

    const menu = root.root.find((node) => node.props['data-page-tabs-menu'] === true);
    const items = menu.findAll((node) => node.type === 'button');
    expect(items.map((item) => item.children.join(''))).toEqual([
      '刷新该标签',
      '关闭该标签',
      '关闭其他标签',
      '关闭全部标签',
    ]);

    const findItem = (label: string) => items.find((item) => item.children.join('') === label);

    await act(async () => {
      findItem('关闭其他标签')?.props.onClick();
    });
    expect(handlers.onCloseOthers).toHaveBeenCalledWith('/logs');

    await act(async () => {
      findTab(root, '/monitor').props.onContextMenu({
        preventDefault: vi.fn(),
        clientX: 10,
        clientY: 20,
      });
    });
    const reopened = root.root.find((node) => node.props['data-page-tabs-menu'] === true);
    const allItem = reopened.findAll((node) => node.type === 'button')
      .find((item) => item.children.join('') === '关闭全部标签');
    await act(async () => {
      allItem?.props.onClick();
    });
    expect(handlers.onCloseAll).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('disables closing the home tab from the menu', async () => {
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs'], '/');

    await act(async () => {
      root.root
        .find((node) => String(node.props.className).includes('page-tabs-more'))
        .props.onClick({ currentTarget: undefined, clientX: undefined, clientY: undefined });
    });

    const items = root.root
      .find((node) => node.props['data-page-tabs-menu'] === true)
      .findAll((node) => node.type === 'button');
    const closeItem = items.find((item) => item.children.join('') === '关闭该标签');

    expect(closeItem?.props.disabled).toBe(true);

    await act(async () => {
      root.unmount();
    });
  });
});
