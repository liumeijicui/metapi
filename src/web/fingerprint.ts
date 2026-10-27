/**
 * 浏览器指纹采集（仅用于管理后台登录审计）。
 *
 * 采集的都是浏览器/设备自身暴露的稳定特征，不读取任何个人数据、不写入 cookie，
 * 也不加载第三方脚本。结果在 sessionStorage 内缓存，避免每次登录重复计算 canvas。
 */

const CACHE_KEY = 'metapi:login-fingerprint:v2';
const MAX_VALUE_LENGTH = 160;

export type BrowserFingerprint = {
  /** 客户端计算值，仅用于和服务端计算结果比对。 */
  hash: string;
  detail: Record<string, string | number | boolean>;
};

function safeString(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_VALUE_LENGTH);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * canvas / WebGL 的原始值很长（dataURL 可达数万字符）。直接截断会丢掉真正
 * 有区分度的像素部分，所以这里保留长度 + 全文短哈希，既短又稳定。
 */
function compactSignature(value: string): string {
  const raw = String(value || '');
  if (!raw) return '';
  return `${raw.length}:${fnv1a(raw)}`;
}

function canvasSignature(): string {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.textBaseline = 'top';
    ctx.font = '16px "Arial"';
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 120, 30);
    ctx.fillStyle = '#069';
    ctx.fillText('Metapi 指纹 0123', 2, 2);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.fillText('Metapi 指纹 0123', 4, 18);
    return compactSignature(canvas.toDataURL());
  } catch {
    return '';
  }
}

function webglSignature(): string {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return '';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return compactSignature(`${vendor || ''} / ${renderer || ''}`);
  } catch {
    return '';
  }
}

function collectDetail(): Record<string, string | number | boolean> {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  const scr = typeof screen === 'undefined' ? null : screen;
  const detail: Record<string, string | number | boolean> = {};

  if (nav) {
    detail.ua = safeString(nav.userAgent);
    detail.platform = safeString((nav as Navigator & { platform?: string }).platform);
    detail.languages = safeString(Array.isArray(nav.languages) ? nav.languages.join(',') : nav.language);
    detail.hardwareConcurrency = Number(nav.hardwareConcurrency) || 0;
    const deviceMemory = Number((nav as Navigator & { deviceMemory?: number }).deviceMemory);
    if (Number.isFinite(deviceMemory) && deviceMemory > 0) detail.deviceMemory = deviceMemory;
    detail.maxTouchPoints = Number(nav.maxTouchPoints) || 0;
    detail.cookieEnabled = !!nav.cookieEnabled;
    const plugins = nav.plugins ? Array.from(nav.plugins).map((p) => p.name).slice(0, 8).join(',') : '';
    detail.plugins = safeString(plugins);
  }

  if (scr) {
    detail.screen = `${scr.width}x${scr.height}x${scr.colorDepth}`;
    detail.availScreen = `${scr.availWidth}x${scr.availHeight}`;
    detail.pixelRatio = Number((typeof devicePixelRatio === 'number' ? devicePixelRatio : 1).toFixed(2));
  }

  try {
    detail.timezone = safeString(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    detail.timezone = '';
  }

  const canvas = canvasSignature();
  if (canvas) detail.canvas = canvas;
  const webgl = webglSignature();
  if (webgl) detail.webgl = webgl;

  return detail;
}

function fallbackHash(input: string): string {
  // crypto.subtle 需要安全上下文；纯内网 http 访问时退化为 FNV-1a。
  return `fnv1a${fnv1a(input)}`;
}

async function sha256Hex(input: string): Promise<string | null> {
  try {
    const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined;
    if (!subtle) return null;
    const data = new TextEncoder().encode(input);
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function readCache(): BrowserFingerprint | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BrowserFingerprint;
    if (!parsed || typeof parsed.hash !== 'string' || !parsed.detail) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getBrowserFingerprint(): Promise<BrowserFingerprint> {
  const cached = readCache();
  if (cached) return cached;

  const detail = collectDetail();
  const canonical = Object.keys(detail).sort().map((key) => `${key}=${detail[key]}`).join('|');
  const hash = (await sha256Hex(`metapi:login-fingerprint:v1|${canonical}`)) || fallbackHash(canonical);
  const fingerprint = { hash, detail };

  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(fingerprint));
  } catch {
    // 隐私模式下 sessionStorage 可能不可写，指纹仍然可用于本次登录。
  }
  return fingerprint;
}

export function resetBrowserFingerprintCacheForTests(): void {
  try {
    sessionStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
}
