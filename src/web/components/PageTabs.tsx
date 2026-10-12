import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  HOME_TAB_PATH,
  TAB_MENU_ANCHOR_GAP,
  TAB_MENU_FALLBACK_HEIGHT,
  TAB_MENU_FALLBACK_WIDTH,
  placeTabMenu,
} from '../pageTabs.js';

type PageTabsProps = {
  /** 已打开的菜单路径，第一个固定是首页。 */
  tabs: string[];
  /** 当前路由对应的页签路径。 */
  activePath: string;
  /** 路径 → 显示文案（由 App 交给 i18n）。 */
  labelOf: (path: string) => string;
  onSelect: (path: string) => void;
  /** 双击页签：让这个菜单重新拉一次数据。 */
  onRefresh: (path: string) => void;
  onClose: (path: string) => void;
  onCloseOthers: (path: string) => void;
  onCloseAll: () => void;
  t: (text: string) => string;
};

type MenuState = {
  path: string;
  /** 锚点左边缘（右键时就是光标 x）。 */
  anchorLeft: number;
  /** 锚点右边缘；右边放不下时用它改成向左展开。 */
  anchorRight: number;
  /** 锚点下边缘；弹窗默认贴在这里往下。 */
  anchorBottom: number;
};

function readViewportSize(): { width: number; height: number } {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return {
    width: Number(window.innerWidth) || 0,
    height: Number(window.innerHeight) || 0,
  };
}

/**
 * 顶部多页签：菜单打开后在这里留一个标签。
 * - 单击切换、双击刷新（重新挂载该页面 → 重新拉数据）
 * - 右键 / 尾部「⋯」出菜单：刷新、关闭、关闭其他、关闭全部
 * - 首页标签固定不可关，「关闭全部」之后留下的是它
 */
