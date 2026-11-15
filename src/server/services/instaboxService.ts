import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Transform, type Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { fetch } from 'undici';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { deriveSecuritySeed } from './securitySeedService.js';

const API_BASE_URL = (process.env.INSTABOX_API_BASE_URL || 'https://api.instabox.sh').replace(/\/+$/, '');
const SETTING_KEY = 'instabox_api_key_v1';
const CIPHER_VERSION = 'v1';
const CIPHER_ALGORITHM = 'aes-256-gcm';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_MACHINE_PAGES = 10;

/** InstaBox 官方单个文件上限为 5 GiB。 */
export const INSTABOX_UPLOAD_MAX_BYTES = 5 * 1024 * 1024 * 1024;
export const INSTABOX_UPLOAD_MAX_LABEL = '5 GiB';

type StoredInstaboxConfig = {
  cipherText: string;
  maskedKey: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
};

export type InstaboxConfigStatus = {
  configured: boolean;
  keyReadable: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
};

export type InstaboxRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Raw request body, used by the file-upload endpoint. Mutually exclusive with body. */
  rawBody?: Buffer | Uint8Array;
  /** Streaming request body for large uploads; avoids buffering the whole file in RAM. */
  streamBody?: Readable;
  contentLength?: number;
  contentType?: string;
  key?: string;
  idempotencyKey?: string;
  confirmDelete?: string;
  timeoutMs?: number;
};

export type InstaboxSshToken = {
  id: string;
  name: string;
  machineId: string;
  host: string;
  port: number;
  token: string;
  command: string;
  expiresAt: string;
  hostKeyFingerprint?: string;
};

export type InstaboxSshTokenMetadata = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
};

export type InstaboxFileUploadResult = {
  path: string;
  size: number;
  sha256: string;
  mode: string;
  created: boolean;
  replaced: boolean;
};

export class InstaboxApiError extends Error {
  status: number;
  code: string | null;
  requestId: string | null;
  retryable: boolean;
  retryAfterSeconds: number | null;

  constructor(message: string, input: {
    status: number;
    code?: string | null;
    requestId?: string | null;
    retryable?: boolean;
    retryAfterSeconds?: number | null;
  }) {
    super(message);
    this.name = 'InstaboxApiError';
    this.status = input.status;
    this.code = input.code ?? null;
    this.requestId = input.requestId ?? null;
    this.retryable = input.retryable === true;
    this.retryAfterSeconds = typeof input.retryAfterSeconds === 'number' ? input.retryAfterSeconds : null;
  }
}

function buildCipherKey(): Buffer {
  return deriveSecuritySeed('instabox-api-key');
}

