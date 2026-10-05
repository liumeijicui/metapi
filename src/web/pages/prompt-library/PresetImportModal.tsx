import CenteredModal from '../../components/CenteredModal.js';
import type { BuiltinPreset } from './types.js';

type PresetImportModalProps = {
  open: boolean;
  presets: BuiltinPreset[];
  loading: boolean;
  importingSlug: string | null;
  onClose: () => void;
  onImport: (slug: string) => void;
};

export default function PresetImportModal({
  open,
  presets,
  loading,
  importingSlug,
  onClose,
  onImport,
}: PresetImportModalProps) {
  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title="内置题库预设"
      maxWidth={860}
      closeOnBackdrop={!importingSlug}
      closeOnEscape={!importingSlug}
      footer={<button className="btn btn-ghost" onClick={onClose} disabled={!!importingSlug}>关闭</button>}
    >
      <div id="prompt-library-preset-list" className="prompt-library-preset-list">
        {loading ? (
          <div className="prompt-library-preset-empty">加载中...</div>
        ) : presets.length === 0 ? (
          <div className="prompt-library-preset-empty">暂无可导入的内置题库</div>
        ) : presets.map((preset) => {
          const withAnswer = preset.cases.filter((item) => !!item.expectedAnswer).length;
          return (
            <div className="prompt-library-preset-item" key={preset.slug} data-preset-slug={preset.slug}>
              <div className="prompt-library-preset-main">
                <div className="prompt-library-preset-head">
                  <span className="prompt-library-preset-name">{preset.name}</span>
                  {preset.category ? <span className="prompt-library-chip">{preset.category}</span> : null}
                  {preset.imported ? <span className="prompt-library-chip is-imported">已导入</span> : null}
                </div>
                <div className="prompt-library-preset-desc">{preset.description}</div>
                <div className="prompt-library-preset-meta">
                  <span>{preset.cases.length} 道题</span>
                  <span>·</span>
                  <span>{withAnswer} 道带标准答案</span>
                  {preset.tags.length > 0 ? <span>· {preset.tags.join(' / ')}</span> : null}
                </div>
                {preset.sourceUrl ? (
                  <a
                    className="prompt-library-preset-source"
                    href={preset.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {preset.sourceUrl}
                  </a>
                ) : null}
              </div>
              <div className="prompt-library-preset-actions">
                <button
                  className="btn btn-primary prompt-library-btn-sm"
                  data-preset-import={preset.slug}
                  onClick={() => onImport(preset.slug)}
                  disabled={!!importingSlug}
                >
                  {importingSlug === preset.slug ? '导入中...' : preset.imported ? '补齐缺失题目' : '导入'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </CenteredModal>
  );
}
