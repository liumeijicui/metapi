import React, { useCallback, useEffect, useRef, useState } from 'react';
import { HOME_TAB_PATH } from '../pageTabs.js';

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
  left: number;
  top: number;
};

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
  const barRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

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
    // 页面滚走了菜单会跟内容错位，直接收起来
    window.addEventListener('scroll', closeMenu, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', closeMenu, true);
    };
  }, [menu, closeMenu]);

  // 页签被关掉（比如「关闭其他」）后，菜单要跟着收起来
  useEffect(() => {
    if (menu && !tabs.includes(menu.path)) setMenu(null);
  }, [tabs, menu]);

  const openMenu = (path: string, event: { clientX?: number; clientY?: number; currentTarget?: unknown }) => {
    const barRect = barRef.current?.getBoundingClientRect?.();
    const targetRect = (event.currentTarget as HTMLElement | undefined)?.getBoundingClientRect?.();
    const left = Number.isFinite(event.clientX)
      ? Number(event.clientX)
      : (targetRect?.left ?? barRect?.left ?? 0);
    const top = Number.isFinite(event.clientY)
      ? Number(event.clientY)
      : (targetRect?.bottom ?? (barRect?.top ?? 0) + (barRect?.height ?? 0));
    setMenu({ path, left, top });
  };

  const menuLabel = menu ? labelOf(menu.path) : '';

  return (
    <div className="page-tabs" ref={barRef} data-page-tabs>
      <div className="page-tabs-scroll" role="tablist" aria-label={t('已打开的菜单')}>
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
          className="page-tabs-menu"
          role="menu"
          data-page-tabs-menu
          style={{ left: menu.left, top: menu.top + 6 }}
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
