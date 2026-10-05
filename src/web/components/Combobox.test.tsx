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
});