export default function PageTabs({
  tabs,
  activePath,
  labelOf,
  onSelect,
  onRefresh,
  onClose,
  onCloseOthers,
  onCloseAll,
  t,
}: PageTabsProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [menuSize, setMenuSize] = useState<{ width: number; height: number } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  /**
   * 弹窗文案、字号都固定，宽度量一次就够；量到之后交给 placeTabMenu 算最终落点
   * （右边放不下会改成向左展开）。尺寸没变时不更新 state，避免死循环。
   */
  useLayoutEffect(() => {
    if (!menu) return;
    const element = menuRef.current as HTMLElement | null;
    if (!element || typeof element.getBoundingClientRect !== 'function') return;

    const rect = element.getBoundingClientRect();
    setMenuSize((prev) => (
      prev && prev.width === rect.width && prev.height === rect.height
        ? prev
        : { width: rect.width, height: rect.height }
    ));
  }, [menu]);

  useEffect(() => {
    if (!menu) return undefined;
    const handlePointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (barRef.current && target && barRef.current.contains(target)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu, closeMenu]);

  /**
   * 只在标签条自己横向滚动时收起菜单 —— 那时锚点会从弹窗底下滑走。
   * 页面纵向滚动不收：标签栏是 sticky 的、弹窗是 fixed 的，两者一起走，不会错位；
   * 而且点「⋯」时浏览器把按钮滚进视野也会发 document 级 scroll，按以前那样监听
   * window 会把刚打开的菜单立刻关掉。
   */
  useEffect(() => {
    if (!menu) return undefined;
    const strip = stripRef.current;
    if (!strip || typeof strip.addEventListener !== 'function') return undefined;

    const handleStripScroll = () => closeMenu();
    strip.addEventListener('scroll', handleStripScroll);
    return () => {
      if (typeof strip.removeEventListener === 'function') {
        strip.removeEventListener('scroll', handleStripScroll);
      }
    };
  }, [menu, closeMenu]);

  // 页签被关掉（比如「关闭其他」）后，菜单要跟着收起来
  useEffect(() => {
    if (menu && !tabs.includes(menu.path)) setMenu(null);
  }, [tabs, menu]);

  const openMenu = (path: string, event: { clientX?: number; clientY?: number; currentTarget?: unknown }) => {
    const barRect = barRef.current?.getBoundingClientRect?.();
    const targetRect = (event.currentTarget as HTMLElement | undefined)?.getBoundingClientRect?.();
    const hasPointerX = Number.isFinite(event.clientX);
    const hasPointerY = Number.isFinite(event.clientY);
    const anchorLeft = hasPointerX
      ? Number(event.clientX)
      : (targetRect?.left ?? barRect?.left ?? 0);
    const anchorRight = hasPointerX
      ? Number(event.clientX)
      : (targetRect?.right ?? anchorLeft);
    const anchorBottom = hasPointerY
      ? Number(event.clientY)
      : (targetRect?.bottom ?? (barRect?.top ?? 0) + (barRect?.height ?? 0));

    setMenuSize(null);
    setMenu({ path, anchorLeft, anchorRight, anchorBottom });
  };

  const viewport = readViewportSize();
  const placement = menu
    ? placeTabMenu({
      anchorLeft: menu.anchorLeft,
      anchorRight: menu.anchorRight,
      anchorBottom: menu.anchorBottom,
      menuWidth: menuSize?.width ?? TAB_MENU_FALLBACK_WIDTH,
      menuHeight: menuSize?.height ?? TAB_MENU_FALLBACK_HEIGHT,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      gap: TAB_MENU_ANCHOR_GAP,
    })
    : null;
  const menuLabel = menu ? labelOf(menu.path) : '';

  return (
    <div className="page-tabs" ref={barRef} data-page-tabs>
      <div className="page-tabs-scroll" ref={stripRef} role="tablist" aria-label={t('已打开的菜单')}>
        {tabs.map((path) => {
          const isActive = path === activePath;
          const label = labelOf(path);
          return (
            <div
              key={path}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              data-page-tab={path}
              className={`page-tab ${isActive ? 'active' : ''}`}
              title={t('单击切换，双击刷新')}
              onClick={() => onSelect(path)}
              onDoubleClick={() => onRefresh(path)}
              onContextMenu={(event) => {
                event.preventDefault();
                openMenu(path, event);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(path);
                }
                if (event.key === 'F5' || (event.key === 'r' && (event.ctrlKey || event.metaKey))) {
                  event.preventDefault();
                  onRefresh(path);
                }
              }}
            >
              <span className="page-tab-label">{label}</span>
              {path === HOME_TAB_PATH ? null : (
                <button
                  type="button"
                  className="page-tab-close"
                  aria-label={`${t('关闭')} ${label}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(path);
                  }}
                >
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="page-tabs-more"
        aria-label={t('标签操作')}
        title={t('标签操作')}
        onClick={(event) => openMenu(activePath, event)}
      >
        <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h.01M12 12h.01M19 12h.01" />
        </svg>
      </button>

      {menu ? (
        <div
          ref={menuRef}
          className="page-tabs-menu"
          role="menu"
          data-page-tabs-menu
          style={{ left: placement?.left, top: placement?.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="page-tabs-menu-title">{menuLabel}</div>
          <button
            type="button"
            role="menuitem"
            className="page-tabs-menu-item"
            onClick={() => {
              closeMenu();
              onRefresh(menu.path);
            }}
          >
            {t('刷新该标签')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="page-tabs-menu-item"
            disabled={menu.path === HOME_TAB_PATH}
            onClick={() => {
              closeMenu();
              onClose(menu.path);
            }}
          >
            {t('关闭该标签')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="page-tabs-menu-item"
            onClick={() => {
              closeMenu();
              onCloseOthers(menu.path);
            }}
          >
            {t('关闭其他标签')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="page-tabs-menu-item danger"
            onClick={() => {
              closeMenu();
              onCloseAll();
            }}
          >
            {t('关闭全部标签')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
