import { useEffect, useMemo, useRef, useState } from 'react';
import { tr } from '../i18n.js';

export type ComboboxOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
};

type ComboboxProps = {
  value: string;
  onChange: (value: string) => void;
  options: ComboboxOption[];
  'data-testid'?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * 允不允许填列表外的值：
   * - false（默认，比如「站点」）：只能在候选里选；直接输入站点名时，一旦和某个
   *   选项完全对上或候选只剩一个，就自动补全成那一项。
   * - true（比如「上游模型名」）：输入什么就用什么，候选只用来提示和快速挑选。
   */
  allowCustom?: boolean;
  emptyLabel?: string;
  menuMaxHeight?: number;
  className?: string;
  size?: 'md' | 'sm';
  onQueryChange?: (query: string) => void;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 可搜索 + 可直接输入的下拉框（combobox）。
 * 相比 ModernSelect：触发器本身就是一个输入框，既能下拉搜索，也能敲字填充。
 */
export default function Combobox({
  value,
  onChange,
  options,
  'data-testid': dataTestId,
  placeholder = tr('请选择或输入'),
  disabled = false,
  allowCustom = false,
  emptyLabel = tr('没有匹配项'),
  menuMaxHeight = 280,
  className = '',
  size = 'md',
  onQueryChange,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const latestRef = useRef({ displayText: '', query: '' });

  const selected = useMemo(
    () => options.find((item) => item.value === value),
    [options, value],
  );

  // 未编辑时展示选中项的标签；allowCustom 且没匹配到选项时直接展示原始值。
  const displayText = open
    ? query
    : (selected ? selected.label : (allowCustom ? value : ''));

  const visibleOptions = useMemo(() => {
    const keyword = normalize(open ? query : '');
    if (!keyword) return options;
    return options.filter((item) => (
      [item.label, item.description, item.value]
        .filter((text): text is string => typeof text === 'string' && text.trim().length > 0)
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    ));
  }, [open, options, query]);

  latestRef.current = { displayText, query };

  useEffect(() => {
    if (!open) return;
    if (typeof document === 'undefined') return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (rootRef.current.contains(event.target as Node)) return;
      // 点空白处失焦：把输入框里的文字落定（对不上候选就回退）。
      commitRef.current(latestRef.current.displayText);
      setOpen(false);
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  useEffect(() => {
    if (open) setHighlight(0);
  }, [open, query]);

  /** 输入框里的文字落定成 value：优先精确匹配选项，其次（allowCustom）原样采用。 */
  const commit = (text: string) => {
    const trimmed = text.trim();
    const exact = options.find((item) => normalize(item.label) === normalize(trimmed)
      || normalize(item.value) === normalize(trimmed));
    if (exact) {
      onChange(exact.value);
      setQuery(exact.label);
      return;
    }
    if (!trimmed) {
      if (allowCustom) {
        onChange('');
        setQuery('');
      } else {
        setQuery(selected ? selected.label : '');
      }
      return;
    }
    // 「直接输入填充」：候选只剩一个时自动补全成它。
    if (!allowCustom && visibleOptions.length === 1) {
      onChange(visibleOptions[0].value);
      setQuery(visibleOptions[0].label);
      return;
    }
    if (allowCustom) {
      onChange(trimmed);
      setQuery(trimmed);
      return;
    }
    // 不允许自定义又对不上：回退到原来的选择，避免出现「看着填了其实没生效」。
    setQuery(selected ? selected.label : '');
  };

  const commitRef = useRef(commit);
  commitRef.current = commit;

  const handlePick = (option: ComboboxOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const total = visibleOptions.length;
      if (total === 0) return;
      setHighlight((current) => (current + step + total) % total);
      return;
    }
    if (event.key === 'Enter') {
      if (open && visibleOptions[highlight] && normalize(query) !== '') {
        event.preventDefault();
        handlePick(visibleOptions[highlight]);
        return;
      }
      commit(query);
      setOpen(false);
      return;
    }
    if (event.key === 'Escape') {
      setQuery(selected ? selected.label : (allowCustom ? value : ''));
      setOpen(false);
    }
  };

  return (
    <div
      ref={rootRef}
      className={`modern-select combobox ${open ? 'is-open' : ''} ${disabled ? 'is-disabled' : ''} ${size === 'sm' ? 'is-sm' : ''} ${className}`.trim()}
      data-testid={dataTestId}
    >
      <div className="modern-select-trigger" style={{ cursor: disabled ? 'not-allowed' : 'text' }}>
        <input
          ref={inputRef}
          type="text"
          className="combobox-input"
          value={displayText}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => {
            setOpen(true);
            setQuery(selected ? selected.label : (allowCustom ? value : ''));
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            onQueryChange?.(event.target.value);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: 'inherit',
            fontSize: 'inherit',
            fontFamily: 'inherit',
            padding: 0,
          }}
        />
        {!disabled && (value || query) ? (
          <button
            type="button"
            className="combobox-clear"
            title={tr('清空')}
            onMouseDown={(event) => {
              event.preventDefault();
              onChange('');
              setQuery('');
              setOpen(false);
            }}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              lineHeight: 1,
              padding: 0,
            }}
          >
            ×
          </button>
        ) : null}
        <span className="modern-select-chevron" aria-hidden="true">
          <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </div>

      {open ? (
        <div className="modern-select-panel" style={{ maxHeight: menuMaxHeight }}>
          {visibleOptions.length === 0 ? (
            <div className="modern-select-empty">
              {allowCustom && query.trim()
                ? `${tr('没有匹配项，回车直接使用')}「${query.trim()}」`
                : emptyLabel}
            </div>
          ) : (
            visibleOptions.map((option, index) => (
              <button
                key={option.value}
                type="button"
                className={`modern-select-option ${option.value === value ? 'is-selected' : ''} ${index === highlight ? 'is-active' : ''}`.trim()}
                disabled={option.disabled}
                onMouseEnter={() => setHighlight(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => handlePick(option)}
              >
                <span className="modern-select-option-label">{option.label}</span>
                {option.description ? (
                  <span className="modern-select-option-description">{option.description}</span>
                ) : null}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
