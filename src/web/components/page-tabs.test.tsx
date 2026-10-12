import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import PageTabs from './PageTabs.js';
import { HOME_TAB_PATH, resolvePageTabLabel } from '../pageTabs.js';

function stubRuntime(viewport: { width: number; height: number } = { width: 1280, height: 800 }) {
  vi.stubGlobal('document', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', {
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

type MenuBox = { width: number; height: number };

type Handlers = {
  onSelect: ReturnType<typeof vi.fn>;
  onRefresh: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
  onCloseOthers: ReturnType<typeof vi.fn>;
  onCloseAll: ReturnType<typeof vi.fn>;
};

type RenderOptions = {
  /** 弹窗量出来的尺寸；react-test-renderer 不建真实 DOM，只能喂这个。 */
  menuBox?: MenuBox;
};

/** createNodeMock 造出来的假节点收下的监听器，key 是事件名。 */
const nodeListeners = new Map<string, Set<() => void>>();

function emitNodeEvent(type: string) {
  for (const handler of nodeListeners.get(type) ?? []) handler();
}

async function renderTabs(
  tabs: string[],
  activePath: string,
  options: RenderOptions = {},
): Promise<{ root: WebTestRenderer; handlers: Handlers }> {
  const handlers: Handlers = {
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    onCloseOthers: vi.fn(),
    onCloseAll: vi.fn(),
  };
  const menuBox: MenuBox = options.menuBox ?? { width: 148, height: 150 };

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
      {
        createNodeMock: (element) => {
          const props = element.props as { className?: string };
          return {
            getBoundingClientRect: () => ({
              width: menuBox.width,
              height: menuBox.height,
              left: 0,
              top: 0,
              right: menuBox.width,
              bottom: menuBox.height,
            }),
            className: String(props?.className ?? ''),
            addEventListener: (type: string, handler: () => void) => {
              const bucket = nodeListeners.get(type) ?? new Set<() => void>();
              bucket.add(handler);
              nodeListeners.set(type, bucket);
            },
            removeEventListener: (type: string, handler: () => void) => {
              nodeListeners.get(type)?.delete(handler);
            },
          };
        },
      },
    );
  });

  return { root, handlers };
}

function findTab(root: WebTestRenderer, path: string) {
  return root.root.find((node) => node.props['data-page-tab'] === path);
}

describe('PageTabs', () => {
  beforeEach(() => {
    nodeListeners.clear();
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

  it('never listens for scroll on document or window', async () => {
    // 点「⋯」时浏览器把按钮滚进视野也会发 document 级 scroll，
    // 挂在 window 上会把刚打开的菜单立刻关掉 —— 所以只允许挂在标签条上。
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs'], '/logs');

    await act(async () => {
      root.root
        .find((node) => String(node.props.className).includes('page-tabs-more'))
        .props.onClick({ currentTarget: undefined, clientX: 700, clientY: 60 });
    });

    expect(document.addEventListener).not.toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(window.addEventListener).not.toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect(nodeListeners.get('scroll')?.size).toBe(1);
    expect(root.root.findAll((node) => node.props['data-page-tabs-menu'] === true)).toHaveLength(1);

    await act(async () => {
      root.unmount();
    });
  });

  it('closes the menu when the tab strip scrolls horizontally', async () => {
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs'], '/logs');

    await act(async () => {
      root.root
        .find((node) => String(node.props.className).includes('page-tabs-more'))
        .props.onClick({ currentTarget: undefined, clientX: 700, clientY: 60 });
    });

    // 只给标签条挂了 scroll 监听，触发它就应该收起来
    expect(nodeListeners.get('scroll')?.size).toBe(1);
    await act(async () => {
      emitNodeEvent('scroll');
    });

    expect(root.root.findAll((node) => node.props['data-page-tabs-menu'] === true)).toHaveLength(0);

    await act(async () => {
      root.unmount();
    });
  });

  it('opens the menu leftwards when the anchor sits near the right edge', async () => {
    // 视口 800 宽、弹窗 148 宽：锚点在 780 时右向展开必然溢出，应向左收回来。
    stubRuntime({ width: 800, height: 600 });
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs'], '/logs', {
      menuBox: { width: 148, height: 150 },
    });

    await act(async () => {
      findTab(root, '/logs').props.onContextMenu({
        preventDefault: vi.fn(),
        clientX: 780,
        clientY: 40,
      });
    });

    const menu = root.root.find((node) => node.props['data-page-tabs-menu'] === true);
    // 向右放不下，改成以光标为右边缘向左展开：780 - 148 = 632
    expect(menu.props.style.left).toBe(632);

    await act(async () => {
      root.unmount();
    });
  });

  it('opens leftwards from the trailing 「⋯」 button', async () => {
    stubRuntime({ width: 800, height: 600 });
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs'], '/logs', {
      menuBox: { width: 148, height: 150 },
    });

    await act(async () => {
      root.root
        .find((node) => String(node.props.className).includes('page-tabs-more'))
        .props.onClick({
          clientX: undefined,
          clientY: undefined,
          // 尾部按钮贴着右边缘：left 760 / right 788
          currentTarget: {
            getBoundingClientRect: () => ({ left: 760, right: 788, top: 56, bottom: 82, width: 28, height: 26 }),
          },
        });
    });

    const menu = root.root.find((node) => node.props['data-page-tabs-menu'] === true);
    // 弹窗右边缘贴住「⋯」按钮右边缘 788：788 - 148 = 640
    expect(menu.props.style.left).toBe(640);
    // 顶部没有越界，还是贴着按钮下沿（82 + 6）
    expect(menu.props.style.top).toBe(88);

    await act(async () => {
      root.unmount();
    });
  });

  it('lifts the menu when it would overflow the bottom edge', async () => {
    stubRuntime({ width: 1280, height: 600 });
    const { root } = await renderTabs([HOME_TAB_PATH, '/logs'], '/logs', {
      menuBox: { width: 148, height: 150 },
    });

    await act(async () => {
      findTab(root, '/logs').props.onContextMenu({
        preventDefault: vi.fn(),
        clientX: 200,
        clientY: 580,
      });
    });

    const menu = root.root.find((node) => node.props['data-page-tabs-menu'] === true);
    // 下边放不下就夹回视口：600 - 8 - 150 = 442
    expect(menu.props.style.top).toBe(442);
    // 左侧本来就放得下，不动
    expect(menu.props.style.left).toBe(200);

    await act(async () => {
      root.unmount();
    });
  });
});
