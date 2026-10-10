import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import { triggerEdgeSync, useEdgeStatus } from '../edgeMode.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';
import RuleEditorModal from './model-forwarding/RuleEditorModal.js';
import type {
  ModelForwardDraftTarget,
  ModelForwardOptions,
  ModelForwardRuleRow,
  ModelForwardTargetRow,
} from './model-forwarding/types.js';

/**
 * 待确认的删除操作。
 *
 * 删除转发规则会连带它的全部目标，删错一次就得重新配站点、模型、账号三样；
 * 目标也是「站点 + 上游模型 + 账号」拼出来的，手滑点掉不好复原。所以两种删除
 * 都先弹确认框，用户点了「确认删除」才真的发请求。
 */
type PendingDelete =
  | { mode: 'rule'; rule: ModelForwardRuleRow }
  | { mode: 'target'; rule: ModelForwardRuleRow; target: ModelForwardTargetRow };

const EMPTY_OPTIONS: ModelForwardOptions = { sites: [], accounts: [], models: [] };

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function describeTargets(rule: ModelForwardRuleRow): string[] {
  const grouped = new Map<string, number>();
  for (const target of rule.targets) {
    const key = `${target.siteName || `#${target.siteId}`} · ${target.upstreamModel}`;
    grouped.set(key, (grouped.get(key) ?? 0) + 1);
  }
  return Array.from(grouped.entries()).map(([label, count]) => `${label} × ${count} 账号`);
}

