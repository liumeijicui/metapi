import { useEffect, useMemo, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import Combobox from '../../components/Combobox.js';
import { tr } from '../../i18n.js';
import type {
  ModelForwardAccountOption,
  ModelForwardDraftTarget,
  ModelForwardOptions,
  ModelForwardRuleRow,
} from './types.js';

type RuleEditorModalProps = {
  open: boolean;
  editingRule: ModelForwardRuleRow | null;
  options: ModelForwardOptions;
  siteModels: Record<number, string[]>;
  knownModels: string[];
  /** 已被其它转发规则占用的对外模型名（小写），用于前端即时查重。 */
  existingRuleNames: string[];
  saving: boolean;
  onLoadSiteModels: (siteId: number) => void;
  onClose: () => void;
  onSave: (payload: { modelName: string; enabled: boolean; targets: ModelForwardDraftTarget[] }) => void;
};

const INPUT_STYLE = {
  width: '100%',
  padding: '10px 14px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
  outline: 'none',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
} as const;

function emptyTarget(siteId: number | null): ModelForwardDraftTarget {
  return { siteId, upstreamModel: '', accountIds: [] };
}

function toDraftTargets(rule: ModelForwardRuleRow | null, fallbackSiteId: number | null): ModelForwardDraftTarget[] {
  if (!rule || rule.targets.length === 0) return [emptyTarget(fallbackSiteId)];
  const grouped = new Map<string, ModelForwardDraftTarget>();
  for (const target of rule.targets) {
    const key = `${target.siteId}::${target.upstreamModel}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.accountIds.push(target.accountId);
      continue;
    }
    grouped.set(key, {
      siteId: target.siteId,
      upstreamModel: target.upstreamModel,
      accountIds: [target.accountId],
    });
  }
  return Array.from(grouped.values());
}

export default function RuleEditorModal({
  open,
  editingRule,
  options,
  siteModels,
  knownModels,
  existingRuleNames,
  saving,
  onLoadSiteModels,
  onClose,
  onSave,
}: RuleEditorModalProps) {
  const [modelName, setModelName] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [targets, setTargets] = useState<ModelForwardDraftTarget[]>([emptyTarget(null)]);
  const [accountSearch, setAccountSearch] = useState('');

  useEffect(() => {
    if (!open) return;
    const fallbackSiteId = options.sites[0]?.id ?? null;
    setModelName(editingRule?.modelName ?? '');
    setEnabled(editingRule?.enabled ?? true);
    setTargets(toDraftTargets(editingRule, fallbackSiteId));
    setAccountSearch('');
    for (const target of toDraftTargets(editingRule, fallbackSiteId)) {
      if (target.siteId) onLoadSiteModels(target.siteId);
    }
  }, [open, editingRule]);

  const accountsBySiteId = useMemo(() => {
    const map = new Map<number, ModelForwardAccountOption[]>();
    for (const account of options.accounts) {
      const list = map.get(account.siteId) ?? [];
      list.push(account);
      map.set(account.siteId, list);
    }
    return map;
  }, [options.accounts]);

  const siteOptions = useMemo(
    () => options.sites.map((site) => ({
      value: String(site.id),
      label: site.name,
      description: site.status === 'active' ? undefined : site.status,
    })),
    [options.sites],
  );

  const updateTarget = (index: number, patch: Partial<ModelForwardDraftTarget>) => {
    setTargets((current) => current.map((target, targetIndex) => (
      targetIndex === index ? { ...target, ...patch } : target
    )));
  };

  const incomplete = targets.some((target) => (
    !target.siteId || !target.upstreamModel.trim() || target.accountIds.length === 0
  ));
  // 对外模型名不能重复（后端按大小写不敏感判定，前端先提示一次，少一次白跑接口）。
  const duplicatedModelName = useMemo(() => {
    const normalized = modelName.trim().toLowerCase();
    if (!normalized) return false;
    return existingRuleNames.some((name) => name.trim().toLowerCase() === normalized);
  }, [modelName, existingRuleNames]);
  const canSave = !saving && !!modelName.trim() && !incomplete && !duplicatedModelName;

  const handleSave = () => {
    if (!canSave) return;
    onSave({ modelName: modelName.trim(), enabled, targets });
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={editingRule ? tr('编辑转发规则') : tr('新建转发规则')}
      maxWidth={900}
      closeOnEscape
      footer={(
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn btn-ghost" onClick={onClose}>{tr('取消')}</button>
          <button type="button" className="btn btn-primary" disabled={!canSave} onClick={handleSave}>
            {saving ? tr('保存中…') : tr('保存')}
          </button>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div
          style={{
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 14px',
            background: 'var(--color-bg-card)',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 6 }}>
            {tr('对外模型名')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
            {tr('下游用这个名字调用，网关会转发到你下面指定的站点与模型；该规则优先级高于「路由」页面里的同名路由。')}
          </div>
          <input
            style={INPUT_STYLE}
            list="model-forward-known-models"
            placeholder={tr('例如 gpt-6-astra')}
            value={modelName}
            onChange={(event) => setModelName(event.target.value)}
          />
          <datalist id="model-forward-known-models">
            {knownModels.slice(0, 500).map((name) => <option key={name} value={name} />)}
          </datalist>
          {duplicatedModelName ? (
            <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 8 }}>
              {tr('该对外模型名已经有转发规则了，模型名不能重复。')}
            </div>
          ) : null}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
              style={{ width: 16, height: 16, accentColor: 'var(--color-primary)' }}
            />
            <span style={{ fontSize: 12.5, color: 'var(--color-text-primary)' }}>
              {tr('启用该规则（关闭后同名请求回落走老路由）')}
            </span>
          </label>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{tr('转发目标')}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {tr('选择站点、上游模型名，再勾选该站点下的账号；多个账号之间按权重随机。')}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-link"
              onClick={() => setTargets((current) => [...current, emptyTarget(options.sites[0]?.id ?? null)])}
            >
              {tr('+ 添加目标')}
            </button>
          </div>

          {targets.map((target, index) => {
            const siteAccounts = target.siteId ? (accountsBySiteId.get(target.siteId) ?? []) : [];
            const keyword = accountSearch.trim().toLowerCase();
            const visibleAccounts = keyword
              ? siteAccounts.filter((account) => (account.username || '').toLowerCase().includes(keyword))
              : siteAccounts;
            const models = target.siteId ? (siteModels[target.siteId] ?? []) : [];
            return (
              <div
                key={index}
                style={{
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '12px 14px',
                  background: 'var(--color-bg-card)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    {`${tr('目标')} ${index + 1}`}
                  </span>
                  {targets.length > 1 ? (
                    <button
                      type="button"
                      className="btn btn-link btn-link-danger"
                      onClick={() => setTargets((current) => current.filter((_, targetIndex) => targetIndex !== index))}
                    >
                      {tr('删除目标')}
                    </button>
                  ) : null}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 12 }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('站点')}</span>
                    {/* 站点：可下拉搜索，也可以直接把站点名敲进去（对上就自动补全）。 */}
                    <Combobox
                      value={target.siteId === null ? '' : String(target.siteId)}
                      onChange={(nextValue) => {
                        const nextSiteId = Number(nextValue);
                        updateTarget(index, { siteId: Number.isSafeInteger(nextSiteId) && nextSiteId > 0 ? nextSiteId : null, accountIds: [] });
                        if (Number.isSafeInteger(nextSiteId) && nextSiteId > 0) onLoadSiteModels(nextSiteId);
                      }}
                      options={siteOptions.map((site) => ({
                        value: site.value,
                        label: site.label,
                        description: site.description,
                      }))}
                      placeholder={tr('搜索或输入站点名')}
                      emptyLabel={tr('暂无站点')}
                      data-testid={`model-forward-site-${index}`}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{tr('上游模型名')}</span>
                    {/* 上游模型名：可搜索该站点的模型清单，也可以直接输入任意模型名。 */}
                    <Combobox
                      value={target.upstreamModel}
                      onChange={(nextValue) => updateTarget(index, { upstreamModel: nextValue })}
                      options={(target.upstreamModel.trim() && !models.includes(target.upstreamModel.trim())
                        ? [target.upstreamModel.trim(), ...models]
                        : models).slice(0, 500).map((name) => ({ value: name, label: name }))}
                      allowCustom
                      placeholder={tr('搜索或输入模型名，例如 deepseek-v4.1-flash')}
                      emptyLabel={tr('该站点还没有已知模型，直接输入即可')}
                      data-testid={`model-forward-upstream-${index}`}
                    />
                  </label>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                      {`${tr('账号')} ${target.accountIds.length > 0 ? `(${target.accountIds.length})` : ''}`}
                    </span>
                    {siteAccounts.length > 6 ? (
                      <input
                        style={{ ...INPUT_STYLE, width: 200, padding: '6px 10px', fontSize: 12 }}
                        placeholder={tr('搜索账号')}
                        value={accountSearch}
                        onChange={(event) => setAccountSearch(event.target.value)}
                      />
                    ) : null}
                  </div>
                  {!target.siteId ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('请先选择站点。')}</div>
                  ) : siteAccounts.length === 0 ? (
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('该站点下没有可用账号。')}</div>
                  ) : (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {visibleAccounts.map((account) => {
                        const checked = target.accountIds.includes(account.id);
                        return (
                          <button
                            key={account.id}
                            type="button"
                            className={`badge ${checked ? 'badge-success' : 'badge-muted'}`}
                            style={{ fontSize: 11.5, cursor: 'pointer' }}
                            onClick={() => updateTarget(index, {
                              accountIds: checked
                                ? target.accountIds.filter((id) => id !== account.id)
                                : [...target.accountIds, account.id],
                            })}
                          >
                            {checked ? '✓ ' : ''}{account.username || `#${account.id}`}
                            {account.status !== 'active' ? ` (${account.status})` : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {incomplete ? (
          <div style={{ fontSize: 12, color: 'var(--color-danger)' }}>
            {tr('每个目标都需要选择站点、填写上游模型名，并至少勾选一个账号。')}
          </div>
        ) : null}

        {knownModels.length === 0 && !editingRule ? (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {tr('提示：直接手写对外模型名也可以，不一定要从建议列表里选。')}
          </div>
        ) : null}
      </div>
    </CenteredModal>
  );
}
