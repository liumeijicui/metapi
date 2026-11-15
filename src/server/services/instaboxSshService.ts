import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import {
  InstaboxApiError,
  createInstaboxSshToken,
  decryptInstaboxSecret,
  encryptInstaboxSecret,
  getInstaboxConfigStatus,
  listInstaboxMachines,
  listInstaboxSshTokens,
} from './instaboxService.js';

export const INSTABOX_SSH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const INSTABOX_SSH_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1_000;
export const INSTABOX_SSH_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

const SETTING_KEY = 'instabox_ssh_tokens_v1';
const STATE_VERSION = 1;
const TOKEN_NAME = 'metapi-auto';

type StoredSshToken = {
  tokenCipher: string;
  tokenId: string;
  name: string;
  host: string;
  port: number;
  expiresAt: string;
  createdAt: string;
  hostKeyFingerprint?: string;
};

type StoredSshState = {
  version: 1;
  machines: Record<string, StoredSshToken>;
  updatedAt: string;
  lastCheckAt?: string;
};

export type InstaboxSshAccessStatus = {
  machineId: string;
  available: boolean;
  command: string | null;
  expiresAt: string | null;
  remainingSeconds: number | null;
  expiringSoon: boolean;
  autoRenew: boolean;
  renewed: boolean;
  warning: string | null;
};

export type InstaboxSshSchedulerStatus = {
  running: boolean;
  checking: boolean;
  intervalMinutes: number;
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  machineCount: number;
};

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerReady = false;
let tickInFlight = false;
let lastCheckAtIso: string | null = null;
let lastSuccessAtIso: string | null = null;
let lastError: string | null = null;
let lastMachineCount = 0;

const machineQueues = new Map<string, Promise<unknown>>();
let stateWriteTail: Promise<void> = Promise.resolve();

function emptyState(): StoredSshState {
  return { version: STATE_VERSION, machines: {}, updatedAt: new Date(0).toISOString() };
}

function normalizeMachineId(id: string): string {
  const value = String(id || '').trim();
  if (!value) throw new InstaboxApiError('机器 ID 不能为空', { status: 400, code: 'bad_request' });
  return value;
}

function parseStoredToken(raw: unknown): StoredSshToken | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<StoredSshToken>;
  if (
    typeof value.tokenCipher !== 'string'
    || !value.tokenCipher
    || typeof value.tokenId !== 'string'
    || !value.tokenId
    || typeof value.host !== 'string'
    || !value.host
    || !Number.isInteger(Number(value.port))
    || Number(value.port) < 1
    || Number(value.port) > 65535
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  return {
    tokenCipher: value.tokenCipher,
    tokenId: value.tokenId,
    name: typeof value.name === 'string' ? value.name : TOKEN_NAME,
    host: value.host,
    port: Number(value.port),
    expiresAt: value.expiresAt,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    hostKeyFingerprint: typeof value.hostKeyFingerprint === 'string' ? value.hostKeyFingerprint : undefined,
  };
}

async function readStoredState(): Promise<StoredSshState> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, SETTING_KEY))
    .get();
  if (!row?.value) return emptyState();
  try {
    const parsed = JSON.parse(String(row.value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyState();
    const machines: Record<string, StoredSshToken> = {};
    const source = parsed.machines && typeof parsed.machines === 'object' && !Array.isArray(parsed.machines)
      ? parsed.machines as Record<string, unknown>
      : {};
    for (const [machineId, raw] of Object.entries(source)) {
      const token = parseStoredToken(raw);
      if (token) machines[machineId] = token;
    }
    return {
      version: STATE_VERSION,
      machines,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
      lastCheckAt: typeof parsed.lastCheckAt === 'string' ? parsed.lastCheckAt : undefined,
    };
  } catch {
    return emptyState();
  }
}

function withMachineLock<T>(machineId: string, task: () => Promise<T>): Promise<T> {
  const previous = machineQueues.get(machineId) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.then(() => undefined, () => undefined);
  machineQueues.set(machineId, tail);
  void tail.finally(() => {
    if (machineQueues.get(machineId) === tail) machineQueues.delete(machineId);
  });
  return run;
}

function withStateWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = stateWriteTail.then(task, task);
  stateWriteTail = run.then(() => undefined, () => undefined);
  return run;
}