export function encryptInstaboxSecret(plainText: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(CIPHER_ALGORITHM, buildCipherKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CIPHER_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join(':');
}

export function decryptInstaboxSecret(cipherText: string): string | null {
  const parts = String(cipherText || '').split(':');
  if (parts.length !== 4 || parts[0] !== CIPHER_VERSION) return null;
  try {
    const [, ivRaw, tagRaw, dataRaw] = parts;
    const decipher = createDecipheriv(
      CIPHER_ALGORITHM,
      buildCipherKey(),
      Buffer.from(ivRaw!, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw!, 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataRaw!, 'base64url')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

export function maskInstaboxApiKey(apiKey: string): string {
  const value = String(apiKey || '').trim();
  if (!value) return '';
  if (value.length <= 16) return `${value.slice(0, 4)}…${value.slice(-4)}`;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function normalizeApiKey(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new InstaboxApiError('请填写 InstaBox API Key', { status: 400, code: 'missing_key' });
  if (!value.startsWith('ibk_') || value.length < 20) {
    throw new InstaboxApiError('API Key 格式不正确，应以 ibk_ 开头', { status: 400, code: 'malformed_key' });
  }
  return value;
}

async function readStoredConfig(): Promise<StoredInstaboxConfig | null> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTING_KEY))
    .get();
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(String(row.value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const candidate = parsed as Partial<StoredInstaboxConfig>;
    if (typeof candidate.cipherText !== 'string' || !candidate.cipherText) return null;
    return {
      cipherText: candidate.cipherText,
      maskedKey: typeof candidate.maskedKey === 'string' ? candidate.maskedKey : '',
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
      lastVerifiedAt: typeof candidate.lastVerifiedAt === 'string' ? candidate.lastVerifiedAt : null,
    };
  } catch {
    return null;
  }
}

async function writeStoredConfig(config: StoredInstaboxConfig): Promise<void> {
  await upsertSetting(SETTING_KEY, config);
}

export async function getInstaboxConfigStatus(): Promise<InstaboxConfigStatus> {
  const stored = await readStoredConfig();
  if (!stored) {
    return {
      configured: false,
      keyReadable: false,
      maskedKey: null,
      updatedAt: null,
      lastVerifiedAt: null,
    };
  }
  return {
    configured: true,
    keyReadable: Boolean(decryptInstaboxSecret(stored.cipherText)),
    maskedKey: stored.maskedKey || null,
    updatedAt: stored.updatedAt || null,
    lastVerifiedAt: stored.lastVerifiedAt,
  };
}

async function requireInstaboxApiKey(): Promise<string> {
  const stored = await readStoredConfig();
  if (!stored) {
    throw new InstaboxApiError('尚未配置 InstaBox API Key', { status: 400, code: 'missing_key' });
  }
  const apiKey = decryptInstaboxSecret(stored.cipherText);
  if (!apiKey) {
    throw new InstaboxApiError('已保存的 InstaBox API Key 无法解密，请重新填写', { status: 400, code: 'invalid_key' });
  }
  return apiKey;
}

/**
 * InstaBox 的错误字段嵌在 `error` 里（`{"error":{"code":…,"message":…}}`）。
 * 只读顶层会拿不到 code，401/429/409 全部退化成“请求失败（HTTP 409）”，
 * 调用方也就无法区分“冷却中一会儿自动恢复”和“密钥失效需要人处理”。
 */
function unwrapErrorPayload(payload: any): {
  code: string | null;
  message: string;
  hint: string;
  requestId: string | null;
  retryable: boolean;
  retryAfterSeconds: number | null;
} {
  const nested = payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error
    : payload;
  const code = typeof nested?.code === 'string' ? nested.code : null;
  const message = typeof nested?.message === 'string' ? nested.message.trim() : '';
  const hint = typeof nested?.hint === 'string' ? nested.hint.trim() : '';
  const requestId = typeof nested?.requestId === 'string'
    ? nested.requestId
    : typeof payload?.requestId === 'string' ? payload.requestId : null;
  const retryAfterSeconds = Number.isFinite(Number(nested?.retryAfterSeconds))
    ? Number(nested.retryAfterSeconds)
    : null;
  return { code, message, hint, requestId, retryable: nested?.retryable === true, retryAfterSeconds };
}

function formatCooldown(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '';
  const minutes = Math.ceil(seconds / 60);
  const at = new Date(Date.now() + seconds * 1000).toLocaleString('zh-CN');
  return `（还需约 ${minutes} 分钟，${at} 后可再启动）`;
}

/** 把 InstaBox 的错误体翻译成操作者能直接照做的中文说明。 */
export function upstreamErrorMessage(status: number, payload: any): string {
  const { code, message: rawMessage, hint, retryAfterSeconds } = unwrapErrorPayload(payload);

  if (status === 401 || ['invalid_key', 'expired_key', 'revoked_key', 'missing_key', 'malformed_key'].includes(code || '')) {
    return 'InstaBox API Key 无效、已过期或已被撤销，请更新密钥';
  }
  if (code === 'missing_scope' || code === 'permission_denied') {
    return `API Key 权限不足${rawMessage ? `：${rawMessage}` : ''}`;
  }
  if (code === 'quota_exceeded' || status === 429) {
    return 'InstaBox 配额或频率限制已触发，请稍后重试';
  }
  if (code === 'no_capacity') {
    return 'InstaBox 当前没有可用容量，请稍后重试';
  }
  if (code === 'machine_cooldown') {
    return `机器处于冷却期，暂不可启动${formatCooldown(retryAfterSeconds)}`;
  }
  if (code === 'operation_conflict') {
    return '机器已有操作正在进行，请等待完成后再试';
  }
  if (code === 'payment_method_required' || code === 'subscription_required' || status === 402) {
    return 'InstaBox 账户当前不可用，请检查套餐、付款方式或额度';
  }
  if (code === 'delete_confirmation_required') {
    return '删除确认失败，请刷新页面后重试';
  }
  if (status >= 500) {
    return `InstaBox 服务暂时异常（HTTP ${status}），请稍后重试`;
  }
  return `InstaBox 请求失败（HTTP ${status}）${rawMessage ? `：${rawMessage}` : hint ? `：${hint}` : ''}`;
}

async function instaboxRequest<T>(path: string, options: InstaboxRequestOptions = {}): Promise<T> {
  const bodyKinds = [options.body, options.rawBody, options.streamBody].filter((value) => value !== undefined);
  if (bodyKinds.length > 1) {
    throw new InstaboxApiError('InstaBox 请求体只能使用一种传输方式', {
      status: 500,
      code: 'invalid_request_body',
    });
  }
  const apiKey = options.key ?? await requireInstaboxApiKey();
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
  if (options.rawBody !== undefined || options.streamBody !== undefined) {
    headers['Content-Type'] = options.contentType || 'application/octet-stream';
  } else if (options.body !== undefined) {
    headers['Content-Type'] = options.contentType || 'application/json';
  }
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.confirmDelete) headers['X-Confirm-Delete'] = options.confirmDelete;
  if (options.streamBody !== undefined && Number.isFinite(options.contentLength) && Number(options.contentLength) >= 0) {
    headers['Content-Length'] = String(Math.trunc(Number(options.contentLength)));
  }

  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    const requestInit: Record<string, unknown> = {
      method: options.method ?? 'GET',
      headers,
      body: options.rawBody !== undefined
        ? options.rawBody
        : options.streamBody !== undefined
          ? options.streamBody
          : options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
      signal: controller.signal,
    };
    if (options.streamBody !== undefined) requestInit.duplex = 'half';
    response = await fetch(`${API_BASE_URL}${path}`, requestInit as any);
  } catch (error: any) {
    if (error instanceof InstaboxApiError) throw error;
    if (error?.cause instanceof InstaboxApiError) throw error.cause;
    if (error?.name === 'AbortError') {
      throw new InstaboxApiError(`InstaBox 请求超时（${Math.round(timeoutMs / 1000)}s）`, {
        status: 504,
        code: 'timeout',
        retryable: true,
      });
    }
    throw new InstaboxApiError('无法连接 InstaBox 服务，请检查服务器网络', {
      status: 502,
      code: 'network_error',
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const parsedError = unwrapErrorPayload(payload);
    throw new InstaboxApiError(upstreamErrorMessage(response.status, payload), {
      status: response.status,
      code: parsedError.code,
      requestId: parsedError.requestId,
      retryable: parsedError.retryable,
      retryAfterSeconds: parsedError.retryAfterSeconds,
    });
  }

  return payload as T;
}

export async function validateInstaboxApiKey(raw: unknown): Promise<void> {
  const apiKey = normalizeApiKey(raw);
  await instaboxRequest<Record<string, unknown>>('/v1/orgs', { key: apiKey });
}

export async function saveInstaboxApiKey(raw: unknown): Promise<InstaboxConfigStatus> {
  const apiKey = normalizeApiKey(raw);
  await instaboxRequest<Record<string, unknown>>('/v1/orgs', { key: apiKey });
  const now = new Date().toISOString();
  await writeStoredConfig({
    cipherText: encryptInstaboxSecret(apiKey),
    maskedKey: maskInstaboxApiKey(apiKey),
    updatedAt: now,
    lastVerifiedAt: now,
  });
  return getInstaboxConfigStatus();
}

export async function clearInstaboxApiKey(): Promise<void> {
  await db.delete(schema.settings).where(eq(schema.settings.key, SETTING_KEY)).run();
}

export async function testInstaboxConnection(): Promise<{ verifiedAt: string }> {
  const stored = await readStoredConfig();
  if (!stored) {
    throw new InstaboxApiError('尚未配置 InstaBox API Key', { status: 400, code: 'missing_key' });
  }
  const apiKey = await requireInstaboxApiKey();
  await instaboxRequest<Record<string, unknown>>('/v1/orgs', { key: apiKey });
  const verifiedAt = new Date().toISOString();
  await writeStoredConfig({ ...stored, lastVerifiedAt: verifiedAt });
  return { verifiedAt };
}

export async function listInstaboxMachines(): Promise<{ machines: any[]; nextCursor: string | null }> {
  const machines: any[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_MACHINE_PAGES; page += 1) {
    const params = new URLSearchParams({ limit: '100' });
    if (cursor) params.set('cursor', cursor);
    const payload = await instaboxRequest<{ machines?: any[]; nextCursor?: string | null }>(
      `/v1/machines?${params.toString()}`,
    );
    if (Array.isArray(payload?.machines)) machines.push(...payload.machines);
    cursor = typeof payload?.nextCursor === 'string' && payload.nextCursor ? payload.nextCursor : null;
    if (!cursor) break;
  }
  return { machines, nextCursor: cursor };
}

export async function getInstaboxMachine(id: string): Promise<any> {
  return instaboxRequest(`/v1/machines/${encodeURIComponent(id)}`);
}

function normalizeMachineName(raw: unknown): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new InstaboxApiError('机器名只能包含小写字母、数字和短横线，且不能以短横线开头', {
      status: 400,
      code: 'bad_request',
    });
  }
  return value;
}

export async function createInstaboxMachine(input: {
  name?: unknown;
  templateId?: unknown;
  templateVersion?: unknown;
  desiredState?: unknown;
}): Promise<any> {
  const body: Record<string, unknown> = {};
  const name = normalizeMachineName(input.name);
  if (name) body.name = name;
  const templateId = typeof input.templateId === 'string' ? input.templateId.trim() : '';
  const templateVersion = typeof input.templateVersion === 'string' ? input.templateVersion.trim() : '';
  if (templateId) {
    if (templateId.length > 120 || /\s/.test(templateId)) {
      throw new InstaboxApiError('模板标识不正确', { status: 400, code: 'bad_request' });
    }
    body.templateId = templateId;
  }
  if (templateVersion) {
    if (templateVersion.length > 120 || /\s/.test(templateVersion)) {
      throw new InstaboxApiError('模板版本不正确', { status: 400, code: 'bad_request' });
    }
    body.templateVersion = templateVersion;
  }
  if (input.desiredState === 'running' || input.desiredState === 'stopped') {
    body.desiredState = input.desiredState;
  }
  return instaboxRequest('/v1/machines', {
    method: 'POST',
    body,
    idempotencyKey: randomUUID(),
  });
}

const MACHINE_ACTIONS = new Set(['start', 'stop', 'suspend', 'resume']);

export async function runInstaboxMachineAction(id: string, action: string): Promise<any> {
  const machineId = String(id || '').trim();
  if (!machineId) throw new InstaboxApiError('机器 ID 不能为空', { status: 400, code: 'bad_request' });
  if (!MACHINE_ACTIONS.has(action)) {
    throw new InstaboxApiError('不支持的机器操作', { status: 400, code: 'bad_request' });
  }
  return instaboxRequest(`/v1/machines/${encodeURIComponent(machineId)}/${action}`, {
    method: 'POST',
    body: {},
    idempotencyKey: randomUUID(),
  });
}

export type InstaboxStartAction = 'resume' | 'start' | 'wake' | 'pending' | 'skip';

/**
 * InstaBox 的 /wake 只对「运行中但空闲」的机器有效；suspended 机器直接
 * wake 会返回 `machine_not_running: machine is suspended; start it first`。
 * 所以暂停中的机器必须走 /resume，运行中的机器才走 /wake。
 */
export function resolveInstaboxStartAction(
  machine: { state?: unknown; desiredState?: unknown } | null | undefined,
): InstaboxStartAction {
  const state = String(machine?.state || '');
  const desiredState = String(machine?.desiredState || '');
  if (state === 'suspended') {
    // desiredState=running 说明已经有人/本服务发起过 resume，等待完成即可。
    return desiredState === 'running' ? 'pending' : 'resume';
  }
  if (state === 'starting' || state === 'resuming' || state === 'stopping' || state === 'suspending') {
    return 'pending';
  }
  if (state === 'running') {
    return desiredState === 'suspended' ? 'pending' : 'wake';
  }
  // 客户机自己重启（systemctl reboot）后 InstaBox 会把机器置为 stopped，
  // 但 desiredState 仍是 running。这种情况下窗口内应当自动 start，否则
  // 一次 OS 重启就会让机器整天不再被拉起。用户主动停止时 desiredState
  // 会变成 stopped，仍然保持不动。
  if (state === 'stopped') {
    return desiredState === 'running' ? 'start' : 'skip';
  }
  return 'skip';
}

export async function wakeInstaboxMachine(id: string): Promise<any> {
  const machineId = String(id || '').trim();
  if (!machineId) throw new InstaboxApiError('机器 ID 不能为空', { status: 400, code: 'bad_request' });
  return instaboxRequest(`/v1/machines/${encodeURIComponent(machineId)}/wake`, {
    method: 'POST',
    body: {},
    timeoutMs: 60_000,
  });
}

async function waitForInstaboxOperation(operationId: string, timeoutMs = 120_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let latest: any = null;
  while (Date.now() < deadline) {
    latest = await instaboxRequest(`/v1/operations/${encodeURIComponent(operationId)}`);
    if (latest?.state === 'succeeded') return latest;
    if (latest?.state === 'failed') {
      const message = typeof latest?.error?.message === 'string' ? latest.error.message : '操作失败';
      throw new InstaboxApiError(`InstaBox 操作失败：${message}`, {
        status: 502,
        code: typeof latest?.error?.code === 'string' ? latest.error.code : 'operation_failed',
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new InstaboxApiError('InstaBox 操作等待超时，请稍后刷新查看状态', {
    status: 504,
    code: 'operation_timeout',
    retryable: true,
  });
}

/**
 * InstaBox 没有单独的 restart 接口；官方 CLI 的 restart 也是
 * 「stop → 等操作完成 → start」。这里按同样语义实现，避免前端误以为
 * 只停不启也算重启。
 */
export async function restartInstaboxMachine(id: string): Promise<any> {
  const machineId = String(id || '').trim();
  if (!machineId) throw new InstaboxApiError('机器 ID 不能为空', { status: 400, code: 'bad_request' });
  const stopOperation = await runInstaboxMachineAction(machineId, 'stop');
  if (!stopOperation?.id) {
    throw new InstaboxApiError('InstaBox 未返回停止任务 ID', { status: 502, code: 'missing_operation' });
  }
  await waitForInstaboxOperation(String(stopOperation.id));
  const startOperation = await runInstaboxMachineAction(machineId, 'start');
  return { stop: stopOperation, start: startOperation };
}

export async function deleteInstaboxMachine(id: string): Promise<any> {
  const machineId = String(id || '').trim();
  if (!machineId) throw new InstaboxApiError('机器 ID 不能为空', { status: 400, code: 'bad_request' });
  return instaboxRequest(`/v1/machines/${encodeURIComponent(machineId)}`, {
    method: 'DELETE',
    idempotencyKey: randomUUID(),
    confirmDelete: machineId,
  });
}

function normalizeInstaboxMachineId(id: string): string {
  const machineId = String(id || '').trim();
  if (!machineId) throw new InstaboxApiError('机器 ID 不能为空', { status: 400, code: 'bad_request' });
  return machineId;
}

export async function createInstaboxSshToken(
  id: string,
  input: { name?: string; ttlSeconds?: number } = {},
): Promise<InstaboxSshToken> {
  const machineId = normalizeInstaboxMachineId(id);
  const ttlSeconds = Math.trunc(Number(input.ttlSeconds ?? 30 * 24 * 60 * 60));
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 30 * 24 * 60 * 60) {
    throw new InstaboxApiError('SSH token 有效期必须在 60 秒到 30 天之间', {
      status: 400,
      code: 'bad_request',
    });
  }
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const payload = await instaboxRequest<InstaboxSshToken>(
    `/v1/machines/${encodeURIComponent(machineId)}/ssh-tokens`,
    {
      method: 'POST',
      body: {
        ...(name ? { name: name.slice(0, 100) } : {}),
        ttlSeconds,
      },
    },
  );
  if (
    !payload
    || typeof payload.token !== 'string'
    || !/^ibssh_[A-Za-z0-9_-]+$/.test(payload.token)
    || typeof payload.id !== 'string'
    || !payload.id
    || typeof payload.host !== 'string'
    || !/^[A-Za-z0-9.[\]:-]+$/.test(payload.host)
    || !Number.isInteger(Number(payload.port))
    || Number(payload.port) < 1
    || Number(payload.port) > 65535
  ) {
    throw new InstaboxApiError('InstaBox 返回的 SSH token 数据不完整', {
      status: 502,
      code: 'invalid_ssh_token_response',
    });
  }
  return payload;
}

export async function listInstaboxSshTokens(id: string): Promise<InstaboxSshTokenMetadata[]> {
  const machineId = normalizeInstaboxMachineId(id);
  const payload = await instaboxRequest<{ tokens?: InstaboxSshTokenMetadata[] }>(
    `/v1/machines/${encodeURIComponent(machineId)}/ssh-tokens`,
  );
  return Array.isArray(payload?.tokens) ? payload.tokens : [];
}

export async function revokeInstaboxSshToken(id: string, tokenId: string): Promise<void> {
  const machineId = normalizeInstaboxMachineId(id);
  const normalizedTokenId = String(tokenId || '').trim();
  if (!normalizedTokenId) {
    throw new InstaboxApiError('SSH token ID 不能为空', { status: 400, code: 'bad_request' });
  }
  await instaboxRequest(
    `/v1/machines/${encodeURIComponent(machineId)}/ssh-tokens/${encodeURIComponent(normalizedTokenId)}`,
    { method: 'DELETE' },
  );
}

/**
 * 文件上传只允许写入持久化数据盘。拒绝目录穿越、控制字符和空文件名，
 * 避免前端参数被拼成机器上的任意路径。
 */
/**
 * 去掉路径两端误带进来的引号。
 *
 * 双引号逐个剥（`"a.jar`、`a.jar"` 都见过）；单引号只在成对时剥，
 * 因为文件名里合法地存在撇号（`my app's.jar`），不能当引号处理。
 */
function stripBoundaryQuotes(value: string): string {
  let next = value.trim().replace(/^"+|"+$/g, '').trim();
  if (next.length >= 2 && next.startsWith("'") && next.endsWith("'")) {
    next = next.slice(1, -1).trim();
  }
  return next;
}

export function normalizeInstaboxUploadPath(raw: unknown): string {
  let value = typeof raw === 'string' ? raw.trim() : '';
  // 从资源管理器/网页复制路径时常常把外层引号一起带进来。保留它会把
  // `"` 编码成 %22 拼到文件名末尾，上传成功但落盘名字是错的，随后的
  // java -jar 自然找不到文件，所以这里先剥掉成对的引号。
  value = stripBoundaryQuotes(value);
  if (!value || value.length > 1_024) {
    throw new InstaboxApiError('上传路径不能为空且不能超过 1024 个字符', {
      status: 400,
      code: 'invalid_upload_path',
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new InstaboxApiError('上传路径不能包含控制字符', { status: 400, code: 'invalid_upload_path' });
  }
  if (value.includes('"')) {
    throw new InstaboxApiError('上传路径不能包含双引号', { status: 400, code: 'invalid_upload_path' });
  }
  if (!value.startsWith('/data/') || value === '/data/' || value.endsWith('/')) {
    throw new InstaboxApiError('文件只能上传到 /data/ 下的完整文件路径', {
      status: 400,
      code: 'invalid_upload_path',
    });
  }
  const segments = value.split('/').slice(1);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new InstaboxApiError('上传路径不能包含空目录、. 或 ..', {
      status: 400,
      code: 'invalid_upload_path',
    });
  }
  return value;
}

function normalizeInstaboxLocalFilePath(raw: unknown): string {
  let value = typeof raw === 'string' ? raw.trim() : '';
  value = stripBoundaryQuotes(value);
  if (value.startsWith('@')) value = value.slice(1).trim();
  if (!value || value.length > 4_096) {
    throw new InstaboxApiError('本地文件路径不能为空且不能超过 4096 个字符', {
      status: 400,
      code: 'invalid_local_path',
    });
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new InstaboxApiError('本地文件路径不能包含换行或控制字符', {
      status: 400,
      code: 'invalid_local_path',
    });
  }
  if (value.includes('"')) {
    throw new InstaboxApiError('本地文件路径不能包含双引号', {
      status: 400,
      code: 'invalid_local_path',
    });
  }
  if (/[\\/]$/.test(value) || /^[A-Za-z]:$/.test(value)) {
    throw new InstaboxApiError('本地文件路径必须指向具体文件', {
      status: 400,
      code: 'invalid_local_path',
    });
  }
  const fileName = value.split(/[\\/]/).pop() || '';
  if (!fileName) {
    throw new InstaboxApiError('无法从本地路径识别文件名', {
      status: 400,
      code: 'invalid_local_path',
    });
  }
  return value;
}

/**
 * 用双引号包裹参数，把内嵌的 `"` 转义成 `\"`。
 *
 * 单引号在 PowerShell 里才是字面量，在 CMD 里却是普通字符——之前生成的命令
 * 就是这样：粘到 CMD 后引号被当成参数的一部分，`&parents=true` 被 CMD 当成
 * 命令分隔符执行，于是报「'parents' 不是内部或外部命令」和 URL 端口非法。
 * 双引号在两种 shell 里都能正确分组，是唯一能同时兼容的写法。
 */
function quoteCommandArg(value: string): string {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * 生成一行可直接粘贴到 CMD 或 PowerShell 的上传命令。使用 curl.exe，避免
 * PowerShell 把 curl 解析成 Invoke-WebRequest。
 */
export function buildInstaboxUploadCommand(input: {
  machineId: string;
  apiKey: string;
  path?: unknown;
  localPath?: unknown;
}): { command: string; path: string; localPath: string } {
  const machineId = normalizeInstaboxMachineId(input.machineId);
  const apiKey = normalizeApiKey(input.apiKey);
  const localPath = normalizeInstaboxLocalFilePath(input.localPath);
  const remotePath = typeof input.path === 'string' ? input.path.trim() : '';
  const fileName = localPath.split(/[\\/]/).pop() || '';
  const path = normalizeInstaboxUploadPath(remotePath || `/data/home/jar/${fileName}`);
  const encodedPath = encodeURIComponent(path).replace(/'/g, '%27');
  const query = `path=${encodedPath}&parents=true&overwrite=true&mode=0644`;
  const url = `${API_BASE_URL}/v1/machines/${encodeURIComponent(machineId)}/files?${query}`;
  const command = [
    'curl.exe -X PUT',
    quoteCommandArg(url),
    '-H',
    quoteCommandArg(`Authorization: Bearer ${apiKey}`),
    '-H',
    quoteCommandArg('Content-Type: application/octet-stream'),
    '--data-binary',
    quoteCommandArg(`@${localPath}`),
    '-w',
    quoteCommandArg('\\nHTTP %{http_code}\\n'),
  ].join(' ');
  return { command, path, localPath };
}

export async function createInstaboxUploadCommand(
  id: string,
  input: { path?: unknown; localPath?: unknown },
): Promise<{ command: string; path: string; localPath: string }> {
  const apiKey = await requireInstaboxApiKey();
  return buildInstaboxUploadCommand({
    machineId: id,
    apiKey,
    path: input.path,
    localPath: input.localPath,
  });
}

async function getInstaboxFileEntry(id: string, path: string): Promise<any | null> {
  const machineId = normalizeInstaboxMachineId(id);
  const params = new URLSearchParams({ path });
  try {
    return await instaboxRequest(
      `/v1/machines/${encodeURIComponent(machineId)}/files?${params.toString()}`,
    );
  } catch (error) {
    if (error instanceof InstaboxApiError && error.status === 404) return null;
    throw error;
  }
}

async function prepareInstaboxUpload(
  id: string,
  input: { path?: unknown; overwrite?: boolean; mode?: unknown },
): Promise<{
  machineId: string;
  path: string;
  existing: any | null;
  mode: string;
  params: URLSearchParams;
}> {
  const machineId = normalizeInstaboxMachineId(id);
  const path = normalizeInstaboxUploadPath(input.path);
  const existing = await getInstaboxFileEntry(machineId, path);
  if (existing && existing.type === 'dir') {
    throw new InstaboxApiError('目标路径是一个目录，不能覆盖为文件', {
      status: 409,
      code: 'upload_path_is_directory',
    });
  }
  if (existing && input.overwrite !== true) {
    throw new InstaboxApiError('目标文件已存在；确认覆盖后请携带 overwrite=true 重试', {
      status: 409,
      code: 'upload_overwrite_required',
    });
  }
  const mode = typeof input.mode === 'string' && /^0?[0-7]{3,4}$/.test(input.mode.trim())
    ? input.mode.trim()
    : '';
  const params = new URLSearchParams({ path, parents: 'true' });
  if (mode) params.set('mode', mode);
  return { machineId, path, existing, mode, params };
}

function uploadTooLargeError(): InstaboxApiError {
  return new InstaboxApiError(`单个上传文件不能超过 ${INSTABOX_UPLOAD_MAX_LABEL}`, {
    status: 413,
    code: 'upload_too_large',
  });
}

/**
 * 流式上传时无法依赖 Content-Length，必须边传边计数；超过上限立即终止，
 * 避免恶意请求把服务器连接和上游配额一直占住。
 */
export function createInstaboxLimitedUploadStream(
  source: Readable,
  maxBytes = INSTABOX_UPLOAD_MAX_BYTES,
): { stream: Transform; bytesWritten: () => number } {
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(uploadTooLargeError());
        return;
      }
      callback(null, chunk);
    },
    flush(callback) {
      if (total === 0) {
        callback(new InstaboxApiError('上传文件不能为空', { status: 400, code: 'empty_upload' }));
        return;
      }
      callback();
    },
  });
  limiter.once('error', () => {
    if (!source.destroyed) source.destroy();
  });
  return { stream: source.pipe(limiter), bytesWritten: () => total };
}

export async function uploadInstaboxFileStream(
  id: string,
  input: {
    path?: unknown;
    stream: Readable;
    contentLength?: number;
    overwrite?: boolean;
    mode?: unknown;
  },
): Promise<InstaboxFileUploadResult> {
  if (Number.isFinite(input.contentLength) && Number(input.contentLength) > INSTABOX_UPLOAD_MAX_BYTES) {
    throw uploadTooLargeError();
  }
  if (Number.isFinite(input.contentLength) && Number(input.contentLength) === 0) {
    throw new InstaboxApiError('上传文件不能为空', { status: 400, code: 'empty_upload' });
  }

  const { machineId, path, existing, mode, params } = await prepareInstaboxUpload(id, input);
  const limited = createInstaboxLimitedUploadStream(input.stream);
  const payload = await instaboxRequest<{
    path?: string;
    size?: number;
    sha256?: string;
    mode?: string;
    created?: boolean;
  }>(`/v1/machines/${encodeURIComponent(machineId)}/files?${params.toString()}`, {
    method: 'PUT',
    streamBody: limited.stream,
    contentLength: Number.isFinite(input.contentLength) ? Number(input.contentLength) : undefined,
    contentType: 'application/octet-stream',
    timeoutMs: 30 * 60_000,
  });

  return {
    path: typeof payload?.path === 'string' ? payload.path : path,
    size: Number.isFinite(Number(payload?.size)) ? Number(payload.size) : limited.bytesWritten(),
    sha256: typeof payload?.sha256 === 'string' ? payload.sha256 : '',
    mode: typeof payload?.mode === 'string' ? payload.mode : mode || '0644',
    created: payload?.created !== false,
    replaced: payload?.created === false || Boolean(existing),
  };
}

export async function uploadInstaboxFile(
  id: string,
  input: {
    path?: unknown;
    data?: Buffer | Uint8Array;
    overwrite?: boolean;
    mode?: unknown;
  },
): Promise<InstaboxFileUploadResult> {
  const data = input.data;
  if (!data || data.length === 0) {
    throw new InstaboxApiError('上传文件不能为空', { status: 400, code: 'empty_upload' });
  }
  if (data.length > INSTABOX_UPLOAD_MAX_BYTES) {
    throw uploadTooLargeError();
  }
  const { machineId, path, existing, mode, params } = await prepareInstaboxUpload(id, input);
  const payload = await instaboxRequest<{
    path?: string;
    size?: number;
    sha256?: string;
    mode?: string;
    created?: boolean;
  }>(`/v1/machines/${encodeURIComponent(machineId)}/files?${params.toString()}`, {
    method: 'PUT',
    rawBody: data,
    contentType: 'application/octet-stream',
    timeoutMs: 180_000,
  });

  return {
    path: typeof payload?.path === 'string' ? payload.path : path,
    size: Number.isFinite(Number(payload?.size)) ? Number(payload.size) : data.length,
    sha256: typeof payload?.sha256 === 'string' ? payload.sha256 : '',
    mode: typeof payload?.mode === 'string' ? payload.mode : mode || '0644',
    created: payload?.created !== false,
    replaced: payload?.created === false || Boolean(existing),
  };
}

export async function listInstaboxPorts(id: string): Promise<{ enabled: boolean; ports: any[] }> {
  const payload = await instaboxRequest<{ enabled?: boolean; ports?: any[] }>(
    `/v1/machines/${encodeURIComponent(id)}/ports`,
  );
  return {
    enabled: payload?.enabled === true,
    ports: Array.isArray(payload?.ports) ? payload.ports : [],
  };
}

export async function publishInstaboxPort(id: string, input: {
  port?: unknown;
  name?: unknown;
  access?: unknown;
  protocol?: unknown;
}): Promise<any> {
  const port = Math.trunc(Number(input.port));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new InstaboxApiError('端口必须是 1024 到 65535 之间的整数', { status: 400, code: 'bad_request' });
  }
  const body: Record<string, unknown> = { port };
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name) {
    if (name.length > 100) {
      throw new InstaboxApiError('端口名称不能超过 100 个字符', { status: 400, code: 'bad_request' });
    }
    body.name = name;
  }
  if (input.access === 'public' || input.access === 'private') body.access = input.access;
  if (input.protocol === 'http' || input.protocol === 'tcp') body.protocol = input.protocol;
  return instaboxRequest(`/v1/machines/${encodeURIComponent(id)}/ports`, { method: 'POST', body });
}

export async function unpublishInstaboxPort(id: string, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InstaboxApiError('端口不正确', { status: 400, code: 'bad_request' });
  }
  await instaboxRequest(`/v1/machines/${encodeURIComponent(id)}/ports/${port}`, { method: 'DELETE' });
}

