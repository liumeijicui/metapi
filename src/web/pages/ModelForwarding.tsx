import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';
import RuleEditorModal from './model-forwarding/RuleEditorModal.js';
import type {
  ModelForwardDraftTarget,
  ModelForwardOptions,
  ModelForwardRuleRow,
  ModelForwardTargetRow,
} from './model-forwarding/types.js';

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
  const [rules, setRules] = useState<ModelForwardRuleRow[]>([]);
  const [options, setOptions] = useState<ModelForwardOptions>(EMPTY_OPTIONS);
  const [siteModels, setSiteModels] = useState<Record<number, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<ModelForwardRuleRow | null>(null);
  const [busyRuleId, setBusyRuleId] = useState<number | null>(null);
  const [busyTargetKey, setBusyTargetKey] = useState<string | null>(null);

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

  const handleDelete = async (rule: ModelForwardRuleRow) => {
    setBusyRuleId(rule.id);
    try {
      await api.deleteModelForwardRule(rule.id);
      toast.success(tr('转发规则已删除'));
      await load();
    } catch (error: any) {
      toast.error(error?.message || tr('删除转发规则失败'));
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

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr('模型转发')}</h1>
          <div className="page-subtitle">
            {tr('把对外模型名固定转发到指定站点、上游模型与账号；优先级高于「路由」页面里的同名路由，规则未启用时自动回落老路由。')}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => { setEditingRule(null); setEditorOpen(true); }}
        >
          {tr('新建转发')}
        </button>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--color-text-muted)' }}>
          {tr('加载中…')}
        </div>
      ) : rules.length === 0 ? (
        <div className="card" style={{ padding: 16, fontSize: 13, color: 'var(--color-text-muted)' }}>
          {tr('还没有转发规则。点右上角「新建转发」，选择站点、模型和账号即可。')}
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
                  onClick={() => void handleDelete(rule)}
                >
                  {tr('删除')}
                </button>
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
                  const cooling = target.cooldownUntil && Date.parse(target.cooldownUntil) > Date.now();
                  const state = !target.enabled
                    ? tr('已停用')
                    : cooling
                      ? tr('冷却中')
                      : (target.successCount ?? 0) > 0
                        ? tr('正常')
                        : tr('待命');
                  const stateClass = !target.enabled || cooling ? 'badge-warning' : 'badge-success';
                  const targetBusy = busyTargetKey === `${rule.id}:${target.id}`;
                  const isFirst = index === 0;
                  const isLast = index === rule.targets.length - 1;
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
                      <span className="badge badge-muted" style={{ fontSize: 10.5, minWidth: 34, justifyContent: 'center' }}>
                        {tr('目标')}{index + 1}
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
                        data-tooltip={`${tr('最近使用')}: ${formatDateTime(target.lastUsedAt)}`}
                      >
                        {state}
                      </span>
                      <span style={{ flex: 1 }} />
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 11.5, padding: '0 4px' }}
                        title={tr('置顶')}
                        disabled={targetBusy || isFirst}
                        onClick={() => void handleMoveTarget(rule, target, 'top')}
                      >
                        {tr('置顶')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 11.5, padding: '0 4px' }}
                        title={tr('上移')}
                        disabled={targetBusy || isFirst}
                        onClick={() => void handleMoveTarget(rule, target, 'up')}
                      >
                        ↑ {tr('上移')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-link"
                        style={{ fontSize: 11.5, padding: '0 4px' }}
                        title={tr('下移')}
                        disabled={targetBusy || isLast}
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
                    </div>
                  );
                })}
              </div>

              <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)' }}>
                {`${tr('最近更新')}: ${formatDateTime(rule.updatedAt)}`}
              </div>
            </div>
          ))}
        </div>
      )}

      <RuleEditorModal
        open={editorOpen}
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
