import { isCloudflareChallenge, isTokenExpiredError } from './alertRules.js';

type FailureReasonCategory =
  | 'verification'
  | 'auth'
  | 'network'
  | 'site'
  | 'state'
  | 'unknown';

type FailureReasonCode =
  | 'site_disabled'
  | 'checkin_not_supported'
  | 'manual_turnstile_required'
  | 'session_limit'
  | 'invalid_credentials'
  | 'cloudflare_tunnel_unavailable'
  | 'cloudflare_challenge'
  | 'site_unreachable'
  | 'token_expired'
  | 'already_checked_in'
  | 'network_timeout'
  | 'rate_limited'
  | 'upstream_error'
  | 'unknown_error';

type FailureReason = {
  code: FailureReasonCode;
  category: FailureReasonCategory;
  title: string;
  actionHint: string;
  detailHint: string;
};

function includesAny(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

/**
 * True when a body is an HTML page rather than an API answer.
 *
 * A gateway in front of a site answers a refused request with a full page —
 * nginx's `403 Forbidden`, a WAF interstitial, a 502 from a reverse proxy —
 * and that page then travels back inside the error message. Kept verbatim it
 * turns a one-line reason into a wall of markup, and it reads as if the
 * credential were at fault when the request never reached the application.
 *
 * Matches both a whole document (leading `<!doctype html>` / `<html>`) and the
 * page pasted after a status line (`HTTP 403: <html> <head>…`), which is how
 * these bodies actually arrive here.
 */
export function isHtmlErrorPage(value?: string | null): boolean {
  const text = String(value || '').trim();
  if (!text) return false;
  if (/^<(?:!doctype\s+html|html)\b/i.test(text)) return true;
  return text.length > 40 && /<\/(?:html|head|body|center|title|h1)>/i.test(text);
}

/**
 * Collapses an HTML error page to one readable line, keeping whatever the
 * caller had already said in front of it.
 *
 * The status code is worth keeping — `403` and `502` mean different things to
 * the operator — but the markup, the `<hr>` and the server banner are not. The
 * page's own `<title>` is deliberately dropped too: it is almost always just
 * the status again.
 */
export function stripHtmlErrorPage(value?: string | null): string {
  const text = String(value || '').trim();
  if (!isHtmlErrorPage(text)) return text;
  const firstTag = text.search(/<[a-z!/]/i);
  const head = (firstTag > 0 ? text.slice(0, firstTag) : '')
    .replace(/[\s:：-]+$/, '')
    .trim();

  // A challenge page's heading is deliberately meaningless ("Just a moment..."),
  // so it is named for what it is instead of quoted. Any other page's heading is
  // the one part worth keeping: nginx says `403 Forbidden`, a proxy `502 Bad
  // Gateway`.
  const isChallenge = /cloudflare|turnstile|challenge|just a moment/i.test(text);
  const heading = (
    text.match(/<title[^>]*>([^<]{1,80})<\/title>/i)?.[1]
    ?? text.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i)?.[1]
    ?? ''
  ).replace(/\s+/g, ' ').trim();

  if (head) {
    // A status already in the prefix is the whole story; the page's own copy of
    // it would only repeat what the caller just said.
    const label = isChallenge ? '验证/防护页' : (/\b\d{3}\b/.test(head) ? null : (heading || null));
    return label ? `${head}（${label}）` : `${head}（站点返回 HTML 错误页）`;
  }
  if (isChallenge) return '站点返回 HTML 错误页（验证/防护页）';
  return heading ? `${heading}（站点返回 HTML 错误页）` : '站点返回 HTML 错误页';
}

