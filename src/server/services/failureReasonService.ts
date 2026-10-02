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

export function classifyFailureReason(
  input: { message?: string | null; status?: string | null; httpStatus?: number | null },
): FailureReason {
  const rawMessage = String(input.message || '').trim();
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

  if (isCloudflareChallenge(rawMessage)) {
    return {
      code: 'cloudflare_challenge',
      category: 'verification',
      title: '触发 Cloudflare 验证',
      actionHint: '降低频率并稍后重试',
      detailHint: '请求触发了防护挑战，建议稍后再试或更换稳定站点。',
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
      title: '上游站点错误',
      actionHint: '稍后重试',
      detailHint: '站点返回服务端错误，通常需要站点恢复后才可成功。',
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
