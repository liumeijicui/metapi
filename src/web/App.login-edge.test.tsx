import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { Login } from './App.js';

// 登录页里的 EdgeServerFields 走 useI18n：这里只测登录页本身，直接给它一个直通的实现。
vi.mock('./i18n.js', () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => children,
  useI18n: () => ({
    language: 'zh',
    setLanguage: vi.fn(),
    toggleLanguage: vi.fn(),
    t: (text: string) => text,
  }),
}));

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  } as Storage;
}

/** 登录页自己接收 t，不必套 Provider。 */
function renderLogin(edgeServerUrl: string) {
  return <Login onLogin={vi.fn()} t={(text) => text} edgeMode edgeServerUrl={edgeServerUrl} />;
}

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => (
    typeof child === 'string' ? child : collectText(child)
  )).join('');
}

function findByText(root: ReactTestInstance, type: string, text: string): ReactTestInstance {
  return root.find((node) => node.type === type && collectText(node).trim() === text);
}

function findServerInput(root: ReactTestInstance, suffix: string): ReactTestInstance | null {
  const matches = root.findAll((node) => (
    node.type === 'input' && node.props.id === `edge-server-${suffix}`
  ));
  return matches[0] || null;
}

describe('边缘版登录页的配置来源', () => {
  beforeAll(() => {
    vi.stubGlobal('localStorage', createMemoryStorage());
  });

  it('没配过服务器时展开，回填默认服务器，只要填令牌', () => {
    const root = create(renderLogin(''));
    try {
      expect(collectText(root.root)).toContain('同步设置 · 配置来源');
      expect(findServerInput(root.root, 'address')?.props.value).toBe('43.142.48.105');
      expect(findServerInput(root.root, 'port')?.props.value).toBe('81');
    } finally {
      root.unmount();
    }
  });

  it('配过之后默认折叠成一行摘要，点「修改」才展开', () => {
    const root = create(renderLogin('http://43.142.48.105:81'));
    try {
      const summary = collectText(root.root);
      expect(summary).toContain('已保存');
      expect(summary).toContain('43.142.48.105:81');
      // 折叠状态下不渲染输入框，登录只需要填令牌。
      expect(findServerInput(root.root, 'address')).toBeNull();

      act(() => findByText(root.root, 'button', '修改').props.onClick());
      expect(findServerInput(root.root, 'address')?.props.value).toBe('43.142.48.105');
      expect(findServerInput(root.root, 'port')?.props.value).toBe('81');

      act(() => findByText(root.root, 'button', '收起').props.onClick());
      expect(findServerInput(root.root, 'address')).toBeNull();
    } finally {
      root.unmount();
    }
  });

  it('已保存的地址晚一步到货也能回填（登录页先渲染、状态接口后返回）', () => {
    const root = create(renderLogin(''));
    try {
      act(() => {
        root.update(renderLogin('https://gateway.example.com'));
      });

      // 地址到货后自动折叠，摘要显示的就是保存的那份。
      expect(collectText(root.root)).toContain('已保存');
      expect(collectText(root.root)).toContain('gateway.example.com');
      act(() => findByText(root.root, 'button', '修改').props.onClick());
      expect(findServerInput(root.root, 'address')?.props.value).toBe('gateway.example.com');
      expect(findServerInput(root.root, 'port')?.props.value).toBe('');
    } finally {
      root.unmount();
    }
  });

  it('用户已经改过输入框时，晚到的地址不覆盖输入', () => {
    const root = create(renderLogin(''));
    try {
      act(() => {
        findServerInput(root.root, 'address')!.props.onChange({ target: { value: '10.0.0.5' } });
      });
      act(() => {
        root.update(renderLogin('http://43.142.48.105:81'));
      });

      expect(findServerInput(root.root, 'address')?.props.value).toBe('10.0.0.5');
    } finally {
      root.unmount();
    }
  });
});

