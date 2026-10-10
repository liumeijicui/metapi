import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { ToastProvider } from '../components/Toast.js';
import ModelForwarding from './ModelForwarding.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelForwardRules: vi.fn(),
    getModelForwardOptions: vi.fn(),
    deleteModelForwardRule: vi.fn(),
    deleteModelForwardTarget: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

// 确认框走 createPortal 挂到 body 上，测试里直接当普通节点渲染。
vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return { ...actual, createPortal: (node: unknown) => node };
});

vi.mock('../edgeMode.js', () => ({
  useEdgeStatus: () => null,
  triggerEdgeSync: vi.fn(),
}));

const rule = {
  id: 7,
  modelName: 'gpt-6-astra',
  enabled: true,
  routeId: null,
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
  targets: [
    {
      id: 31,
      siteId: 3,
      siteName: 'Demo',
      accountId: 9,
      accountUsername: 'alpha',
      upstreamModel: 'deepseek-v4.1-flash',
      enabled: true,
      sortOrder: 0,
      cooldownUntil: null,
      autoDemotedAt: null,
      consecutiveUpstreamFailures: null,
    },
  ],
};

function findByTestId(root: ReactTestInstance, testId: string): ReactTestInstance {
  return root.find((node) => node.props?.['data-testid'] === testId);
}

function findButton(root: ReactTestInstance, className: string): ReactTestInstance {
  return root.find((node) => (
    node.type === 'button' && String(node.props?.className || '').split(' ').includes(className)
  ));
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('模型转发删除确认', () => {
  let tree: ReturnType<typeof create> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getModelForwardRules.mockResolvedValue({ rules: [rule] });
    apiMock.getModelForwardOptions.mockResolvedValue({ sites: [], accounts: [], models: [] });
    apiMock.deleteModelForwardRule.mockResolvedValue({ success: true });
    apiMock.deleteModelForwardTarget.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    tree?.unmount();
    tree = null;
  });

  async function mount() {
    await act(async () => {
      tree = create(
        <ToastProvider>
          <ModelForwarding />
        </ToastProvider>,
      );
    });
    await flush();
    return tree!.root;
  }

  it('点「删除」只弹确认框，不发删除请求', async () => {
    const root = await mount();

    await act(async () => {
      findByTestId(root, 'forward-target-delete-31').props.onClick();
    });
    await flush();

    expect(apiMock.deleteModelForwardTarget).not.toHaveBeenCalled();
    // 确认框里点名说清删的是谁。
    expect(JSON.stringify(tree!.toJSON())).toContain('deepseek-v4.1-flash');
  });

  it('确认后才真的删除目标，取消则什么都不做', async () => {
    const root = await mount();

    await act(async () => {
      findByTestId(root, 'forward-target-delete-31').props.onClick();
    });
    await flush();

    // 先走一次取消：不该删除，也不该留下定时炸弹（再点删除还能弹出来）。
    await act(async () => {
      findButton(root, 'btn-ghost').props.onClick();
    });
    await flush();
    expect(apiMock.deleteModelForwardTarget).not.toHaveBeenCalled();

    await act(async () => {
      findByTestId(root, 'forward-target-delete-31').props.onClick();
    });
    await flush();
    await act(async () => {
      findButton(root, 'btn-danger').props.onClick();
    });
    await flush();

    expect(apiMock.deleteModelForwardTarget).toHaveBeenCalledWith(rule.id, 31);
  });

  it('删除整条规则同样要确认，并说清会连带删掉几个目标', async () => {
    const root = await mount();

    await act(async () => {
      findByTestId(root, 'forward-rule-delete-7').props.onClick();
    });
    await flush();
    expect(apiMock.deleteModelForwardRule).not.toHaveBeenCalled();
    expect(JSON.stringify(tree!.toJSON())).toContain('gpt-6-astra');

    await act(async () => {
      findButton(root, 'btn-danger').props.onClick();
    });
    await flush();
    expect(apiMock.deleteModelForwardRule).toHaveBeenCalledWith(rule.id);
  });
});
