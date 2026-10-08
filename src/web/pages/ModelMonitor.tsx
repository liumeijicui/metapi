import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import Combobox from '../components/Combobox.js';
import ModelChatModal from '../components/ModelChatModal.js';
import DownstreamKeyCcSwitchModal, { type CcSwitchKeyTarget } from './downstream-keys/DownstreamKeyCcSwitchModal.js';
import ModernSelect from '../components/ModernSelect.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';

type Sample = { ts: number | null; rate: number };

type ModelRow = {
  siteId: number;
  siteName: string;
  siteUrl: string;
  platform: string;
  modelName: string;
  avgLatencyMs: number | null;
  successRate: number | null;
  avgTps: number | null;
  recentSuccess: Sample[];
  windowStart: number | null;
  windowEnd: number | null;
  showThroughput: boolean | null;
  /** false = 站点没有监控接口，这一行只有模型名，页面不显示指标。 */
  metricsAvailable?: boolean;
  /** 'token' = 每 100 万 token 的美元价，'call' = 每次调用的美元价。 */
  pricingUnit: 'token' | 'call' | null;
  inputPrice: number | null;
  outputPrice: number | null;
  fetchedAt: string | null;
};

type SiteRow = {
  siteId: number;
  siteName: string;
  url: string;
  platform: string;
  status: string;
  message: string | null;
  modelsCount: number;
  fetchedAt: string | null;
};

type Overview = {
  updatedAt: string | null;
  running: boolean;
  windowStartHour: number;
  windowEndHour: number;
  intervalMs: number;
  /** 「仅模型列表」站点每天几点后刷新一次（其余 15 分钟轮次会跳过它们）。 */
  modelListRefreshHour?: number;
  scheduler?: {
    enabled: boolean;
    intervalMs: number;
    windowStartHour: number;
    windowEndHour: number;
    running: boolean;
    lastRunStartedAt: string | null;
    /** 最近一轮是谁触发的：定时任务，还是页面上的「立即采集」。 */
    lastRunTrigger?: 'scheduler' | 'manual' | null;
    lastRunFinishedAt: string | null;
    skippedRuns: number;
    nextRunAt: string | null;
  };
  modelOptions: Array<{ modelName: string; siteCount: number }>;
  sites: SiteRow[];
  models: ModelRow[];
};

const SLOT_COUNT = 24;
const REFRESH_POLL_MS = 30_000;

const SORT_OPTIONS = [
  { value: 'success', label: '按成功率' },
  { value: 'latency', label: '按延迟' },
  { value: 'tps', label: '按吞吐' },
  { value: 'site', label: '按站点' },
];

const SUCCESS_FILTERS = [
  { value: '', label: '全部成功率' },
  { value: '90', label: '成功率 ≥ 90%' },
  { value: '70', label: '成功率 ≥ 70%' },
  { value: '50', label: '成功率 ≥ 50%' },
];

