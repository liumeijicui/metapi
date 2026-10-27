import { useCallback, useEffect, useState } from 'react';
import {
  api,
  type AdminLoginLogSummary,
  type AdminLoginLogRecord,
  type FingerprintBlocklistRecord,
  type IpBlocklistRecord,
  type TrustedFingerprintRecord,
} from '../api.js';
import ModernSelect from '../components/ModernSelect.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : value;
}

const sourceLabel = (source: IpBlocklistRecord['source']) => {
  if (source === 'admin_login') return '登录爆破';
  if (source === 'proxy_auth') return '密钥爆破';
  return '手动';
};

const fingerprintSourceLabel = (source: FingerprintBlocklistRecord['source']) => (
  source === 'admin_login' ? '登录爆破' : '手动'
);

function shortFingerprint(value: string | null | undefined): string {
  const raw = String(value || '').trim();
  if (!raw) return '-';
  return raw.length > 12 ? `${raw.slice(0, 12)}…` : raw;
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--color-text-secondary)',
  whiteSpace: 'nowrap',
};

const tdStyle: React.CSSProperties = {
  padding: '7px 10px',
  verticalAlign: 'top',
};

const inputStyle: React.CSSProperties = {
  padding: '9px 12px',
  border: '1px solid var(--color-border)',
  borderRadius: 'var(--radius-sm)',
  fontSize: 13,
  outline: 'none',
  background: 'var(--color-bg)',
  color: 'var(--color-text-primary)',
};

const statCardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '8px 14px',
  border: '1px solid var(--color-border-light)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-bg)',
};

const statLabelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-muted)',
};

