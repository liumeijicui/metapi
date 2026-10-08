import { useEffect, useState } from 'react';
import { getAuthToken } from '../authSession.js';
import { useI18n } from '../i18n.js';
import {
  buildServerAddress,
  formatEdgeSyncTime,
  saveEdgeSyncSource,
  splitServerAddress,
  type EdgeStatus,
} from '../edgeMode.js';
import CenteredModal from './CenteredModal.js';
import EdgeServerFields from './EdgeServerFields.js';

type EdgeSyncSettingsModalProps = {
  open: boolean;
  status: EdgeStatus | null;
  /** 同步进行中：按钮置灰，避免重复点。 */
  syncing: boolean;
  onClose: () => void;
  /** 保存成功后顺手拉一次配置；返回是否成功。 */
  onSync: () => Promise<boolean>;
};

/**
 * 边缘版的「同步设置」：改服务器地址 / 端口 / 管理令牌，保存后立刻同步一次。
 * 令牌留空表示沿用已保存的那份（本地登录令牌就是它）。
 */
export default function EdgeSyncSettingsModal({
  open,
  status,
  syncing,
  onClose,
  onSync,
}: EdgeSyncSettingsModalProps) {
  const { t } = useI18n();
  const [fields, setFields] = useState({ address: '', port: '' });
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const parts = splitServerAddress(status?.configSource.url || '');
    setFields({ address: parts.host, port: parts.port });
    setToken('');
    setError('');
  }, [open, status?.configSource.url]);

  const handleSave = async () => {
    const parts = splitServerAddress(fields.address);
    const serverUrl = buildServerAddress({ scheme: parts.scheme, host: parts.host, port: fields.port });
    if (!serverUrl) {
      setError(t('请先填写服务器地址'));
      return;
    }

    const effectiveToken = token.trim() || getAuthToken(localStorage) || '';
    if (!effectiveToken) {
      setError(t('请填写管理员令牌'));
      return;
    }

    setSaving(true);
    setError('');
    const saved = await saveEdgeSyncSource({ address: serverUrl, token: effectiveToken });
    setSaving(false);
    if (!saved.ok) {
      setError(saved.message || t('保存服务器设置失败'));
      return;
    }

    setToken('');
    await onSync();
  };

  const busy = saving || syncing;
  const lastSyncAt = formatEdgeSyncTime(status?.lastSyncAt);

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={t('同步设置')}
      maxWidth={520}
      footer={(
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t('取消')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={busy}>
            {busy ? t('同步中…') : t('保存并同步')}
          </button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <EdgeServerFields
          value={fields}
          onChange={(patch) => {
            setFields((prev) => ({ ...prev, ...patch }));
            setError('');
          }}
          disabled={busy}
          idPrefix="edge-settings"
        />

        <div className="edge-server-field">
          <label className="edge-server-label" htmlFor="edge-settings-token">
            {t('管理员令牌（留空表示不修改）')}
          </label>
          <input
            id="edge-settings-token"
            className="edge-server-input"
            type="password"
            placeholder="••••••••"
            value={token}
            disabled={busy}
            onChange={(event) => {
              setToken(event.target.value);
              setError('');
            }}
          />
        </div>

        <div className="edge-server-hint">
          {t('令牌与服务器上设置的管理员令牌一致')}
          {' · '}
          {t('上次同步')}
          {': '}
          {lastSyncAt || t('尚未同步')}
        </div>
        {status?.lastSyncError ? (
          <div className="alert alert-error">{status.lastSyncError}</div>
        ) : null}
        {error ? (
          <div className="alert alert-error">{error}</div>
        ) : null}
        <div className="edge-server-hint">
          {t('本机只从服务器拉取配置，不会向服务器写入任何数据。')}
        </div>
      </div>
    </CenteredModal>
  );
}
