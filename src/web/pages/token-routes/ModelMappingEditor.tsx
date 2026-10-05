import { useEffect, useRef, useState } from 'react';
import { tr } from '../../i18n.js';
import {
  parseModelMappingEntries,
  serializeModelMappingEntries,
  type ModelMappingEntry,
} from './utils.js';

type ModelMappingEditorProps = {
  value: string | null | undefined;
  onChange: (nextValue: string | null) => void;
};

const INPUT_STYLE = {
  flex: '1 1 160px',
  minWidth: 0,
  padding: '8px 12px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 12.5,
  outline: 'none',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  fontFamily: 'var(--font-mono)',
} as const;

function isCompleteRow(entry: ModelMappingEntry): boolean {
  return !!entry.from.trim() && !!entry.to.trim();
}

export default function ModelMappingEditor({ value, onChange }: ModelMappingEditorProps) {
  const [rows, setRows] = useState<ModelMappingEntry[]>(() => parseModelMappingEntries(value));
  const lastEmittedRef = useRef<string | null>(serializeModelMappingEntries(parseModelMappingEntries(value)));

  useEffect(() => {
    const incoming = serializeModelMappingEntries(parseModelMappingEntries(value));
    if (incoming !== lastEmittedRef.current) {
      lastEmittedRef.current = incoming;
      setRows(parseModelMappingEntries(incoming));
    }
  }, [value]);

  const commit = (nextRows: ModelMappingEntry[]) => {
    setRows(nextRows);
    const serialized = serializeModelMappingEntries(nextRows);
    lastEmittedRef.current = serialized;
    onChange(serialized);
  };

  const updateRow = (index: number, patch: Partial<ModelMappingEntry>) => {
    commit(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)));
  };

  const removeRow = (index: number) => {
    commit(rows.filter((_, rowIndex) => rowIndex !== index));
  };

  const addRow = () => {
    commit([...rows, { from: '', to: '' }]);
  };

  const hasIncompleteRow = rows.some((row) => !isCompleteRow(row));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
          {tr('模型映射')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
          {tr('把请求里的模型名转发到上游站点的其它模型；留空则原样转发。左侧支持精确模型名或通配符。')}
        </div>
      </div>

      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          {tr('暂无映射，请求模型将原样转发到上游。')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((row, index) => {
            const invalid = !isCompleteRow(row);
            return (
              <div key={index} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <input
                  value={row.from}
                  placeholder={tr('请求模型名，如 gpt-6-astra')}
                  onChange={(event) => updateRow(index, { from: event.target.value })}
                  style={{
                    ...INPUT_STYLE,
                    borderColor: invalid ? 'var(--color-danger)' : 'var(--color-border)',
                  }}
                />
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>→</span>
                <input
                  value={row.to}
                  placeholder={tr('上游模型名，如 deepseek-v4.1-flash')}
                  onChange={(event) => updateRow(index, { to: event.target.value })}
                  style={{
                    ...INPUT_STYLE,
                    borderColor: invalid ? 'var(--color-danger)' : 'var(--color-border)',
                  }}
                />
                <button
                  type="button"
                  className="btn btn-link btn-link-danger"
                  onClick={() => removeRow(index)}
                >
                  {tr('删除')}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {hasIncompleteRow ? (
        <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>
          {tr('存在未填写完整的映射行，请补全后再保存。')}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-link" onClick={addRow}>
          {tr('+ 添加映射')}
        </button>
      </div>
    </div>
  );
}
