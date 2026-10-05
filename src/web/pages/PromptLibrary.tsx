import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import ModernSelect from '../components/ModernSelect.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';
import CaseEditorModal, { type CaseEditorPayload } from './prompt-library/CaseEditorModal.js';
import CaseTable from './prompt-library/CaseTable.js';
import PresetImportModal from './prompt-library/PresetImportModal.js';
import SuiteEditorModal, { type SuiteEditorPayload } from './prompt-library/SuiteEditorModal.js';
import type { BuiltinPreset, PromptCase, PromptSuite } from './prompt-library/types.js';

type DeleteTarget =
  | { kind: 'suite'; id: number; name: string }
  | { kind: 'case'; id: number; name: string };

export default function PromptLibrary() {
  const toast = useToast();
  const [suites, setSuites] = useState<PromptSuite[]>([]);
  const [cases, setCases] = useState<PromptCase[]>([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState<number | null>(null);
  const [loadingSuites, setLoadingSuites] = useState(true);
  const [loadingCases, setLoadingCases] = useState(false);
  const [search, setSearch] = useState('');
  const [suiteEditor, setSuiteEditor] = useState<{ open: boolean; suite: PromptSuite | null }>({ open: false, suite: null });
  const [caseEditor, setCaseEditor] = useState<{ open: boolean; promptCase: PromptCase | null }>({ open: false, promptCase: null });
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presets, setPresets] = useState<BuiltinPreset[]>([]);
  const [loadingPresets, setLoadingPresets] = useState(false);
  const [importingSlug, setImportingSlug] = useState<string | null>(null);

  const loadSuites = useCallback(async (preferSuiteId?: number | null) => {
    setLoadingSuites(true);
    try {
      const response = await api.getPromptSuites();
      const nextSuites: PromptSuite[] = response?.suites ?? [];
      setSuites(nextSuites);
      setSelectedSuiteId((current) => {
        const wanted = preferSuiteId ?? current;
        if (wanted != null && nextSuites.some((item) => item.id === wanted)) return wanted;
        return nextSuites.length > 0 ? nextSuites[0].id : null;
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('加载题库失败'));
    } finally {
      setLoadingSuites(false);
    }
  }, [toast]);

  const loadCases = useCallback(async (suiteId: number) => {
    setLoadingCases(true);
    try {
      const response = await api.getPromptSuiteCases(suiteId);
      setCases(response?.cases ?? []);
    } catch (error) {
      setCases([]);
      toast.error(error instanceof Error ? error.message : tr('加载题目失败'));
    } finally {
      setLoadingCases(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadSuites();
  }, [loadSuites]);

  useEffect(() => {
    if (selectedSuiteId == null) {
      setCases([]);
      return;
    }
    void loadCases(selectedSuiteId);
  }, [selectedSuiteId, loadCases]);

  const selectedSuite = useMemo(
    () => suites.find((item) => item.id === selectedSuiteId) ?? null,
    [suites, selectedSuiteId],
  );

  const filteredCases = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return cases;
    return cases.filter((item) => [
      item.title,
      item.prompt,
      item.expectedAnswer ?? '',
      item.answerNotes ?? '',
      item.tags.join(' '),
    ].some((field) => field.toLowerCase().includes(keyword)));
  }, [cases, search]);

  const stats = useMemo(() => ({
    suites: suites.length,
    cases: suites.reduce((total, item) => total + item.caseCount, 0),
    enabled: suites.reduce((total, item) => total + item.enabledCaseCount, 0),
    withAnswer: cases.filter((item) => !!item.expectedAnswer).length,
  }), [suites, cases]);

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
      const result = await api.importPromptPreset(slug) as {
        suiteId?: number;
        suiteCreated?: boolean;
        casesCreated?: number;
        casesSkipped?: number;
      };
      toast.success(
        `${result?.suiteCreated ? '已创建题库并' : ''}导入 ${result?.casesCreated ?? 0} 道题`
        + `${result?.casesSkipped ? `，跳过已存在 ${result.casesSkipped} 道` : ''}`,
      );
      await loadSuites(result?.suiteId ?? null);
      const response = await api.getPromptPresets();
      setPresets(response?.presets ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('导入失败'));
    } finally {
      setImportingSlug(null);
    }
  }, [loadSuites, toast]);

  const handleSaveSuite = useCallback(async (payload: SuiteEditorPayload) => {
    setSaving(true);
    try {
      if (suiteEditor.suite) {
        await api.updatePromptSuite(suiteEditor.suite.id, payload);
        toast.success(tr('题库已更新'));
      } else {
        const created = await api.createPromptSuite(payload) as { suite?: PromptSuite };
        toast.success(tr('题库已创建'));
        setSuiteEditor({ open: false, suite: null });
        await loadSuites(created?.suite?.id ?? null);
        return;
      }
      setSuiteEditor({ open: false, suite: null });
      await loadSuites(suiteEditor.suite?.id ?? selectedSuiteId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('保存失败'));
    } finally {
      setSaving(false);
    }
  }, [suiteEditor, loadSuites, selectedSuiteId, toast]);

  const handleSaveCase = useCallback(async (payload: CaseEditorPayload) => {
    if (selectedSuiteId == null) {
      toast.error(tr('请先选择题库'));
      return;
    }
    setSaving(true);
    try {
      if (caseEditor.promptCase) {
        await api.updatePromptCase(caseEditor.promptCase.id, payload);
        toast.success(tr('题目已更新'));
      } else {
        await api.createPromptCase({ ...payload, suiteId: selectedSuiteId });
        toast.success(tr('题目已创建'));
      }
      setCaseEditor({ open: false, promptCase: null });
      await Promise.all([loadCases(selectedSuiteId), loadSuites(selectedSuiteId)]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('保存失败'));
    } finally {
      setSaving(false);
    }
  }, [caseEditor, selectedSuiteId, loadCases, loadSuites, toast]);

  const handleToggleEnabled = useCallback(async (promptCase: PromptCase) => {
    if (selectedSuiteId == null) return;
    try {
      await api.updatePromptCase(promptCase.id, { enabled: !promptCase.enabled });
      await Promise.all([loadCases(selectedSuiteId), loadSuites(selectedSuiteId)]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('更新状态失败'));
    }
  }, [selectedSuiteId, loadCases, loadSuites, toast]);

  const handleCopy = useCallback(async (promptCase: PromptCase) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(promptCase.prompt);
      } else {
        const helper = document.createElement('textarea');
        helper.value = promptCase.prompt;
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        document.body.removeChild(helper);
      }
      toast.success(tr('提示词已复制'));
    } catch {
      toast.error(tr('复制失败'));
    }
  }, [toast]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      if (deleteTarget.kind === 'suite') {
        await api.deletePromptSuite(deleteTarget.id);
        toast.success(tr('题库已删除'));
        await loadSuites(null);
        setSelectedSuiteId(null);
      } else {
        await api.deletePromptCase(deleteTarget.id);
        toast.success(tr('题目已删除'));
        if (selectedSuiteId != null) {
          await Promise.all([loadCases(selectedSuiteId), loadSuites(selectedSuiteId)]);
        }
      }
      setDeleteTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tr('删除失败'));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, loadSuites, loadCases, selectedSuiteId, toast]);

  const suiteOptions = useMemo(
    () => suites.map((item) => ({
      value: String(item.id),
      label: item.name,
      description: `${item.caseCount} 道题${item.category ? ` · ${item.category}` : ''}`,
    })),
    [suites],
  );

  return (
    <div className="animate-fade-in" id="prompt-library-page">
      <div className="page-header">
        <div>
          <h2 className="page-title">{tr('提示词管理')}</h2>
          <div className="page-subtitle">
            {tr('登记评测模型用的提示词题库（如鹈鹕测试、糖果测试），题目可附带标准答案或评分要点。')}
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
            id="prompt-library-new-suite"
            className="btn btn-primary"
            onClick={() => setSuiteEditor({ open: true, suite: null })}
          >
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
            </svg>
            {tr('新建题库')}
          </button>
        </div>
      </div>

      <div className="prompt-library-stats">
        <div className="stat-card">
          <div className="stat-card-row"><span className="stat-label">{tr('题库')}</span></div>
          <div className="stat-value">{stats.suites}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-row"><span className="stat-label">{tr('题目总数')}</span></div>
          <div className="stat-value">{stats.cases}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-row"><span className="stat-label">{tr('启用题目')}</span></div>
          <div className="stat-value">{stats.enabled}</div>
        </div>
        <div className="stat-card">
          <div className="stat-card-row"><span className="stat-label">{tr('当前题库带标准答案')}</span></div>
          <div className="stat-value">{stats.withAnswer}</div>
        </div>
      </div>

      <div className="card prompt-library-toolbar">
        <div className="prompt-library-toolbar-field">
          <label className="form-label">{tr('题库')}</label>
          <ModernSelect
            value={selectedSuiteId == null ? '' : String(selectedSuiteId)}
            onChange={(value) => setSelectedSuiteId(value ? Number(value) : null)}
            options={suiteOptions}
            placeholder={loadingSuites ? tr('加载中...') : tr('选择题库')}
            emptyLabel={tr('暂无题库')}
            searchable
            searchPlaceholder={tr('搜索题库')}
          />
        </div>
        <div className="prompt-library-toolbar-field prompt-library-toolbar-search">
          <label className="form-label">{tr('搜索题目')}</label>
          <input
            id="prompt-library-search"
            className="input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={tr('按标题 / 提示词 / 答案 / 标签过滤')}
          />
        </div>
      </div>

      {selectedSuite ? (
        <div className="card prompt-library-suite-head">
          <div className="prompt-library-suite-main">
            <div className="prompt-library-suite-title-row">
              <h3 className="prompt-library-suite-name">{selectedSuite.name}</h3>
              {selectedSuite.category ? <span className="prompt-library-chip">{selectedSuite.category}</span> : null}
              {selectedSuite.tags.map((tag) => (
                <span className="prompt-library-chip" key={tag}>{tag}</span>
              ))}
            </div>
            {selectedSuite.description ? (
              <div className="prompt-library-suite-desc">{selectedSuite.description}</div>
            ) : null}
            {selectedSuite.sourceUrl ? (
              <a className="prompt-library-preset-source" href={selectedSuite.sourceUrl} target="_blank" rel="noreferrer">
                {selectedSuite.sourceUrl}
              </a>
            ) : null}
          </div>
          <div className="prompt-library-suite-actions">
            <button className="btn btn-ghost prompt-library-btn-sm" onClick={() => setSuiteEditor({ open: true, suite: selectedSuite })}>
              {tr('编辑题库')}
            </button>
            <button
              className="btn btn-ghost prompt-library-btn-sm prompt-library-danger"
              onClick={() => setDeleteTarget({ kind: 'suite', id: selectedSuite.id, name: selectedSuite.name })}
            >
              {tr('删除题库')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="card prompt-library-cases">
        <div className="prompt-library-cases-head">
          <div className="prompt-library-cases-title">
            {tr('题目')}
            <span className="prompt-library-muted">{filteredCases.length} / {cases.length}</span>
          </div>
          <button
            id="prompt-library-new-case"
            className="btn btn-primary prompt-library-btn-sm"
            onClick={() => setCaseEditor({ open: true, promptCase: null })}
            disabled={selectedSuiteId == null}
          >
            {tr('新增题目')}
          </button>
        </div>

        {loadingCases ? (
          <div className="empty-state">{tr('加载中...')}</div>
        ) : selectedSuiteId == null ? (
          <div className="empty-state">{tr('请先选择或新建一个题库')}</div>
        ) : filteredCases.length === 0 ? (
          <div className="empty-state">
            {cases.length === 0
              ? tr('这个题库还没有题目，点「新增题目」或导入内置题库')
              : tr('没有匹配的题目')}
          </div>
        ) : (
          <CaseTable
            cases={filteredCases}
            onEdit={(promptCase) => setCaseEditor({ open: true, promptCase })}
            onDelete={(promptCase) => setDeleteTarget({ kind: 'case', id: promptCase.id, name: promptCase.title })}
            onToggleEnabled={(promptCase) => void handleToggleEnabled(promptCase)}
            onCopy={(promptCase) => void handleCopy(promptCase)}
          />
        )}
      </div>

      <SuiteEditorModal
        open={suiteEditor.open}
        suite={suiteEditor.suite}
        saving={saving}
        onClose={() => setSuiteEditor({ open: false, suite: null })}
        onSubmit={(payload) => void handleSaveSuite(payload)}
      />

      <CaseEditorModal
        open={caseEditor.open}
        promptCase={caseEditor.promptCase}
        suiteName={selectedSuite?.name ?? ''}
        saving={saving}
        onClose={() => setCaseEditor({ open: false, promptCase: null })}
        onSubmit={(payload) => void handleSaveCase(payload)}
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
        title={deleteTarget?.kind === 'suite' ? tr('删除题库') : tr('删除题目')}
        description={deleteTarget?.kind === 'suite'
          ? `${tr('将删除题库')}「${deleteTarget.name}」${tr('及其下所有题目。')}`
          : `${tr('将删除题目')}「${deleteTarget?.name ?? ''}」。`}
        onConfirm={() => void handleConfirmDelete()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