export async function getInstaboxUsage(): Promise<any> {
  return instaboxRequest('/v1/usage');
}

export async function listInstaboxOrgs(): Promise<any[]> {
  const payload = await instaboxRequest<{ orgs?: any[] }>('/v1/orgs');
  return Array.isArray(payload?.orgs) ? payload.orgs : [];
}

export async function listInstaboxTemplates(): Promise<any[]> {
  const payload = await instaboxRequest<{ templates?: any[] }>('/v1/templates');
  return Array.isArray(payload?.templates) ? payload.templates : [];
}

export async function getInstaboxOverview(): Promise<{
  config: InstaboxConfigStatus;
  machines: any[];
  usage: any;
  templates: any[];
  org: any;
}> {
  const config = await getInstaboxConfigStatus();
  if (!config.configured) {
    return { config, machines: [], usage: null, templates: [], org: null };
  }
  const [machinePage, usage, templates, orgs] = await Promise.all([
    listInstaboxMachines(),
    getInstaboxUsage(),
    listInstaboxTemplates().catch(() => []),
    listInstaboxOrgs(),
  ]);
  return {
    config,
    machines: machinePage.machines,
    usage,
    templates,
    org: orgs.find((item: any) => item?.personal === true) ?? orgs[0] ?? null,
  };
}
