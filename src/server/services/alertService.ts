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

export async function reportProxyAllFailed(params: { model: string; reason: string }) {
  const createdAt = formatUtcSqlDateTime(new Date());
  await db.insert(schema.events).values({
    type: 'proxy',
    title: '代理全部失败',
    message: `模型=${params.model}, 原因=${params.reason}`,
    level: 'error',
    relatedType: 'route',
    createdAt,
  }).run();

  await sendNotification(
    '代理全部失败',
    `模型=${params.model}, 原因=${params.reason}`,
    'error',
  );
}
