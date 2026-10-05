import { MobileCard } from '../../components/MobileCard.js';
import { useIsMobile } from '../../components/useIsMobile.js';
import { judgeModeLabel, type PromptCase } from './types.js';

type CaseTableProps = {
  cases: PromptCase[];
  onEdit: (promptCase: PromptCase) => void;
  onDelete: (promptCase: PromptCase) => void;
  onToggleEnabled: (promptCase: PromptCase) => void;
  onCopy: (promptCase: PromptCase) => void;
};

function AnswerCell({ promptCase }: { promptCase: PromptCase }) {
  if (promptCase.expectedAnswer) {
    return (
      <span className="prompt-library-answer" title={promptCase.expectedAnswer}>
        <span className="prompt-library-chip is-answer">标准答案</span>
        <span className="prompt-library-answer-value">{promptCase.expectedAnswer}</span>
      </span>
    );
  }
  if (promptCase.answerNotes) {
    return <span className="prompt-library-chip is-notes">仅评分要点</span>;
  }
  return <span className="prompt-library-muted">—</span>;
}

function CaseActions({
  promptCase,
  onEdit,
  onDelete,
  onToggleEnabled,
  onCopy,
}: CaseTableProps & { promptCase: PromptCase }) {
  return (
    <div className="prompt-library-row-actions">
      <button className="btn btn-ghost prompt-library-btn-sm" onClick={() => onCopy(promptCase)} title="复制提示词">复制</button>
      <button className="btn btn-ghost prompt-library-btn-sm" onClick={() => onToggleEnabled(promptCase)}>
        {promptCase.enabled ? '禁用' : '启用'}
      </button>
      <button className="btn btn-ghost prompt-library-btn-sm" onClick={() => onEdit(promptCase)}>编辑</button>
      <button className="btn btn-ghost prompt-library-btn-sm prompt-library-danger" onClick={() => onDelete(promptCase)}>删除</button>
    </div>
  );
}

export default function CaseTable(props: CaseTableProps) {
  const isMobile = useIsMobile();
  const { cases } = props;

  if (isMobile) {
    return (
      <div className="prompt-library-case-list">
        {cases.map((promptCase) => (
          <MobileCard
            key={promptCase.id}
            title={promptCase.title}
            subtitle={`${judgeModeLabel(promptCase.judgeMode)}${promptCase.enabled ? '' : ' · 已禁用'}`}
            footerActions={(
              <CaseActions
                {...props}
                promptCase={promptCase}
              />
            )}
          >
            <div className="prompt-library-case-prompt prompt-library-mono">{promptCase.prompt}</div>
            <div className="prompt-library-case-meta">
              <AnswerCell promptCase={promptCase} />
              {promptCase.tags.map((tag) => (
                <span className="prompt-library-chip" key={tag}>{tag}</span>
              ))}
            </div>
          </MobileCard>
        ))}
      </div>
    );
  }

  return (
    <div className="prompt-library-table-wrap">
      <table className="data-table prompt-library-table">
        <thead>
          <tr>
            <th style={{ width: '18%' }}>题目</th>
            <th style={{ width: '28%' }}>提示词</th>
            <th style={{ width: '18%' }}>答案</th>
            <th style={{ width: '10%' }}>判定</th>
            <th style={{ width: '12%' }}>标签</th>
            <th style={{ width: '6%' }}>状态</th>
            <th style={{ width: '8%' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((promptCase) => (
            <tr key={promptCase.id} data-case-id={promptCase.id}>
              <td className="prompt-library-case-title">{promptCase.title}</td>
              <td>
                <div className="prompt-library-case-prompt prompt-library-mono" title={promptCase.prompt}>
                  {promptCase.prompt}
                </div>
              </td>
              <td><AnswerCell promptCase={promptCase} /></td>
              <td>{judgeModeLabel(promptCase.judgeMode)}</td>
              <td>
                <div className="prompt-library-tags">
                  {promptCase.tags.map((tag) => (
                    <span className="prompt-library-chip" key={tag}>{tag}</span>
                  ))}
                </div>
              </td>
              <td>
                <span className={`prompt-library-status ${promptCase.enabled ? 'is-on' : 'is-off'}`}>
                  {promptCase.enabled ? '启用' : '禁用'}
                </span>
              </td>
              <td>
                <CaseActions {...props} promptCase={promptCase} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
