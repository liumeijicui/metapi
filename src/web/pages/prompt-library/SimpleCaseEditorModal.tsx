import { useEffect, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';

/**
 * 简化后的题目编辑器：只有题目名称、题目描述、答案（可选）。
 *
 * 之前要先建题库、再选题库、再设判分模式/标签/排序，对自用场景太重了。
 * 这里把「描述就是发给模型的提示词」这件事直接写进表单，答案留空即视为没有答案。
 */
export type SimpleCaseEditorPayload = {
  title: string;
  description: string;
  answer: string | null;
};

export type SimpleCaseDraft = {
  id: number;
  title: string;
  description: string;
  answer: string | null;
};

type SimpleCaseEditorModalProps = {
  open: boolean;
  promptCase: SimpleCaseDraft | null;
  saving: boolean;
  onClose: () => void;
  onSubmit: (payload: SimpleCaseEditorPayload) => void;
};

export default function SimpleCaseEditorModal({
  open,
  promptCase,
  saving,
  onClose,
  onSubmit,
}: SimpleCaseEditorModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTitle(promptCase?.title ?? '');
    setDescription(promptCase?.description ?? '');
    setAnswer(promptCase?.answer ?? '');
    setError('');
  }, [open, promptCase]);

  const handleSubmit = () => {
    if (saving) return;
    const nextTitle = title.trim();
    const nextDescription = description.trim();
    if (!nextTitle) {
      setError('题目名称不能为空');
      return;
    }
    if (!nextDescription) {
      setError('题目描述不能为空');
      return;
    }
    setError('');
    onSubmit({
      title: nextTitle,
      description: nextDescription,
      answer: answer.trim() || null,
    });
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={promptCase ? '编辑题目' : '新增题目'}
      maxWidth={680}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button
            id="prompt-library-case-save"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={saving}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="form-group">
          <label className="form-label" htmlFor="prompt-simple-title">题目名称</label>
          <input
            id="prompt-simple-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：鹈鹕骑自行车"
            autoFocus
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-simple-description">题目描述</label>
          <textarea
            id="prompt-simple-description"
            className="input"
            rows={7}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="测试时选这道题，就会把这段描述发给模型"
          />
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>测试时选中该题目名称，会自动把这段描述填进对话框。</div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-simple-answer">答案（可选）</label>
          <textarea
            id="prompt-simple-answer"
            className="input"
            rows={4}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="留空表示这道题没有标准答案"
          />
        </div>

        {error ? <div style={{ fontSize: 13, color: 'var(--color-danger, #e5484d)' }}>{error}</div> : null}
      </div>
    </CenteredModal>
  );
}
