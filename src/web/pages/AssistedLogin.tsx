import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';

type BrowserStatus = {
  available: boolean;
  running: boolean;
  connected: boolean;
  executableLabel?: string | null;
  profileDir?: string;
};

type SessionStatus = {
  loggedIn: boolean;
  username: string | null;
  userId: number | null;
  blocked: boolean;
  message?: string;
};

type SiteRow = {
  id: number;
  name: string;
  url: string;
  platform: string;
};

type ProviderInfo = {
  id: string;
  label: string;
};

const PROVIDER_FALLBACK: Record<string, ProviderInfo> = {
  linuxdo: { id: 'linuxdo', label: 'Linux.do' },
  github: { id: 'github', label: 'GitHub' },
};

function providerFromParam(raw: string | undefined): ProviderInfo {
  const id = (raw || 'linuxdo').trim().toLowerCase();
  return PROVIDER_FALLBACK[id] || { id, label: id };
}

export default function AssistedLogin({ providerId }: { providerId?: string } = {}) {
  const params = useParams();
  const provider = useMemo(
    () => providerFromParam(providerId || params.provider),
    [providerId, params.provider],
  );
  const toast = useToast();
  const [browser, setBrowser] = useState<BrowserStatus | null>(null);
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [bindAccount, setBindAccount] = useState(true);
  const [skipModelFetch, setSkipModelFetch] = useState(false);
  const [lastResult, setLastResult] = useState<string>('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, sitesRes] = await Promise.all([
        api.getAssistedLoginStatus(provider.id),
        api.getSites(),
      ]);
      setBrowser(statusRes?.browser ?? null);
      setSession(statusRes?.session ?? null);
      const rows = Array.isArray(sitesRes) ? sitesRes : [];
      setSites(rows);
      setSelectedSiteId((prev) => {
        if (prev && rows.some((row: SiteRow) => row.id === prev)) return prev;
        return rows[0]?.id ?? null;
      });
    } catch (err: any) {
      toast.error(err?.message || `加载 ${provider.label} 助手状态失败`);
    } finally {
      setLoading(false);
    }
  }, [toast, provider.id, provider.label]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === selectedSiteId) || null,
    [sites, selectedSiteId],
  );

  const handleOpenLogin = async () => {
    try {
      await api.openAssistedLoginWindow(provider.id);
      toast.success(`已在受管浏览器中打开 ${provider.label} 登录页，完成后点击“刷新状态”`);
    } catch (err: any) {
      toast.error(err?.message || '无法打开登录窗口');
    }
  };

  const handleCheckSession = async () => {
    try {
      await api.checkAssistedLoginSession(provider.id);
      toast.success('已检查会话状态；若已失效，将按通知设置发送提醒');
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || '检查会话失败');
    }
  };

  const handleCapture = async () => {
    if (!selectedSiteId) {
      toast.error('请先选择要快捷登录的站点');
      return;
    }
    setCapturing(true);
    setLastResult('');
    try {
      const res = await api.captureAssistedLoginCredentials(provider.id, {
        siteId: selectedSiteId,
        bindAccount,
        skipModelFetch: bindAccount ? skipModelFetch : undefined,
      });
      if (res?.success) {
        const label = res.accountId
          ? `已绑定账号 #${res.accountId}${res.username ? `（${res.username}）` : ''}`
          : '凭证已捕获';
        setLastResult(label);
        toast.success(label);
        await loadAll();
        return;
      }
      const status = String(res?.status || 'unknown');
      const message = res?.message || '未能获取凭证';
      setLastResult(`${status}：${message}`);
      if (status === 'needs_provider_login') {
        toast.error(`需要先完成 ${provider.label} 登录，请在受管浏览器中登录后重试`);
      } else {
        toast.error(message);
      }
    } catch (err: any) {
      toast.error(err?.message || '快捷登录失败');
    } finally {
      setCapturing(false);
    }
  };

  const browserLabel = browser?.executableLabel || (loading || !browser ? '检测中…' : '未检测到浏览器');
  const stateColor = session?.loggedIn ? 'var(--color-success, #16a34a)' : 'var(--color-text-muted)';
  const browserDetail = !browser || loading
    ? '正在读取受管浏览器状态…'
    : browser.available
      ? browser.connected ? '已连接，会话保持中' : '已就绪，尚未启动'
      : '未找到 Chrome/Edge，无法使用自动授权';

  return (
    <div className="animate-fade-in monitor-page">
      <div className="monitor-toolbar page-header">
        <div>
          <h2 className="page-title">{tr(`${provider.label} 快捷登录`)}</h2>
          <div style={{ marginTop: 6, fontSize: 13, color: 'var(--color-text-muted)' }}>
            用一次 {provider.label} 登录，为需要二次授权的站点自动完成授权并绑定凭证。
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={handleOpenLogin}>
            打开 {provider.label} 登录
          </button>
          <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => void loadAll()} disabled={loading}>
            {loading ? '刷新中…' : '刷新状态'}
          </button>
          <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={handleCheckSession}>
            立即检查会话
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>受管浏览器</div>
            <div style={{ fontWeight: 600 }}>{browserLabel}</div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {browserDetail}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{provider.label} 登录状态</div>
            <div style={{ fontWeight: 600, color: stateColor }}>
              {session?.loggedIn ? `已登录：${session.username || '（未知用户）'}` : '未登录'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              {session?.blocked
                ? '校验未通过，请在受管浏览器窗口中完成验证'
                : session?.message || '会话已持久化，后续授权可复用'}
            </div>
          </div>
        </div>

        {!loading && browser && !browser.available && (
          <div className="monitor-hint" style={{ padding: '10px 12px' }}>
            未检测到 Chrome 或 Edge。请安装任一浏览器后点击“刷新状态”，或设置环境变量
            <code style={{ margin: '0 4px', fontFamily: 'var(--font-mono)' }}>
              {provider.id === 'github' ? 'GITHUB_BROWSER_PATH' : 'LINUXDO_BROWSER_PATH'}
            </code>
            指向浏览器可执行文件。
          </div>
        )}
        {!loading && browser?.available && !session?.loggedIn && (
          <div className="monitor-hint" style={{ padding: '10px 12px' }}>
            点击“打开 {provider.label} 登录”后，在自动弹出的浏览器窗口完成登录
            {provider.id === 'linuxdo' ? '（含 Cloudflare 校验）' : ''}。
            登录一次即可，后续该窗口会保持会话。
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 600 }}>对站点执行快捷登录</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="monitor-cookie-input"
            style={{ maxWidth: 380 }}
            value={selectedSiteId ?? ''}
            onChange={(event) => setSelectedSiteId(Number(event.target.value) || null)}
          >
            <option value="">选择站点…</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}（{site.platform}）
              </option>
            ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={bindAccount} onChange={(e) => setBindAccount(e.target.checked)} />
            捕获后直接绑定账号
          </label>
          {bindAccount && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={skipModelFetch} onChange={(e) => setSkipModelFetch(e.target.checked)} />
              跳过模型拉取
            </label>
          )}
          <button type="button" className="btn btn-primary" onClick={handleCapture} disabled={capturing || !selectedSiteId || !browser?.available}>
            {capturing ? '授权中…' : '快捷登录并捕获凭证'}
          </button>
        </div>
        {selectedSite && (
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            目标站点：{selectedSite.name} · {selectedSite.url} · 平台 {selectedSite.platform}
          </div>
        )}
        {lastResult && (
          <div style={{ fontSize: 13 }}>
            最近结果：<span style={{ fontFamily: 'var(--font-mono)' }}>{lastResult}</span>
          </div>
        )}
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          流程：在受管浏览器打开站点 → 点击站点的 {provider.label} 登录 → 自动同意授权 → 读取站点下发的凭证 →
          {bindAccount ? '直接写入连接管理。' : '仅展示结果，不写入账号。'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          会话会保存在受管浏览器中并长期复用。系统每 30 分钟自动检查一次登录状态，
          一旦检测到失效会按「通知设置」发送提醒，届时点「打开 {provider.label} 登录」重新登录即可。
        </div>
      </div>
    </div>
  );
}