export default function Security() {
  const toast = useToast();
  const [ipBlocklist, setIpBlocklist] = useState<IpBlocklistRecord[]>([]);
  const [fingerprintBlocklist, setFingerprintBlocklist] = useState<FingerprintBlocklistRecord[]>([]);
  const [trustedFingerprints, setTrustedFingerprints] = useState<TrustedFingerprintRecord[]>([]);
  const [loginLogs, setLoginLogs] = useState<AdminLoginLogRecord[]>([]);
  const [loginSummary, setLoginSummary] = useState<AdminLoginLogSummary | null>(null);
  const [blocklistQuery, setBlocklistQuery] = useState('');
  const [blocklistSource, setBlocklistSource] = useState<string>('all');
  const [loginLogIp, setLoginLogIp] = useState('');
  const [loginLogFingerprint, setLoginLogFingerprint] = useState('');
  const [loginLogSuccess, setLoginLogSuccess] = useState<'all' | 'true' | 'false'>('all');
  const [spoofOnly, setSpoofOnly] = useState(false);
  const [expandedLogId, setExpandedLogId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [newBlockIp, setNewBlockIp] = useState('');
  const [newBlockReason, setNewBlockReason] = useState('');
  const [blockingIp, setBlockingIp] = useState(false);
  const [fpQuery, setFpQuery] = useState('');
  const [fpSource, setFpSource] = useState<string>('all');
  const [newFingerprint, setNewFingerprint] = useState('');
  const [newFingerprintReason, setNewFingerprintReason] = useState('');
  const [blockingFingerprint, setBlockingFingerprint] = useState(false);
  const [trustedQuery, setTrustedQuery] = useState('');
  const [newTrustedFingerprint, setNewTrustedFingerprint] = useState('');
  const [newTrustedLabel, setNewTrustedLabel] = useState('');
  const [trustingFingerprint, setTrustingFingerprint] = useState(false);
  const [clearingLocks, setClearingLocks] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [blocked, fpBlocked, trusted, logs] = await Promise.all([
        api.listIpBlocklist({
          query: blocklistQuery.trim(),
          source: blocklistSource === 'all' ? undefined : blocklistSource,
          limit: 500,
        }),
        api.listFingerprintBlocklist({
          query: fpQuery.trim(),
          source: fpSource === 'all' ? undefined : fpSource,
          limit: 500,
        }),
        api.listTrustedFingerprints({ limit: 1000 }),
        api.getLoginLogs({
          ip: loginLogIp.trim(),
          fingerprint: loginLogFingerprint.trim(),
          success: loginLogSuccess === 'all' ? undefined : loginLogSuccess === 'true',
          spoofOnly,
          limit: 200,
        }),
      ]);
      setIpBlocklist(Array.isArray(blocked?.items) ? blocked.items : []);
      setFingerprintBlocklist(Array.isArray(fpBlocked?.items) ? fpBlocked.items : []);
      setTrustedFingerprints(Array.isArray(trusted?.items) ? trusted.items : []);
      setLoginLogs(Array.isArray(logs?.items) ? logs.items : []);
      setLoginSummary(logs?.summary || null);
    } catch (error: any) {
      toast.error(error?.message || '加载安全记录失败');
    } finally {
      setLoading(false);
    }
  }, [blocklistQuery, blocklistSource, fpQuery, fpSource, loginLogIp, loginLogFingerprint, loginLogSuccess, spoofOnly, toast]);

  useEffect(() => {
    void load();
    // 只在首次进入时自动加载，后续由“查询”按钮触发，避免每输入一个字就打一次接口。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleBlock = async () => {
    const ip = newBlockIp.trim();
    if (!ip) {
      toast.info('请输入要拉黑的 IP');
      return;
    }
    setBlockingIp(true);
    try {
      await api.blockIp({ ip, reason: newBlockReason.trim() || '管理员手动拉黑' });
      setNewBlockIp('');
      setNewBlockReason('');
      toast.success('IP 已加入黑名单');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '拉黑失败');
    } finally {
      setBlockingIp(false);
    }
  };

  const handleUnblock = async (item: IpBlocklistRecord) => {
    if (!window.confirm(`确认解除对 ${item.ip} 的封禁？`)) return;
    try {
      await api.unblockIp(item.id);
      toast.success('已解除封禁');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '解除失败');
    }
  };

  const handleBlockFingerprint = async () => {
    const fingerprint = newFingerprint.trim().toLowerCase();
    if (!fingerprint) {
      toast.info('请输入要拉黑的浏览器指纹');
      return;
    }
    setBlockingFingerprint(true);
    try {
      await api.blockFingerprint({
        fingerprint,
        reason: newFingerprintReason.trim() || '管理员手动拉黑',
      });
      setNewFingerprint('');
      setNewFingerprintReason('');
      toast.success('浏览器指纹已加入黑名单');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '拉黑失败');
    } finally {
      setBlockingFingerprint(false);
    }
  };

  const handleTrustFingerprint = async (payload: {
    fingerprint: string;
    label?: string;
    note?: string;
    lastIp?: string;
    lastUserAgent?: string;
  }) => {
    const fingerprint = payload.fingerprint.trim().toLowerCase();
    if (!fingerprint) {
      toast.info('请输入要标记的浏览器指纹');
      return;
    }
    setTrustingFingerprint(true);
    try {
      const result = await api.trustFingerprint({ ...payload, fingerprint });
      setNewTrustedFingerprint('');
      setNewTrustedLabel('');
      if (result.stillBlocked) toast.info(result.message);
      else toast.success(result.autoUnblocked ? `${result.message}，并已解除自动拉黑` : result.message);
      await load();
    } catch (error: any) {
      toast.error(error?.message || '标记失败');
    } finally {
      setTrustingFingerprint(false);
    }
  };

  const handleUntrustFingerprint = async (item: TrustedFingerprintRecord) => {
    if (!window.confirm(`确认取消「${item.label || shortFingerprint(item.fingerprint)}」的可信标记？`)) return;
    try {
      await api.untrustFingerprint(item.id);
      toast.success('已取消可信标记');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '取消失败');
    }
  };

  const handleTrustLogFingerprint = async (item: AdminLoginLogRecord) => {
    const fingerprint = String(item.fingerprint || '').trim().toLowerCase();
    if (!fingerprint) {
      toast.info('这条记录没有采集到浏览器指纹');
      return;
    }
    const ua = String(item.userAgent || '').trim();
    const label = ua ? (ua.length > 80 ? `${ua.slice(0, 80)}…` : ua) : undefined;
    if (!window.confirm(`确认把该浏览器标记为「我的设备」？\n${fingerprint}\n\n标记后不会再触发指纹锁定或自动拉黑。`)) return;
    await handleTrustFingerprint({
      fingerprint,
      label,
      note: '从登录审计标记',
      lastIp: item.ip,
      lastUserAgent: ua || undefined,
    });
  };

  const handleBlockLogFingerprint = async (item: AdminLoginLogRecord) => {
    const fingerprint = String(item.fingerprint || '').trim().toLowerCase();
    if (!fingerprint) {
      toast.info('这条记录没有采集到浏览器指纹');
      return;
    }
    const ua = String(item.userAgent || '').trim();
    const label = ua ? (ua.length > 80 ? `${ua.slice(0, 80)}…` : ua) : undefined;
    if (!window.confirm(`确认拉黑该浏览器指纹？\n${fingerprint}\n\n该浏览器之后将无法登录，即使密码正确。`)) return;
    try {
      await api.blockFingerprint({
        fingerprint,
        reason: '从登录审计手动拉黑',
        label,
        lastIp: item.ip,
        lastUserAgent: ua || undefined,
      });
      toast.success('该浏览器指纹已拉黑');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '拉黑失败');
    }
  };

  const handleUnblockFingerprint = async (item: FingerprintBlocklistRecord) => {
    const target = item.label || shortFingerprint(item.fingerprint);
    if (!window.confirm(`确认解除该浏览器指纹的封禁？\n${target}\n${item.fingerprint}`)) return;
    try {
      await api.unblockFingerprint(item.id);
      toast.success('已解除指纹封禁');
      await load();
    } catch (error: any) {
      toast.error(error?.message || '解除失败');
    }
  };

  const handleClearLocks = async () => {
    setClearingLocks(true);
    try {
      await api.clearLoginFingerprintLocks();
      toast.success('已清除指纹锁定，可重新登录');
    } catch (error: any) {
      toast.error(error?.message || '清除失败');
    } finally {
      setClearingLocks(false);
    }
  };

  const trustedFingerprintSet = new Set(trustedFingerprints.map((item) => item.fingerprint));
  const normalizedTrustedQuery = trustedQuery.trim().toLowerCase();
  const filteredTrustedFingerprints = normalizedTrustedQuery
    ? trustedFingerprints.filter((item) => (
      item.fingerprint.startsWith(normalizedTrustedQuery)
      || String(item.label || '').toLowerCase().includes(normalizedTrustedQuery)
    ))
    : trustedFingerprints;

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr('安全中心')}</h2>
        <div className="page-actions">
          <button
            onClick={() => { void load(); }}
            disabled={loading}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {loading ? <><span className="spinner spinner-sm" /> 刷新中...</> : '刷新'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>我的设备（可信指纹）</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
          标记后，该浏览器即使多次输错密码也不会触发指纹锁定，也不会被自动写入指纹黑名单。
          可信设备登录失败时也不会再累计 IP 临时锁或自动拉黑；但已有的 IP 黑名单仍然生效，也不会解除手动拉黑。只标记自己常用的浏览器；
          换浏览器、清空站点数据或无痕模式会改变指纹，需要重新标记。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            value={newTrustedFingerprint}
            onChange={(e) => setNewTrustedFingerprint(e.target.value)}
            placeholder="要标记的指纹（64 位十六进制）"
            style={{ ...inputStyle, flex: '2 1 320px', fontFamily: 'var(--font-mono)' }}
          />
          <input
            value={newTrustedLabel}
            onChange={(e) => setNewTrustedLabel(e.target.value)}
            placeholder="标签（例如：我的 Chrome）"
            style={{ ...inputStyle, flex: '1 1 180px' }}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => { void handleTrustFingerprint({ fingerprint: newTrustedFingerprint, label: newTrustedLabel.trim() || undefined }); }}
            disabled={trustingFingerprint}
          >
            {trustingFingerprint ? '标记中...' : '标记为我的设备'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <input
            value={trustedQuery}
            onChange={(e) => setTrustedQuery(e.target.value)}
            placeholder="按指纹前缀或标签筛选"
            style={{ ...inputStyle, flex: '1 1 240px', fontFamily: 'var(--font-mono)' }}
          />
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>共 {trustedFingerprints.length} 台设备</span>
        </div>
        <div style={{ overflow: 'auto', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-bg)' }}>
                <th style={thStyle}>指纹</th>
                <th style={thStyle}>标签</th>
                <th style={thStyle}>最近 IP</th>
                <th style={thStyle}>最近使用</th>
                <th style={thStyle}>添加时间</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {filteredTrustedFingerprints.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 14, textAlign: 'center', color: 'var(--color-text-muted)' }}>{trustedFingerprints.length === 0 ? '还没有标记可信设备' : '没有匹配的设备'}</td></tr>
              ) : filteredTrustedFingerprints.map((item) => (
                <tr key={item.id} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }} title={item.fingerprint}>
                    <span className="badge badge-success" style={{ marginRight: 6 }}>我的设备</span>
                    {shortFingerprint(item.fingerprint)}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 260, wordBreak: 'break-all' }}>{item.label || '-'}{item.note ? <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{item.note}</div> : null}</td>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>{item.lastIp || '-'}</td>
                  <td style={tdStyle}>{formatTimestamp(item.lastSeenAt)}</td>
                  <td style={tdStyle}>{formatTimestamp(item.createdAt)}</td>
                  <td style={tdStyle}>
                    <button type="button" className="btn btn-link" onClick={() => { void handleUntrustFingerprint(item); }}>取消信任</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>IP 黑名单</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
          下游密钥连续错误 20 次、管理登录连续失败 10 次会自动拉黑。被拉黑的 IP 无法访问页面、管理接口和 /v1 代理；
          环回地址永久豁免，避免把服务器本机锁死。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            value={newBlockIp}
            onChange={(e) => setNewBlockIp(e.target.value)}
            placeholder="要拉黑的 IP"
            style={{ ...inputStyle, flex: '1 1 180px', fontFamily: 'var(--font-mono)' }}
          />
          <input
            value={newBlockReason}
            onChange={(e) => setNewBlockReason(e.target.value)}
            placeholder="原因（可选）"
            style={{ ...inputStyle, flex: '2 1 240px' }}
          />
          <button type="button" className="btn btn-danger" onClick={() => { void handleBlock(); }} disabled={blockingIp}>
            {blockingIp ? '拉黑中...' : '拉黑'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <input
            value={blocklistQuery}
            onChange={(e) => setBlocklistQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            placeholder="按 IP 筛选"
            style={{ ...inputStyle, flex: '1 1 180px', fontFamily: 'var(--font-mono)' }}
          />
          <div style={{ minWidth: 150 }}>
            <ModernSelect
              value={blocklistSource}
              onChange={setBlocklistSource}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'proxy_auth', label: '密钥爆破' },
                { value: 'admin_login', label: '登录爆破' },
                { value: 'manual', label: '手动拉黑' },
              ]}
            />
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => { void load(); }}>查询</button>
        </div>
        <div style={{ overflow: 'auto', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-bg)' }}>
                <th style={thStyle}>IP</th>
                <th style={thStyle}>来源</th>
                <th style={thStyle}>原因</th>
                <th style={thStyle}>次数</th>
                <th style={thStyle}>封禁时间</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {ipBlocklist.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 14, textAlign: 'center', color: 'var(--color-text-muted)' }}>暂无记录</td></tr>
              ) : ipBlocklist.map((item) => (
                <tr key={item.id} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>{item.ip}</td>
                  <td style={tdStyle}>{sourceLabel(item.source)}</td>
                  <td style={{ ...tdStyle, maxWidth: 320 }}>{item.reason}{item.note ? `（${item.note}）` : ''}</td>
                  <td style={tdStyle}>{item.failureCount}</td>
                  <td style={tdStyle}>{formatTimestamp(item.blockedAt)}</td>
                  <td style={tdStyle}>
                    <button type="button" className="btn btn-link" onClick={() => { void handleUnblock(item); }}>解除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>浏览器指纹黑名单</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
          指纹按浏览器环境计算，同一个浏览器换 IP 仍然能被识别。被拉黑的指纹无法登录，也无法继续使用已登录的会话。
          清除上方的「指纹锁定」只解除临时锁，不会移除这里的永久拉黑。
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <input
            value={newFingerprint}
            onChange={(e) => setNewFingerprint(e.target.value)}
            placeholder="要拉黑的指纹（64 位十六进制）"
            style={{ ...inputStyle, flex: '2 1 320px', fontFamily: 'var(--font-mono)' }}
          />
          <input
            value={newFingerprintReason}
            onChange={(e) => setNewFingerprintReason(e.target.value)}
            placeholder="原因（可选）"
            style={{ ...inputStyle, flex: '1 1 180px' }}
          />
          <button type="button" className="btn btn-danger" onClick={() => { void handleBlockFingerprint(); }} disabled={blockingFingerprint}>
            {blockingFingerprint ? '拉黑中...' : '拉黑指纹'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <input
            value={fpQuery}
            onChange={(e) => setFpQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            placeholder="按指纹前缀筛选"
            style={{ ...inputStyle, flex: '1 1 220px', fontFamily: 'var(--font-mono)' }}
          />
          <div style={{ minWidth: 150 }}>
            <ModernSelect
              value={fpSource}
              onChange={setFpSource}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'admin_login', label: '登录爆破' },
                { value: 'manual', label: '手动拉黑' },
              ]}
            />
          </div>
          <button type="button" className="btn btn-ghost" onClick={() => { void load(); }}>查询</button>
        </div>
        <div style={{ overflow: 'auto', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-bg)' }}>
                <th style={thStyle}>指纹</th>
                <th style={thStyle}>标签 / 最近 IP</th>
                <th style={thStyle}>来源</th>
                <th style={thStyle}>原因</th>
                <th style={thStyle}>次数</th>
                <th style={thStyle}>拉黑时间</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {fingerprintBlocklist.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 14, textAlign: 'center', color: 'var(--color-text-muted)' }}>暂无记录</td></tr>
              ) : fingerprintBlocklist.map((item) => (
                <tr key={item.id} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }} title={item.fingerprint}>
                    {trustedFingerprintSet.has(item.fingerprint) ? (
                      <span className="badge badge-success" style={{ marginRight: 6 }}>我的设备</span>
                    ) : null}
                    {shortFingerprint(item.fingerprint)}
                  </td>
                  <td style={{ ...tdStyle, maxWidth: 320, wordBreak: 'break-all' }}>
                    <div>{item.label || '-'}</div>
                    {item.lastIp ? <div style={{ fontSize: 11, color: 'var(--color-text-muted)', fontFamily: 'var(--font-mono)' }}>{item.lastIp}</div> : null}
                  </td>
                  <td style={tdStyle}>{fingerprintSourceLabel(item.source)}</td>
                  <td style={{ ...tdStyle, maxWidth: 260 }}>{item.reason}{item.note ? `（${item.note}）` : ''}</td>
                  <td style={tdStyle}>{item.failureCount}</td>
                  <td style={tdStyle}>{formatTimestamp(item.blockedAt)}</td>
                  <td style={tdStyle}>
                    <button type="button" className="btn btn-link" onClick={() => { void handleUnblockFingerprint(item); }}>解除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>登录审计</div>
          <button type="button" className="btn btn-ghost" onClick={() => { void handleClearLocks(); }} disabled={clearingLocks}>
            {clearingLocks ? '清除中...' : '清除指纹锁定'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.8, marginBottom: 12 }}>
          每次登录都会记录用户名、来源 IP、socket 对端地址、浏览器指纹与结果，不记录明文密码。
          同一浏览器 15 分钟内失败 10 次会被指纹锁定（与 IP 无关），已成功登录过的浏览器不受影响。
        </div>
        {loginSummary ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            <div className="stat-chip" style={statCardStyle}>
              <span style={statLabelStyle}>总计</span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>{loginSummary.total} 次</span>
              <span style={statLabelStyle}>成功 {loginSummary.success} / 失败 {loginSummary.failed}</span>
            </div>
            <div className="stat-chip" style={{ ...statCardStyle, borderColor: 'var(--color-primary)' }}>
              <span style={statLabelStyle}>今日（{loginSummary.today.localDay}）</span>
              <span style={{ fontSize: 16, fontWeight: 600 }}>{loginSummary.today.total} 次</span>
              <span style={statLabelStyle}>
                成功 {loginSummary.today.success} / 失败 {loginSummary.today.failed}
              </span>
              <span style={statLabelStyle}>
                我的设备 {loginSummary.today.trusted} · 其他设备 {loginSummary.today.other}
              </span>
            </div>
            <div className="stat-chip" style={statCardStyle}>
              <span style={statLabelStyle}>我的设备</span>
              <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-success)' }}>{loginSummary.trusted} 次</span>
              <span style={statLabelStyle}>成功 {loginSummary.trustedSuccess} · 今日 {loginSummary.today.trusted} 次</span>
            </div>
            <div className="stat-chip" style={statCardStyle}>
              <span style={statLabelStyle}>其他设备</span>
              <span style={{ fontSize: 16, fontWeight: 600, color: loginSummary.other > 0 ? 'var(--color-danger)' : 'var(--color-text-primary)' }}>{loginSummary.other} 次</span>
              <span style={statLabelStyle}>成功 {loginSummary.otherSuccess} · 今日 {loginSummary.today.other} 次</span>
              <span style={statLabelStyle}>不同指纹 {loginSummary.uniqueFingerprints} 个</span>
            </div>
            <div style={{ alignSelf: 'flex-end', fontSize: 11, color: 'var(--color-text-muted)', paddingBottom: 2 }}>
              按当前筛选条件全量统计（含失败记录）；今日按服务器时区
            </div>
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10, alignItems: 'center' }}>
          <input
            value={loginLogIp}
            onChange={(e) => setLoginLogIp(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            placeholder="按 IP 筛选"
            style={{ ...inputStyle, flex: '1 1 160px', fontFamily: 'var(--font-mono)' }}
          />
          <input
            value={loginLogFingerprint}
            onChange={(e) => setLoginLogFingerprint(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load()}
            placeholder="按指纹筛选（完整或前缀）"
            style={{ ...inputStyle, flex: '1 1 200px', fontFamily: 'var(--font-mono)' }}
          />
          <div style={{ minWidth: 140 }}>
            <ModernSelect
              value={loginLogSuccess}
              onChange={(value) => setLoginLogSuccess(value as 'all' | 'true' | 'false')}
              options={[
                { value: 'all', label: '全部结果' },
                { value: 'true', label: '成功' },
                { value: 'false', label: '失败' },
              ]}
            />
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <input type="checkbox" checked={spoofOnly} onChange={(e) => setSpoofOnly(e.target.checked)} />
            只看可疑
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => { void load(); }}>查询</button>
        </div>
        <div style={{ overflow: 'auto', border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--color-bg)' }}>
                <th style={thStyle}>时间</th>
                <th style={thStyle}>用户名</th>
                <th style={thStyle}>来源 IP</th>
                <th style={thStyle}>设备指纹</th>
                <th style={thStyle}>结果</th>
                <th style={thStyle}>原因</th>
                <th style={thStyle}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loginLogs.length === 0 ? (
                <tr><td colSpan={7} style={{ padding: 14, textAlign: 'center', color: 'var(--color-text-muted)' }}>暂无记录</td></tr>
              ) : loginLogs.map((item) => {
                const expanded = expandedLogId === item.id;
                const peerDiffers = !!item.peerIp && item.peerIp !== item.ip;
                const trustedDevice = item.fingerprint
                  ? trustedFingerprints.find((trusted) => trusted.fingerprint === item.fingerprint)
                  : undefined;
                return (
                  <>
                    <tr
                      key={item.id}
                      style={{ borderTop: '1px solid var(--color-border-light)', cursor: 'pointer' }}
                      onClick={() => setExpandedLogId(expanded ? null : item.id)}
                    >
                      <td style={tdStyle}>{formatTimestamp(item.createdAt)}</td>
                      <td style={tdStyle}>{item.username || '-'}</td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>
                        {item.ip}
                        {peerDiffers ? (
                          <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>对端 {item.peerIp}</div>
                        ) : null}
                      </td>
                      <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }} title={item.fingerprint || ''}>
                        {shortFingerprint(item.fingerprint)}
                        {trustedDevice ? (
                          <span className="badge badge-success" style={{ marginLeft: 6 }}>我的设备</span>
                        ) : null}
                      </td>
                      <td style={{ ...tdStyle, color: item.success ? 'var(--color-success)' : 'var(--color-danger)' }}>
                        {item.success ? '成功' : '失败'}
                        {item.spoofSuspect ? (
                          <span className="badge badge-warning" style={{ marginLeft: 6 }}>可疑</span>
                        ) : null}
                      </td>
                      <td style={tdStyle}>{item.reason || '-'}</td>
                      <td style={tdStyle}>
                        {!item.fingerprint ? '-' : trustedDevice ? (
                          <button
                            type="button"
                            className="btn btn-link"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleUntrustFingerprint(trustedDevice);
                            }}
                          >
                            取消信任
                          </button>
                        ) : (
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            <button
                              type="button"
                              className="btn btn-link"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleTrustLogFingerprint(item);
                              }}
                            >
                              标记为我的设备
                            </button>
                            <button
                              type="button"
                              className="btn btn-link"
                              style={{ color: 'var(--color-danger)' }}
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleBlockLogFingerprint(item);
                              }}
                            >
                              拉黑此浏览器
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                    {expanded ? (
                      <tr key={`${item.id}-detail`} style={{ background: 'var(--color-bg)' }}>
                        <td colSpan={7} style={{ ...tdStyle, fontSize: 11, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
                          <div>User-Agent：{item.userAgent || '-'}</div>
                          {item.ipChain ? <div>X-Forwarded-For：{item.ipChain}</div> : null}
                          <div>指纹：{item.fingerprint || '-'}</div>
                          {item.fingerprintDetail ? <div>指纹特征：{item.fingerprintDetail}</div> : null}
                        </td>
                      </tr>
                    ) : null}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