export default function ModelForwarding() {
  const toast = useToast();
  const edgeStatus = useEdgeStatus();
  // 边缘版（exe）：规则本身仍然是服务器配置的镜像，但「顺序 / 启停」是这台机器的
  // 转发开关 —— 点完立即对本机生效，服务器上的规则一变就以服务器为准。
  const edgeMode = edgeStatus?.edgeMode === true;
  const [rules, setRules] = useState<ModelForwardRuleRow[]>([]);
  const [options, setOptions] = useState<ModelForwardOptions>(EMPTY_OPTIONS);
  const [siteModels, setSiteModels] = useState<Record<number, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ModelForwardRuleRow | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<number | null>(null);
  const [busyTargetKey, setBusyTargetKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rulesResult, optionsResult] = await Promise.all([
        api.getModelForwardRules(),
        api.getModelForwardOptions(),
      ]);
      setRules(Array.isArray(rulesResult?.rules) ? rulesResult.rules : []);
      setOptions({
        sites: Array.isArray(optionsResult?.sites) ? optionsResult.sites : [],
        accounts: Array.isArray(optionsResult?.accounts) ? optionsResult.accounts : [],
        models: Array.isArray(optionsResult?.models) ? optionsResult.models : [],
      });
    } catch (error: any) {
      toast.error(error?.message || tr('加载转发规则失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleEdgeSync = async () => {
    setSyncing(true);
    try {
      const result = await triggerEdgeSync();
      if (result.ok) {
        toast.success(result.imported ? tr('已同步服务器最新转发配置') : tr('服务器配置没有变化'));
        await load();
      } else {
        toast.error(result.message || tr('同步失败'));
      }
    } finally {
      setSyncing(false);
    }
  };

  // 「恢复服务器顺序」：清掉本机改过的顺序 / 启停，并按服务器那一版重排（以服务器为准）。
  const handleEdgeResetOrder = async () => {
    setSyncing(true);
    try {
      const result = await api.resetEdgeModelForwardLocalOrder() as {
        ok?: boolean;
        synced?: boolean;
        message?: string | null;
      } | null;
      // 本机改动已经清掉、但这一轮没拉到服务器配置时不能报成功：
      // 镜像里还是本机那版顺序，得等下一次同步成功才会真正回到服务器顺序。
      if (result?.ok && result.synced !== false) {
        toast.success(tr('已恢复为服务器顺序'));
      } else {
        const detail = typeof result?.message === 'string' && result.message ? `：${result.message}` : '';
        toast.error(`${tr('恢复服务器顺序失败')}${detail}`);
      }
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('恢复服务器顺序失败'));
    } finally {
      setSyncing(false);
    }
  };

  const loadSiteModels = useCallback(async (siteId: number) => {
    if (!Number.isSafeInteger(siteId) || siteId <= 0) return;
    if (siteModels[siteId]) return;
    try {
      const result = await api.getSiteAvailableModels(siteId);
      setSiteModels((current) => ({
        ...current,
        [siteId]: Array.isArray(result?.models) ? result.models : [],
      }));
    } catch {
      setSiteModels((current) => ({ ...current, [siteId]: [] }));
    }
  }, [siteModels]);

  const knownModels = useMemo(() => {
    const names = new Set<string>(options.models);
    for (const rule of rules) names.add(rule.modelName);
    return Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [options.models, rules]);

  const handleSave = async (payload: {
    modelName: string;
    enabled: boolean;
    targets: ModelForwardDraftTarget[];
  }) => {
    const targets = payload.targets.flatMap((target) => (
      target.accountIds.map((accountId) => ({
        siteId: target.siteId as number,
        accountId,
        upstreamModel: target.upstreamModel.trim(),
      }))
    ));
    if (targets.length === 0) {
      toast.error(tr('至少需要一个账号'));
      return;
    }
    setSaving(true);
    try {
      if (editingRule) {
        await api.updateModelForwardRule(editingRule.id, {
          modelName: payload.modelName,
          enabled: payload.enabled,
          targets,
        });
        toast.success(tr('转发规则已更新'));
      } else {
        await api.createModelForwardRule({
          modelName: payload.modelName,
          enabled: payload.enabled,
          targets,
        });
        toast.success(tr('转发规则已创建'));
      }
      setEditorOpen(false);
      setEditingRule(null);
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('保存转发规则失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (rule: ModelForwardRuleRow) => {
    setBusyRuleId(rule.id);
    try {
      await api.setModelForwardRuleEnabled(rule.id, !rule.enabled);
      toast.success(!rule.enabled ? tr('转发规则已启用') : tr('转发规则已停用'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('更新转发规则失败'));
    } finally {
      setBusyRuleId(null);
    }
  };

  const handleMoveTarget = async (
    rule: ModelForwardRuleRow,
    target: ModelForwardTargetRow,
    action: 'up' | 'down' | 'top',
  ) => {
    setBusyTargetKey(`${rule.id}:${target.id}`);
    try {
      await api.moveModelForwardTarget(rule.id, target.id, action);
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('调整转发目标顺序失败'));
    } finally {
      setBusyTargetKey(null);
    }
  };

  const handleToggleTarget = async (rule: ModelForwardRuleRow, target: ModelForwardTargetRow) => {
    setBusyTargetKey(`${rule.id}:${target.id}`);
    try {
      await api.setModelForwardTargetEnabled(rule.id, target.id, !target.enabled);
      toast.success(!target.enabled ? tr('转发目标已启用') : tr('转发目标已停用'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('更新转发目标失败'));
    } finally {
      setBusyTargetKey(null);
    }
  };

  // 真正执行删除：只由确认框里的「确认删除」触发，页面上的「删除」按钮只负责
  // 把待删对象放进 pendingDelete。
  const confirmDelete = async () => {
    const pending = pendingDelete;
    if (!pending) return;
    setDeleting(true);
    if (pending.mode === 'rule') setBusyRuleId(pending.rule.id);
    else setBusyTargetKey(`${pending.rule.id}:${pending.target.id}`);
    try {
      if (pending.mode === 'rule') {
        await api.deleteModelForwardRule(pending.rule.id);
        toast.success(tr('转发规则已删除'));
      } else {
        await api.deleteModelForwardTarget(pending.rule.id, pending.target.id);
        toast.success(tr('转发目标已删除'));
      }
      setPendingDelete(null);
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr(
        pending.mode === 'rule' ? '删除转发规则失败' : '删除转发目标失败',
      ));
    } finally {
      setDeleting(false);
      setBusyRuleId(null);
      setBusyTargetKey(null);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('模型转发')}</h1>
          <div className="page-subtitle">
            {edgeMode
              ? tr('本机可以调整转发顺序与启停（只对本机生效）；规则的增删改请在服务器上做。')
              : tr('把对外模型名固定转发到指定站点、上游模型与账号；规则声明过的模型只走这里配的站点，不再回落到同名的老路由。')}
          </div>
        </div>
        {edgeMode ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={syncing}
            onClick={() => void handleEdgeSync()}
          >
            {syncing ? tr('同步中…') : tr('从服务器同步')}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { setEditingRule(null); setEditorOpen(true); }}
          >
            {tr('新建转发')}
          </button>
        )}
      </div>

      {edgeMode ? (
        <div className="edge-mirror-banner">
          <span>
            {tr('本机的顺序与启停只对本机转发生效，不写服务器；服务器上的模型转发规则一变，这里就以服务器为准。')}
          </span>
          <button
            type="button"
            className="btn btn-link"
            style={{ fontSize: 11.5, padding: '0 4px' }}
            disabled={syncing}
            data-testid="edge-forward-restore-order"
            onClick={() => void handleEdgeResetOrder()}
          >
            {tr('恢复服务器顺序')}
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--color-text-muted)' }}>
          {tr('加载中…')}
        </div>
      ) : rules.length === 0 ? (
        <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--color-text-muted)' }}>
          {edgeMode
            ? tr('本机还没有转发规则。请确认服务器上已配置，然后点右上角「从服务器同步」。')
            : tr('还没有转发规则。点右上角「新建转发」，选择站点、模型和账号即可。')}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rules.map((rule) => (
            <div key={rule.id} className="card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <code style={{ fontWeight: 600, fontSize: 13.5 }}>{rule.modelName}</code>
                <span className={`badge ${rule.enabled ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: 10.5 }}>
                  {rule.enabled ? tr('启用') : tr('停用')}
                </span>
                <span className="badge badge-info" style={{ fontSize: 10.5 }}>
                  {rule.targets.length} {tr('账号')}
                </span>
                {rule.routeId ? (
                  <span className="badge badge-muted" style={{ fontSize: 10.5 }} data-tooltip={tr('转发规则接管后，同名的老路由不会再被选中')}>
                    {tr('已接管同名老路由')}
                  </span>
                ) : null}
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-link"
                  disabled={busyRuleId === rule.id}
                  onClick={() => void handleToggle(rule)}
                >
                  {rule.enabled ? tr('停用') : tr('启用')}
                </button>
                {edgeMode ? null : (
                  <>
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => { setEditingRule(rule); setEditorOpen(true); }}
                    >
                      {tr('编辑')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-link btn-link-danger"
                      disabled={busyRuleId === rule.id}
                      title={tr('删除该转发规则（会一并删除它的全部目标）')}
                      data-testid={`forward-rule-delete-${rule.id}`}
                      onClick={() => setPendingDelete({ mode: 'rule', rule })}
                    >
                      {tr('删除')}
                    </button>
                  </>
                )}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {describeTargets(rule).map((label) => (
                  <span key={label} className="badge badge-muted" style={{ fontSize: 11 }}>
                    {label}
                  </span>
                ))}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {rule.targets.map((target, index) => {
                  // 转发只看「启用 / 停用」：顺序由你自己排，第一个启用的目标就是每次
                  // 被调用的那个，不会因为冷却或连续失败被系统悄悄换掉。
                  const state = target.enabled ? tr('启用中') : tr('已停用');
                  const stateClass = target.enabled ? 'badge-success' : 'badge-muted';
                  const stateTooltip = `${tr('最近使用')}: ${formatDateTime(target.lastUsedAt)}`;
                  const targetBusy = busyTargetKey === `${rule.id}:${target.id}`;
                  return (
                    <div
                      key={target.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        padding: '6px 8px',
                        border: '1px solid var(--color-border)',
                        borderRadius: 6,
                        opacity: target.enabled ? 1 : 0.6,
                      }}
                    >
                      <span
                        className="badge badge-muted"
                        style={{ fontSize: 10.5, minWidth: 34, justifyContent: 'center' }}
                        title={tr('调用顺序：数字越小越先被调用')}
                        data-testid={`forward-target-order-${target.id}`}
                      >
                        {tr('顺序')}{index + 1}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 500 }}>
                        {target.siteName || `#${target.siteId}`}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                        {target.accountUsername || `#${target.accountId}`}
                      </span>
                      <code style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                        {target.upstreamModel}
                      </code>
                      <span
                        className={`badge ${stateClass}`}
                        style={{ fontSize: 10.5 }}
                        data-tooltip={stateTooltip}
                      >
                        {state}
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 11.5, padding: '0 4px' }}
                        title={tr('置顶（移到最前，最先被调用）')}
                        disabled={targetBusy}
                        data-testid={`forward-target-top-${target.id}`}
                        onClick={() => void handleMoveTarget(rule, target, 'top')}
                      >
                        {tr('置顶')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 11.5, padding: '0 4px' }}
                        title={tr('上移（更靠前调用）')}
                        disabled={targetBusy}
                        data-testid={`forward-target-up-${target.id}`}
                        onClick={() => void handleMoveTarget(rule, target, 'up')}
                      >
                        ↑ {tr('上移')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 11.5, padding: '0 4px' }}
                        title={tr('下移（更靠后调用）')}
                        disabled={targetBusy}
                        data-testid={`forward-target-down-${target.id}`}
                        onClick={() => void handleMoveTarget(rule, target, 'down')}
                      >
                        ↓ {tr('下移')}
                      </button>
                      <button
                        type="button"
                        className={`btn btn-link${target.enabled ? ' btn-link-danger' : ''}`}
                        style={{ fontSize: 11.5, padding: '0 4px' }}
                        disabled={targetBusy}
                        onClick={() => void handleToggleTarget(rule, target)}
                      >
                        {target.enabled ? tr('停用') : tr('启用')}
                      </button>
                      {edgeMode ? null : (
                        <button
                          type="button"
                          className="btn btn-link btn-link-danger"
                          style={{ fontSize: 11.5, padding: '0 4px' }}
                          title={tr('删除该转发目标（无需进入编辑）')}
                          disabled={targetBusy}
                          data-testid={`forward-target-delete-${target.id}`}
                          onClick={() => setPendingDelete({ mode: 'target', rule, target })}
                        >
                          {tr('删除')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              <div
                data-testid={`forward-target-order-hint-${rule.id}`}
                style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}
              >
                {tr('顺序即调用顺序：永远只走排在最前面的「启用」目标；把它停用，才会落到下一个。')}
                {edgeMode ? ` ${tr('（本机的顺序只对本机转发生效）')}` : ''}
              </div>

              <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                {`${tr('最近更新')}: ${formatDateTime(rule.updatedAt)}`}
              </div>
            </div>
          ))}
        </div>
      )}

      <DeleteConfirmModal
        open={pendingDelete !== null}
        onClose={() => { if (!deleting) setPendingDelete(null); }}
        onConfirm={() => { void confirmDelete(); }}
        loading={deleting}
        title={pendingDelete?.mode === 'target'
          ? tr('确认删除转发目标')
          : tr('确认删除转发规则')}
        description={pendingDelete?.mode === 'target'
          ? (
            <>
              {tr('将删除该转发规则下的目标')}
              {' '}
              <strong>
                {`${pendingDelete.target.siteName || `#${pendingDelete.target.siteId}`} / `
                  + `${pendingDelete.target.accountUsername || `#${pendingDelete.target.accountId}`} / `
                  + `${pendingDelete.target.upstreamModel}`}
              </strong>
              {tr('。同一规则下的其它目标不受影响。')}
            </>
          )
          : pendingDelete
            ? (
              <>
                {tr('将删除转发规则')}
                {' '}
                <strong>{pendingDelete.rule.modelName}</strong>
                {` ${tr('及其')} ${pendingDelete.rule.targets.length} ${tr('个转发目标')}`}
                {tr('。删除后该模型名不再由本页接管。')}
              </>
            )
            : null}
      />

      <RuleEditorModal
        open={editorOpen && !edgeMode}
        editingRule={editingRule}
        options={options}
        siteModels={siteModels}
        knownModels={knownModels}
        existingRuleNames={rules
          .filter((rule) => rule.id !== editingRule?.id)
          .map((rule) => rule.modelName)}
        saving={saving}
        onLoadSiteModels={(siteId) => { void loadSiteModels(siteId); }}
        onClose={() => { setEditorOpen(false); setEditingRule(null); }}
        onSave={handleSave}
      />
    </div>
  );
}
