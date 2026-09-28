import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { tr } from '../i18n.js';

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

type ImportedSessionInfo = {
  cookieNames: string[];
  savedAt: string;
  hasCsrfToken: boolean;
  cookieHeader?: string;
};

type WatchState = {
  lastStatus: 'unknown' | 'logged_in' | 'logged_out';
  lastKeepAliveAt: string | null;
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
  const [session, setSession] = useState<SessionStatus | null>(null);
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [bindAccount, setBindAccount] = useState(true);
  const [skipModelFetch, setSkipModelFetch] = useState(false);
  const [lastResult, setLastResult] = useState<string>('');
  const [importedSession, setImportedSession] = useState<ImportedSessionInfo | null>(null);
  const [watch, setWatch] = useState<WatchState | null>(null);
  const [sessionRaw, setSessionRaw] = useState('');
  const [sessionBusy, setSessionBusy] = useState(false);
  const [cookieRevealed, setCookieRevealed] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, sitesRes] = await Promise.all([
        api.getAssistedLoginStatus(provider.id),
        api.getSites(),
      ]);
      setSession(statusRes?.session ?? null);
      setImportedSession(statusRes?.importedSession ?? null);
      setWatch(statusRes?.watch ?? null);
      const rows = Array.isArray(sitesRes) ? sitesRes : [];
      setSites(rows);
      setSelectedSiteId((prev) => {
        if (prev && rows.some((row: SiteRow) => row.id === prev)) return prev;
        return rows[0]?.id ?? null;
      });
      return statusRes?.session ?? null;
    } catch (err: any) {
      toast.error(err?.message || `加载 ${provider.label} 助手状态失败`);
      return null;
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

  const handleRefreshStatus = async () => {
    const state = await loadAll();
    if (!state) return;
    if (state.loggedIn) {
      toast.success(`刷新成功：已登录${state.username ? `：${state.username}` : ''}`);
    } else if (state.blocked) {
      toast.info(`刷新完成：${state.message || '暂时无法确认登录状态'}`);
    } else {
      toast.error(`刷新完成：未登录 · ${state.message || '请重新导入 Cookie'}`);
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
        toast.error(`需要先完成 ${provider.label} 登录，请先在上方粘贴并导入会话后重试`);
      } else {
        toast.error(message);
      }
    } catch (err: any) {
      toast.error(err?.message || '快捷登录失败');
    } finally {
      setCapturing(false);
    }
  };

  // Importing a session replaces the managed browser: the operator pastes the
  // provider cookie once and the server polls it over plain HTTP from then on.
  const handleSaveSession = async () => {
    if (!sessionRaw.trim()) {
      toast.error('请先粘贴 Cookie 或 DevTools 的 Copy as cURL 内容');
      return;
    }
    setSessionBusy(true);
    try {
      const res = await api.saveAssistedLoginSession(provider.id, sessionRaw);
      if (!res?.success) {
        toast.error(res?.message || '导入失败');
        return;
      }
      setImportedSession(res.importedSession ?? null);
      setSessionRaw('');
      if (res.verified === false) {
        // A transient probe failure (rate limit, edge block) still keeps the
        // import; the annotated result is shown in the status line below.
        toast.info(res.loginState?.message || '会话已保存，稍后刷新状态确认');
      } else {
        toast.success(`会话已导入并验证通过：${res.loginState?.username || '（未知用户）'}`);
      }
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || '导入失败');
    } finally {
      setSessionBusy(false);
    }
  };

  const handleClearSession = async () => {
    setSessionBusy(true);
    try {
      await api.clearAssistedLoginSession(provider.id);
      setImportedSession(null);
      setCookieRevealed(false);
      toast.success('已清除导入的会话');
      await loadAll();
    } catch (err: any) {
      toast.error(err?.message || '清除失败');
    } finally {
      setSessionBusy(false);
    }
  };

  const handleCopyCookie = async () => {
    const value = importedSession?.cookieHeader;
    if (!value) {
      toast.error('未找到已保存的 Cookie');
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Cookie 已复制到剪贴板');
    } catch (err: any) {
      toast.error(err?.message || '复制失败，请点“显示 Cookie”后手动复制');
    }
  };

  const stateColor = session?.loggedIn
    ? 'var(--color-success, #16a34a)'
    : session?.blocked
      ? 'var(--color-warning)'
      : 'var(--color-text-muted)';

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
          <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => void handleRefreshStatus()} disabled={loading}>
            {loading ? '刷新中…' : '刷新状态'}
          </button>
        </div>
      </div>

      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 600 }}>导入 {provider.label} 会话（推荐，无需浏览器）</div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          在本机浏览器登录 {provider.label} 后，打开开发者工具 → 网络 → 任一条已登录请求 →
          复制请求头里的 Cookie（或直接“Copy as cURL”），粘贴到下面。
          {provider.id === 'linuxdo' ? ' 该方式同时绕开了 Cloudflare 对无头浏览器的拦截。' : ''}
          服务器会加密保存这段 Cookie，仅在需要时用于自动重跑授权。
        </div>
        <textarea
          className="monitor-cookie-input"
          style={{ minHeight: 96, fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
          placeholder={provider.id === 'github'
            ? '粘贴 Cookie（需包含 user_session）或整段 Copy as cURL 内容…'
            : '粘贴 Cookie（需包含 _t）或整段 Copy as cURL 内容…'}
          value={sessionRaw}
          onChange={(event) => setSessionRaw(event.target.value)}
        />
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-primary" onClick={handleSaveSession} disabled={sessionBusy}>
            {sessionBusy ? '处理中…' : importedSession ? '重新导入并检测' : '保存并检测'}
          </button>
          {importedSession && (
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={handleClearSession}
              disabled={sessionBusy}
            >
              清除已导入会话
            </button>
          )}
          {importedSession && (
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              已导入：{importedSession.cookieNames.join('、') || '（未知）'}
              {importedSession.savedAt ? ` · ${new Date(importedSession.savedAt).toLocaleString()}` : ''}
              {importedSession.hasCsrfToken ? ' · 含 CSRF 令牌' : ''}
            </span>
          )}
        </div>
        {importedSession && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, color: 'var(--color-text-muted)' }}>
            <span>已保存的 Cookie 值（可随时取回，避免误判失效后拿不到原串）：</span>
            {!cookieRevealed && (
              <code style={{ fontFamily: 'var(--font-mono)' }}>
                {importedSession.cookieNames.map((name) => `${name}=••••••`).join('; ') || '（未知）'}
              </code>
            )}
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={() => setCookieRevealed((value) => !value)}
            >
              {cookieRevealed ? '隐藏 Cookie' : '显示 Cookie'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={() => void handleCopyCookie()}
            >
              复制 Cookie
            </button>
          </div>
        )}
        {importedSession && cookieRevealed && importedSession.cookieHeader && (
          <textarea
            className="monitor-cookie-input"
            readOnly
            value={importedSession.cookieHeader}
            onFocus={(event) => event.currentTarget.select()}
            style={{ minHeight: 64, fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' }}
          />
        )}
        <div style={{ fontSize: 13 }}>
          {provider.label} 登录状态：
          <span style={{ fontWeight: 600, color: stateColor }}>
            {session?.loggedIn
              ? `已登录${session.username ? `：${session.username}` : ''}`
              : session?.blocked ? '暂时无法确认' : '未登录'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            {session?.blocked
              ? ` · ${session.message || '限流或风控拦截，不代表会话已失效，稍后刷新即可'}`
              : session?.message
                ? ` · ${session.message}`
                : importedSession ? ' · 会话已加密保存，可长期复用' : ''}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          最近保活：{watch?.lastKeepAliveAt
            ? `${new Date(watch.lastKeepAliveAt).toLocaleString()}${watch.lastStatus === 'logged_in' ? ' · 已登录' : watch.lastStatus === 'logged_out' ? ' · 未登录' : ''}`
            : '尚未执行（服务启动后会自动进行）'}
        </div>
        {importedSession && (
          <div className="monitor-hint" style={{ padding: '10px 12px' }}>
            已使用导入的会话，服务器不会再启动浏览器。探测遇到限流或风控时会沿用上次验证结果，并在后面标注错误码；只有显示“未登录”时才需要重新复制 Cookie 导入。
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
          <button type="button" className="btn btn-primary" onClick={handleCapture} disabled={capturing || !selectedSiteId}>
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
          流程：打开站点登录页 → 使用 {provider.label} 登录并自动同意授权 → 读取站点下发的凭证 →
          {bindAccount ? '直接写入连接管理。' : '仅展示结果，不写入账号。'}
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
          {provider.label} 会话会被加密持久化并长期复用，系统会在 10:00–21:00 每 30–60 分钟、夜间每 2–3 小时随机保活一次；
          若在 10:00–21:00 检测到失效，会按「通知设置」发送提醒，届时重新粘贴一次 Cookie 即可恢复。
        </div>
      </div>
    </div>
  );
}
