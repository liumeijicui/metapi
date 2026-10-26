import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { getOauthInfoFromAccount } from './oauth/oauthAccount.js';
import { db, schema } from '../db/index.js';
import { and, asc, eq } from 'drizzle-orm';
import { isReadyAccountToken } from './accountTokenService.js';

/** 执行系统命令，不经过 shell，避免模型名或路径进入命令解释器。 */
const execFileAsync = promisify(execFile);

/** 同步成功后返回给管理页面的脱敏信息。 */
export type CodexConfigSyncResult = {
  user: string;
  model: string;
  provider: string;
  baseUrl: string;
  configPath: string;
  backupPath: string | null;
  codexVersion: string | null;
};

type SyncInput = {
  siteId: number;
  accountId: number;
  tokenId?: number | null;
  model: string;
};

type Credential = {
  site: typeof schema.sites.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  token: typeof schema.accountTokens.$inferSelect | null;
  apiKey: string;
};

/** 可读的业务错误：路由会把 message 原样返回，不能把密钥写进去。 */
export class CodexConfigSyncError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'CodexConfigSyncError';
  }
}

function validateModelName(value: string): string {
  const model = String(value || '').trim();
  if (!model) throw new CodexConfigSyncError('model 不能为空');
  // TOML 基本字符串里只保留常规模型名，避免注入额外配置行。
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new CodexConfigSyncError('模型名包含不支持的字符');
  }
  return model;
}

function validateBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new CodexConfigSyncError('站点地址不是合法 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CodexConfigSyncError('站点地址只支持 http/https');
  }
  parsed.search = '';
  parsed.hash = '';
  const path = parsed.pathname.replace(/\/+$/, '');
  const base = `${parsed.origin}${path === '/' ? '' : path}`;
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function quoteToml(value: string): string {
  return `"${escapeTomlString(value)}"`;
}

