import { useEffect, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import ModernSelect from '../../components/ModernSelect.js';
import ResponsiveFormGrid from '../../components/ResponsiveFormGrid.js';
import {
  JUDGE_MODE_OPTIONS,
  formatTagInput,
  parseTagInput,
  type JudgeMode,
  type PromptCase,
} from './types.js';

export type CaseEditorPayload = {
  title: string;
  prompt: string;
  expectedAnswer: string | null;
  answerNotes: string | null;
  judgeMode: JudgeMode;
  tags: string[];
  sortOrder: number;
  enabled: boolean;
};

type CaseEditorModalProps = {
  open: boolean;
  promptCase: PromptCase | null;
  suiteName: string;
  saving: boolean;
  onClose: () => void;
  onSubmit: (payload: CaseEditorPayload) => void;
};

export default function CaseEditorModal({
  open,
  promptCase,
  suiteName,
  saving,
  onClose,
  onSubmit,
}: CaseEditorModalProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [expectedAnswer, setExpectedAnswer] = useState('');
  const [answerNotes, setAnswerNotes] = useState('');
  const [judgeMode, setJudgeMode] = useState<JudgeMode>('manual');
  const [tags, setTags] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!open) return;
    setTitle(promptCase?.title ?? '');
    setPrompt(promptCase?.prompt ?? '');
    setExpectedAnswer(promptCase?.expectedAnswer ?? '');
    setAnswerNotes(promptCase?.answerNotes ?? '');
    setJudgeMode(promptCase?.judgeMode ?? 'manual');
    setTags(formatTagInput(promptCase?.tags));
    setSortOrder(String(promptCase?.sortOrder ?? 0));
    setEnabled(promptCase?.enabled ?? true);
  }, [open, promptCase]);

  const handleSubmit = () => {
    if (saving) return;
    onSubmit({
      title: title.trim(),
      prompt: prompt.trim(),
      expectedAnswer: expectedAnswer.trim() || null,
      answerNotes: answerNotes.trim() || null,
      judgeMode,
      tags: parseTagInput(tags),
      sortOrder: Number.parseInt(sortOrder, 10) || 0,
      enabled,
    });
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={promptCase ? '编辑题目' : '新增题目'}
      maxWidth={820}
      closeOnBackdrop={!saving}
      closeOnEscape={!saving}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>取消</button>
          <button
            id="prompt-library-case-save"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={saving || !title.trim() || !prompt.trim()}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div className="prompt-library-modal-hint">所属题库：{suiteName}</div>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-library-case-title">题目标题</label>
          <input
            id="prompt-library-case-title"
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：鹈鹕骑自行车（原版）"
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-library-case-prompt">提示词</label>
          <textarea
            id="prompt-library-case-prompt"
            className="input prompt-library-mono"
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="发给模型的原始提示词"
            style={{ resize: 'vertical' }}
          />
        </div>

        <ResponsiveFormGrid columns={2}>
          <div className="form-group">
            <label className="form-label" htmlFor="prompt-library-case-judge">判定方式</label>
            <ModernSelect
              value={judgeMode}
              onChange={(value) => setJudgeMode(value as JudgeMode)}
              options={JUDGE_MODE_OPTIONS.map((item) => ({
                value: item.value,
                label: item.label,
                description: item.description,
              }))}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="prompt-library-case-sort">排序值</label>
            <input
              id="prompt-library-case-sort"
              className="input"
              type="number"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
            />
          </div>
        </ResponsiveFormGrid>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-library-case-answer">
            标准答案 <span className="prompt-library-hint">（可空，主观题留空）</span>
          </label>
          <textarea
            id="prompt-library-case-answer"
            className="input prompt-library-mono"
            rows={2}
            value={expectedAnswer}
            onChange={(event) => setExpectedAnswer(event.target.value)}
            placeholder="例如：21"
            style={{ resize: 'vertical' }}
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="prompt-library-case-notes">
            评分要点 / 备注 <span className="prompt-library-hint">（主观题的评分清单）</span>
          </label>
          <textarea
            id="prompt-library-case-notes"
            className="input"
            rows={4}
            value={answerNotes}
            onChange={(event) => setAnswerNotes(event.target.value)}
            placeholder="例如：①输出必须是可渲染的 SVG；②自行车结构成立…"
            style={{ resize: 'vertical' }}
          />
        </div>

        <ResponsiveFormGrid columns={2}>
          <div className="form-group">
            <label className="form-label" htmlFor="prompt-library-case-tags">标签</label>
            <input
              id="prompt-library-case-tags"
              className="input"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="用逗号分隔"
            />
          </div>
          <div className="form-group">
            <label className="form-label">状态</label>
            <label className="prompt-library-switch" htmlFor="prompt-library-case-enabled">
              <input
                id="prompt-library-case-enabled"
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              <span>{enabled ? '启用（参与抽测）' : '已禁用'}</span>
            </label>
          </div>
        </ResponsiveFormGrid>
      </div>
    </CenteredModal>
  );
}