function formatLatency(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function formatThroughput(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K t/s`;
  return `${value.toFixed(value < 10 ? 2 : 1)} t/s`;
}

function formatPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(2)}%`;
}

/** 价格按数量级留小数：$75 不写「75.00」，$0.0125 也别被抹成 0.01。 */
function formatUnitPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0';
  const digits = Math.abs(value) >= 1 ? 2 : 4;
  return `$${value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function priceSuffix(unit: 'token' | 'call'): string {
  return unit === 'call' ? tr('/ 次') : tr('/ 1M');
}

function formatModelPrice(model: ModelRow): string {
  if (!model.pricingUnit) return '';
  const suffix = priceSuffix(model.pricingUnit);
  const parts: string[] = [];
  if (model.inputPrice != null) {
    // 按次计费只给一个总价时（new-api 的数字 model_price），不再硬写「输入」。
    const singleTotal = model.pricingUnit === 'call' && model.outputPrice == null;
    parts.push(singleTotal
      ? `${formatUnitPrice(model.inputPrice)} ${suffix}`
      : `${tr('输入')} ${formatUnitPrice(model.inputPrice)} ${suffix}`);
  }
  if (model.outputPrice != null) {
    parts.push(`${tr('输出')} ${formatUnitPrice(model.outputPrice)} ${suffix}`);
  }
  if (!parts.length) return '';
  return `${model.pricingUnit === 'call' ? tr('按次计费') : tr('按量计费')} ${parts.join(' ')}`;
}

function resolveRateLevel(rate: number | null): 'excellent' | 'good' | 'warning' | 'critical' | 'unknown' {
  if (rate == null || !Number.isFinite(rate)) return 'unknown';
  if (rate >= 100) return 'excellent';
  if (rate >= 90) return 'good';
  if (rate >= 70) return 'warning';
  return 'critical';
}

/** 把上游的采样点铺进 24 个整点槽位；上游没给时间轴时按尾部右对齐。 */
function buildSlots(samples: Sample[], windowStart: number | null): Array<number | null> {
  const slots: Array<number | null> = Array.from({ length: SLOT_COUNT }, () => null);
  if (!samples.length) return slots;
  const allHaveTs = samples.every((sample) => sample.ts != null);
  if (windowStart != null && allHaveTs) {
    for (const sample of samples) {
      const index = Math.floor(((sample.ts as number) - windowStart) / 3600);
      if (index >= 0 && index < SLOT_COUNT) slots[index] = sample.rate;
    }
    return slots;
  }
  const tail = samples.slice(-SLOT_COUNT);
  for (let index = 0; index < tail.length; index += 1) {
    slots[SLOT_COUNT - tail.length + index] = tail[index].rate;
  }
  return slots;
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatRelative(value: string | null | undefined): string {
  if (!value) return tr('尚未采集');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 0) return formatTimestamp(value);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return tr('刚刚');
  if (minutes < 60) return `${minutes} ${tr('分钟前')}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${tr('小时前')}`;
  return `${Math.floor(hours / 24)} ${tr('天前')}`;
}

function siteStatusLabel(status: string): string {
  if (status === 'ok') return '采集正常';
  if (status === 'empty') return '本轮无数据';
  if (status === 'models_only') return '仅模型列表';
  if (status === 'unsupported') return '站点不支持';
  if (status === 'error') return '采集失败';
  return '等待采集';
}

function siteStatusClass(status: string): string {
  if (status === 'ok') return 'badge badge-success';
  if (status === 'empty') return 'badge badge-muted';
  if (status === 'models_only') return 'badge badge-info';
  if (status === 'unsupported') return 'badge badge-info';
  if (status === 'error') return 'badge badge-error';
  return 'badge badge-muted';
}

function SuccessBars({ samples, windowStart }: { samples: Sample[]; windowStart: number | null }) {
  const slots = useMemo(() => buildSlots(samples, windowStart), [samples, windowStart]);
  return (
    <div className="model-monitor-bars" aria-hidden>
      {slots.map((rate, index) => (
        <span
          key={index}
          className={`model-monitor-bar is-${resolveRateLevel(rate)}`}
        />
      ))}
    </div>
  );
}

export default function ModelMonitor() {
  const toast = useToast();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [view, setView] = useState<'cards' | 'table'>('cards');
  const [modelFilter, setModelFilter] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [minSuccessRate, setMinSuccessRate] = useState('');
  const [sortKey, setSortKey] = useState('success');
  const [showFailures, setShowFailures] = useState(false);
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [showModelsOnly, setShowModelsOnly] = useState(false);
  const [copiedModel, setCopiedModel] = useState<string | null>(null);
  const [attachTarget, setAttachTarget] = useState<ModelRow | null>(null);
  const [attachModelName, setAttachModelName] = useState('');
  const [attachBusy, setAttachBusy] = useState(false);
  const [chatTarget, setChatTarget] = useState<ModelRow | null>(null);
  // 「导入到 CC Switch」：先把原站的 base 地址与 sk- 密钥取回来，再打开弹窗。
  const [ccSwitchTarget, setCcSwitchTarget] = useState<{ item: CcSwitchKeyTarget; baseUrl: string } | null>(null);
  const [ccSwitchBusyKey, setCcSwitchBusyKey] = useState<string | null>(null);
  const [forwardNames, setForwardNames] = useState<string[]>([]);
  const [forwardNamesLoaded, setForwardNamesLoaded] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 打开「导入到 CC Switch」：取该站点自己的 sk- 密钥（原站凭据），不是我们网关的下游密钥。
  const openCcSwitch = useCallback(async (model: ModelRow) => {
    const busyKey = `${model.siteId}:${model.modelName}`;
    setCcSwitchBusyKey(busyKey);
    try {
      const res = await api.getModelMonitorChatChannels(model.siteId, model.modelName);
      const credentials = Array.isArray(res?.credentials) ? res.credentials : [];
      const tokenCredential = credentials.find(
        (item: { credential?: string; tokenId?: number | null }) =>
          item?.credential === 'api_token' && Number(item?.tokenId) > 0,
      );
      if (!tokenCredential?.tokenId) {
        toast.error(tr('该站点还没有 sk- 密钥，先在「站点」里生成一个再导入 CC Switch'));
        return;
      }
      const value = await api.getAccountTokenValue(tokenCredential.tokenId);
      const apiKey = String(value?.token || '').trim();
      if (!apiKey) {
        toast.error(tr('读取 sk- 密钥失败，请到「站点」里查看该密钥'));
        return;
      }
      setCcSwitchTarget({
        item: {
          id: model.siteId,
          name: `${model.siteName} · ${model.modelName}`,
          key: apiKey,
          supportedModels: [model.modelName],
        },
        baseUrl: String(model.siteUrl || '').trim(),
      });
    } catch (error: any) {
      toast.error(error?.message || tr('读取原站配置失败'));
    } finally {
      setCcSwitchBusyKey(null);
    }
  }, [toast]);

  // 打开「挂到转发」弹窗时再拉一次对外模型清单，保证是当前的。
  const openAttach = useCallback(async (model: ModelRow) => {
    setAttachTarget(model);
    setAttachModelName(model.modelName);
    if (forwardNamesLoaded) return;
    try {
      const res = await api.getModelForwardRules();
      const names = Array.isArray(res?.rules)
        ? res.rules.map((rule: { modelName?: string }) => String(rule.modelName || '')).filter(Boolean)
        : [];
      setForwardNames(names);
      setForwardNamesLoaded(true);
    } catch {
      setForwardNames([]);
    }
  }, [forwardNamesLoaded]);

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
      setForwardNamesLoaded(false);
    } catch (error: any) {
      // 重复添加等业务错误由后端给出可读原因，这里原样透出。
      toast.error(error?.message || tr('挂载失败'));
    } finally {
      setAttachBusy(false);
    }
  }, [attachTarget, attachModelName, toast]);

  // 模型名是复制按钮：手打一长串模型名太费劲，点一下就拿走。
  const copyModelName = useCallback((name: string) => {
    navigator.clipboard?.writeText?.(name).catch(() => {});
    setCopiedModel(name);
    setTimeout(() => {
      setCopiedModel((current) => (current === name ? null : current));
    }, 1500);
  }, []);

  const load = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    try {
      const data = await api.getModelMonitorOverview({
        model: modelFilter || null,
        siteId: siteFilter ? Number(siteFilter) : null,
        minSuccessRate: minSuccessRate ? Number(minSuccessRate) : null,
        sort: sortKey,
      });
      setOverview(data as Overview);
    } catch (error: any) {
      if (!silent) toast.error(error?.message || '加载模型监控失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [modelFilter, siteFilter, minSuccessRate, sortKey, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // 手动/定时采集进行中时轮询刷新，采集结束后自动停下。
  useEffect(() => {
    if (overview?.running && !pollRef.current) {
      pollRef.current = setInterval(() => { void load(true); }, REFRESH_POLL_MS);
    }
    if (!overview?.running && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [overview?.running, load]);

  const triggerRefresh = async () => {
    setStarting(true);
    try {
      const res = await api.refreshModelMonitor();
      if (res?.success === false) throw new Error('启动采集失败');
      toast.success(res?.queued === false ? '已有采集任务在跑，等它结束即可' : '已开始采集，稍候会自动刷新');
      await load(true);
    } catch (error: any) {
      toast.error(error?.message || '启动采集失败');
    } finally {
      setStarting(false);
    }
  };

  // 「重置」按钮只在真的改过筛选时可点，避免一个永远没效果的按钮。
  const monitorFiltersActive =
    siteFilter !== '' || modelFilter !== '' || minSuccessRate !== '';
  const resetMonitorFilters = () => {
    setSiteFilter('');
    setModelFilter('');
    setMinSuccessRate('');
  };

  const models = overview?.models ?? [];
  const sites = overview?.sites ?? [];
  // CC Switch 导入弹窗里的模型候选：当前这份清单里的「站点 · 模型」，方便换模型名。
  const ccSwitchModelOptions = useMemo(() => {
    const byName = new Map<string, { value: string; label: string; description?: string }>();
    for (const model of models) {
      const name = String(model.modelName || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (byName.has(key)) continue;
      const siteName = String(model.siteName || '').trim();
      byName.set(key, siteName && siteName !== name
        ? { value: name, label: name, description: siteName }
        : { value: name, label: name });
    }
    return [...byName.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [models]);
  // 「全部模型」这一项要说清当前是在哪个范围里全部：选了站点之后，它就是该
  // 站点的全部模型，而不是全部站点的全部模型。
  const selectedSiteName = siteFilter
    ? (sites.find((site) => String(site.siteId) === siteFilter)?.siteName || '')
    : '';
  const modelFilterSiteLabel = selectedSiteName
    ? `${selectedSiteName} ${tr('的全部模型')}`
    : tr('全部模型');
  // 模型下拉的候选由后端算好了，并且已经按站点筛过（它的 facet 只吃站点与
  // 成功率，不吃模型），所以选了站点之后这一份就是该站点的模型。用 useMemo
  // 保持引用稳定：下面的「清掉失效选项」要看它。
  const modelOptions = useMemo(() => overview?.modelOptions ?? [], [overview]);
  // 站点自己就没有这个接口，属于「已知无法采集」，和真正需要关注的失败
  // 分开：默认不占版面，只在需要时展开看一眼。
  const isKnownLimited = (status: string) => status === 'unsupported' || status === 'models_only';
  const failedSites = sites.filter((site) => site.status !== 'ok' && !isKnownLimited(site.status));
  const unsupportedSites = sites.filter((site) => site.status === 'unsupported');
  // 没有监控接口、但用密钥读回了模型名的站点：有数据可看，只是没有指标。
  const modelsOnlySites = sites.filter((site) => site.status === 'models_only');

  const stats = useMemo(() => {
    const okSites = sites.filter((site) => site.status === 'ok').length;
    const unsupported = sites.filter((site) => site.status === 'unsupported').length;
    const modelsOnly = sites.filter((site) => site.status === 'models_only').length;
    const rates = models.map((model) => model.successRate).filter((rate): rate is number => rate != null);
    const average = rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null;
    return { okSites, totalSites: sites.length - unsupported, unsupported, modelsOnly, average };
  }, [models, sites]);

  // 站点切换后，之前选的模型很可能不在新站点的清单里。留着它只会查到空结果，
  // 而且下拉会显示一个「候选里根本没有」的模型名（看起来就像没有跟着站点收窄）。
  // 清单是随着响应回来的，所以在它落地之后比一次：不在就清掉，让查询回到
  // 只按站点过滤。成功率筛选把模型挤出清单时同理 —— 那个模型本来就不该再被选。
  useEffect(() => {
    if (!modelFilter) return;
    if (modelOptions.some((option) => option.modelName === modelFilter)) return;
    setModelFilter('');
  }, [modelFilter, modelOptions]);

  const windowText = overview
    ? ` (${overview.windowStartHour}:00-${overview.windowEndHour}:00)`
    : '';

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">{tr('模型监控')}</h2>
          <div className="page-subtitle">
            {tr('取自各站点自己的模型监控接口，只保留最近一轮；没有监控接口的站点用密钥只列模型名，每天早上刷新一次。')}
            <span title={formatTimestamp(overview?.updatedAt)}>{formatRelative(overview?.updatedAt)}</span>
            {overview ? ` · ${tr('每 15 分钟采集一次')}${windowText}` : ''}
            {overview?.scheduler?.nextRunAt ? (
              <span title={formatTimestamp(overview.scheduler.nextRunAt)}>
                {` · ${tr('下次采集')} ${formatRelative(overview.scheduler.nextRunAt)}`}
              </span>
            ) : null}
            {overview?.scheduler?.skippedRuns ? (
              <span title={tr('上一轮还没跑完时跳过本次，避免并发采集')}>
                {` · ${tr('已跳过')} ${overview.scheduler.skippedRuns} ${tr('次')}`}
              </span>
            ) : null}
          </div>
        </div>
        <div className="page-actions">
          {overview?.running ? (
            // 采集中往往只是赶上了每 15 分钟那一轮定时任务：写清来源，免得以为
            // 是「打开页面触发的采集」。页面本身只读库，不会启动采集。
            <span
              className="badge badge-info"
              title={overview.scheduler?.lastRunTrigger === 'manual'
                ? tr('由页面上的「立即采集」触发')
                : tr('由定时任务触发（每 15 分钟一轮），和打开页面无关')}
            >
              {overview.scheduler?.lastRunTrigger === 'manual' ? tr('手动采集中') : tr('定时采集中')}
            </span>
          ) : null}
          <button
            onClick={triggerRefresh}
            disabled={starting || overview?.running}
            className="btn btn-primary"
            style={{ padding: '8px 14px' }}
          >
            {starting || overview?.running
              ? <><span className="spinner spinner-sm" /> {tr('采集中...')}</>
              : tr('立即采集')}
          </button>
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {refreshing ? <><span className="spinner spinner-sm" /> {tr('刷新中...')}</> : tr('刷新')}
          </button>
        </div>
      </div>

      <div className="model-monitor-stats">
        <div className="stat-card">
          <div className="stat-card-row">
            <span>{tr('模型数')}</span>
            <strong>{models.length}</strong>
          </div>
          <div className="stat-card-row">
            <span>{tr('覆盖站点')}</span>
            <strong title={tr('不含站点侧没有模型监控接口的站点')}>
              {stats.okSites} / {stats.totalSites}
            </strong>
          </div>
          {stats.modelsOnly ? (
            <div className="stat-card-row">
              <span>{tr('仅模型列表')}</span>
              <strong title={tr('站点没有监控接口，只用密钥取到了模型名')}>{stats.modelsOnly}</strong>
            </div>
          ) : null}
        </div>
        <div className="stat-card">
          <div className="stat-card-row">
            <span>{tr('平均成功率')}</span>
            <strong>{formatPercent(stats.average)}</strong>
          </div>
          <div className="stat-card-row">
            <span>{tr('最近更新')}</span>
            <strong title={formatTimestamp(overview?.updatedAt)}>{formatRelative(overview?.updatedAt)}</strong>
          </div>
        </div>
      </div>

      <div className="card model-monitor-toolbar">
        {/* 站点在前、模型在后：模型候选是按站点收窄的，先定站点再挑模型才顺。 */}
        <div className="model-monitor-filter model-monitor-filter-site">
          <ModernSelect
            value={siteFilter}
            onChange={setSiteFilter}
            options={[
              { value: '', label: tr('全部站点') },
              ...sites.map((site) => ({
                value: String(site.siteId),
                label: site.status === 'unsupported'
                  ? `${site.siteName}${tr('（不支持）')}`
                  : site.status === 'models_only'
                    ? `${site.siteName}${tr('（仅模型）')}`
                    : site.siteName,
              })),
            ]}
            size="sm"
            searchable
            placeholder={tr('全部站点')}
            searchPlaceholder={tr('搜索站点名')}
            emptyLabel={tr('没有匹配的站点')}
            menuMaxHeight={320}
            data-testid="model-monitor-site-select"
          />
        </div>
        <div className="model-monitor-filter model-monitor-filter-model">
          <ModernSelect
            value={modelFilter}
            onChange={setModelFilter}
            options={[
              { value: '', label: modelFilterSiteLabel },
              ...modelOptions.map((option) => ({
                value: option.modelName,
                label: option.modelName,
                description: `${option.siteCount} ${tr('个站点')}`,
              })),
            ]}
            size="sm"
            searchable
            placeholder={tr('全部模型')}
            searchPlaceholder={tr('搜索模型名')}
            emptyLabel={selectedSiteName
              ? `${selectedSiteName} ${tr('没有采集到模型')}`
              : tr('没有匹配的模型')}
            menuMaxHeight={320}
            data-testid="model-monitor-model-select"
          />
        </div>
        <select value={minSuccessRate} onChange={(event) => setMinSuccessRate(event.target.value)}>
          {SUCCESS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>{tr(option.label)}</option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={resetMonitorFilters}
          disabled={!monitorFiltersActive}
          style={{ border: '1px solid var(--color-border)', padding: '8px 14px', whiteSpace: 'nowrap' }}
          data-testid="model-monitor-reset-filters"
        >
          {tr('重置筛选')}
        </button>
        <select value={sortKey} onChange={(event) => setSortKey(event.target.value)}>
          {SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{tr(option.label)}</option>
          ))}
        </select>
        <div className="model-monitor-view-toggle">
          <button
            className={`btn btn-ghost ${view === 'cards' ? 'btn-ghost-active' : ''}`}
            onClick={() => setView('cards')}
          >
            {tr('卡片视图')}
          </button>
          <button
            className={`btn btn-ghost ${view === 'table' ? 'btn-ghost-active' : ''}`}
            onClick={() => setView('table')}
          >
            {tr('表格视图')}
          </button>
        </div>
      </div>

      {failedSites.length ? (
        <div className="card model-monitor-failures">
          <button className="model-monitor-failures-head" onClick={() => setShowFailures((current) => !current)}>
            <span>{tr('未取到数据的站点')} · {failedSites.length}</span>
            <span>{showFailures ? tr('收起') : tr('展开')}</span>
          </button>
          {showFailures ? (
            <ul className="model-monitor-failures-list">
              {failedSites.map((site) => (
                <li key={site.siteId}>
                  {site.url ? (
                    <a className="model-monitor-site-name" href={site.url} target="_blank" rel="noreferrer" title={site.url}>
                      {site.siteName}
                    </a>
                  ) : (
                    <span className="model-monitor-site-name">{site.siteName}</span>
                  )}
                  <span className={siteStatusClass(site.status)}>{tr(siteStatusLabel(site.status))}</span>
                  <span className="model-monitor-failure-message">{site.message || '—'}</span>
                  <span className="model-monitor-failure-time" title={formatTimestamp(site.fetchedAt)}>
                    {formatRelative(site.fetchedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {modelsOnlySites.length ? (
        <div className="model-monitor-unsupported">
          <button
            className="model-monitor-unsupported-head"
            onClick={() => setShowModelsOnly((current) => !current)}
          >
            <span className="badge badge-info">{tr('仅模型列表')}</span>
            <span>
              {modelsOnlySites.length} {tr('个站点没有监控接口，已用密钥只取回模型名')}
              {overview?.modelListRefreshHour != null
                ? tr('（每天早上刷新一次）')
                : null}
            </span>
            <span>{showModelsOnly ? tr('收起') : tr('展开')}</span>
          </button>
          {showModelsOnly ? (
            <div className="model-monitor-unsupported-list">
              {modelsOnlySites.map((site) => (
                site.url ? (
                  <a key={site.siteId} href={site.url} target="_blank" rel="noreferrer" title={site.message || site.url}>
                    {site.siteName}
                  </a>
                ) : (
                  <span key={site.siteId} title={site.message || ''}>{site.siteName}</span>
                )
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {unsupportedSites.length ? (
        <div className="model-monitor-unsupported">
          <button
            className="model-monitor-unsupported-head"
            onClick={() => setShowUnsupported((current) => !current)}
          >
            <span className="badge badge-muted">{tr('站点不支持')}</span>
            <span>
              {unsupportedSites.length} {tr('个站点没有模型监控接口')}
            </span>
            <span>{showUnsupported ? tr('收起') : tr('展开')}</span>
          </button>
          {showUnsupported ? (
            <div className="model-monitor-unsupported-list">
              {unsupportedSites.map((site) => (
                site.url ? (
                  <a key={site.siteId} href={site.url} target="_blank" rel="noreferrer" title={site.message || site.url}>
                    {site.siteName}
                  </a>
                ) : (
                  <span key={site.siteId} title={site.message || ''}>{site.siteName}</span>
                )
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <span className="spinner spinner-sm" />
        </div>
      ) : models.length === 0 ? (
        <div className="card empty-state">
          <div className="empty-state-title">{tr('还没有采集到模型监控数据')}</div>
          <div className="empty-state-desc">
            {tr('点「立即采集」拉一轮；站点版本较旧时不会返回这些数据。')}
          </div>
        </div>
      ) : view === 'cards' ? (
        <div className="model-monitor-grid">
          {models.map((model) => {
            const metricsAvailable = model.metricsAvailable !== false;
            return (
            <div className="card model-monitor-card" key={`${model.siteId}:${model.modelName}`}>
              <div className="model-monitor-card-head">
                <button
                  type="button"
                  className="model-monitor-model-name"
                  title={copiedModel === model.modelName ? tr('已复制') : tr('点击复制模型名')}
                  onClick={() => copyModelName(model.modelName)}
                >
                  {model.modelName}
                  <span className="model-monitor-copy-hint">
                    {copiedModel === model.modelName ? tr('已复制') : tr('复制')}
                  </span>
                </button>
                {metricsAvailable ? (
                  <span className={`model-monitor-rate is-${resolveRateLevel(model.successRate)}`}>
                    {formatPercent(model.successRate)}
                  </span>
                ) : (
                  <span className="badge badge-info" title={tr('站点没有模型监控接口，只有模型名')}>{tr('仅模型')}</span>
                )}
              </div>
              {model.siteUrl ? (
                <a
                  className="model-monitor-card-site"
                  href={model.siteUrl}
                  target="_blank"
                  rel="noreferrer"
                  title={model.siteUrl}
                >
                  {model.siteName}
                </a>
              ) : (
                <div className="model-monitor-card-site">{model.siteName}</div>
              )}
              {metricsAvailable ? (
                <>
                  <SuccessBars samples={model.recentSuccess} windowStart={model.windowStart} />
                  <div className="model-monitor-card-metrics">
                    <span title={tr('平均延迟')}>
                      <em>{tr('延迟')}</em>
                      {formatLatency(model.avgLatencyMs)}
                    </span>
                    {model.showThroughput !== false ? (
                      <span title={tr('吞吐')}>
                      <em>{tr('吞吐量')}</em>
                        {formatThroughput(model.avgTps)}
                      </span>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="model-monitor-card-metrics">
                  <span title={tr('站点没有监控接口，成功率/延迟/吞吐均无法获取')}>
                    {tr('站点未提供监控指标')}
                  </span>
                </div>
              )}
              {formatModelPrice(model) ? (
                <div className="model-monitor-card-price">{formatModelPrice(model)}</div>
              ) : null}
              <div className="model-monitor-card-actions">
                <button
                  type="button"
                  className="btn btn-link"
                  style={{ fontSize: 11.5, padding: 0 }}
                  title={tr('直接对这个站点的这个模型发一条对话，日志里会标记为测试')}
                  onClick={() => setChatTarget(model)}
                >
                  {tr('对话')}
                </button>
                <button
                  type="button"
                  className="btn btn-link"
                  style={{ fontSize: 11.5, padding: 0 }}
                  title={tr('把这个站点的这个模型挂到某个对外模型转发的最后面')}
                  onClick={() => void openAttach(model)}
                >
                  {tr('挂到转发')}
                </button>
                <button
                  type="button"
                  className="btn model-monitor-ccswitch-btn"
                  title={tr('把原站的地址与 sk- 密钥导入到 CC Switch')}
                  disabled={ccSwitchBusyKey === `${model.siteId}:${model.modelName}`}
                  onClick={() => void openCcSwitch(model)}
                >
                  {ccSwitchBusyKey === `${model.siteId}:${model.modelName}` ? tr('读取中…') : tr('导入到 CC Switch')}
                </button>
              </div>
            </div>
            );
          })}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>{tr('模型')}</th>
                <th>{tr('站点')}</th>
                <th>{tr('成功率')}</th>
                <th>{tr('延迟')}</th>
                <th>{tr('吞吐')}</th>
                <th>{tr('价格')}</th>
                <th>{tr('最近更新')}</th>
                <th>{tr('操作')}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const metricsAvailable = model.metricsAvailable !== false;
                return (
                <tr key={`${model.siteId}:${model.modelName}`}>
                  <td>
                    <button
                      type="button"
                      className="model-monitor-model-name"
                      title={copiedModel === model.modelName ? tr('已复制') : tr('点击复制模型名')}
                      onClick={() => copyModelName(model.modelName)}
                    >
                      {model.modelName}
                      <span className="model-monitor-copy-hint">
                        {copiedModel === model.modelName ? tr('已复制') : tr('复制')}
                      </span>
                    </button>
                  </td>
                  <td>
                    {model.siteUrl ? (
                      <a href={model.siteUrl} target="_blank" rel="noreferrer" title={model.siteUrl}>
                        {model.siteName}
                      </a>
                    ) : model.siteName}
                  </td>
                  <td className={metricsAvailable ? `model-monitor-rate is-${resolveRateLevel(model.successRate)}` : ''}>
                    {metricsAvailable ? formatPercent(model.successRate) : (
                      <span className="badge badge-info" title={tr('站点没有监控接口，只有模型名')}>{tr('仅模型')}</span>
                    )}
                  </td>
                  <td>{metricsAvailable ? formatLatency(model.avgLatencyMs) : '—'}</td>
                  <td>{metricsAvailable ? formatThroughput(model.avgTps) : '—'}</td>
                  <td className="model-monitor-price">{formatModelPrice(model) || '—'}</td>
                  <td title={formatTimestamp(model.fetchedAt)}>{formatRelative(model.fetchedAt)}</td>
                  <td>
                    <div className="model-monitor-row-actions">
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 12, padding: 0 }}
                        title={tr('直接对这个站点的这个模型发一条对话，日志里会标记为测试')}
                        onClick={() => setChatTarget(model)}
                      >
                        {tr('对话')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 12, padding: 0 }}
                        title={tr('把这个站点的这个模型挂到某个对外模型转发的最后面')}
                        onClick={() => void openAttach(model)}
                      >
                        {tr('挂到转发')}
                      </button>
                      <button
                        type="button"
                        className="btn model-monitor-ccswitch-btn"
                        title={tr('把原站的地址与 sk- 密钥导入到 CC Switch')}
                        disabled={ccSwitchBusyKey === `${model.siteId}:${model.modelName}`}
                        onClick={() => void openCcSwitch(model)}
                      >
                        {ccSwitchBusyKey === `${model.siteId}:${model.modelName}` ? tr('读取中…') : tr('导入到 CC Switch')}
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="model-monitor-legend">
        <span>{tr('成功率颜色：')}
          <i className="model-monitor-bar is-excellent" /> ≥100%
          <i className="model-monitor-bar is-good" /> ≥90%
          <i className="model-monitor-bar is-warning" /> ≥70%
          <i className="model-monitor-bar is-critical" /> &lt;70%
          <i className="model-monitor-bar is-unknown" /> {tr('无采样')}
        </span>
      </div>

      <ModelChatModal
        open={chatTarget !== null}
        target={chatTarget ? {
          modelName: chatTarget.modelName,
          siteId: chatTarget.siteId,
          siteName: chatTarget.siteName,
          siteUrl: chatTarget.siteUrl,
        } : null}
        onClose={() => setChatTarget(null)}
      />

      <DownstreamKeyCcSwitchModal
        open={ccSwitchTarget !== null}
        onClose={() => setCcSwitchTarget(null)}
        item={ccSwitchTarget?.item || null}
        modelOptions={ccSwitchModelOptions}
        initialBaseUrl={ccSwitchTarget?.baseUrl}
        title={tr('把原站配置导入到 CC Switch')}
        sourceHint={(
          <>
            <div>{tr('导入的是「原站」自己的地址与 sk- 密钥，不经过我们的网关。')}</div>
            <div>{tr('CC Switch 里会新增一个直连该站点的供应商，模型名保持原样。')}</div>
          </>
        )}
      />

      <CenteredModal
        open={attachTarget !== null}
        onClose={() => { if (!attachBusy) setAttachTarget(null); }}
        title={tr('挂到模型转发')}
        maxWidth={560}
        footer={(
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={attachBusy}
              onClick={() => setAttachTarget(null)}
            >
              {tr('取消')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={attachBusy}
              onClick={() => void submitAttach()}
            >
              {attachBusy ? tr('挂载中…') : tr('挂到末尾')}
            </button>
          </div>
        )}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
          <div style={{ color: 'var(--color-text-secondary)' }}>
            {tr('把下面这个「站点 + 模型」挂到某个对外模型转发的最后面；同一个模型重复挂会被拒绝。')}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '10px 12px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg-subtle, transparent)',
            }}
          >
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>{tr('站点')}：</span>
              <strong>{attachTarget?.siteName}</strong>
            </div>
            <div>
              <span style={{ color: 'var(--color-text-muted)' }}>{tr('模型')}：</span>
              <strong>{attachTarget?.modelName}</strong>
            </div>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
              {tr('挂到哪个对外模型')}
            </span>
            <Combobox
              value={attachModelName}
              onChange={setAttachModelName}
              options={forwardNames.map((name) => ({ value: name, label: name }))}
              allowCustom
              placeholder={tr('搜索已有对外模型，或直接输入新的名字')}
              emptyLabel={tr('还没有转发规则，直接输入名字会新建一条')}
              data-testid="model-monitor-attach-combobox"
            />
            <span style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
              {forwardNames.length === 0
                ? tr('现在还没有对外模型转发规则；直接输入名字保存后会自动新建一条。')
                : tr('选已有对外模型会追加到它的最后面；输入新名字会新建一条转发规则。')}
            </span>
          </label>
        </div>
      </CenteredModal>
    </div>
  );
}
