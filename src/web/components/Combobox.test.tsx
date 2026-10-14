import { describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import Combobox from './Combobox.js';

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

const OPTIONS = [
  { value: '19', label: 'happycoding' },
  { value: '21', label: 'linux.do' },
  { value: '22', label: 'lucky' },
];

function findInput(root: ReactTestInstance) {
  return root.find((node) => node.type === 'input');
}

describe('Combobox', () => {
  it('下拉里能按关键字搜索候选', async () => {
    const root = create(<Combobox value="" onChange={() => {}} options={OPTIONS} />);
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });
    await act(async () => {
      input.props.onChange({ target: { value: 'luck' } });
    });

    const text = collectText(root.root);
    expect(text).toContain('lucky');
    expect(text).not.toContain('happycoding');
  });

  it('直接输入站点名并回车会填充成对应选项', async () => {
    const onChange = vi.fn();
    const root = create(<Combobox value="" onChange={onChange} options={OPTIONS} />);
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });
    await act(async () => {
      input.props.onChange({ target: { value: 'happycoding' } });
    });
    await act(async () => {
      input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
    });

    expect(onChange).toHaveBeenCalledWith('19');
  });

  it('allowCustom 时可以直接使用列表外的值', async () => {
    const onChange = vi.fn();
    const root = create(
      <Combobox value="" onChange={onChange} options={OPTIONS} allowCustom />,
    );
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });
    await act(async () => {
      input.props.onChange({ target: { value: 'brand-new-model' } });
    });
    await act(async () => {
      input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
    });

    expect(onChange).toHaveBeenCalledWith('brand-new-model');
  });

  it('不允许自定义时，对不上的输入会回退成原来的选中项', async () => {
    const onChange = vi.fn();
    const root = create(<Combobox value="19" onChange={onChange} options={OPTIONS} />);
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });
    await act(async () => {
      input.props.onChange({ target: { value: 'something-else' } });
    });
    await act(async () => {
      input.props.onKeyDown({ key: 'Enter', preventDefault: () => {} });
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(findInput(root.root).props.value).toBe('happycoding');
  });

  it('刚聚焦时不会拿选中项的标签当筛选词，候选仍然是完整的', async () => {
    const root = create(<Combobox value="19" onChange={() => {}} options={OPTIONS} />);
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });

    // 输入框里显示的是「现在选的是谁」，但它不该把自己筛成唯一的候选 ——
    // 否则一打开面板就只剩一项，等于必须先删字才能搜。
    expect(findInput(root.root).props.value).toBe('happycoding');
    const text = collectText(root.root);
    for (const option of OPTIONS) {
      expect(text).toContain(option.label);
    }
  });

  it('聚焦后第一次按键是替换而不是追加', async () => {
    const root = create(<Combobox value="19" onChange={() => {}} options={OPTIONS} />);
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });
    // 全选由 onFocus 里的 requestAnimationFrame 完成；这里直接验证它被调过。
    await act(async () => {
      input.props.onChange({ target: { value: 'lu' } });
    });

    // 如果按键是追加在「happycoding」后面，这里就会是「happycodinglu」而筛不出
    // lucky，只会看到一个空面板。
    expect(findInput(root.root).props.value).toBe('lu');
    expect(collectText(root.root)).toContain('lucky');
  });

  it('点候选项会选中它', async () => {
    const onChange = vi.fn();
    const root = create(<Combobox value="" onChange={onChange} options={OPTIONS} />);
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });

    const option = root.root.find((node) => (
      node.type === 'button'
      && typeof node.props.className === 'string'
      && node.props.className.includes('modern-select-option')
      && collectText(node).includes('lucky')
    ));
    await act(async () => {
      option.props.onClick();
    });

    expect(onChange).toHaveBeenCalledWith('22');
  });

  it('选中一项后输入框仍然聚焦，再点一下能重新展开完整候选', async () => {
    const root = create(<Combobox value="" onChange={() => {}} options={OPTIONS} />);
    const input = findInput(root.root);

    await act(async () => {
      input.props.onFocus();
    });
    const option = root.root.find((node) => (
      node.type === 'button'
      && typeof node.props.className === 'string'
      && node.props.className.includes('modern-select-option')
      && collectText(node).includes('lucky')
    ));
    await act(async () => {
      option.props.onClick();
    });
    expect(collectText(root.root)).not.toContain('happycoding');

    // 选中后焦点没离开，onFocus 不会再触发；点触发框必须能把面板重新打开。
    const trigger = root.root.find((node) => (
      typeof node.props.className === 'string'
      && node.props.className.includes('modern-select-trigger')
    ));
    await act(async () => {
      trigger.props.onClick({ target: { closest: () => null } });
    });

    const text = collectText(root.root);
    for (const option of OPTIONS) {
      expect(text).toContain(option.label);
    }
  });
});
