import { describe, expect, it } from 'vitest';
import {
  classifyFailureReason,
  isHtmlErrorPage,
  stripHtmlErrorPage,
} from './failureReasonService.js';

describe('failureReasonService', () => {
  it('classifies turnstile requirement as manual verification', () => {
    const result = classifyFailureReason({
      message: 'Turnstile token 为空',
      status: 'failed',
    });
    expect(result.code).toBe('manual_turnstile_required');
    expect(result.category).toBe('verification');
  });

  it('names a concurrent-session cap instead of blaming the token', () => {
    // new-api forks that cap sessions answer an otherwise correct password with
    // `409 AUTH_SESSION_LIMIT`; the request that follows then fails 401 and would
    // otherwise be reported as an expired token.
    const refusal = classifyFailureReason({
      message: 'Conflict（AUTH_SESSION_LIMIT）',
    });
    expect(refusal.code).toBe('session_limit');
    expect(refusal.actionHint).toContain('退出其他登录会话');

    const visible = classifyFailureReason({
      message: 'Too many active login sessions. On a device where you are already signed in, '
        + 'open Login sessions and use “Sign out other sessions” to revoke them.',
    });
    expect(visible.code).toBe('session_limit');

    // The generic 401 that follows the refusal must not outrank it.
    expect(classifyFailureReason({
      httpStatus: 401,
      message: 'HTTP 401: Unauthorized, not logged in and no access token provided',
    }).code).toBe('token_expired');
  });

  it('names a refused credential pair as such, banned accounts included', () => {
    const refused = classifyFailureReason({
      message: 'Username or password is incorrect, or user has been banned',
    });
    expect(refused.code).toBe('invalid_credentials');
    expect(refused.category).toBe('auth');
  });

  it('recognises the refusal wording this system records on the account', () => {
    // `autoRelogin` writes `<title>：<actionHint>` onto the account when a site
    // refuses the stored password. That same string is what the check-in log
    // carries, so it has to classify back to the same cause instead of falling
    // through to "unknown error".
    const banned = classifyFailureReason({
      message: '账号密码无效或账号被封禁：核对保存的账号密码，或确认账号是否被站点封禁',
      status: 'failed',
    });
    expect(banned.code).toBe('invalid_credentials');
    expect(banned.category).toBe('auth');

    const capped = classifyFailureReason({
      message: '站点登录会话数已达上限：在站点上退出其他登录会话（或重置密码）后重试',
      status: 'failed',
    });
    expect(capped.code).toBe('session_limit');
    expect(capped.category).toBe('auth');
  });

  it('classifies cloudflare tunnel outage', () => {
    const result = classifyFailureReason({
      message: 'HTTP 530 Cloudflare Tunnel error | Error 1033',
      status: 'failed',
      httpStatus: 530,
    });
    expect(result.code).toBe('cloudflare_tunnel_unavailable');
    expect(result.category).toBe('network');
  });

  it('classifies token errors using status and message', () => {
    const result = classifyFailureReason({
      message: 'invalid access token',
      status: 'failed',
      httpStatus: 401,
    });
    expect(result.code).toBe('token_expired');
    expect(result.category).toBe('auth');
  });

  it('names an unreachable site instead of blaming the token', () => {
    // Node's fetch throws a bare `fetch failed` for DNS, refused connections and
    // dropped TLS alike. Reading that as an expired token is what sends the
    // operator to rotate a credential the site never even saw.
    for (const message of [
      'fetch failed',
      'connect ECONNREFUSED 1.2.3.4:443',
      'getaddrinfo ENOTFOUND api.example.com',
      'socket hang up',
      'other side closed',
      'HTTP 522',
    ]) {
      const result = classifyFailureReason({ message, status: 'failed' });
      expect(result.code, message).toBe('site_unreachable');
      expect(result.category, message).toBe('network');
      expect(result.title, message).toContain('站点无法访问');
    }
  });

  it('says the site may be down when it answers 5xx', () => {
    const result = classifyFailureReason({ message: 'HTTP 502: 878.indevs.in', status: 'failed' });
    expect(result.code).toBe('upstream_error');
    expect(result.title).toContain('网站可能挂了');
    expect(result.actionHint).toContain('无需改动凭据');
  });

  it('keeps a plain timeout a timeout, not an unreachable host', () => {
    const result = classifyFailureReason({ message: '请求超时 (ETIMEDOUT)', status: 'failed' });
    expect(result.code).toBe('network_timeout');
  });

  it('classifies already checked in as state info', () => {
    const result = classifyFailureReason({
      message: '今天已经签到过啦',
      status: 'success',
    });
    expect(result.code).toBe('already_checked_in');
    expect(result.category).toBe('state');
  });

  it('names an edge throttle instead of blaming the credential', () => {
    const result = classifyFailureReason({
      message: '站点当前限流（HTTP 429），本次未取得访问令牌，稍后会自动重试',
      status: 'failed',
    });
    expect(result.code).toBe('rate_limited');
    expect(result.category).toBe('site');
  });

  it('classifies missing checkin endpoint as site capability issue', () => {
    const result = classifyFailureReason({
      message: 'checkin endpoint not found',
      status: 'skipped',
    });
    expect(result.code).toBe('checkin_not_supported');
    expect(result.category).toBe('site');
    expect(result.title).toBe('站点未开启签到');
  });

  it('classifies sub2api unsupported checkin message as site capability issue', () => {
    const result = classifyFailureReason({
      message: 'Check-in is not supported by Sub2API',
      status: 'failed',
    });
    expect(result.code).toBe('checkin_not_supported');
    expect(result.category).toBe('site');
  });

  it('names an HTML error page as the site side instead of pasting its markup', () => {
    const nginxPage = '<html>\n<head><title>403 Forbidden</title></head>\n'
      + '<body>\n<center><h1>403 Forbidden</h1></center>\n<hr><center>nginx</center>\n'
      + '</body>\n</html>\n';
    const result = classifyFailureReason({
      message: `sub2api token refresh failed: HTTP 403: ${nginxPage}`,
    });

    expect(result).toMatchObject({
      code: 'upstream_error',
      category: 'site',
    });
    expect(result.title).toContain('站点服务异常');
  });

  it('reads the same verdict from the collapsed marker alone', () => {
    // Once the page has been replaced by `stripHtmlErrorPage`, this phrase is
    // all that is left for the classifier to go on — and it has to keep working,
    // because the message the site's own layer produced is re-classified later.
    const result = classifyFailureReason({
      message: 'sub2api token refresh failed: HTTP 403: 站点返回 HTML 错误页，请求未到达接口',
    });

    expect(result).toMatchObject({ code: 'upstream_error', category: 'site' });
    expect(result.actionHint).toContain('无需改动凭据');
  });

  it('collapses an HTML error page to one line and keeps the status reported before it', () => {
    const nginxPage = '<html><head><title>403 Forbidden</title></head>'
      + '<body><center><h1>403 Forbidden</h1></center></body></html>';

    expect(stripHtmlErrorPage(`sub2api token refresh failed: HTTP 403: ${nginxPage}`))
      .toBe('sub2api token refresh failed: HTTP 403（站点返回 HTML 错误页）');
    // A bare page has no prefix to keep, so the status is read off the page.
    expect(stripHtmlErrorPage(`HTTP 502: ${nginxPage}`))
      .toBe('HTTP 502（站点返回 HTML 错误页）');
    // A bare page has no prefix, so its own heading is what identifies it.
    expect(stripHtmlErrorPage(nginxPage)).toBe('403 Forbidden（站点返回 HTML 错误页）');
  });

  it('names a challenge page for what it is instead of quoting its heading', () => {
    const challenge = '<html><head><title>Just a moment...</title></head>'
      + '<body><div id="cf-challenge-running">Checking your browser before accessing '
      + 'cloudflare</div></body></html>';

    expect(stripHtmlErrorPage(challenge)).toBe('站点返回 HTML 错误页（验证/防护页）');
    expect(stripHtmlErrorPage(`HTTP 403: ${challenge}`))
      .toBe('HTTP 403（验证/防护页）');
  });

  it('leaves ordinary API errors untouched', () => {
    expect(stripHtmlErrorPage('HTTP 401: invalid refresh token (REFRESH_TOKEN_INVALID)'))
      .toBe('HTTP 401: invalid refresh token (REFRESH_TOKEN_INVALID)');
    expect(isHtmlErrorPage('HTTP 401: invalid refresh token')).toBe(false);
    expect(isHtmlErrorPage('')).toBe(false);
    expect(isHtmlErrorPage(null)).toBe(false);
  });

  it('still reports a challenge page as a challenge, not as a dead site', () => {
    // The interstitial names itself inside the body, which the HTML strip
    // removes; the verdict has to be taken from the original text.
    const challenge = '<html><head><title>Just a moment...</title></head>'
      + '<body><div id="cf-challenge-running">Checking your browser before accessing '
      + 'cloudflare</div></body></html>';
    const result = classifyFailureReason({ message: challenge });

    expect(result.code).toBe('cloudflare_challenge');
    expect(result.category).toBe('verification');
  });
});
