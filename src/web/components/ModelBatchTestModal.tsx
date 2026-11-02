import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.js';
import CenteredModal from './CenteredModal.js';
import Combobox from './Combobox.js';
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
  /** 站点主页；列表里的站点名做成链接，点一下直接跳过去。 */
  siteUrl?: string;
  modelName: string;
};

type Props = {
  open: boolean;
  models: ModelBatchTestModel[];
  onClose: () => void;
  /** 挂到转发成功后通知父页面刷新对外模型清单。 */
  onForwardChanged?: () => void;
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
  httpStatus?: number | null;
  message?: string;
  preview?: string;
};

type BatchResultRow = {
  id: number;
  runId: string;
  siteId: number;
  siteName: string;
  modelName: string;
  status: 'success' | 'failed' | 'cancelled';
  httpStatus: number | null;
  firstByteMs: number | null;
  durationMs: number | null;
  apiMode: string | null;
  reasoningEffort: string | null;
  promptTitle: string | null;
  answer: string | null;
  errorMessage: string | null;
  createdAt: string;
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

function formatBalance(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/** 相对时间：结果集里几十条记录，绝对时间反而不容易扫。 */
function formatRelativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '—';
  const diff = Date.now() - timestamp;
  if (diff < 0) return '刚刚';
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s 之前`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}min 之前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h 之前`;
  return `${Math.round(diff / 86_400_000)}d 之前`;
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

function httpStatusLabel(value: number | null): string {
  return value == null ? tr('无状态码') : String(value);
}

function httpStatusBadgeClass(value: number | null): string {
  if (value == null) return 'badge badge-muted';
  if (value >= 200 && value < 300) return 'badge badge-success';
  if (value === 429) return 'badge badge-warning';
  if (value >= 400) return 'badge badge-error';
  return 'badge badge-muted';
}

function createRunId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `batch-${Date.now()}-${random}`;
}

export default function ModelBatchTestModal({ open, models, onClose, onForwardChanged }: Props) {
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
  const [tab, setTab] = useState<'list' | 'results'>('list');
  const [balances, setBalances] = useState<Record<number, number>>({});
  const [runId, setRunId] = useState<string | null>(null);
  const [resultRows, setResultRows] = useState<BatchResultRow[]>([]);
  const [resultTotal, setResultTotal] = useState(0);
  const [resultCounts, setResultCounts] = useState<Array<{ httpStatus: number | null; count: number }>>([]);
  const [resultLoading, setResultLoading] = useState(false);
  const [resultStatus, setResultStatus] = useState('');
  const [httpFilter, setHttpFilter] = useState<number[]>([]);
  const [resultModelQuery, setResultModelQuery] = useState('');
  const [resultReloadToken, setResultReloadToken] = useState(0);
  const [attachTarget, setAttachTarget] = useState<{ siteId: number; siteName: string; modelName: string } | null>(null);
  const [attachModelName, setAttachModelName] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);
  const [forwardNames, setForwardNames] = useState<string[]>([]);
  const [forwardNamesLoading, setForwardNamesLoading] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  /**
   * 列表顺序 = 执行顺序。
   *
   * 之前只在执行前打散，左侧列表还是原始顺序，看起来像「随机挑一条跑」。
   * 现在打开弹窗时就把各站点的模型穿插好，列表和队列共用这一份顺序，
   * 既不会连续打同一个站点，也能让用户看到真实执行次序。
   *
   * 依赖里带上 `open`：每次重新打开都会重新穿插一次，同一次会话里顺序稳定，
   * 列表和执行队列才不会对不上。
   */
  const orderedModels = useMemo(
    () => (open ? interleaveModelBatchTargets(models) : models),
    [open, models],
  );

  const selectedModels = useMemo(
    () => orderedModels.filter((model) => selectedKeys.has(model.key)),
    [orderedModels, selectedKeys],
  );

  const visibleModels = useMemo(() => {
    const query = rowQuery.trim().toLowerCase();
    if (!query) return orderedModels;
    return orderedModels.filter((model) => (
      model.modelName.toLowerCase().includes(query)
      || model.siteName.toLowerCase().includes(query)
    ));
  }, [orderedModels, rowQuery]);

  const activeModel = useMemo(
    () => selectedModels.find((model) => model.key === activeKey)
      || orderedModels.find((model) => model.key === activeKey)
      || selectedModels[0]
      || null,
    [activeKey, orderedModels, selectedModels],
  );
  const activeState = activeModel ? rows[activeModel.key] : undefined;

  useEffect(() => {
    if (!open) {
      controllerRef.current?.abort();
      return;
    }

    const initialKeys = new Set(orderedModels.slice(0, 3).map((model) => model.key));
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
    setTab('list');
    setRunId(null);
    setResultRows([]);
    setResultTotal(0);
    setResultCounts([]);
    setResultStatus('');
    setHttpFilter([]);
    setResultModelQuery('');

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

  // 左侧列表要显示站点余额：一次把所有涉及站点的余额取回来。
  useEffect(() => {
    if (!open || models.length === 0) return;
    const siteIds = Array.from(new Set(models.map((model) => model.siteId)));
    let cancelled = false;
    void api.getModelBatchTestSiteBalances(siteIds)
      .then((res) => {
        if (cancelled) return;
        const next: Record<number, number> = {};
        for (const item of res?.balances || []) {
          next[Number(item.siteId)] = Number(item.balance) || 0;
        }
        setBalances(next);
      })
      .catch(() => {
        if (!cancelled) setBalances({});
      });
    return () => {
      cancelled = true;
    };
  }, [open, models]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const loadResults = useCallback(async () => {
    setResultLoading(true);
    try {
      const res = await api.getModelBatchTestResults({
        status: resultStatus || null,
        httpStatuses: httpFilter.length ? httpFilter : null,
        model: resultModelQuery.trim() || null,
        limit: 500,
      });
      setResultRows(res.results || []);
      setResultTotal(Number(res.total) || 0);
      setResultCounts(res.httpStatusCounts || []);
    } catch (error: any) {
      toast.error(error?.message || tr('加载测试结果失败'));
    } finally {
      setResultLoading(false);
    }
  }, [httpFilter, resultModelQuery, resultStatus, toast]);

  // 结果集只在切到该页签时加载，避免打开弹窗就多打一次数据库。
  useEffect(() => {
    if (!open || tab !== 'results') return;
    void loadResults();
  }, [open, tab, loadResults, resultReloadToken]);

  const loadForwardNames = useCallback(async () => {
    setForwardNamesLoading(true);
    try {
      const res = await api.getModelForwardRules();
      const names = Array.isArray(res?.rules)
        ? res.rules.map((rule: { modelName?: string }) => String(rule.modelName || '')).filter(Boolean)
        : [];
      setForwardNames(names);
    } catch {
      setForwardNames([]);
    } finally {
      setForwardNamesLoading(false);
    }
  }, []);

  const openAttach = useCallback((target: { siteId: number; siteName: string; modelName: string }) => {
    setAttachTarget(target);
    setAttachModelName(target.modelName);
    void loadForwardNames();
  }, [loadForwardNames]);

  const submitAttach = useCallback(async () => {
    if (!attachTarget) return;
    const modelName = attachModelName.trim();
    if (!modelName) {
      toast.error(tr('请选择或填写要挂到的对外模型名'));
      return;
    }
    setAttachBusy(true);
    try {
      const res = await api.attachModelForwardTarget({
        siteId: attachTarget.siteId,
        upstreamModel: attachTarget.modelName,
        modelName,
      });
      toast.success(res?.created
        ? tr('已新建对外模型并挂上该模型')
        : tr('已挂到该对外模型的最后面'));
      setAttachTarget(null);
      onForwardChanged?.();
    } catch (error: any) {
      toast.error(error?.message || tr('挂载失败'));
    } finally {
      setAttachBusy(false);
    }
  }, [attachModelName, attachTarget, onForwardChanged, toast]);

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
    setSelectedKeys(new Set(orderedModels.slice(0, 3).map((model) => model.key)));
    setSummary(null);
  }, [orderedModels, running]);

  const clearSelection = useCallback(() => {
    if (running) return;
    setSelectedKeys(new Set());
    setSummary(null);
  }, [running]);

  const selectAll = useCallback(() => {
    if (running) return;
    if (orderedModels.length > 10 && !window.confirm(
      `${tr('全选会为每个模型各消耗一次额度，共')} ${orderedModels.length} ${tr('个，确定继续？')}`,
    )) {
      return;
    }
    setSelectedKeys(new Set(orderedModels.map((model) => model.key)));
    setSummary(null);
  }, [orderedModels, running]);

  const executeOne = useCallback(async (
    target: ModelBatchTestTarget,
    prompt: string,
    promptTitle: string,
    batchRunId: string,
    signal: AbortSignal,
  ): Promise<ModelBatchTestResult> => {
    const startedAt = Date.now();
    const channels = await api.getModelMonitorChatChannels(target.siteId, target.modelName);
    if (signal.aborted) {
      return { status: 'cancelled', firstByteMs: null, durationMs: Date.now() - startedAt, message: '已停止', preview: '', httpStatus: null };
    }

    const preference = (channels as any)?.preference;
    // 没有保存过偏好时默认 Responses：和 Codex 那边保持同一条链路。
    const apiMode = preference?.apiMode === 'chat' ? 'chat' : 'responses';
    const reasoningEffort = typeof preference?.reasoningEffort === 'string'
      ? preference.reasoningEffort
      : '';

    /**
     * 每跑完一个模型写两处：
     * - probe-result：upsert 的「最新结果」，模型监控列表直接展示；
     * - batch-test-results：追加的历史记录，结果集按错误码 / 站点筛选。
     */
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
      void api.saveModelBatchTestResult({
        runId: batchRunId,
        siteId: target.siteId,
        modelName: target.modelName,
        status: result.status,
        httpStatus: result.httpStatus ?? null,
        firstByteMs: result.firstByteMs,
        durationMs: result.durationMs,
        apiMode,
        reasoningEffort: reasoningEffort || null,
        promptTitle: promptTitle || null,
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
        httpStatus: null,
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

    const httpStatus = response.status;

    if (signal.aborted) {
      return { status: 'cancelled', firstByteMs: null, durationMs: Date.now() - startedAt, message: '已停止', preview: '', httpStatus };
    }
    if (!response.ok) {
      return record({
        status: 'failed',
        firstByteMs: null,
        durationMs: Date.now() - startedAt,
        message: await readModelBatchErrorResponse(response),
        preview: '',
        httpStatus,
      });
    }
    if (!response.body) {
      return record({
        status: 'failed',
        firstByteMs: null,
        durationMs: Date.now() - startedAt,
        message: '流式响应体为空',
        preview: '',
        httpStatus,
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
          httpStatus,
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
        httpStatus,
      };
    }
    if (parsed.error) {
      return record({
        status: 'failed',
        firstByteMs,
        durationMs: Date.now() - startedAt,
        message: parsed.error,
        preview: parsed.preview,
        httpStatus,
      });
    }
    if (bytes === 0) {
      return record({
        status: 'failed',
        firstByteMs: null,
        durationMs: Date.now() - startedAt,
        message: '上游没有返回任何内容',
        preview: '',
        httpStatus,
      });
    }

    return record({
      status: 'success',
      firstByteMs,
      durationMs: Date.now() - startedAt,
      message: '测试成功',
      preview: parsed.preview,
      httpStatus,
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
    const batchRunId = createRunId();
    controllerRef.current = controller;
    setRunId(batchRunId);
    setRunning(true);
    setStopping(false);
    setSummary(null);
    setActiveKey(selectedModels[0]?.key ?? null);
    setRows(Object.fromEntries(selectedModels.map((model) => [model.key, { status: 'pending' as const }])));

    const promptTitle = promptCases.find((item) => item.id === promptCaseId)?.title || '';

    try {
      // 顺序就是左侧列表的顺序（打开弹窗时已经按站点穿插过），不再二次打散：
      // 用户看到的次序和实际执行完全一致。
      const targets = selectedModels;
      const completed = await runModelBatchTestQueue({
        targets,
        signal: controller.signal,
        runOne: (target, signal) => executeOne(target, prompt, promptTitle, batchRunId, signal),
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
              httpStatus: result.httpStatus ?? null,
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
      setResultReloadToken((value) => value + 1);
    }
  }, [executeOne, promptCaseId, promptCases, promptText, running, selectedModels, toast]);

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

  const toggleHttpFilter = useCallback((code: number) => {
    setHttpFilter((current) => (
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code]
    ));
  }, []);

  const footer = (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%', flexWrap: 'wrap' }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', alignSelf: 'center' }}>
        {summary
          ? `${tr('总计')} ${summary.total} · ${tr('成功')} ${summary.success} · ${tr('失败')} ${summary.failed} · ${tr('已停止')} ${summary.cancelled}`
          : `${tr('已选')} ${selectedModels.length} ${tr('个模型，按左侧顺序逐个测试')}`}
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 8, background: 'var(--color-bg)' }}>
            <button
              type="button"
              className={tab === 'list' ? 'btn btn-primary' : 'btn btn-ghost'}
              style={{ padding: '5px 12px', fontSize: 12.5 }}
              onClick={() => setTab('list')}
            >
              {tr('待测列表')}
            </button>
            <button
              type="button"
              className={tab === 'results' ? 'btn btn-primary' : 'btn btn-ghost'}
              style={{ padding: '5px 12px', fontSize: 12.5 }}
              onClick={() => setTab('results')}
            >
              {tr('结果集')}
              {resultTotal > 0 ? ` (${resultTotal})` : ''}
            </button>
          </div>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
            {tr('测试会直接调用每个模型所在的源站，日志会标记为「模型测试」。列表已按站点穿插，测试按这个顺序逐个执行。')}
          </span>
        </div>

        {tab === 'list' ? (
          <>
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
                {`${tr('筛选结果')} ${orderedModels.length}`}
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
                  width: isMobile ? '100%' : 380,
                  flexShrink: 0,
                  border: '1px solid var(--color-border-light)',
                  borderRadius: 'var(--radius-sm)',
                  overflowY: 'auto',
                  maxHeight: isMobile ? 300 : undefined,
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
                  const balance = balances[model.siteId];
                  return (
                    <div
                      key={model.key}
                      role="button"
                      tabIndex={0}
                      onClick={() => setActiveKey(model.key)}
                      onKeyDown={(event) => { if (event.key === 'Enter') setActiveKey(model.key); }}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '22px 24px minmax(0, 1fr) auto',
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
                      <span style={{ fontSize: 11, color: 'var(--color-text-muted)', textAlign: 'right' }}>{index + 1}</span>
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span
                          title={model.modelName}
                          style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        >
                          {model.modelName}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          {model.siteUrl ? (
                            <a
                              href={model.siteUrl}
                              target="_blank"
                              rel="noreferrer"
                              title={`${tr('打开站点')} ${model.siteUrl}`}
                              onClick={(event) => event.stopPropagation()}
                              style={{
                                fontSize: 12,
                                color: 'var(--color-primary, #6366f1)',
                                textDecoration: 'underline',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {model.siteName}
                            </a>
                          ) : (
                            <span
                              title={model.siteName}
                              style={{ fontSize: 12, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            >
                              {model.siteName}
                            </span>
                          )}
                          <span
                            title={tr('站点余额（该站点下所有账号之和）')}
                            style={{ fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0 }}
                          >
                            {balance == null ? '' : formatBalance(balance)}
                          </span>
                        </span>
                      </span>
                      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                        <span className={state ? statusClass(state) : 'badge badge-muted'} style={{ fontSize: 11 }}>
                          {state ? statusLabel(state) : tr('未测试')}
                        </span>
                        {state?.status === 'success' ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ padding: '1px 6px', fontSize: 10.5, border: '1px solid var(--color-border-light)' }}
                            onClick={(event) => {
                              event.stopPropagation();
                              openAttach({ siteId: model.siteId, siteName: model.siteName, modelName: model.modelName });
                            }}
                          >
                            {tr('挂到转发')}
                          </button>
                        ) : null}
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
                      {activeState?.httpStatus != null ? (
                        <span className={httpStatusBadgeClass(activeState.httpStatus)} style={{ fontSize: 11 }}>
                          HTTP {activeState.httpStatus}
                        </span>
                      ) : null}
                      {activeState && (activeState.status === 'success' || activeState.status === 'failed' || activeState.status === 'cancelled') ? (
                        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                          {tr('首字')} {formatBatchDuration(activeState.firstByteMs)} · {tr('用时')} {formatBatchDuration(activeState.durationMs)}
                        </span>
                      ) : null}
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                        {activeState?.status === 'success' ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ border: '1px solid var(--color-border)', padding: '4px 10px', fontSize: 12 }}
                            onClick={() => openAttach({
                              siteId: activeModel.siteId,
                              siteName: activeModel.siteName,
                              modelName: activeModel.modelName,
                            })}
                          >
                            {tr('挂到转发')}
                          </button>
                        ) : null}
                        {activeState?.preview ? (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ border: '1px solid var(--color-border)', padding: '4px 10px', fontSize: 12 }}
                            onClick={() => {
                              void navigator.clipboard?.writeText(activeState.preview || '');
                              toast.success(tr('已复制回复内容'));
                            }}
                          >
                            {tr('复制回复')}
                          </button>
                        ) : null}
                      </div>
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
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: 0 }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select
                value={resultStatus}
                onChange={(event) => setResultStatus(event.target.value)}
                style={{ padding: '6px 10px', fontSize: 12.5 }}
              >
                <option value="">{tr('全部状态')}</option>
                <option value="success">{tr('成功')}</option>
                <option value="failed">{tr('失败')}</option>
                <option value="cancelled">{tr('已停止')}</option>
              </select>
              <input
                value={resultModelQuery}
                onChange={(event) => setResultModelQuery(event.target.value)}
                placeholder={tr('筛选模型名（包含）')}
                style={{ padding: '6px 10px', minWidth: 200, fontSize: 12.5 }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)', padding: '5px 10px', fontSize: 12 }}
                onClick={() => setResultReloadToken((value) => value + 1)}
                disabled={resultLoading}
              >
                {resultLoading ? tr('刷新中…') : tr('刷新')}
              </button>
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>
                {`${tr('共')} ${resultTotal} ${tr('条')}`}
              </span>
            </div>

            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('状态码')}：</span>
              <button
                type="button"
                className={httpFilter.length === 0 ? 'btn btn-primary' : 'btn btn-ghost'}
                style={{ padding: '3px 10px', fontSize: 11.5, border: '1px solid var(--color-border-light)' }}
                onClick={() => setHttpFilter([])}
              >
                {tr('全部')}
              </button>
              {resultCounts.map((item) => {
                const code = item.httpStatus;
                if (code == null) return null;
                const selected = httpFilter.includes(code);
                return (
                  <button
                    key={code}
                    type="button"
                    className={selected ? 'btn btn-primary' : 'btn btn-ghost'}
                    style={{ padding: '3px 10px', fontSize: 11.5, border: '1px solid var(--color-border-light)' }}
                    onClick={() => toggleHttpFilter(code)}
                  >
                    {code} <span style={{ opacity: 0.7 }}>{item.count}</span>
                  </button>
                );
              })}
              {resultCounts.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('还没有记录')}</span>
              ) : null}
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                border: '1px solid var(--color-border-light)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {resultRows.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted)', fontSize: 13 }}>
                  {resultLoading ? tr('加载中…') : tr('还没有批量测试记录，先跑一轮测试。')}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: 'var(--color-bg)', position: 'sticky', top: 0, zIndex: 1 }}>
                      <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{tr('时间')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{tr('站点')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{tr('模型')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{tr('状态')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{tr('状态码')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600 }}>{tr('首字')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600 }}>{tr('用时')}</th>
                      <th style={{ textAlign: 'left', padding: '8px 10px', fontWeight: 600 }}>{tr('协议')}</th>
                      <th style={{ textAlign: 'right', padding: '8px 10px', fontWeight: 600 }}>{tr('操作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultRows.map((row) => (
                      <tr key={row.id} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                        <td style={{ padding: '7px 10px', color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }} title={row.createdAt}>
                          {formatRelativeTime(row.createdAt)}
                        </td>
                        <td style={{ padding: '7px 10px' }}>{row.siteName}</td>
                        <td style={{ padding: '7px 10px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.modelName}>
                          {row.modelName}
                        </td>
                        <td style={{ padding: '7px 10px' }}>
                          <span
                            className={row.status === 'success' ? 'badge badge-success' : row.status === 'failed' ? 'badge badge-error' : 'badge badge-muted'}
                            style={{ fontSize: 11 }}
                          >
                            {row.status === 'success' ? tr('成功') : row.status === 'failed' ? tr('失败') : tr('已停止')}
                          </span>
                        </td>
                        <td style={{ padding: '7px 10px' }}>
                          <span className={httpStatusBadgeClass(row.httpStatus)} style={{ fontSize: 11 }} title={row.errorMessage || ''}>
                            {httpStatusLabel(row.httpStatus)}
                          </span>
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatBatchDuration(row.firstByteMs)}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatBatchDuration(row.durationMs)}</td>
                        <td style={{ padding: '7px 10px', color: 'var(--color-text-muted)' }}>
                          {row.apiMode || '—'}{row.reasoningEffort ? ` · ${row.reasoningEffort}` : ''}
                        </td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {row.status === 'success' ? (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ padding: '2px 8px', fontSize: 11.5, border: '1px solid var(--color-border-light)' }}
                              onClick={() => openAttach({ siteId: row.siteId, siteName: row.siteName, modelName: row.modelName })}
                            >
                              {tr('挂到转发')}
                            </button>
                          ) : row.errorMessage ? (
                            <span
                              style={{ fontSize: 11.5, color: 'var(--color-text-muted)', cursor: 'help' }}
                              title={row.errorMessage}
                            >
                              {tr('错误详情')}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {runId ? (
              <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                {tr('最近一次批量测试')}：{runId}
              </div>
            ) : null}
          </div>
        )}
      </div>

      <CenteredModal
        open={attachTarget !== null}
        onClose={() => { if (!attachBusy) setAttachTarget(null); }}
        title={tr('挂到模型转发')}
        maxWidth={520}
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="btn btn-ghost" disabled={attachBusy} onClick={() => setAttachTarget(null)}>
              {tr('取消')}
            </button>
            <button type="button" className="btn btn-primary" disabled={attachBusy} onClick={() => void submitAttach()}>
              {attachBusy ? tr('挂载中…') : tr('挂到末尾')}
            </button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
          <div style={{ color: 'var(--color-text-secondary)' }}>
            {tr('把这个「站点 + 模型」挂到某个对外模型转发的最后面；重复挂载会被拒绝。')}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '10px 12px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            <div><span style={{ color: 'var(--color-text-muted)' }}>{tr('站点')}：</span><strong>{attachTarget?.siteName}</strong></div>
            <div><span style={{ color: 'var(--color-text-muted)' }}>{tr('模型')}：</span><strong>{attachTarget?.modelName}</strong></div>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('挂到哪个对外模型')}</span>
            <Combobox
              value={attachModelName}
              onChange={setAttachModelName}
              options={forwardNames.map((name) => ({ value: name, label: name }))}
              allowCustom
              placeholder={forwardNamesLoading ? tr('加载中…') : tr('搜索已有对外模型，或直接输入新的名字')}
              emptyLabel={tr('还没有转发规则，直接输入名字会新建一条')}
            />
          </label>
        </div>
      </CenteredModal>
    </CenteredModal>
  );
}
