/**
 * Drives the server's managed browser from the page itself.
 *
 * The frames are polled as JPEG blobs and painted into an <img>; a tap on that
 * image is translated back into browser coordinates and posted as a click. This
 * is the phone-friendly replacement for copy-pasting a cookie header, and it is
 * the only path that can also answer a captcha or a device-verification prompt,
 * because the operator can see and act on whatever the provider shows.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.js';

type Props = {
  providerId: string;
  providerLabel: string;
  onSessionSaved?: () => void | Promise<void>;
};

const FRAME_INTERVAL_MS = 900;
const FINISH_CHECK_INTERVAL_MS = 4_000;
const QUICK_KEYS: Array<{ label: string; value: string }> = [
  { label: '回车', value: 'Enter' },
  { label: 'Tab', value: 'Tab' },
  { label: '退格', value: 'Backspace' },
];

export default function LiveLoginPanel({ providerId, providerLabel, onSessionSaved }: Props) {
  const toast = useToast();
  const [active, setActive] = useState(false);
  const [starting, setStarting] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [capturedName, setCapturedName] = useState<string | null>(null);

  const frameUrlRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkingRef = useRef(false);
  const lastFinishAtRef = useRef(0);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const releaseFrame = useCallback(() => {
    if (frameUrlRef.current) {
      URL.revokeObjectURL(frameUrlRef.current);
      frameUrlRef.current = null;
    }
  }, []);

  const stopPolling = useCallback(() => {
    runningRef.current = false;
    clearTimer();
  }, [clearTimer]);

  const tick = useCallback(async () => {
    if (!runningRef.current) return;
    try {
      const blob = await api.fetchAssistedLoginLiveFrame(providerId);
      if (!runningRef.current) return;
      if (!blob) {
        // The window was closed (idle sweeper, or another start replaced it).
        stopPolling();
        setActive(false);
        releaseFrame();
        setFrameUrl(null);
        return;
      }
      const nextUrl = URL.createObjectURL(blob);
      releaseFrame();
      frameUrlRef.current = nextUrl;
      setFrameUrl(nextUrl);

      const dueForCheck = Date.now() - lastFinishAtRef.current > FINISH_CHECK_INTERVAL_MS;
      if (dueForCheck && !checkingRef.current) {
        checkingRef.current = true;
        lastFinishAtRef.current = Date.now();
        try {
          const res = await api.finishAssistedLoginLive(providerId);
          if (res?.loggedIn && res?.saved) {
            stopPolling();
            setActive(false);
            releaseFrame();
            setFrameUrl(null);
            setCapturedName(res.username || null);
            toast.success(`已获取并保存 ${providerLabel} 会话${res.username ? `：${res.username}` : ''}`);
            void api.stopAssistedLoginLive(providerId).catch(() => undefined);
            await onSessionSaved?.();
            return;
          }
        } catch {
          // A probe failure says nothing about the login; keep painting.
        } finally {
          checkingRef.current = false;
        }
      }
    } catch {
      // Transient transport error: keep the loop alive and try the next frame.
    }
    if (!runningRef.current) return;
    timerRef.current = setTimeout(() => void tick(), FRAME_INTERVAL_MS);
  }, [providerId, providerLabel, onSessionSaved, releaseFrame, stopPolling, toast]);

  const beginPolling = useCallback(() => {
    stopPolling();
    runningRef.current = true;
    setActive(true);
    void tick();
  }, [stopPolling, tick]);

  // Restore an already-running window after a page reload, so a half-finished
  // login is not silently abandoned.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.getAssistedLoginLiveStatus(providerId);
        if (cancelled) return;
        if (res?.active) {
          setPageUrl(res.url ?? null);
          beginPolling();
        }
      } catch {
        // ignore: the panel simply starts idle
      }
    })();
    return () => {
      cancelled = true;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  useEffect(() => () => {
    stopPolling();
    releaseFrame();
  }, [stopPolling, releaseFrame]);

  const handleStart = async () => {
    setStarting(true);
    setCapturedName(null);
    try {
      const res = await api.startAssistedLoginLive(providerId);
      if (!res?.success) {
        toast.error(res?.message || '无法启动远程登录');
        return;
      }
      setPageUrl(res.url ?? null);
      beginPolling();
      toast.info('已打开远程浏览器，请在画面里完成登录');
    } catch (err: any) {
      toast.error(err?.message || '无法启动远程登录');
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async () => {
    stopPolling();
    releaseFrame();
    setFrameUrl(null);
    setActive(false);
    setPageUrl(null);
    try {
      await api.stopAssistedLoginLive(providerId);
    } catch {
      // best effort
    }
  };

  const handleFrameTap = async (event: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.round((event.clientX - rect.left) * (img.naturalWidth / rect.width));
    const y = Math.round((event.clientY - rect.top) * (img.naturalHeight / rect.height));
    try {
      await api.sendAssistedLoginLiveInput(providerId, { type: 'click', x, y });
    } catch (err: any) {
      toast.error(err?.message || '点击转发失败');
    }
  };

  const sendText = async () => {
    if (!text) return;
    const value = text;
    setText('');
    try {
      await api.sendAssistedLoginLiveInput(providerId, { type: 'text', value });
    } catch (err: any) {
      toast.error(err?.message || '输入转发失败');
    }
  };

  const sendKey = async (value: string) => {
    try {
      await api.sendAssistedLoginLiveInput(providerId, { type: 'key', value });
    } catch (err: any) {
      toast.error(err?.message || '按键转发失败');
    }
  };

  return (
    <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontWeight: 600 }}>远程浏览器登录 {providerLabel}（手机可用）</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
        点“启动远程登录”后，服务器的浏览器会打开 {providerLabel} 登录页，画面会显示在下面。
        直接点画面即可点击，用下面的输入框打字。登录完成后会自动检测并把会话保存到服务器。
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button type="button" className="btn btn-primary" onClick={handleStart} disabled={starting || active}>
          {starting ? '启动中…' : active ? '登录窗口已打开' : '启动远程登录'}
        </button>
        {active && (
          <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={handleStop}>
            关闭窗口
          </button>
        )}
        {capturedName && (
          <span style={{ fontSize: 12, color: 'var(--color-success, #16a34a)' }}>
            已登录并保存：{capturedName}
          </span>
        )}
      </div>

      {active && (
        <>
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 6,
              overflow: 'hidden',
              background: '#111',
              touchAction: 'manipulation',
            }}
          >
            {frameUrl ? (
              <img
                ref={imgRef}
                src={frameUrl}
                alt={`${providerLabel} 远程浏览器画面`}
                onClick={handleFrameTap}
                style={{ display: 'block', width: '100%', height: 'auto', cursor: 'crosshair' }}
              />
            ) : (
              <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: '#bbb' }}>
                正在获取画面…
              </div>
            )}
          </div>

          {pageUrl && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
              当前页面：{pageUrl}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="monitor-cookie-input"
              style={{ flex: '1 1 220px', minWidth: 0 }}
              placeholder="点画面聚焦输入框后，在这里打字"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void sendText();
                }
              }}
            />
            <button type="button" className="btn btn-primary" onClick={() => void sendText()} disabled={!text}>
              输入
            </button>
            {QUICK_KEYS.map((key) => (
              <button
                key={key.value}
                type="button"
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
                onClick={() => void sendKey(key.value)}
              >
                {key.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