export function classifyFailureReason(
  input: { message?: string | null; status?: string | null; httpStatus?: number | null },
): FailureReason {
  const originalMessage = String(input.message || '').trim();
  // Classified on the readable form, never on the markup: the page's `<html>`
  // scaffolding must not decide which keyword matches.
  const rawMessage = stripHtmlErrorPage(originalMessage);
  // ...but the challenge verdicts are the exception: an interstitial names
  // itself inside the page body, which the strip above has just removed.
  const htmlErrorPage = isHtmlErrorPage(originalMessage);
  const text = rawMessage.toLowerCase();
  const status = (input.status || '').toLowerCase();
  const httpStatus = typeof input.httpStatus === 'number' ? input.httpStatus : 0;

  if (status === 'skipped' && includesAny(text, ['site disabled'])) {
    return {
      code: 'site_disabled',
      category: 'site',
      title: '站点已禁用',
      actionHint: '启用站点后再试',
      detailHint: '该账号所属站点处于禁用状态，任务会自动跳过。',
    };
  }

  if (includesAny(text, [
    'checkin endpoint not found',
    '签到端点不存在',
    '站点不支持签到',
    'not support checkin',
    'check-in is not supported',
    'checkin is not supported',
    'does not support checkin',
  ])) {
    return {
      code: 'checkin_not_supported',
      category: 'site',
      title: '站点未开启签到',
      actionHint: '无需重试（非故障）',
      detailHint: '该站点未提供签到端点，账号会被自动跳过。',
    };
  }

  if (includesAny(text, ['turnstile token 为空', 'turnstile']) && includesAny(text, ['校验', 'token', '验证', 'manual'])) {
    return {
      code: 'manual_turnstile_required',
      category: 'verification',
      title: '需要人工验证',
      actionHint: '浏览器先人工签到一次',
      detailHint: '站点开启了 Turnstile 人机验证，自动签到无法直接通过。',
    };
  }

  if (includesAny(text, ['cloudflare tunnel error', 'error 1033', 'unable to resolve it'])) {
    return {
      code: 'cloudflare_tunnel_unavailable',
      category: 'network',
      title: '站点隧道不可用',
      actionHint: '稍后重试或联系站点方',
      detailHint: 'Cloudflare Tunnel 当前不可达，通常是站点侧网络或隧道进程问题。',
    };
  }

  if (isCloudflareChallenge(originalMessage)) {
    return {
      code: 'cloudflare_challenge',
      category: 'verification',
      title: '触发 Cloudflare 验证',
      actionHint: '降低频率并稍后重试',
      detailHint: '请求触发了防护挑战，建议稍后再试或更换稳定站点。',
    };
  }

  // A page came back where an API answer was expected. The request reached
  // something, but not the application: a gateway, a WAF or a dead upstream
  // answered instead. That is the site's side of the call, and saying so keeps
  // the operator from rotating a credential that was never examined.
  // Also matched by the marker `stripHtmlErrorPage` leaves behind: once the page
  // is gone, that phrase is the only trace left of what came back, and the
  // verdict it earns is the same one.
  if (htmlErrorPage || text.includes('html 错误页')) {
    return {
      code: 'upstream_error',
      category: 'site',
      title: '站点服务异常（网站可能挂了）',
      actionHint: '无需改动凭据，等站点恢复后会自动重试',
      detailHint: '站点（或其前面的网关）返回了 HTML 错误页而不是接口响应，'
        + '说明请求没有到达应用本身，与账号令牌无关，站点恢复后会自动恢复。',
    };
  }

  // A new-api fork that caps concurrent sessions refuses an otherwise correct
  // password with `409` and `AUTH_SESSION_LIMIT` (the visible text is "Too many
  // active login sessions ... sign out other sessions"). The credentials are
  // fine and no retry can help, so naming the cause is what lets the operator
  // act instead of hunting for a token problem that does not exist.
  if (
    includesAny(text, [
      'auth_session_limit',
      'too many active login sessions',
      'sign out other sessions',
      'session limit',
      '登录会话数',
      '会话数已达上限',
    ])
  ) {
    return {
      code: 'session_limit',
      category: 'auth',
      title: '站点登录会话数已达上限',
      actionHint: '在站点上退出其他登录会话，或等会话过期后重试',
      detailHint: '账号密码本身有效，但站点限制了同时登录的会话数量，'
        + '新的登录会被拒绝。请在仍登录着该站点的设备上打开「登录会话」'
        + '并退出其他设备；若没有任何设备在线，只能等旧会话到期'
        + '（New API 每个会话固定 30 天，到期后站点每小时清理）'
        + '或请站长在后台清理。重置密码同样能退出全部会话，'
        + '但它依赖站点邮件通道，未配置 SMTP 的站点发不出重置链接。'
        + '本系统会持续自动重试，一旦有空位就会自动登录。',
    };
  }

  // A login that the site answers with a credential verdict is not a token
  // problem: the operator has to fix the credentials on file, and the generic
  // 401 that follows would send them looking in the wrong place.
  if (
    includesAny(text, [
      'username or password is incorrect',
      'incorrect username or password',
      'invalid username or password',
      'user has been banned',
      '账号或密码错误',
      '用户名或密码',
      '账号已被封禁',
      // The refusal this system records on the account itself, so that the
      // wording it writes is also the wording it recognises on the way back in.
      '账号密码无效',
      '账号被封禁',
      '被封禁',
      '密码无效',
    ])
  ) {
    return {
      code: 'invalid_credentials',
      category: 'auth',
      title: '账号密码无效或账号被封禁',
      actionHint: '核对保存的账号密码，或确认账号是否被站点封禁',
      detailHint: '站点明确拒绝了这组账号密码：可能是密码已修改，或账号已被封禁。'
        + '请在站点上确认可正常登录后，回到本系统更新凭据。',
    };
  }

  // A site that cannot be reached at all is not a credential problem, and
  // saying "token expired" for it sends the operator to rotate a token that was
  // never the issue. `fetch failed` is what Node's fetch throws for a DNS
  // failure, a refused connection, and a dropped TLS handshake alike, so the
  // whole family is named here for what it is: the site is down or unreachable.
  if (
    includesAny(text, [
      'fetch failed',
      'econnrefused',
      'econnreset',
      'econnaborted',
      'epipe',
      'enotfound',
      'eai_again',
      'getaddrinfo',
      'socket hang up',
      'other side closed',
      'network error',
      'net::err',
      'connection refused',
      'connection reset',
      'connect timeout',
      'und_err_',
      'error 520',
      'error 521',
      'error 522',
      'error 525',
      'error 526',
      'http 520',
      'http 521',
      'http 522',
      'http 525',
      'http 526',
    ])
  ) {
    return {
      code: 'site_unreachable',
      category: 'network',
      title: '站点无法访问（网站可能挂了）',
      actionHint: '无需改动凭据，等站点恢复后会自动重试',
      detailHint: '本机连不上该站点：域名解析、连接或 TLS 握手在到达站点之前就失败了。'
        + '这属于站点侧或网络侧问题，与账号令牌无关，站点恢复后会自动恢复。',
    };
  }

  if (isTokenExpiredError({ status: httpStatus > 0 ? httpStatus : undefined, message: rawMessage })) {
    return {
      code: 'token_expired',
      category: 'auth',
      title: '令牌失效',
      actionHint: '重新登录或同步新令牌',
      detailHint: '账号访问令牌可能过期或无效，需更新认证信息。',
    };
  }

  if (includesAny(text, ['already checked in', 'already signed', '今天已经签到', '今日已签到', '已经签到'])) {
    return {
      code: 'already_checked_in',
      category: 'state',
      title: '今日已签到',
      actionHint: '无需重复执行',
      detailHint: '该账号当天签到已完成，重复请求会被站点拒绝或跳过。',
    };
  }

  if (includesAny(text, ['timeout', 'timed out', 'etimedout', '请求超时'])) {
    return {
      code: 'network_timeout',
      category: 'network',
      title: '请求超时',
      actionHint: '稍后重试并检查网络',
      detailHint: '请求在超时时间内未完成，可能是网络波动或站点响应慢。',
    };
  }

  // Checked before the token verdicts and worded so it cannot be confused with
  // one: a relay that throttles by egress IP answers with a bare 429, and
  // reading that as a dead credential is what takes an account out of rotation
  // over a condition that clears itself.
  if (includesAny(text, ['限流', 'rate limit', 'ratelimit', 'too many requests', 'http 429'])) {
    return {
      code: 'rate_limited',
      category: 'site',
      title: '站点限流',
      actionHint: '稍后自动重试',
      detailHint: '站点按出口 IP 限流，凭据本身没有问题；等限流窗口过去后会自动恢复。',
    };
  }

  if (httpStatus >= 500 || includesAny(text, ['http 5', 'upstream', 'internal server error'])) {
    return {
      code: 'upstream_error',
      category: 'site',
      title: '站点服务异常（网站可能挂了）',
      actionHint: '无需改动凭据，等站点恢复后会自动重试',
      detailHint: '站点自己返回了 5xx，说明请求已经到达站点、失败在它那一侧，'
        + '与账号令牌无关；站点恢复后会自动恢复。',
    };
  }

  return {
    code: 'unknown_error',
    category: 'unknown',
    title: status === 'success' ? '执行成功' : '未知错误',
    actionHint: status === 'success' ? '无需操作' : '查看详细日志后重试',
    detailHint: status === 'success'
      ? '任务已成功完成。'
      : '暂未识别到明确错误类型，可根据原始信息进一步排查。',
  };
}
