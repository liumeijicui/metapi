import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.js';
import CenteredModal from './CenteredModal.js';
import { useIsMobile } from './useIsMobile.js';
import { tr } from '../i18n.js';
import {
  createModelBatchSseParser,
  interleaveModelBatchTargets,
  readModelBatchErrorResponse,
  runModelBatchTestQueue,
  type ModelBatchTestCompleted,
  type ModelBatchTestResult,
  type ModelBatchTestTarget,
} from '../modelMonitorBatchTest.js';

export type ModelBatchTestModel = {
  key: string;
  siteId: number;
  siteName: string;
  modelName: string;
};

type Props = {
  open: boolean;
  models: ModelBatchTestModel[];
  onClose: () => void;
};

type PromptCase = {
  id: number;
  title: string;
  prompt: string;
  answer: string | null;
};

type RowState = {
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  firstByteMs?: number | null;
  durationMs?: number | null;
  message?: string;
  preview?: string;
};

type BatchSummary = {
  total: number;
  success: number;
  failed: number;
  cancelled: number;
};

function formatBatchDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(value)}ms`;
}

function statusLabel(state: RowState): string {
  if (state.status === 'running') return tr('测试中');
  if (state.status === 'success') return tr('成功');
  if (state.status === 'failed') return tr('失败');
  if (state.status === 'cancelled') return tr('已停止');
  return tr('等待');
}

function statusClass(state: RowState): string {
  if (state.status === 'success') return 'badge badge-success';
  if (state.status === 'failed') return 'badge badge-error';
  if (state.status === 'running') return 'badge badge-info';
  return 'badge badge-muted';
}

export default function ModelBatchTestModal({ open, models, onClose }: Props) {
  const toast = useToast();
  const isMobile = useIsMobile();
  const [promptCases, setPromptCases] = useState<PromptCase[]>([]);
  const [promptCaseId, setPromptCaseId] = useState<number | null>(null);
  const [promptText, setPromptText] = useState('');
  const [promptLoading, setPromptLoading] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [rowQuery, setRowQuery] = useState('');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const selectedModels = useMemo(
    () => models.filter((model) => selectedKeys.has(model.key)),
    [models, selectedKeys],
  );

  const visibleModels = useMemo(() => {
    const query = rowQuery.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => (
      model.modelName.toLowerCase().includes(query)
      || model.siteName.toLowerCase().includes(query)
    ));
  }, [models, rowQuery]);

  const activeModel = useMemo(
    () => selectedModels.find((model) => model.key === activeKey)
      || models.find((model) => model.key === activeKey)
      || selectedModels[0]
      || null,
    [activeKey, models, selectedModels],
  );
  const activeState = activeModel ? rows[activeModel.key] : undefined;

  useEffect(() => {
    if (!open) {
      controllerRef.current?.abort();
      return;
    }

    const initialKeys = new Set(models.slice(0, 3).map((model) => model.key));
    setSelectedKeys(initialKeys);
    setRows({});
    setRowQuery('');
    setSummary(null);
    setRunning(false);
    setStopping(false);
    setPromptCaseId(null);
    setPromptText('');
    setPromptCases([]);
    setPromptLoading(true);

    let cancelled = false;
    void api.getSimplePromptCases()
      .then((res: any) => {
        if (cancelled) return;
        const list: PromptCase[] = (Array.isArray(res?.cases) ? res.cases : [])
          .map((item: any) => ({
            id: Number(item?.id),
            title: String(item?.title || ''),
            prompt: String(item?.description || ''),
            answer: item?.answer == null || item?.answer === '' ? null : String(item.answer),
          }))
          .filter((item: PromptCase) => Number.isFinite(item.id) && item.prompt);
        setPromptCases(list);
        const defaultId = Number(res?.defaultCaseId);
        const preferred = Number.isFinite(defaultId)
          ? list.find((item) => item.id === Math.trunc(defaultId))
          : null;
        const nextCase = preferred || list[0] || null;
        setPromptCaseId(nextCase?.id ?? null);
        setPromptText(nextCase?.prompt || '');
      })
      .catch(() => {
        if (!cancelled) {
          setPromptCases([]);
          setPromptCaseId(null);
        }
      })
      .finally(() => {
        if (!cancelled) setPromptLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const applyPromptCase = useCallback((rawId: string) => {
    if (!rawId) {
      setPromptCaseId(null);
      return;
    }
    const id = Number(rawId);
    const nextCase = promptCases.find((item) => item.id === id) || null;
    setPromptCaseId(nextCase?.id ?? null);
    if (nextCase) setPromptText(nextCase.prompt);
  }, [promptCases]);

  const toggleModel = useCallback((key: string) => {
    if (running) return;
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setSummary(null);
  }, [running]);

  const selectFirstThree = useCallback(() => {
    if (running) return;
    setSelectedKeys(new Set(models.slice(0, 3).map((model) => model.key)));
    setSummary(null);
  }, [models, running]);

  const clearSelection = useCallback(() => {
    if (running) return;
    setSelectedKeys(new Set());
    setSummary(null);
  }, [running]);

  const selectAll = useCallback(() => {
    if (running) return;
    if (models.length > 10 && !window.confirm(
      `${tr('全选会为每个模型各消耗一次额度，共')} ${models.length} ${tr('个，确定继续？')}`,
    )) {
      return;
    }
    setSelectedKeys(new Set(models.map((model) => model.key)));
    setSummary(null);
  }, [models, running]);

  const executeOne = useCallback(async (
    target: ModelBatchTestTarget,
    prompt: string,
    signal: AbortSignal,
  ): Promise<ModelBatchTestResult> => {
    const startedAt = Date.now();
    const channels = await api.getModelMonitorChatChannels(target.siteId, target.modelName);
    if (signal.aborted) {
      return { status: 'cancelled', firstByteMs: null, durationMs: Date.now() - startedAt, message: '已停止', preview: '' };
    }

    const preference = (channels as any)?.preference;
    // 没有保存过偏好时默认 Responses：和 Codex 那边保持同一条链路。
    const apiMode = preference?.apiMode === 'chat' ? 'chat' : 'responses';
    const reasoningEffort = typeof preference?.reasoningEffort === 'string'
      ? preference.reasoningEffort
      : '';

    /** 每跑完一个模型就回写一条「最新结果」，模型监控页直接展示。 */
    const record = (result: ModelBatchTestResult): ModelBatchTestResult => {
      if (result.status === 'cancelled') return result;
      void api.saveModelProbeResult({
        siteId: target.siteId,
        model: target.modelName,
        source: 'batch',
        status: result.status,
        firstByteMs: result.firstByteMs,
        durationMs: result.durationMs,
        apiMode,
        reasoningEffort: reasoningEffort || null,
        answer: result.preview || null,
        errorMessage: result.status === 'failed' ? result.message : null,
      }).catch(() => undefined);
      return result;
    };

    const credentials = Array.isArray((channels as any)?.credentials) ? (channels as any).credentials : [];
    const credential = credentials.find((item: any) => Number(item?.accountId) > 0);
    if (!credential) {
      return record({
        status: 'failed',
        firstByteMs: null,
        durationMs: Date.now() - startedAt,
        message: '该站点没有可用于直连的账号或密钥',
        preview: '',
      });
    }

    const response = await api.directChatStream({
      siteId: target.siteId,
      accountId: Number(credential.accountId),
      tokenId: credential.tokenId == null ? null : Number(credential.tokenId),
      model: target.modelName,
      messages: [{ role: 'user', content: prompt }],
      apiMode,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    }, signal);

    if (signal.aborted) {
      return { status: 'cancelled', firstByteMs: null, durationMs: Date.now() - startedAt, message: '已停止', preview: '' };
    }
    if (!response.ok) {
      return record({
        status: 'failed',
        firstByteMs: null,
        durationMs: Date.now() - startedAt,
        message: await readModelBatchErrorResponse(response),
        preview: '',
      });
    }
    if (!response.body) {
      return record({
        status: 'failed',
        firstByteMs: null,
        durationMs: Date.now() - startedAt,
        message: '流式响应体为空',
        preview: '',
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const parser = createModelBatchSseParser();
    let firstByteMs: number | null = null;
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (firstByteMs == null) firstByteMs = Date.now() - startedAt;
        bytes += value.byteLength;
        parser.push(decoder.decode(value, { stream: true }));
        if (parser.getError()) {
          // 上游已经明确报错就没必要继续把剩余内容读完，立刻掐断节省额度。
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    } catch (error: any) {
      if (signal.aborted || error?.name === 'AbortError') {
        return {
          status: 'cancelled',
          firstByteMs,
          durationMs: Date.now() - startedAt,
          message: '已停止',
          preview: '',
        };
      }
      throw error;
    }

    parser.push(decoder.decode());
    const parsed = parser.finish();
    if (signal.aborted) {
      return {
        status: 'cancelled',
        firstByteMs,
        durationMs: Date.now() - startedAt,
        message: '已停止',
        preview: parsed.preview,
      };
    }
    if (parsed.error) {
      return record({
        status: 'failed',
        firstByteMs,
        durationMs: Date.now() - startedAt,
        message: parsed.error,
        preview: parsed.preview,
      });
    }
    if (bytes === 0) {
      return record({
        status: 'failed',
        firstByteMs: null,
        durationMs: Date.now() - startedAt,
        message: '上游没有返回任何内容',
        preview: '',
      });
    }

    return record({
      status: 'success',
      firstByteMs,
      durationMs: Date.now() - startedAt,
      message: '测试成功',
      preview: parsed.preview,
    });
  }, []);

  const start = useCallback(async () => {
    const prompt = promptText.trim();
    if (!prompt) {
      toast.error(tr('请先选择或填写测试提示词'));
      return;
    }
    if (!selectedModels.length) {
      toast.error(tr('请至少选择一个模型'));
      return;
    }
    if (running) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    setRunning(true);
    setStopping(false);
    setSummary(null);
    setActiveKey(selectedModels[0]?.key ?? null);
    setRows(Object.fromEntries(selectedModels.map((model) => [model.key, { status: 'pending' as const }])));

    try {
      // 按站点打散后再测：勾选的模型可能同一站占一大半，连着打过去最容易
      // 触发上游风控/会话限制。勾选顺序本身不动，只调整实际执行顺序。
      const targets = interleaveModelBatchTargets(selectedModels);
      const completed = await runModelBatchTestQueue({
        targets,
        signal: controller.signal,
        runOne: (target, signal) => executeOne(target, prompt, signal),
        onStart: (target) => {
        setActiveKey(target.key);
          setRows((prev) => ({ ...prev, [target.key]: { status: 'running' } }));
        },
        onResult: ({ target, result }: ModelBatchTestCompleted) => {
          setRows((prev) => ({
            ...prev,
            [target.key]: {
              status: result.status,
              firstByteMs: result.firstByteMs,
              durationMs: result.durationMs,
              message: result.message,
              preview: result.preview,
            },
          }));
        },
      });

      const completedKeys = new Set(completed.map((item) => item.target.key));
      const remaining = selectedModels.filter((model) => !completedKeys.has(model.key));
      if (remaining.length) {
        setRows((prev) => {
          const next = { ...prev };
          for (const model of remaining) {
            next[model.key] = { status: 'cancelled', message: '已停止' };
          }
          return next;
        });
      }

      const counts = { success: 0, failed: 0, cancelled: 0 };
      for (const item of completed) {
        if (item.result.status === 'success') counts.success += 1;
        else if (item.result.status === 'failed') counts.failed += 1;
        else counts.cancelled += 1;
      }
      counts.cancelled += remaining.length;
      setSummary({
        total: selectedModels.length,
        ...counts,
      });
    } catch (error: any) {
      toast.error(String(error?.message || tr('批量测试失败')));
    } finally {
      setRunning(false);
      setStopping(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [executeOne, promptText, running, selectedModels, toast]);

  const stop = useCallback(() => {
    if (!running) return;
    setStopping(true);
    controllerRef.current?.abort();
  }, [running]);

  const requestClose = useCallback(() => {
    if (running) {
      controllerRef.current?.abort();
      setStopping(true);
    }
    onClose();
  }, [onClose, running]);

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%', flexWrap: 'wrap' }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', alignSelf: 'center' }}>
        {summary
          ? `${tr('总计')} ${summary.total} · ${tr('成功')} ${summary.success} · ${tr('失败')} ${summary.failed} · ${tr('已停止')} ${summary.cancelled}`
          : `${tr('已选')} ${selectedModels.length} ${tr('个模型，按顺序逐个测试')}`}
      </div>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
        <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={stopping}>
          {tr('关闭')}
        </button>
        <button type="button" className="btn btn-danger" onClick={stop} disabled={!running || stopping}>
          {stopping ? tr('停止中…') : tr('停止测试')}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void start()} disabled={running || !selectedModels.length || !promptText.trim()}>
          {running ? <><span className="spinner spinner-sm" /> {tr('测试中…')}</> : tr('开始批量测试')}
        </button>
      </div>
    </div>
  );

  return (
    <CenteredModal
      open={open}
      onClose={requestClose}
      title={tr('批量测试')}
      maxWidth={1280}
      width={1280}
      mobileFullscreen
      footer={footer}
      bodyStyle={{ maxHeight: '84vh', overflow: 'hidden', padding: 16 }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          height: isMobile ? 'auto' : 'min(74vh, 780px)',
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
          {tr('测试会直接调用每个模型所在的源站，日志会标记为「模型测试」。默认只勾选前 3 个，建议先小范围验证，避免浪费额度。')}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '220px minmax(0, 1fr)', gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{tr('测试提示词')}</div>
            <select
              value={promptCaseId == null ? '' : String(promptCaseId)}
              onChange={(event) => applyPromptCase(event.target.value)}
              style={{ width: '100%', padding: '8px 10px' }}
              disabled={running || promptLoading}
            >
              <option value="">{promptLoading ? tr('加载中…') : tr('手动输入')}</option>
              {promptCases.map((item) => (
                <option key={item.id} value={String(item.id)}>{item.title}</option>
              ))}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
              {tr('发送内容')} {promptCases.find((item) => item.id === promptCaseId)?.answer
                ? `· ${tr('答案')} ${promptCases.find((item) => item.id === promptCaseId)?.answer}`
                : ''}
            </div>
            <textarea
              value={promptText}
              onChange={(event) => setPromptText(event.target.value)}
              rows={isMobile ? 4 : 5}
              placeholder={tr('选择提示词后会自动填入，也可以手动修改')}
              style={{
                width: '100%',
                minHeight: 110,
                resize: 'vertical',
                padding: '9px 11px',
                fontFamily: 'inherit',
                lineHeight: 1.6,
              }}
              disabled={running}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={rowQuery}
            onChange={(event) => setRowQuery(event.target.value)}
            placeholder={tr('筛选模型或站点')}
            style={{ padding: '7px 10px', minWidth: 200 }}
            disabled={running}
          />
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {`${tr('筛选结果')} ${models.length}`}
          </span>
          <button type="button" className="btn btn-ghost" onClick={selectFirstThree} disabled={running}>{tr('选前 3 个')}</button>
          <button type="button" className="btn btn-ghost" onClick={clearSelection} disabled={running}>{tr('清空选择')}</button>
          <button type="button" className="btn btn-ghost" onClick={selectAll} disabled={running}>{tr('全选')}</button>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>
            {`${tr('已选')} ${selectedModels.length}`}
          </span>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            gap: 12,
            flex: isMobile ? undefined : 1,
            minHeight: 0,
          }}
        >
          <div
            style={{
              width: isMobile ? '100%' : 340,
              flexShrink: 0,
              border: '1px solid var(--color-border-light)',
              borderRadius: 'var(--radius-sm)',
              overflowY: 'auto',
              maxHeight: isMobile ? 260 : undefined,
              minHeight: 0,
            }}
          >
            {visibleModels.length === 0 ? (
              <div style={{ padding: 18, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
                {tr('当前筛选下没有模型')}
              </div>
            ) : visibleModels.map((model, index) => {
              const checked = selectedKeys.has(model.key);
              const state = rows[model.key];
              const active = activeModel?.key === model.key;
              return (
                <div
                  key={model.key}
                  role="button"
                  tabIndex={0}
                  onClick={() => setActiveKey(model.key)}
                  onKeyDown={(event) => { if (event.key === 'Enter') setActiveKey(model.key); }}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '26px minmax(0, 1fr) auto',
                    gap: 8,
                    alignItems: 'center',
                    padding: '8px 10px',
                    borderTop: index === 0 ? 'none' : '1px solid var(--color-border-light)',
                    background: active ? 'var(--color-bg-hover, rgba(99,102,241,0.08))' : 'transparent',
                    borderLeft: active ? '2px solid var(--color-primary, #6366f1)' : '2px solid transparent',
                    cursor: 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => toggleModel(model.key)}
                    disabled={running}
                  />
                  <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span
                      title={model.modelName}
                      style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {model.modelName}
                    </span>
                    <span
                      title={model.siteName}
                      style={{ fontSize: 12, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {model.siteName}
                    </span>
                  </span>
                  <span className={state ? statusClass(state) : 'badge badge-muted'} style={{ fontSize: 11 }}>
                    {state ? statusLabel(state) : tr('未测试')}
                  </span>
                </div>
              );
            })}
          </div>

          <div
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              border: '1px solid var(--color-border-light)',
              borderRadius: 'var(--radius-sm)',
              padding: 12,
              overflow: 'hidden',
            }}
          >
            {activeModel ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: 14, wordBreak: 'break-all' }}>{activeModel.modelName}</span>
                  <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{activeModel.siteName}</span>
                  <span className={activeState ? statusClass(activeState) : 'badge badge-muted'}>
                    {activeState ? statusLabel(activeState) : tr('未测试')}
                  </span>
                  {activeState && (activeState.status === 'success' || activeState.status === 'failed' || activeState.status === 'cancelled') ? (
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      {tr('首字')} {formatBatchDuration(activeState.firstByteMs)} · {tr('用时')} {formatBatchDuration(activeState.durationMs)}
                    </span>
                  ) : null}
                  {activeState?.preview ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      style={{ marginLeft: 'auto', border: '1px solid var(--color-border)', padding: '4px 10px', fontSize: 12 }}
                      onClick={() => {
                        void navigator.clipboard?.writeText(activeState.preview || '');
                        toast.success(tr('已复制回复内容'));
                      }}
                    >
                      {tr('复制回复')}
                    </button>
                  ) : null}
                </div>

                {activeState?.message && activeState.status !== 'success' ? (
                  <div
                    style={{
                      padding: '8px 10px',
                      borderRadius: 'var(--radius-sm)',
                      background: activeState.status === 'failed' ? 'rgba(239,68,68,0.08)' : 'var(--color-bg)',
                      color: activeState.status === 'failed' ? '#ef4444' : 'var(--color-text-muted)',
                      fontSize: 12,
                      lineHeight: 1.6,
                      wordBreak: 'break-word',
                    }}
                  >
                    {activeState.message}
                  </div>
                ) : null}

                <div
                  style={{
                    flex: 1,
                    minHeight: isMobile ? 200 : 0,
                    overflowY: 'auto',
                    background: 'var(--color-bg)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '12px 14px',
                  }}
                >
                  {activeState?.preview ? (
                    <pre
                      style={{
                        margin: 0,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        fontSize: 14,
                        lineHeight: 1.75,
                        fontFamily: 'inherit',
                        color: 'var(--color-text-secondary)',
                      }}
                    >
                      {activeState.preview}
                    </pre>
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--color-text-muted)' }}>
                      {activeState?.status === 'running'
                        ? tr('正在等待上游返回，完成后这里会显示完整回复。')
                        : activeState?.status === 'failed'
                          ? tr('该模型没有返回内容，具体原因见上方错误信息。')
                          : tr('选中左侧模型后，测试结果和完整回复会显示在这里。')}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div style={{ margin: 'auto', fontSize: 13, color: 'var(--color-text-muted)' }}>
                {tr('先在左侧勾选要测试的模型')}
              </div>
            )}
          </div>
        </div>
      </div>
    </CenteredModal>
  );
}
