/**
 * 顶部页签（多标签导航）的纯逻辑与本地持久化。
 *
 * 这里只放「给定当前路径应该有哪些页签」这类可单测的纯函数；
 * 真正的渲染在 `components/PageTabs.tsx`，路由与状态在 `App.tsx`。
 *
 * 注意：页签只记录「打开过哪些菜单路径」，标签文案每次都从下面的注册表取，
 * 所以改文案不需要迁移用户 localStorage 里的旧数据。
 */

/** 固定的首页页签：永远存在、不可关闭，「关闭全部」之后留下的就是它。 */
export const HOME_TAB_PATH = '/';

/** 页签上限：超出后从最旧的非首页页签开始丢，避免 localStorage 无限增长。 */
export const MAX_PAGE_TABS = 20;

/** localStorage 键：只存路径数组，带版本号方便以后换结构。 */
export const PAGE_TABS_STORAGE_KEY = 'metapi.pageTabs.v1';

/** 路由 → 页签标题（i18n 中文原串，渲染时再交给 `t()`）。 */
export const PAGE_TAB_LABELS: Record<string, string> = {
  [HOME_TAB_PATH]: '仪表盘',
  '/sites': '站点管理',
  '/site-announcements': '站点公告',
  '/accounts': '连接管理',
  '/oauth': 'OAuth 管理',
  '/downstream-keys': '下游密钥',
  '/tokens': '令牌管理',
  '/checkin': '签到记录',
  '/model-forwarding': '模型转发',
  '/logs': '使用日志',
  '/monitor': '模型监控',
  '/prompts': '提示词管理',
  '/models': '模型广场',
  '/playground': '模型操练场',
  '/linuxdo': 'Linux.do 快捷登录',
  '/github': 'GitHub 快捷登录',
  '/settings': '设置',
  '/settings/import-export': '导入/导出',
  '/settings/notify': '通知设置',
  '/events': '程序日志',
  '/about': '关于',
};

/** 带参数的页签：路径匹配后由参数拼出标题。 */
const DYNAMIC_PAGE_TAB_LABELS: Array<{
  pattern: RegExp;
  label: (match: RegExpMatchArray) => string;
}> = [
  {
    pattern: /^\/assisted-login\/([^/]+)$/,
    label: (match) => {
      let provider = match[1];
      try {
        provider = decodeURIComponent(provider);
      } catch {
        // 非法编码就按原样显示
      }
      return `${provider} 快捷登录`;
    },
  },
];

export type PageTabStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function coerceStorage(storage: unknown): PageTabStorage | null {
  if (!storage || typeof storage !== 'object') return null;
  const candidate = storage as Partial<PageTabStorage>;
  if (typeof candidate.getItem !== 'function') return null;
  if (typeof candidate.setItem !== 'function') return null;
  return candidate as PageTabStorage;
}

