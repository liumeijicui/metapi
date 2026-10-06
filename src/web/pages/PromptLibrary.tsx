import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';
import PresetImportModal from './prompt-library/PresetImportModal.js';
import type { BuiltinPreset } from './prompt-library/types.js';
import SimpleCaseEditorModal, {
  type SimpleCaseDraft,
  type SimpleCaseEditorPayload,
} from './prompt-library/SimpleCaseEditorModal.js';

type SimpleCase = {
  id: number;
  title: string;
  description: string;
  answer: string | null;
  updatedAt: string | null;
};

/**
 * 提示词管理（简化版）。
 *
 * 只维护三件事：题目名称、题目描述、答案（可选）。描述就是测试时发给模型的
 * 提示词，所以选中题目名称就能带出描述。原先的题库 / 判分模式 / 标签 / 排序
 * 都不再出现在界面上；内置题库导入后也直接平铺进这个列表。
 */
export default function PromptLibrary() {
  const toast = useToast();
  const [cases, setCases] = useState<SimpleCase[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<{ open: boolean; promptCase: SimpleCaseDraft | null }>({
    open: false,
    promptCase: null,
  });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SimpleCase | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presets, setPresets] = useState<BuiltinPreset[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [importingSlug, setImportingSlug] = useState<string | null>(null);

  const loadCases = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.getSimplePromptCases();
      const list: SimpleCase[] = (Array.isArray(response?.cases) ? response.cases : []).map((item: any) => ({
        id: Number(item?.id),
        title: String(item?.title ?? ''),
        description: String(item?.description ?? ''),
        answer: item?.answer == null || item?.answer === '' ? null : String(item.answer),
        updatedAt: item?.updatedAt ?? null,
      }));
      setCases(list);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('加载题目失败'));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadCases();
  }, [loadCases]);

  const filteredCases = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return cases;
    return cases.filter((item) => (
      item.title.toLowerCase().includes(keyword)
      || item.description.toLowerCase().includes(keyword)
      || (item.answer ?? '').toLowerCase().includes(keyword)
    ));
  }, [cases, search]);

  const stats = useMemo(() => ({
    total: cases.length,
    withAnswer: cases.filter((item) => Boolean(item.answer)).length,
    withoutAnswer: cases.filter((item) => !item.answer).length,
  }), [cases]);

  const handleSave = useCallback(async (payload: SimpleCaseEditorPayload) => {
    setSaving(true);
    try {
      if (editor.promptCase) {
        await api.updateSimplePromptCase(editor.promptCase.id, payload);
        toast.success('题目已更新');
      } else {
        await api.createSimplePromptCase(payload);
        toast.success('题目已添加');
      }
      setEditor({ open: false, promptCase: null });
      await loadCases();
    } catch (error: any) {
      toast.error(error?.message || '保存题目失败');
    } finally {
      setSaving(false);
    }
  }, [editor.promptCase, loadCases, toast]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.deletePromptCase(deleteTarget.id);
      toast.success('题目已删除');
      setDeleteTarget(null);
      await loadCases();
    } catch (error: any) {
      toast.error(error?.message || '删除题目失败');
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, loadCases, toast]);

  const handleCopy = useCallback(async (promptCase: SimpleCase) => {
    try {
      await navigator.clipboard.writeText(promptCase.description);
      toast.success('题目描述已复制');
    } catch {
      toast.error('复制失败，请手动选择文本');
    }
  }, [toast]);

  const openPresetModal = useCallback(async () => {
    setPresetOpen(true);
    setLoadingPresets(true);
    try {
      const response = await api.getPromptPresets();
      setPresets(response?.presets ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('加载内置题库失败'));
    } finally {
      setLoadingPresets(false);
    }
  }, [toast]);

  const handleImportPreset = useCallback(async (slug: string) => {
    setImportingSlug(slug);
    try {
      const result = await api.importPromptPreset(slug) as { casesCreated?: number; casesSkipped?: number };
      toast.success(
        `导入 ${result?.casesCreated ?? 0} 道题`
        + `${result?.casesSkipped ? `，跳过已存在 ${result.casesSkipped} 道` : ''}`,
      );
      await loadCases();
      const response = await api.getPromptPresets();
      setPresets(response?.presets ?? []);
    } catch (error: any) {
      toast.error(error?.message || '导入内置题库失败');
    } finally {
      setImportingSlug(null);
    }
  }, [loadCases, toast]);

  return (
    <div className="animate-fade-in" id="prompt-library-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">{tr('提示词管理')}</h2>
          <div className="page-subtitle">
            {tr('只要题目名称、题目描述和答案。测试时选中题目名称，会自动带出题目描述。')}
          </div>
        </div>
        <div className="page-actions">
          <button id="prompt-library-import-presets" className="btn btn-ghost" onClick={() => void openPresetModal()}>
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 4v12m0 0l-4-4m4 4l4-4M4 20h16" />
            </svg>
            {tr('导入内置题库')}
          </button>
          <button
            id="prompt-library-new-case"
            className="btn btn-primary"
            onClick={() => setEditor({ open: true, promptCase: null })}
          >
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
            </svg>
            {tr('新增题目')}
          </button>
        </div>
      </div>

      <div className="prompt-library-stats">
        <div className="stat-card">
          <div className="stat-card-row"><span className="stat-label">{tr('题目总数')}</span></div>
          <div className="stat-value">{stats.total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-row"><span className="stat-label">{tr('有答案')}</span></div>
          <div className="stat-value">{stats.withAnswer}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-row"><span className="stat-label">{tr('无答案（主观题）')}</span></div>
          <div className="stat-value">{stats.withoutAnswer}</div>
        </div>
      </div>

      <div className="card prompt-library-toolbar">
        <div className="prompt-library-toolbar-field prompt-library-toolbar-search">
          <label className="form-label" htmlFor="prompt-library-search">{tr('搜索题目')}</label>
          <input
            id="prompt-library-search"
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tr('按题目名称 / 描述 / 答案过滤')}
          />
        </div>
      </div>

      <div className="card prompt-library-cases">
        <div className="prompt-library-cases-head">
          <div className="prompt-library-cases-title">
            {tr('题目')}
            <span className="prompt-library-muted">{filteredCases.length} / {cases.length}</span>
          </div>
        </div>

        {loading ? (
          <div className="empty-state">{tr('加载中...')}</div>
        ) : cases.length === 0 ? (
          <div className="empty-state">{tr('还没有题目，点「新增题目」或导入内置题库')}</div>
        ) : filteredCases.length === 0 ? (
          <div className="empty-state">{tr('没有匹配的题目')}</div>
        ) : (
          <div className="prompt-library-table-wrap">
            <table className="table prompt-library-table">
              <thead>
                <tr>
                  <th style={{ width: '22%' }}>{tr('题目名称')}</th>
                  <th>{tr('题目描述')}</th>
                  <th style={{ width: '24%' }}>{tr('答案')}</th>
                  <th style={{ width: 150 }}>{tr('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredCases.map((promptCase) => (
                  <tr key={promptCase.id}>
                    <td>
                      <div className="prompt-library-case-title">{promptCase.title}</div>
                    </td>
                    <td>
                      <div className="prompt-library-case-prompt">{promptCase.description}</div>
                    </td>
                    <td>
                      {promptCase.answer ? (
                        <div className="prompt-library-answer-value">{promptCase.answer}</div>
                      ) : (
                        <span className="prompt-library-muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="prompt-library-row-actions">
                        <button
                          className="btn btn-ghost prompt-library-btn-sm"
                          onClick={() => void handleCopy(promptCase)}
                          title="复制题目描述"
                        >
                          {tr('复制')}
                        </button>
                        <button
                          className="btn btn-ghost prompt-library-btn-sm"
                          onClick={() => setEditor({ open: true, promptCase })}
                        >
                          {tr('编辑')}
                        </button>
                        <button
                          className="btn btn-ghost prompt-library-btn-sm prompt-library-danger"
                          onClick={() => setDeleteTarget(promptCase)}
                        >
                          {tr('删除')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SimpleCaseEditorModal
        open={editor.open}
        promptCase={editor.promptCase}
        saving={saving}
        onClose={() => setEditor({ open: false, promptCase: null })}
        onSubmit={(payload) => void handleSave(payload)}
      />

      <PresetImportModal
        open={presetOpen}
        presets={presets}
        loading={loadingPresets}
        importingSlug={importingSlug}
        onClose={() => setPresetOpen(false)}
        onImport={(slug) => void handleImportPreset(slug)}
      />

      <DeleteConfirmModal
        open={deleteTarget != null}
        loading={deleting}
        title={tr('删除题目')}
        description={`${tr('将删除题目')}「${deleteTarget?.title ?? ''}」。`}
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