async function persistToken(machineId: string, token: StoredSshToken | null): Promise<void> {
  await withStateWriteLock(async () => {
    const state = await readStoredState();
    if (token) state.machines[machineId] = token;
    else delete state.machines[machineId];
    state.updatedAt = new Date().toISOString();
    await upsertSetting(SETTING_KEY, state);
  });
}

async function persistCheckTimestamp(): Promise<void> {
  await withStateWriteLock(async () => {
    const state = await readStoredState();
    state.lastCheckAt = new Date().toISOString();
    state.updatedAt = state.lastCheckAt;
    await upsertSetting(SETTING_KEY, state);
  });
}

export function buildInstaboxSshCommand(token: string, host: string, port: number): string {
  return `ssh -p ${port} ${token}@${host}`;
}

export function isInstaboxSshTokenExpiring(expiresAt: string, now = Date.now()): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - now <= INSTABOX_SSH_RENEW_BEFORE_MS;
}

function statusFromStored(
  machineId: string,
  stored: StoredSshToken,
  input: { renewed?: boolean; warning?: string | null; now?: number } = {},
): InstaboxSshAccessStatus {
  const now = input.now ?? Date.now();
  const token = decryptInstaboxSecret(stored.tokenCipher);
  const expiresAtMs = Date.parse(stored.expiresAt);
  const usable = Boolean(token) && Number.isFinite(expiresAtMs) && expiresAtMs > now;
  return {
    machineId,
    available: usable,
    command: token && usable ? buildInstaboxSshCommand(token, stored.host, stored.port) : null,
    expiresAt: stored.expiresAt,
    remainingSeconds: Number.isFinite(expiresAtMs) ? Math.max(0, Math.floor((expiresAtMs - now) / 1_000)) : null,
    expiringSoon: isInstaboxSshTokenExpiring(stored.expiresAt, now),
    autoRenew: true,
    renewed: input.renewed === true,
    warning: input.warning ?? null,
  };
}