/** 保留现有配置里的其他设置，只替换顶层 provider/model 和指定 provider 段。 */
export function mergeCodexConfig(input: {
  existing: string;
  model: string;
  provider: string;
  providerName: string;
  baseUrl: string;
}): string {
  const kept: string[] = [];
  let section = '';
  for (const line of input.existing.split(/\r?\n/)) {
    const match = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (match) section = match[1].trim();
    if (!section && /^\s*(model_provider|model)\s*=/.test(line)) continue;
    if (section === `model_providers.${input.provider}`) continue;
    kept.push(line);
  }

  const rest = kept.join('\n').replace(/^\s*\n+|\n+$/g, '');
  const header = [
    `model_provider = ${quoteToml(input.provider)}`,
    `model = ${quoteToml(input.model)}`,
  ].join('\n');
  const providerSection = [
    `[model_providers.${input.provider}]`,
    `name = ${quoteToml(input.providerName)}`,
    `base_url = ${quoteToml(input.baseUrl)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
  ].join('\n');
  // TOML 要求顶层键先于任何表头；已有文件的顶层键里如果没有空行，要主动补一个。
  return `${header}\n${rest ? `\n${rest}\n\n` : '\n'}${providerSection}\n`;
}

/** 读取该站点和模型实际要用的原站凭据，优先级与模型监控对话一致。 */
async function resolveCredential(input: SyncInput): Promise<Credential> {
  const site = await db.select().from(schema.sites)
    .where(eq(schema.sites.id, Math.trunc(input.siteId))).get();
  if (!site) throw new CodexConfigSyncError('站点不存在', 404);
  const account = await db.select().from(schema.accounts)
    .where(and(eq(schema.accounts.id, Math.trunc(input.accountId)), eq(schema.accounts.siteId, site.id))).get();
  if (!account) throw new CodexConfigSyncError('账号不存在或不属于该站点', 404);

  const requestedTokenId = input.tokenId == null ? null : Math.trunc(input.tokenId);
  if (requestedTokenId !== null) {
    const token = await db.select().from(schema.accountTokens)
      .where(eq(schema.accountTokens.id, requestedTokenId)).get();
    if (!token || token.accountId !== account.id || !isReadyAccountToken(token)) {
      throw new CodexConfigSyncError('所选 sk- 密钥不可用');
    }
    const apiKey = String(token.token || '').trim();
    if (!apiKey) throw new CodexConfigSyncError('所选 sk- 密钥为空');
    return { site, account, token, apiKey };
  }

  // 不指定令牌时按模型监控原有规则，优先账号下第一条可用的 sk- 令牌。
  const tokens = await db.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, account.id),
      eq(schema.accountTokens.enabled, true),
    ))
    .orderBy(asc(schema.accountTokens.id)).all();
  const token = tokens.find((item) => isReadyAccountToken(item) && String(item.token || '').trim()) || null;
  if (token) return { site, account, token, apiKey: String(token.token || '').trim() };

  const oauth = getOauthInfoFromAccount(account);
  const apiKey = String((oauth ? account.accessToken : account.apiToken || account.accessToken) || '').trim();
  if (!apiKey) throw new CodexConfigSyncError('该账号没有可用于直连的凭据');
  return { site, account, token: null, apiKey };
}

function resolveCodexHome(user: string): string {
  const username = String(user || '').trim();
  if (!username || !/^[a-z_][a-z0-9_-]*$/i.test(username)) {
    throw new CodexConfigSyncError('CODEX_CONFIG_SYNC_USER 配置不合法', 503);
  }
  return `/home/${username}/.codex`;
}

/** 服务以 app 用户原子写入后，给目标用户保留读写权限。 */
async function grantFileAccess(path: string, user: string, permissions = 'rw'): Promise<void> {
  // 临时文件由当前进程创建；即使不是 root，文件所有者也能补 ACL。
  // 目标目录的访问权限由部署时预置的 ACL 提供，这里不扩大用户主目录权限。
  await execFileAsync('setfacl', ['-m', `u:${user}:${permissions}`, path]);
}

/** 原子写文件：同目录临时文件 + rename，失败时保留原文件。 */
async function atomicWrite(path: string, content: string, mode: number, targetUser: string): Promise<void> {
  const tempPath = join(dirname(path), `.${path.split('/').pop()}.tmp-${randomUUID()}`);
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode });
    await grantFileAccess(tempPath, targetUser);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 把 config.toml 中 provider、模型与 auth.json 密钥同步到目标用户的 Codex。 */
export async function syncCodexDirectConfig(input: SyncInput): Promise<CodexConfigSyncResult> {
  const model = validateModelName(input.model);
  const user = String(config.codexConfigSyncUser || '').trim();
  if (!user) throw new CodexConfigSyncError('服务器未启用 Codex 配置同步', 503);
  const codexHome = resolveCodexHome(user);
  const configPath = join(codexHome, 'config.toml');
  const authPath = join(codexHome, 'auth.json');
  try {
    await access(codexHome, constants.R_OK | constants.W_OK);
    await access(configPath, constants.R_OK | constants.W_OK);
    await access(authPath, constants.R_OK | constants.W_OK);
  } catch {
    throw new CodexConfigSyncError(`当前进程无权修改 ${user} 的 Codex 配置`, 503);
  }

  const credential = await resolveCredential(input);
  const baseUrl = validateBaseUrl(credential.site.url);
  const providerName = 'custom';
  const existingConfig = await readFile(configPath, 'utf8').catch(() => '');
  const configText = mergeCodexConfig({
    existing: existingConfig,
    model,
    provider: providerName,
    providerName: `${credential.site.name || 'Direct Site'} · ${model}`,
    baseUrl,
  });

  let existingAuth: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(authPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existingAuth = parsed as Record<string, unknown>;
    }
  } catch {
    existingAuth = {};
  }
  const authText = `${JSON.stringify({ ...existingAuth, OPENAI_API_KEY: credential.apiKey }, null, 2)}\n`;

  const backupDir = join(codexHome, 'backups');
  await mkdir(backupDir, { recursive: true, mode: 0o770 });
  // mkdir 的 mode 会受 umask 影响；目录由当前进程创建时显式补回组权限。
  await chmod(backupDir, 0o770).catch(() => undefined);
  await grantFileAccess(backupDir, user, 'rwx');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, `config-before-direct-sync-${stamp}.toml`);
  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  await grantFileAccess(backupPath, user);

  try {
    await atomicWrite(configPath, configText, 0o660, user);
    await atomicWrite(authPath, authText, 0o660, user);
  } catch (error) {
    throw new CodexConfigSyncError(`写入 Codex 配置失败：${error instanceof Error ? error.message : '未知错误'}`, 500);
  }

  let codexVersion: string | null = null;
  try {
    const result = await execFileAsync('su', ['-', user, '-c', 'codex --version']);
    codexVersion = String(result.stdout || '').trim() || null;
  } catch {
    // 版本探测失败不影响已完成的配置写入，但页面会显示未验证。
  }

  return {
    user,
    model,
    provider: providerName,
    baseUrl,
    configPath,
    backupPath,
    codexVersion,
  };
}
