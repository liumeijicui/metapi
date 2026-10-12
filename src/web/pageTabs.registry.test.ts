import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PAGE_TAB_LABELS, resolvePageTabLabel } from './pageTabs.js';

/** 取 App.tsx 里从 startMarker 到 endMarker 之间的源码。 */
function readAppSlice(startMarker: string, endMarker: string): string {
  const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function readNavEntries(slice: string): Array<{ to: string; label: string }> {
  const entries: Array<{ to: string; label: string }> = [];
  // 侧边栏是 `{ to, label }`，顶部导航是 `{ label, to }`，两种顺序都要认。
  const pattern = /\{\s*(?:to:\s*'([^']+)',\s*label:\s*'([^']+)'|label:\s*'([^']+)',\s*to:\s*'([^']+)')/g;
  for (const match of slice.matchAll(pattern)) {
    entries.push({ to: match[1] ?? match[4], label: match[2] ?? match[3] });
  }
  return entries;
}

describe('page tab registry', () => {
  it('covers every sidebar entry with the same title', () => {
    const sidebar = readAppSlice('export const sidebarGroups = [', 'const topNavItems = [');
    const entries = readNavEntries(sidebar);

    expect(entries.length).toBeGreaterThan(10);
    for (const entry of entries) {
      expect(PAGE_TAB_LABELS[entry.to]).toBe(entry.label);
    }
  });

  it('covers the top navigation entries', () => {
    const topNav = readAppSlice('const topNavItems = [', 'const EDGE_MODE_NAV_PATHS');
    const entries = readNavEntries(topNav);

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(resolvePageTabLabel(entry.to)).not.toBeNull();
    }
  });

  it('covers every route registered in the router', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/App.tsx'), 'utf8');
    const paths = [...source.matchAll(/<Route path="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((path) => path !== '*');

    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      const sample = path.startsWith('/assisted-login/') ? '/assisted-login/github' : path;
      expect(resolvePageTabLabel(sample)).not.toBeNull();
    }
  });
});