function tokenNeedsReplacement(stored: StoredSshToken | null, now = Date.now()): boolean {
  if (!stored) return true;
  const token = decryptInstaboxSecret(stored.tokenCipher);
  if (!token) return true;
  const expiresAtMs = Date.parse(stored.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return true;
  return isInstaboxSshTokenExpiring(stored.expiresAt, now);
}

async function createAndStoreToken(machineId: string, now: number): Promise<StoredSshToken> {
  const created = await createInstaboxSshToken(machineId, {
    name: TOKEN_NAME,
    ttlSeconds: INSTABOX_SSH_TOKEN_TTL_SECONDS,
  });
  const expiresAtMs = Date.parse(created.expiresAt);
  const expiresAt = Number.isFinite(expiresAtMs)
    ? new Date(expiresAtMs).toISOString()
    : new Date(now + INSTABOX_SSH_TOKEN_TTL_SECONDS * 1_000).toISOString();
  const stored: StoredSshToken = {
    tokenCipher: encryptInstaboxSecret(created.token),
    tokenId: created.id,
    name: created.name || TOKEN_NAME,
    host: created.host,
    port: Number(created.port),
    expiresAt,
    createdAt: new Date(now).toISOString(),
    hostKeyFingerprint: created.hostKeyFingerprint,
  };
  await persistToken(machineId, stored);
  return stored;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveSshAccess(
  id: string,
  options: { verify?: boolean; force?: boolean },
): Promise<InstaboxSshAccessStatus> {
  const machineId = normalizeMachineId(id);
  const now = Date.now();
  const state = await readStoredState();
  let stored = state.machines[machineId] ?? null;
  let warning: string | null = null;
  let renewed = false;

  if (options.force || tokenNeedsReplacement(stored, now)) {
    try {
      stored = await createAndStoreToken(machineId, now);
      renewed = true;
    } catch (error) {
      if (!stored || options.force) throw error;
      warning = `自动续期失败：${errorMessage(error)}`;
    }
  } else if (options.verify && stored) {
    let tokens: Awaited<ReturnType<typeof listInstaboxSshTokens>> | null = null;
    try {
      tokens = await listInstaboxSshTokens(machineId);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('API Key')) warning = `无法向 InstaBox 校验 token：${message}`;
      else warning = `token 校验失败，继续使用本地有效凭证：${message}`;
    }

    if (tokens) {
      const remote = tokens.find((token) => token.id === stored!.tokenId);
      if (!remote) {
        stored = await createAndStoreToken(machineId, now);
        renewed = true;
      } else {
        const remoteExpiresAt = Date.parse(remote.expiresAt);
        if (Number.isFinite(remoteExpiresAt)) {
          const nextExpiresAt = new Date(remoteExpiresAt).toISOString();
          if (nextExpiresAt !== stored.expiresAt) {
            stored = { ...stored, expiresAt: nextExpiresAt };
            await persistToken(machineId, stored);
          }
          if (isInstaboxSshTokenExpiring(nextExpiresAt, now)) {
            try {
              stored = await createAndStoreToken(machineId, now);
              renewed = true;
            } catch (error) {
              warning = `自动续期失败：${errorMessage(error)}`;
            }
          }
        }
      }
    }
  }

  if (!stored) {
    throw new InstaboxApiError('无法生成可用的 SSH 连接', {
      status: 502,
      code: 'ssh_token_unavailable',
    });
  }
  return statusFromStored(machineId, stored, { renewed, warning, now });
}

export async function getInstaboxSshAccess(
  id: string,
  options: { verify?: boolean; force?: boolean } = {},
): Promise<InstaboxSshAccessStatus> {
  const machineId = normalizeMachineId(id);
  return withMachineLock(machineId, () => resolveSshAccess(machineId, options));
}

async function tick(): Promise<void> {
  if (!schedulerReady || tickInFlight) return;
  tickInFlight = true;
  lastCheckAtIso = new Date().toISOString();
  try {
    const config = await getInstaboxConfigStatus();
    if (!config.configured || !config.keyReadable) {
      lastError = null;
      lastMachineCount = 0;
      return;
    }

    const result = await listInstaboxMachines();
    const machines = (Array.isArray(result.machines) ? result.machines : [])
      .filter((machine: any) => machine?.id && machine.state !== 'deleted' && machine.state !== 'deleting');
    lastMachineCount = machines.length;

    // 单线程顺序处理，避免页面、定时任务同时创建 token，也避免瞬间打满上游配额。
    for (const machine of machines) {
      try {
        await getInstaboxSshAccess(String(machine.id), { verify: true });
      } catch (error) {
        lastError = `${machine.name || machine.id}：${errorMessage(error)}`;
      }
    }
    lastSuccessAtIso = new Date().toISOString();
    await persistCheckTimestamp();
  } catch (error) {
    lastError = errorMessage(error);
  } finally {
    tickInFlight = false;
  }
}

export function getInstaboxSshSchedulerStatus(): InstaboxSshSchedulerStatus {
  return {
    running: Boolean(schedulerTimer),
    checking: tickInFlight,
    intervalMinutes: Math.round(INSTABOX_SSH_CHECK_INTERVAL_MS / 60_000),
    lastCheckAt: lastCheckAtIso,
    lastSuccessAt: lastSuccessAtIso,
    lastError,
    machineCount: lastMachineCount,
  };
}

export function startInstaboxSshScheduler(): void {
  stopInstaboxSshScheduler();
  schedulerReady = true;
  void tick();
  schedulerTimer = setInterval(() => { void tick(); }, INSTABOX_SSH_CHECK_INTERVAL_MS);
  schedulerTimer.unref?.();
}

export function stopInstaboxSshScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerReady = false;
}

export function resetInstaboxSshStateForTests(): void {
  stopInstaboxSshScheduler();
  tickInFlight = false;
  lastCheckAtIso = null;
  lastSuccessAtIso = null;
  lastError = null;
  lastMachineCount = 0;
  machineQueues.clear();
  stateWriteTail = Promise.resolve();
}
