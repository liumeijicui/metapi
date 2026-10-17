import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { appendSessionTokenRebindHint } from './alertRules.js';
import { classifyFailureReason } from './failureReasonService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';

/**
 * Reads a dead credential's failure into the sentence worth showing.
 *
 * Most failures that end with a dead credential are not expiries at all: a
 * session cap refuses an otherwise correct password, a site returns 5xx, or the
 * host cannot be reached. Reporting all of them as "Token 无效或已过期" sends the
 * operator to rotate a token that was never the problem, so each cause gets its
 * own wording here. `siteSide` tells the caller whether the account should be
 * marked `expired` at all — a site that is down has not invalidated anything.
 */
export function describeCredentialFailure(detail?: string | null): {
  reason: ReturnType<typeof classifyFailureReason>;
  headline: string;
  siteSide: boolean;
} {
  const reason = classifyFailureReason({ message: detail });
  const siteSide = (
    reason.code === 'site_unreachable'
    || reason.code === 'cloudflare_tunnel_unavailable'
    || reason.code === 'upstream_error'
    || reason.code === 'rate_limited'
  );
  let headline: string;
  switch (reason.code) {
    case 'session_limit':
      headline = '账号密码有效，但站点登录会话数已达上限，无法自动续期';
      break;
    case 'invalid_credentials':
      headline = '站点拒绝了保存的账号密码（密码已改或被封禁）';
      break;
    case 'manual_turnstile_required':
    case 'cloudflare_challenge':
      headline = '自动续期被人机验证（Cloudflare/Turnstile）拦下';
      break;
    case 'site_unreachable':
    case 'cloudflare_tunnel_unavailable':
    case 'upstream_error':
      headline = '站点无法访问（网站可能挂了），令牌未续期';
      break;
    case 'rate_limited':
      headline = '站点限流，令牌暂未续期';
      break;
    default:
      headline = 'Token 无效或已过期';
      break;
  }
  return { reason, headline, siteSide };
}

export async function reportTokenExpired(params: {
  accountId: number;
  username?: string | null;
  siteName?: string | null;
  detail?: string;
  /**
   * Why the credential could not be renewed automatically, when it could not.
   * Recorded on the account so "why does this never fix itself" has an answer
   * instead of the generic verdict.
   */
  renewalNote?: string;
}) {
  const accountLabel = params.username || `ID:${params.accountId}`;
  const siteLabel = params.siteName || 'unknown-site';
  const { reason, headline, siteSide } = describeCredentialFailure(params.detail);
  const detailText = params.detail ? appendSessionTokenRebindHint(params.detail) : '';
  const renewalText = params.renewalNote ? `。${params.renewalNote}` : '';
  const detail = detailText || renewalText ? ` (${detailText}${renewalText})` : '';
  const createdAt = formatUtcSqlDateTime(new Date());

  if (!siteSide) {
    await db.update(schema.accounts).set({
      status: 'expired',
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.accounts.id, params.accountId)).run();
  }

  await db.insert(schema.events).values({
    type: 'token',
    title: reason.title,
    message: `${accountLabel} @ ${siteLabel}：${headline}${detail}`,
    level: 'error',
    relatedId: params.accountId,
    relatedType: 'account',
    createdAt,
  }).run();

  setAccountRuntimeHealth(params.accountId, {
    state: 'unhealthy',
    reason: `${headline}${detail}`,
    source: siteSide ? 'balance' : 'auth',
  });

  await sendNotification(
    reason.title,
    `${accountLabel} @ ${siteLabel}：${headline}${detail}`,
    'error',
  );
}

export type ProxyFailureClientInfo = {
  ip?: string | null;
  userAgent?: unknown;
  kind?: string | null;
  path?: string | null;
  keyId?: number | null;
  /** Codex 的 thread/session id：同一个人可能开着多个会话，只有它能定位到具体那一个。 */
  session?: string | null;
};

function firstHeaderValue(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim());
    return typeof first === 'string' ? first.trim() : '';
  }
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * 「代理全部失败」只说模型和原因，排障时完全看不出是谁在调用：用户明明只在自己
 * 客户端里用 A 模型，却因为某个后台程序按 B 模型打进来而收到一堆通知，只能猜。
 * 这里把来源 IP、客户端标识、请求路径和下游 Key 一起带上，下次再出现能直接定位。
 */
export function describeProxyFailureClient(client?: ProxyFailureClientInfo | null): string {
  if (!client) return '';
  const parts: string[] = [];
  if (client.kind) parts.push(`客户端=${client.kind}`);
  if (client.path) parts.push(`路径=${client.path}`);
  if (typeof client.keyId === 'number' && client.keyId > 0) parts.push(`Key=#${client.keyId}`);
  if (client.session) parts.push(`会话=${truncateText(client.session, 44)}`);
  if (client.ip) parts.push(`IP=${client.ip}`);
  const userAgent = truncateText(firstHeaderValue(client.userAgent), 90);
  if (userAgent) parts.push(`UA=${userAgent}`);
  if (parts.length === 0) return '';
  return `；来源：${parts.join('，')}`;
}

export async function reportProxyAllFailed(params: {
  model: string;
  reason: string;
  client?: ProxyFailureClientInfo | null;
}) {
  const createdAt = formatUtcSqlDateTime(new Date());
  const message = `模型=${params.model}, 原因=${params.reason}${describeProxyFailureClient(params.client)}`;
  await db.insert(schema.events).values({
    type: 'proxy',
    title: '代理全部失败',
    message,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();

  await sendNotification('代理全部失败', message, 'error');
}
