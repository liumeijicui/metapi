import React, { useEffect, useMemo, useState } from 'react';
import CenteredModal from '../../components/CenteredModal.js';
import Combobox from '../../components/Combobox.js';
import { useToast } from '../../components/Toast.js';
import {
  buildCcSwitchDeepLink,
  buildManualConfigSnippet,
  CC_SWITCH_APP_OPTIONS,
  mergeCcSwitchModelOptions,
  resolveDefaultGatewayBaseUrl,
  type CcSwitchApp,
  type CcSwitchModelOption,
} from './ccSwitch.js';

/** Only the fields the deep link needs, so both list rows and overview items fit. */
export type CcSwitchKeyTarget = {
  id: number;
  name: string;
  key?: string;
  keyMasked?: string;
  supportedModels?: string[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  item: CcSwitchKeyTarget | null;
  /** 我们已获取的全部模型，作为下拉候选（仍允许直接输入）。 */
  modelOptions?: CcSwitchModelOption[];
};

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
  fontSize: 13,
  lineHeight: 1.45,
};

function FieldLabel({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{children}</div>
      {hint ? <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>{hint}</div> : null}
    </div>
  );
}

export default function DownstreamKeyCcSwitchModal({ open, onClose, item, modelOptions = [] }: Props) {
  const toast = useToast();
  const [app, setApp] = useState<CcSwitchApp>('claude');
  const [baseUrl, setBaseUrl] = useState(() => resolveDefaultGatewayBaseUrl());
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [copiedLink, setCopiedLink] = useState(false);

  // Re-seed on every open: the gateway address can change (tunnel, custom
  // domain) and a stale value would silently point the client at the wrong host.
  useEffect(() => {
    if (!open) return;
    setBaseUrl(resolveDefaultGatewayBaseUrl());
    setModel('');
    setEnabled(true);
    setCopiedLink(false);
  }, [open, item?.id]);

  const fullKey = (item?.key || '').trim();
  const keyModelNames = useMemo(
    () => (Array.isArray(item?.supportedModels) ? item.supportedModels.filter(Boolean) : []),
    [item?.supportedModels],
  );

  // 全部模型（我们已获取的）+ 该密钥自己的白名单，同一个下拉里挑。
  const candidateModels = useMemo(
    () => mergeCcSwitchModelOptions(modelOptions, keyModelNames),
    [keyModelNames, modelOptions],
  );

  const deepLink = useMemo(
    () => buildCcSwitchDeepLink({
      app,
      name: item?.name || '',
      baseUrl,
      apiKey: fullKey,
      model,
      enabled,
    }),
    [app, baseUrl, enabled, fullKey, item?.name, model],
  );

  const manualSnippet = useMemo(
    () => buildManualConfigSnippet({ app, name: item?.name || '', baseUrl, apiKey: fullKey, model }),
    [app, baseUrl, fullKey, item?.name, model],
  );

  const missingKey = !fullKey;
  const deepLinkReady = !!deepLink;

  const handleCopyLink = async () => {
    if (!deepLinkReady) return;
    try {
      await copyToClipboard(deepLink);
      setCopiedLink(true);
      toast.success('已复制 ccswitch:// 链接');
    } catch {
      toast.error('复制失败');
    }
  };

  const handleCopySnippet = async () => {
    try {
      await copyToClipboard(manualSnippet);
      toast.success('已复制手动配置');
    } catch {
      toast.error('复制失败');
    }
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title="导入到 CC Switch"
      maxWidth={640}
      closeOnBackdrop
      closeOnEscape
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => void handleCopySnippet()}
            disabled={missingKey}
          >
            复制手动配置
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
            onClick={() => void handleCopyLink()}
            disabled={!deepLinkReady}
          >
            {copiedLink ? '已复制链接' : '复制导入链接'}
          </button>
          {deepLinkReady ? (
            <a className="btn btn-primary" href={deepLink} style={{ textDecoration: 'none' }}>
              打开 CC Switch
            </a>
          ) : (
            <button type="button" className="btn btn-primary" disabled>打开 CC Switch</button>
          )}
        </>
      )}
    >
      <div style={{ display: 'grid', gap: 16 }}>
        <div
          style={{
            fontSize: 12,
            lineHeight: 1.7,
            color: 'var(--color-text-secondary)',
            padding: '8px 10px',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--color-bg-card)',
            border: '1px solid var(--color-border-light)',
          }}
        >
          <div>本机已安装 CC Switch 时，点「打开 CC Switch」即可直接新增一个供应商。</div>
          <div>未安装时请复制链接，或在客户端里手动粘贴下面的配置。</div>
        </div>

        <div>
          <FieldLabel hint="决定写入哪个客户端的环境变量">接入客户端</FieldLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {CC_SWITCH_APP_OPTIONS.map((option) => {
              const active = option.value === app;
              return (
                <button
                  key={option.value}
                  type="button"
                  title={option.description}
                  onClick={() => setApp(option.value)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 13,
                    cursor: 'pointer',
                    border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
                    background: active
                      ? 'color-mix(in srgb, var(--color-primary) 12%, transparent)'
                      : 'var(--color-bg-card)',
                    color: active ? 'var(--color-primary)' : 'var(--color-text-primary)',
                    fontWeight: active ? 600 : 500,
                  }}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6 }}>
            {CC_SWITCH_APP_OPTIONS.find((option) => option.value === app)?.description}
          </div>
        </div>

        <div>
          <FieldLabel hint="默认取当前访问地址；面板与网关不同域时改成网关地址">网关地址</FieldLabel>
          <input
            style={inputStyle}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://your-domain.com"
            spellCheck={false}
          />
        </div>

        <div>
          <FieldLabel hint="下拉是我们已获取的全部模型，可按名字搜索，也可以直接输入别的">模型（可选）</FieldLabel>
          <Combobox
            value={model}
            onChange={setModel}
            options={candidateModels}
            allowCustom
            placeholder="留空则由客户端决定"
            emptyLabel="没有匹配的模型，直接输入即可"
            menuMaxHeight={280}
            data-testid="ccswitch-model-combobox"
          />
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 6 }}>
            共 {candidateModels.length} 个可选模型{keyModelNames.length > 0 ? `，其中 ${keyModelNames.length} 个属于该密钥的白名单` : ''}
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          导入后立即设为该客户端的当前供应商
        </label>

        <div>
          <FieldLabel>将要写入的内容</FieldLabel>
          <div
            style={{
              display: 'grid',
              gap: 6,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              background: 'var(--color-bg-card)',
              border: '1px solid var(--color-border-light)',
              borderRadius: 'var(--radius-sm)',
              padding: 10,
              wordBreak: 'break-all',
            }}
          >
            <div style={{ color: 'var(--color-text-muted)' }}>{'密钥：'}{item?.keyMasked || (fullKey ? `${fullKey.slice(0, 4)}…${fullKey.slice(-4)}` : '--')}</div>
            <div style={{ color: 'var(--color-text-muted)' }}>{'供应商名：'}{item?.name || '--'}</div>
          </div>
        </div>

        {missingKey ? (
          <div style={{ fontSize: 12, color: 'var(--color-warning, #d97706)' }}>
            完整密钥暂不可用，请刷新页面后重试。
          </div>
        ) : null}
      </div>
    </CenteredModal>
  );
}