/** 归一化路径：去掉 query / hash / 结尾斜杠，空路径就是首页。 */
export function normalizeTabPath(pathname: unknown): string {
  const raw = String(pathname ?? '').split('?')[0].split('#')[0].trim();
  if (!raw || raw === HOME_TAB_PATH) return HOME_TAB_PATH;
  const trimmed = raw.replace(/\/+$/, '');
  if (!trimmed) return HOME_TAB_PATH;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/** 该路径对应的页签标题；返回 null 表示这个路径不作为页签（例如 404 重定向）。 */
export function resolvePageTabLabel(pathname: unknown): string | null {
  const path = normalizeTabPath(pathname);
  const exact = PAGE_TAB_LABELS[path];
  if (exact) return exact;

  for (const entry of DYNAMIC_PAGE_TAB_LABELS) {
    const match = path.match(entry.pattern);
    if (match) return entry.label(match);
  }

  return null;
}

/** 这个路径是否应该出现在顶部页签里。 */
export function isPageTabPath(pathname: unknown): boolean {
  return resolvePageTabLabel(pathname) !== null;
}

/** 保证首页在第一位，去掉重复与不认识的路径，并裁到上限。 */
export function normalizePageTabList(input: unknown): string[] {
  const source = Array.isArray(input) ? input : [];
  const result: string[] = [HOME_TAB_PATH];
  const seen = new Set<string>([HOME_TAB_PATH]);

  for (const item of source) {
    if (typeof item !== 'string') continue;
    const path = normalizeTabPath(item);
    if (seen.has(path)) continue;
    if (!isPageTabPath(path)) continue;
    seen.add(path);
    result.push(path);
  }

  if (result.length <= MAX_PAGE_TABS) return result;
  return [result[0], ...result.slice(result.length - (MAX_PAGE_TABS - 1))];
}

/** 打开一个菜单：已经开过就保持原来的位置与顺序。 */
export function openPageTab(tabs: string[], pathname: unknown): string[] {
  const path = normalizeTabPath(pathname);
  // 没变化就返回同一个数组引用：React 的状态更新会因此跳过重渲染。
  if (!isPageTabPath(path)) return tabs;
  if (tabs.includes(path)) return tabs;
  return normalizePageTabList([...tabs, path]);
}

/** 关闭一个页签：首页固定，关不掉。 */
export function closePageTab(tabs: string[], pathname: unknown): string[] {
  const path = normalizeTabPath(pathname);
  if (path === HOME_TAB_PATH) return tabs;
  if (!tabs.includes(path)) return tabs;
  return normalizePageTabList(tabs.filter((item) => item !== path));
}

/** 关闭其他页签：只留首页与被点的那一个。 */
export function closeOtherPageTabs(tabs: string[], pathname: unknown): string[] {
  const path = normalizeTabPath(pathname);
  if (!isPageTabPath(path) || !tabs.includes(path)) return normalizePageTabList(tabs);
  return normalizePageTabList([HOME_TAB_PATH, path]);
}

/** 关闭全部页签：回到只剩首页。 */
export function closeAllPageTabs(): string[] {
  return [HOME_TAB_PATH];
}

/**
 * 关掉某个页签之后应该停在哪：优先右边那个，没有就往左退。
 * 关的不是当前页签时，当前页签不动。
 */
export function resolveActivePathAfterClose(
  tabs: readonly string[],
  closedPath: unknown,
  activePath: unknown,
): string {
  const closed = normalizeTabPath(closedPath);
  const active = normalizeTabPath(activePath);
  if (closed !== active) return active;

  const index = tabs.indexOf(closed);
  if (index < 0) return active;

  const remaining = tabs.filter((item) => item !== closed);
  if (remaining.length === 0) return HOME_TAB_PATH;
  const nextIndex = Math.min(index, remaining.length - 1);
  return remaining[nextIndex] || HOME_TAB_PATH;
}

/** 从 localStorage 读页签；读不到 / 内容坏了都退回「只有首页」。 */
export function readStoredPageTabs(storage?: unknown): string[] {
  const target = coerceStorage(storage);
  if (!target) return [HOME_TAB_PATH];

  try {
    const raw = target.getItem(PAGE_TABS_STORAGE_KEY);
    if (!raw) return [HOME_TAB_PATH];
    return normalizePageTabList(JSON.parse(raw));
  } catch {
    return [HOME_TAB_PATH];
  }
}

/** 写页签；写失败（隐私模式、配额满）不影响使用。 */
export function writeStoredPageTabs(storage: unknown, tabs: readonly string[]): void {
  const target = coerceStorage(storage);
  if (!target) return;

  try {
    target.setItem(PAGE_TABS_STORAGE_KEY, JSON.stringify(normalizePageTabList(tabs)));
  } catch {
    // 存不下就算了，下次进来只有首页
  }
}

/** 弹窗默认留出的视口边距与锚点间距。 */
export const TAB_MENU_VIEWPORT_MARGIN = 8;
export const TAB_MENU_ANCHOR_GAP = 6;
/** 还没量到真实尺寸前先按这个宽度估位，避免第一帧从视口外飞进来。 */
export const TAB_MENU_FALLBACK_WIDTH = 160;
export const TAB_MENU_FALLBACK_HEIGHT = 180;

export type TabMenuPlacementInput = {
  /** 锚点左边缘（右键时就是光标 x）。 */
  anchorLeft: number;
  /** 锚点右边缘（右键时等于 anchorLeft）。 */
  anchorRight: number;
  /** 锚点下边缘。 */
  anchorBottom: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  gap?: number;
};

export type TabMenuPlacement = { left: number; top: number };

function toFiniteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * 计算页签弹窗的落点（视口坐标，配 `position: fixed` 用）。
 *
 * 默认从锚点右边缘向右展开；右边放不下就改成向左展开 ——
 * 左展开时右边缘贴住锚点右边缘（尾部「⋯」按钮就落在这个分支），
 * 这样弹窗不会顶出页面右侧。最后再按视口夹一次，保证四面都在视口内。
 */
export function placeTabMenu(input: TabMenuPlacementInput): TabMenuPlacement {
  const margin = Math.max(0, toFiniteNumber(input.margin, TAB_MENU_VIEWPORT_MARGIN));
  const gap = Math.max(0, toFiniteNumber(input.gap, TAB_MENU_ANCHOR_GAP));
  const menuWidth = Math.max(0, toFiniteNumber(input.menuWidth, TAB_MENU_FALLBACK_WIDTH));
  const menuHeight = Math.max(0, toFiniteNumber(input.menuHeight, TAB_MENU_FALLBACK_HEIGHT));
  const viewportWidth = toFiniteNumber(input.viewportWidth, 0);
  const viewportHeight = toFiniteNumber(input.viewportHeight, 0);
  const anchorLeft = toFiniteNumber(input.anchorLeft, 0);
  const anchorRight = Math.max(anchorLeft, toFiniteNumber(input.anchorRight, anchorLeft));
  const anchorBottom = toFiniteNumber(input.anchorBottom, 0);

  // 先假设向右展开
  let left = anchorLeft;
  if (viewportWidth > 0 && left + menuWidth > viewportWidth - margin) {
    left = anchorRight - menuWidth;
  }
  if (viewportWidth > 0) {
    const maxLeft = Math.max(margin, viewportWidth - margin - menuWidth);
    left = Math.min(Math.max(left, margin), maxLeft);
  }

  let top = anchorBottom + gap;
  if (viewportHeight > 0) {
    const maxTop = Math.max(margin, viewportHeight - margin - menuHeight);
    top = Math.min(Math.max(top, margin), maxTop);
  }

  return { left, top };
}
