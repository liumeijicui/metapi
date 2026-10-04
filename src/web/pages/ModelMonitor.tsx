import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
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
  if (status === 'unsupported') return '站点不支持';
  if (status === 'error') return '采集失败';
  return '等待采集';
}

function siteStatusClass(status: string): string {
  if (status === 'ok') return 'badge badge-success';
  if (status === 'empty') return 'badge badge-muted';
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
  const [copiedModel, setCopiedModel] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const models = overview?.models ?? [];
  const sites = overview?.sites ?? [];
  const modelOptions = overview?.modelOptions ?? [];
  // 站点自己就没有这个接口，属于「已知无法采集」，和真正需要关注的失败
  // 分开：默认不占版面，只在需要时展开看一眼。
  const failedSites = sites.filter((site) => site.status !== 'ok' && site.status !== 'unsupported');
  const unsupportedSites = sites.filter((site) => site.status === 'unsupported');

  const stats = useMemo(() => {
    const okSites = sites.filter((site) => site.status === 'ok').length;
    const unsupported = sites.filter((site) => site.status === 'unsupported').length;
    const rates = models.map((model) => model.successRate).filter((rate): rate is number => rate != null);
    const average = rates.length ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length : null;
    return { okSites, totalSites: sites.length - unsupported, unsupported, average };
  }, [models, sites]);

  const windowText = overview
    ? ` (${overview.windowStartHour}:00-${overview.windowEndHour}:00)`
    : '';

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <div>
          <h2 className="page-title">{tr('模型监控')}</h2>
          <div className="page-subtitle">
            {tr('取自各站点自己的模型监控接口，只保留最近一轮；')}
            <span title={formatTimestamp(overview?.updatedAt)}>{formatRelative(overview?.updatedAt)}</span>
            {overview ? ` · ${tr('每 15 分钟采集一次')}${windowText}` : ''}
          </div>
        </div>
        <div className="page-actions">
          {overview?.running ? <span className="badge badge-info">{tr('采集中')}</span> : null}
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
        <div className="model-monitor-filter model-monitor-filter-model">
          <ModernSelect
            value={modelFilter}
            onChange={setModelFilter}
            options={[
              { value: '', label: tr('全部模型') },
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
            emptyLabel={tr('没有匹配的模型')}
            menuMaxHeight={320}
            data-testid="model-monitor-model-select"
          />
        </div>
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
        <select value={minSuccessRate} onChange={(event) => setMinSuccessRate(event.target.value)}>
          {SUCCESS_FILTERS.map((option) => (
            <option key={option.value} value={option.value}>{tr(option.label)}</option>
          ))}
        </select>
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
          {models.map((model) => (
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
                <span className={`model-monitor-rate is-${resolveRateLevel(model.successRate)}`}>
                  {formatPercent(model.successRate)}
                </span>
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
              {formatModelPrice(model) ? (
                <div className="model-monitor-card-price">{formatModelPrice(model)}</div>
              ) : null}
            </div>
          ))}
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
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
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
                  <td className={`model-monitor-rate is-${resolveRateLevel(model.successRate)}`}>
                    {formatPercent(model.successRate)}
                  </td>
                  <td>{formatLatency(model.avgLatencyMs)}</td>
                  <td>{formatThroughput(model.avgTps)}</td>
                  <td className="model-monitor-price">{formatModelPrice(model) || '—'}</td>
                  <td title={formatTimestamp(model.fetchedAt)}>{formatRelative(model.fetchedAt)}</td>
                </tr>
              ))}
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
    </div>
  );
}
