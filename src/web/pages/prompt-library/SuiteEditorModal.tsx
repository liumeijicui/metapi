import { useEffect, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import { formatTagInput, parseTagInput, type PromptSuite } from './types.js';

export type SuiteEditorPayload = {
  name: string;
  category: string | null;
  sourceUrl: string | null;
  description: string | null;
  tags: string[];
  sortOrder: number;
};

type SuiteEditorModalProps = {
  open: boolean;
  suite: PromptSuite | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: (payload: SuiteEditorPayload) => void;
};

export default function SuiteEditorModal({
  open,
  suite,
  saving,
  onClose,
  onSubmit,
}: SuiteEditorModalProps) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [sortOrder, setSortOrder] = useState('0');

  useEffect(() => {
    if (!open) return;
    setName(suite?.name ?? '');
    setCategory(suite?.category ?? '');
    setSourceUrl(suite?.sourceUrl ?? '');
    setDescription(suite?.description ?? '');
    setTags(formatTagInput(suite?.tags));
    setSortOrder(String(suite?.sortOrder ?? 0));
  }, [open, suite]);

  const handleSubmit = () => {
    if (saving) return;
    onSubmit({
      name: name.trim(),
      category: category.trim() || null,
      sourceUrl: sourceUrl.trim() || null,
      description: description.trim() || null,
      tags: parseTagInput(tags),
      sortOrder: Number.parseInt(sortOrder, 10) || 0,
    });
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={suite ? '编辑题库' : '新建题库'}
      maxWidth={720}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button
            id="prompt-library-suite-save"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={saving || !name.trim()}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <ResponsiveFormGrid columns={2}>
          <div className="form-group">
            <label className="form-label" htmlFor="prompt-library-suite-name">题库名称</label>
            <input
              id="prompt-library-suite-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：鹈鹕测试"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="prompt-library-suite-category">分类</label>
            <input
              id="prompt-library-suite-category"
              className="input"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              placeholder="例如：视觉生成"
            />
          </div>
        </ResponsiveFormGrid>

        <ResponsiveFormGrid columns={2}>
          <div className="form-group">
            <label className="form-label" htmlFor="prompt-library-suite-source">来源链接</label>
            <input
              id="prompt-library-suite-source"
              className="input"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="题目出处（可空）"
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="prompt-library-suite-sort">排序值</label>
            <input
              id="prompt-library-suite-sort"
              className="input"
              type="number"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>
        </ResponsiveFormGrid>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-library-suite-tags">标签</label>
          <input
            id="prompt-library-suite-tags"
            className="input"
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="用逗号分隔，例如：视觉, SVG"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-library-suite-description">题库说明</label>
          <textarea
            id="prompt-library-suite-description"
            className="input"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="这个题库考什么、怎么评分"
            style={{ resize: 'vertical' }}
          />
        </div>
      </div>
    </CenteredModal>
  );
}
