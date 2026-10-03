import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { NewApiAdapter } from './newApi.js';
import { AnyRouterAdapter } from './anyrouter.js';
import { isEdgeRateLimitResponse } from './newApiShield.js';

interface RequestSnapshot {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
}

const COOKIE_SESSION_TOKEN = 'cookie-session-token';
const COOKIE_REQUIRES_USER_TOKEN = 'cookie-requires-user';
const COOKIE_REQUIRES_X_USER_ID_TOKEN = 'cookie-requires-x-user-id';
const CHECKIN_ALREADY_TOKEN = 'checkin-already-token';
const EXTERNAL_WHEEL_TOKEN = 'external-wheel-token';
const CHECKIN_DAILY_TOKEN = 'checkin-daily-token';
const CHECKIN_DAILY_ALREADY_TOKEN = 'checkin-daily-already-token';
const CHECKIN_DAILY_COOKIE_TOKEN = 'checkin-daily-cookie-token';
const CHECKIN_LEGACY_TOKEN = 'checkin-legacy-token';
const CHECKIN_AGENT_PROGRAM_TOKEN = 'checkin-agent-program-token';
const CHECKIN_AGENT_PROGRAM_ALREADY_TOKEN = 'checkin-agent-program-already-token';
const CHECKIN_FEATURE_OFF_TOKEN = 'checkin-feature-off-token';
const CHECKIN_INVALID_URL_TOKEN = 'checkin-invalid-url-token';
const CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN = 'checkin-invalid-url-expired-session-token';
const CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN = 'checkin-invalid-url-forbidden-session-token';
const CHECKIN_CLOUDFLARE_530_TOKEN = 'checkin-cloudflare-530-token';
const BALANCE_FAIL_TOKEN = 'balance-fail-token';
const BALANCE_SHIELD_FAILURE_TOKEN = 'balance-shield-failure-token';
const GROUP_EXPIRED_TOKEN = 'group-expired-token';
const SHIELD_LOGIN_USERNAME = 'shield-user';
const SHIELD_LOGIN_PASSWORD = 'shield-pass';
const SHIELD_LOGIN_TOKEN = 'login-session-token';
const SHIELD_LOGIN_COOKIE = 'challenge-seed';
const COOKIE_ONLY_LOGIN_USERNAME = 'cookie-only-user';
const COOKIE_ONLY_LOGIN_PASSWORD = 'cookie-only-pass';
const COOKIE_ONLY_LOGIN_SESSION = 'cookie-only-session';
const REFRESH_LOGIN_USERNAME = 'refresh-cookie-user';
const REFRESH_LOGIN_PASSWORD = 'refresh-cookie-pass';
const REFRESH_LOGIN_COOKIE = '11111111-2222-3333-4444-555555555555.refresh-secret';
const REFRESH_LOGIN_BEARER = 'refresh-login-short-lived-token';
const OPENAI_MODELS_SHIELDED_TOKEN = 'openai-models-shielded-token';
const SESSIONS_TOKEN = 'sessions-token';
const SESSION_LIMIT_LOGIN_USERNAME = 'session-capped-user';
const SESSION_LIMIT_LOGIN_PASSWORD = 'session-capped-pass';
const EDGE_THROTTLED_TOKEN = 'edge-throttled-token';
const EDGE_THROTTLE_ONCE_TOKEN = 'edge-throttle-once-token';
const COOKIE_SHIELDED_TOKEN = Buffer.from(
  `1771864970|${Buffer.from('username=linuxdo_131936').toString('base64')}|sig`,
).toString('base64');
const COOKIE_GOB_USER_TOKEN = Buffer.from(
  `1772806887|${Buffer.from(
    '0d7f040102ff8000011001100000ff93ff80000506737472696e670c060004726f6c6503696e740402000206737472696e670c08000673746174757303696e740402000206737472696e670c07000567726f757006737472696e670c09000764656661756c7406737472696e670c040002696403696e74040500fd04683006737472696e670c0a0008757365726e616d6506737472696e670c09000773756974313539',
    'hex',
  ).toString('base64')}|sig`,
).toString('base64');
const AUTH_TOKEN_SIGNIN_ONLY_TOKEN = `header.${Buffer.from(JSON.stringify({ id: 5566 })).toString('base64url')}.sig`;
const ANYROUTER_CHALLENGE_HTML = readFileSync(
  new URL('./__fixtures__/anyrouter-challenge.html', import.meta.url),
  'utf8',
);
const ANYROUTER_CHALLENGE_ACW = '699dbedad126579b6bc0ebb91eaae8d7af3548b5';
const CLOUDFLARE_530_HTML = `
<!doctype html>
<html lang="en-US">
  <head>
    <title>Cloudflare Tunnel error | newapi.tanmw.top | Cloudflare</title>
  </head>
  <body>
    <h1><span>Error</span><span>1033</span></h1>
    <h2>Cloudflare Tunnel error</h2>
  </body>
</html>
`;

describe('NewApiAdapter', () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let requests: RequestSnapshot[] = [];
  let throttlePassThroughHits = 0;
  /** Session ids the fake site was asked to sign out, in order. */
  let revokedSids: string[] = [];

  beforeEach(async () => {
    requests = [];
    throttlePassThroughHits = 0;
    revokedSids = [];
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requests.push({
        method: req.method || 'GET',
        url: req.url || '/',
        headers: req.headers,
      });

      if (req.url === '/v1/models') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${OPENAI_MODELS_SHIELDED_TOKEN}`) {
          const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
          if (!cookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (
            !cookieHeader.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`)
            || !cookieHeader.includes(`session=${OPENAI_MODELS_SHIELDED_TOKEN}`)
          ) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'missing shield cookie context' } }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: [
              { id: 'claude-sonnet-4-5-20250929' },
              { id: 'claude-opus-4-6' },
            ],
          }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid token' } }));
        return;
      }

      if (req.url === '/api/user/login' && req.method === 'POST') {
        let bodyRaw = '';
        req.on('data', (chunk) => {
          bodyRaw += chunk.toString();
        });
        req.on('end', () => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(bodyRaw || '{}');
          } catch {}

          const isShieldLogin =
            payload.username === SHIELD_LOGIN_USERNAME &&
            payload.password === SHIELD_LOGIN_PASSWORD;
          const isSessionCappedLogin =
            payload.username === SESSION_LIMIT_LOGIN_USERNAME &&
            payload.password === SESSION_LIMIT_LOGIN_PASSWORD;
          if (isSessionCappedLogin) {
            // A fork that allows one session per account answers a second
            // sign-in with a bare "Conflict" and the cause in `code`.
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'AUTH_SESSION_LIMIT', message: 'Conflict', success: false }));
            return;
          }
          const isCookieOnlyLogin =
            payload.username === COOKIE_ONLY_LOGIN_USERNAME &&
            payload.password === COOKIE_ONLY_LOGIN_PASSWORD;
          const isRefreshLogin =
            payload.username === REFRESH_LOGIN_USERNAME &&
            payload.password === REFRESH_LOGIN_PASSWORD;
          if (!isShieldLogin && !isCookieOnlyLogin && !isRefreshLogin) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'invalid credentials' }));
            return;
          }

          const cookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
          if (!cookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }

          if (!cookieHeader.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing shield cookie' }));
            return;
          }

          if (isCookieOnlyLogin) {
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': `session=${COOKIE_ONLY_LOGIN_SESSION}; Path=/; HttpOnly`,
            });
            res.end(JSON.stringify({
              success: true,
              data: {},
            }));
            return;
          }

          if (isRefreshLogin) {
            // The shape the modern auth stack answers with: the body carries a
            // 15 minute access token, and the durable credential is the
            // rotatable refresh cookie.
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Set-Cookie': [
                `new_api_refresh=${REFRESH_LOGIN_COOKIE}; Path=/api/user/auth; Max-Age=2592000; HttpOnly`,
                'new_api_has_session=1; Path=/; Max-Age=2592000',
              ],
            });
            res.end(JSON.stringify({
              success: true,
              data: { access_token: REFRESH_LOGIN_BEARER, token_type: 'Bearer' },
            }));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { token: SHIELD_LOGIN_TOKEN },
          }));
        });
        return;
      }

      if (req.url === '/api/user/models') {
        if (req.headers['new-api-user'] !== '11494') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: ['gpt-4o', 'gpt-4.1'] }));
        return;
      }

      if (req.url === '/api/notice') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: 'Welcome to the site',
        }));
        return;
      }

      if (req.url?.startsWith('/api/token/')) {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer auth_token=${AUTH_TOKEN_SIGNIN_ONLY_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'shielded-cookie-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_X_USER_ID_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-api-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-user-key' }],
            },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_X_USER_ID_TOKEN}`)) {
          if (req.headers['x-user-id'] !== '448') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing X-User-Id' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            data: {
              items: [{ key: 'cookie-x-user-id-key' }],
            },
          }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: {
            items: [{ key: 'api-key-from-token-list' }],
          },
        }));
        return;
      }

      if (req.url === '/api/user/self') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${BALANCE_SHIELD_FAILURE_TOKEN}`) {
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
          });
          res.end(ANYROUTER_CHALLENGE_HTML);
          return;
        }

       if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${BALANCE_FAIL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }));
          return;
        }

        const selfCookieHeader = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
        const selfBearer = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        if (selfBearer === `Bearer ${EDGE_THROTTLED_TOKEN}` || selfBearer === `Bearer ${EDGE_THROTTLE_ONCE_TOKEN}`) {
          // The ESA edge answers before the application runs: the shield is
          // solved first, and only the requests that pass it spend quota.
          if (!selfCookieHeader.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Set-Cookie': `cdn_sec_tc=${SHIELD_LOGIN_COOKIE}; Path=/; HttpOnly`,
            });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          throttlePassThroughHits += 1;
          if (selfBearer === `Bearer ${EDGE_THROTTLED_TOKEN}` || throttlePassThroughHits === 1) {
            res.writeHead(403, {
              'Content-Type': 'text/html; charset=utf-8',
              'x-tengine-error': 'denied by http_ratelimit',
            });
            res.end('<html><body>denied by http_ratelimit</body></html>');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 166294, username: 'linuxdo_166294', quota: 940000000, used_quota: 1000 },
          }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string' &&
          (
            req.headers.cookie.includes(`session=${BALANCE_SHIELD_FAILURE_TOKEN}`) ||
            req.headers.cookie.includes(`token=${BALANCE_SHIELD_FAILURE_TOKEN}`)
          )
        ) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string' &&
          (
            req.headers.cookie.includes(`session=${BALANCE_FAIL_TOKEN}`) ||
            req.headers.cookie.includes(`token=${BALANCE_FAIL_TOKEN}`)
          )
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，access token 无效' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 131936, username: 'linuxdo_131936', quota: 3000000, used_quota: 1200000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === 'Bearer session-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 11494, username: 'demo-user', quota: 1000000, used_quota: 1000 },
          }));
          return;
        }

        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_USER_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_REQUIRES_X_USER_ID_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'invalid token' }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 7788, username: 'cookie-user', quota: 2000000, used_quota: 500000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '8899') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 8899, username: 'cookie-user-id-required', quota: 1500000, used_quota: 100000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_REQUIRES_X_USER_ID_TOKEN}`)) {
          if (req.headers['x-user-id'] !== '448') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing X-User-Id' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 448, username: 'x-user-id-cookie-user', quota: 1500000, used_quota: 100000 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_GOB_USER_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '144408') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 144408, username: 'suit159', quota: 50000000, used_quota: 0 },
          }));
          return;
        }

        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`auth_token=${AUTH_TOKEN_SIGNIN_ONLY_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '5566') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            data: { id: 5566, username: 'auth-cookie-user', quota: 1500000, used_quota: 250000 },
          }));
          return;
        }

        if (
          typeof req.headers.cookie === 'string'
          && (
            req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_TOKEN}`)
            || req.headers.cookie.includes(`token=${CHECKIN_INVALID_URL_TOKEN}`)
          )
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'temporary self probe failure' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'forbidden' }));
          return;
        }

        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
        return;
      }

      if (req.url === '/api/checkin/spin') {
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`auth_token=${EXTERNAL_WHEEL_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, level: 6, quota: 300000, label: '300次', message: '恭喜获得 300次！' }));
          return;
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: '未提供认证信息' }));
        return;
      }

      if (req.url === '/api/user/daily') {
        if (
          typeof req.headers.authorization === 'string'
          && (req.headers.authorization === `Bearer ${CHECKIN_AGENT_PROGRAM_TOKEN}`
            || req.headers.authorization === `Bearer ${CHECKIN_AGENT_PROGRAM_ALREADY_TOKEN}`
            || req.headers.authorization === `Bearer ${CHECKIN_FEATURE_OFF_TOKEN}`)
        ) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '签到功能未启用' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_DAILY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: '签到成功', data: { quota_awarded: 1787510 } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_DAILY_ALREADY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '今日已签到' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_DAILY_COOKIE_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'checked-in-daily-cookie', data: { quota_awarded: 555 } }));
          return;
        }
      }

      if (req.url === '/api/user/sota-agent-checkin') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_AGENT_PROGRAM_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: '签到成功',
            data: { checkin_date: '2026-10-01', quota_awarded: 10000000, reward_credits: 20 },
          }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_AGENT_PROGRAM_ALREADY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '今日已签到' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_FEATURE_OFF_TOKEN}`) {
          // This fork answers unknown routes with a 200 and an error envelope
          // rather than a real 404.
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/sota-agent-checkin)' } }));
          return;
        }
      }

      if (req.url === '/api/user/checkin') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_FEATURE_OFF_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '签到功能未启用' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_LEGACY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'checked-in-legacy', data: { reward: 123 } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_CLOUDFLARE_530_TOKEN}`) {
          res.writeHead(530, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(CLOUDFLARE_530_HTML);
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid URL (POST /api/user/checkin)' } }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${CHECKIN_ALREADY_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '今天已经签到过啦' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${AUTH_TOKEN_SIGNIN_ONLY_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${COOKIE_SHIELDED_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'unauthorized' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${COOKIE_SHIELDED_TOKEN}`)) {
          if (!req.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(ANYROUTER_CHALLENGE_HTML);
            return;
          }
          if (req.headers['new-api-user'] !== '131936') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'checked-in-ok' }));
          return;
        }
      }

      if (req.url === '/api/user/self/groups') {
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === `Bearer ${GROUP_EXPIRED_TOKEN}`) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'access token expired' }));
          return;
        }
        if (typeof req.headers.authorization === 'string' && req.headers.authorization === 'Bearer session-token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, data: { default: true, gemini: true } }));
          return;
        }
      }

      if (req.url === '/api/user/sign_in') {
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`auth_token=${AUTH_TOKEN_SIGNIN_ONLY_TOKEN}`)) {
          if (req.headers['new-api-user'] !== '5566') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'missing New-Api-User' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'checked-in-via-sign-in' }));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN}`)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({}));
          return;
        }
        if (typeof req.headers.cookie === 'string' && req.headers.cookie.includes(`session=${CHECKIN_ALREADY_TOKEN}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: '无权进行此操作，未登录且未提供 access token' }));
          return;
        }
      }

      if (req.url === '/api/user/sessions' && req.method === 'GET') {
        if (req.headers.authorization !== `Bearer ${SESSIONS_TOKEN}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          data: [
            {
              sid: 'live-session',
              current: true,
              login_method: 'password',
              ip: '10.0.0.1',
              user_agent: 'Mozilla/5.0',
              created_at: 1790904186,
              last_active_at: 1790904186,
              expires_at: 1793496186,
            },
            { sid: 'stale-session', current: false, login_method: 'oauth:linuxdo' },
          ],
        }));
        return;
      }

      if (req.url?.startsWith('/api/user/sessions/') && req.method === 'DELETE') {
        const sid = decodeURIComponent(req.url.slice('/api/user/sessions/'.length));
        if (sid !== 'stale-session' && sid !== 'live-session') {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 'AUTH_SESSION_NOT_FOUND', message: 'session not found', success: false }));
          return;
        }
        revokedSids.push(sid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  it('falls back to session model endpoint when /v1/models rejects token', async () => {
    const adapter = new NewApiAdapter();
    const models = await adapter.getModels(baseUrl, 'session-token', 11494);

    expect(models).toEqual(['gpt-4o', 'gpt-4.1']);
    expect(requests.some((r) => r.url === '/v1/models')).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/models' && r.headers['new-api-user'] === '11494'),
    ).toBe(true);
  });

  it('reuses shield cookie retry when anyrouter /v1/models returns challenge html', async () => {
    const adapter = new AnyRouterAdapter();
    const models = await adapter.getModels(baseUrl, OPENAI_MODELS_SHIELDED_TOKEN);

    expect(models).toEqual(['claude-sonnet-4-5-20250929', 'claude-opus-4-6']);
    expect(
      requests.some(
        (r) =>
          r.url === '/v1/models'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(`session=${OPENAI_MODELS_SHIELDED_TOKEN}`),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/v1/models'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
  });

  it('parses token list response with data.items[] shape', async () => {
    const adapter = new NewApiAdapter();
    const token = await adapter.getApiToken(baseUrl, 'session-token', 11494);

    expect(token).toBe('api-key-from-token-list');
  });

  it('solves anyrouter acw challenge for account-password login', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, SHIELD_LOGIN_USERNAME, SHIELD_LOGIN_PASSWORD);

    expect(result.success).toBe(true);
    expect(result.accessToken).toBe(SHIELD_LOGIN_TOKEN);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/login' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/login' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`),
      ),
    ).toBe(true);
  });

  it('uses session cookie as access credential when login success has no token payload', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, COOKIE_ONLY_LOGIN_USERNAME, COOKIE_ONLY_LOGIN_PASSWORD);

    expect(result.success).toBe(true);
    expect(result.accessToken || '').toContain(`session=${COOKIE_ONLY_LOGIN_SESSION}`);
    expect(result.accessToken || '').toContain(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`);
    expect(result.accessToken || '').toContain(`cdn_sec_tc=${SHIELD_LOGIN_COOKIE}`);
  });

  it('keeps the rotatable refresh cookie instead of the short-lived access token', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, REFRESH_LOGIN_USERNAME, REFRESH_LOGIN_PASSWORD);

    expect(result.success).toBe(true);
    // Storing the body token would make the account sign in again as soon as it
    // lapses, and every one of those sign-ins adds another entry to the site's
    // concurrent-session list.
    expect(result.accessToken).toBe(`new_api_refresh=${REFRESH_LOGIN_COOKIE}`);
    // The token is still handed to the caller for the calls this same flow makes
    // before the cookie has been exchanged.
    expect(result.bearerToken).toBe(REFRESH_LOGIN_BEARER);
  });

  it('names the cause when the site refuses a second session for the account', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.login(baseUrl, SESSION_LIMIT_LOGIN_USERNAME, SESSION_LIMIT_LOGIN_PASSWORD);

    expect(result.success).toBe(false);
    // "Conflict" on its own reads like a transient clash and says nothing about
    // what to do; the code is the part that names the cause — the account already
    // holds a session, and that one has to be signed out before another opens.
    expect(result.message).toBe('Conflict（AUTH_SESSION_LIMIT）');
  });

  it('lists the account sign-in sessions the way a session-capping fork reports them', async () => {
    const adapter = new NewApiAdapter();
    const sessions = await adapter.listSessions(baseUrl, SESSIONS_TOKEN, 38);

    expect(sessions).toEqual([
      {
        sid: 'live-session',
        current: true,
        loginMethod: 'password',
        ip: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
        createdAt: 1790904186,
        lastActiveAt: 1790904186,
        expiresAt: 1793496186,
      },
      {
        sid: 'stale-session',
        current: false,
        loginMethod: 'oauth:linuxdo',
        ip: null,
        userAgent: null,
        createdAt: null,
        lastActiveAt: null,
        expiresAt: null,
      },
    ]);
    expect(requests.some((r) => r.url === '/api/user/sessions' && r.headers['new-api-user'] === '38')).toBe(true);
  });

  it('returns null instead of throwing when the site has no session API', async () => {
    // The endpoint is a fork extra: on a plain new-api it 404s, and that must
    // read as "no such feature" rather than a failure worth reporting.
    const adapter = new NewApiAdapter();
    const sessions = await adapter.listSessions(baseUrl, 'not-a-real-token', 38);

    expect(sessions).toBeNull();
  });

  it('signs one session out by id over DELETE', async () => {
    const adapter = new NewApiAdapter();
    const revoked = await adapter.revokeSession(baseUrl, SESSIONS_TOKEN, 38, 'stale-session');

    expect(revoked).toBe(true);
    expect(revokedSids).toEqual(['stale-session']);
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/user/sessions/stale-session')).toBe(true);
  });

  it('treats an already-gone session as signed out', async () => {
    // Two cleanup passes can race; the second must not report a failure for
    // work the first already did.
    const adapter = new NewApiAdapter();
    const revoked = await adapter.revokeSession(baseUrl, SESSIONS_TOKEN, 38, 'never-existed');

    expect(revoked).toBe(true);
    expect(revokedSids).toEqual([]);
  });

  it('detects cookie session values as session cookies for anyrouter-like deployments', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SESSION_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user');
    expect(result.apiToken).toBe('cookie-api-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && typeof r.headers.cookie === 'string' && r.headers.cookie.includes(`session=${COOKIE_SESSION_TOKEN}`)),
    ).toBe(true);
  });

  it('auto-probes New-Api-User for cookie sessions when header is required', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_REQUIRES_USER_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('cookie-user-id-required');
    expect(result.apiToken).toBe('cookie-user-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '8899'),
    ).toBe(true);
  });

  it('sends X-User-Id for cookie sessions when the site requires that New API variant', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_REQUIRES_X_USER_ID_TOKEN, 448);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('x-user-id-cookie-user');
    expect(result.apiToken).toBe('cookie-x-user-id-key');
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['x-user-id'] === '448'),
    ).toBe(true);
    expect(
      requests.some((r) => r.url?.startsWith('/api/token/') && r.headers['x-user-id'] === '448'),
    ).toBe(true);
  });

  it('solves anyrouter acw challenge and probes user id from session payload', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('linuxdo_131936');
    expect(typeof result.apiToken === 'string' && result.apiToken.length > 0).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/self' &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('reports an edge-throttled verification as rate limited instead of an invalid token', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.verifyToken(baseUrl, EDGE_THROTTLED_TOKEN);

    expect(result.tokenType).toBe('unknown');
    expect(result.failureReason).toBe('rate-limited');
  });

  it('retries an edge-throttled anyrouter call before reporting the site as busy', async () => {
    const adapter = new AnyRouterAdapter();
    const result = await adapter.verifyToken(baseUrl, EDGE_THROTTLE_ONCE_TOKEN);

    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('linuxdo_166294');
    expect(
      requests.filter(
        (r) =>
          r.url === '/api/user/self' &&
          r.headers.authorization === `Bearer ${EDGE_THROTTLE_ONCE_TOKEN}` &&
          typeof r.headers.cookie === 'string' &&
          r.headers.cookie.includes(`acw_sc__v2=${ANYROUTER_CHALLENGE_ACW}`),
      ).length,
    ).toBeGreaterThan(1);
  });

  it('treats a bare 429 with no body as the edge rate limit it is', () => {
    expect(isEdgeRateLimitResponse(429, null, '')).toBe(true);
    // 403 and 503 are only a throttle when the edge says so in the body.
    expect(isEdgeRateLimitResponse(403, null, '')).toBe(false);
  });

  it('reveals a masked key through the per-row endpoint instead of settling for the placeholder', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    const revealCalls: string[] = [];
    server = createServer((req, res) => {
      if (req.url === '/api/token/?p=0&size=100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: { items: [{ id: 10384, name: 'claude', key: 'C5XJ**********Lemx', status: 1 }] },
        }));
        return;
      }
      if (req.url === '/api/token/10384/key') {
        revealCalls.push(`${req.method} ${req.url}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: { key: 'C5XJ2kZ9T0J3so8Ag0FlrqDHabunCrqOqfPTfRy5MTvCLemx' },
          success: true,
        }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const adapter = new NewApiAdapter();
    const tokens = await adapter.getApiTokens(baseUrl, 'session-token', 6597);

    expect(tokens[0].key).toBe('C5XJ2kZ9T0J3so8Ag0FlrqDHabunCrqOqfPTfRy5MTvCLemx');
    expect(revealCalls).toEqual(['POST /api/token/10384/key']);
  });

  it('keeps the masked placeholder when the fork has no reveal endpoint', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    server = createServer((req, res) => {
      if (req.url === '/api/token/?p=0&size=100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: { items: [{ id: 7, name: 'plain', key: 'FULL-PLAINTEXT-KEY', status: 1 },
            { id: 8, name: 'hidden', key: 'C5XJ**********Lemx', status: 1 }] },
        }));
        return;
      }
      // No reveal route on this fork: every attempt is a 404.
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const adapter = new NewApiAdapter();
    const tokens = await adapter.getApiTokens(baseUrl, 'session-token', 6597);

    expect(tokens.map((t) => t.key)).toEqual(['FULL-PLAINTEXT-KEY', 'C5XJ**********Lemx']);
  });

  it('reports a throttled refresh exchange as a rate limit instead of a dead credential', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    const seen: Array<{ url?: string; authorization?: string }> = [];
    server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: String(req.headers.authorization || '') });
      if (req.url === '/api/user/auth/refresh') {
        // The shape this relay's edge uses for a throttled caller: a bare
        // status, no body, nothing to parse and no marker to match on.
        res.writeHead(429).end();
        return;
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'invalid access token' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const adapter = new NewApiAdapter();
    await expect(adapter.getBalance(baseUrl, `new_api_refresh=${REFRESH_LOGIN_COOKIE}`))
      .rejects.toThrow('站点当前限流');

    expect(seen.some((r) => r.url === '/api/user/auth/refresh')).toBe(true);
    // Falling through to the raw cookie as a bearer token is what turned this
    // throttle into `invalid access token` and expired the account.
    expect(seen.some((r) => r.url === '/api/user/self' || r.authorization.includes('new_api_refresh='))).toBe(false);
  });

  it('extracts gob-encoded user id from anyrouter session cookie when reading balance', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_GOB_USER_TOKEN);

    expect(balance.balance).toBe(100);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '144408'),
    ).toBe(true);
  });

  it('recovers from mismatched provided user id by probing gob-encoded session payload', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_GOB_USER_TOKEN, 159);

    expect(balance.balance).toBe(100);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '159'),
    ).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/self' && r.headers['new-api-user'] === '144408'),
    ).toBe(true);
  });

  it('uses shielded cookie flow for balance and checkin', async () => {
    const adapter = new NewApiAdapter();
    const balance = await adapter.getBalance(baseUrl, COOKIE_SHIELDED_TOKEN);
    const checkin = await adapter.checkin(baseUrl, COOKIE_SHIELDED_TOKEN);

    expect(balance).toEqual({
      quota: 8.4,
      used: 2.4,
      balance: 6,
    });
    expect(checkin.success).toBe(true);
    expect(
      requests.some((r) => r.url === '/api/user/checkin' && r.headers['new-api-user'] === '131936'),
    ).toBe(true);
  });

  it('supports auth_token-style session cookies when sign_in requires a user header', async () => {
    const adapter = new NewApiAdapter();
    const checkin = await adapter.checkin(baseUrl, `auth_token=${AUTH_TOKEN_SIGNIN_ONLY_TOKEN}`);

    expect(checkin).toEqual({
      success: true,
      message: 'checked-in-via-sign-in',
      reward: undefined,
    });
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/self'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(`auth_token=${AUTH_TOKEN_SIGNIN_ONLY_TOKEN}`)
          && r.headers['new-api-user'] === '5566',
      ),
    ).toBe(true);
    expect(
      requests.some(
        (r) =>
          r.url === '/api/user/sign_in'
          && typeof r.headers.cookie === 'string'
          && r.headers.cookie.includes(`auth_token=${AUTH_TOKEN_SIGNIN_ONLY_TOKEN}`)
          && r.headers['new-api-user'] === '5566',
      ),
    ).toBe(true);
  });

  it('preserves upstream balance failure message for UI feedback', async () => {
    const adapter = new NewApiAdapter();

    await expect(adapter.getBalance(baseUrl, BALANCE_FAIL_TOKEN)).rejects.toThrow('access token');
  });

  it('prefers post-challenge cookie failure over raw html parse error when reading balance', async () => {
    const adapter = new AnyRouterAdapter();

    await expect(adapter.getBalance(baseUrl, BALANCE_SHIELD_FAILURE_TOKEN)).rejects
      .toThrow('无权进行此操作，未登录且未提供 access token');
  });

  it('preserves nested checkin error message instead of generic fallback', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid URL');
  });

  it('prefers cookie session auth failure over invalid-url fallback when cookie session is expired', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_EXPIRED_SESSION_TOKEN, 131936);

    expect(result.success).toBe(false);
    expect(result.message).toContain('access token');
    expect(result.message).not.toContain('Invalid URL');
  });

  it('treats forbidden self probe responses as cookie session auth failures', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_INVALID_URL_FORBIDDEN_SESSION_TOKEN, 131936);

    expect(result.success).toBe(false);
    expect(result.message).toContain('forbidden');
    expect(result.message).not.toContain('Invalid URL');
  });

  it('summarizes cloudflare tunnel HTML failures to concise checkin error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_CLOUDFLARE_530_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('HTTP 530: Cloudflare Tunnel error (Error 1033)');
  });

  it('preserves already-checked-in message instead of overriding with cookie fallback error', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_ALREADY_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('今天已经签到过啦');
  });

  it('runs the declared external wheel instead of the relay check-in route', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, 'relay-session-token', 11494, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({ externalCheckin: { cookieHeader: `auth_token=${EXTERNAL_WHEEL_TOKEN}` } }),
    });

    expect(result).toEqual({
      success: true,
      message: '恭喜获得 300次！',
      reward: '300次',
    });
    expect(requests.some((r) => r.url === '/api/checkin/spin')).toBe(true);
    expect(requests.some((r) => r.url === '/api/user/daily')).toBe(false);
  });

  it('reports an unbound external wheel session instead of falling back to the relay', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, 'relay-session-token', 11494, {
      externalCheckinUrl: baseUrl,
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('未绑定');
    expect(requests.some((r) => r.url === '/api/user/daily')).toBe(false);
  });

  it('checks in through /api/user/daily on forks that moved the endpoint', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_DAILY_TOKEN, 11494);

    expect(result).toEqual({
      success: true,
      message: '签到成功',
      reward: '3.57502',
    });
    expect(requests.some((r) => r.url === '/api/user/daily')).toBe(true);
    expect(requests.some((r) => r.url === '/api/user/checkin')).toBe(false);
  });

  it('keeps the daily already-checked-in verdict instead of probing the fake legacy route', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_DAILY_ALREADY_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('今日已签到');
    expect(requests.some((r) => r.url === '/api/user/checkin')).toBe(false);
  });

  it('falls back to the legacy checkin endpoint when daily is missing', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_LEGACY_TOKEN, 11494);

    expect(result).toEqual({
      success: true,
      message: 'checked-in-legacy',
      reward: '0.000246',
    });
    const dailyIndex = requests.findIndex((r) => r.url === '/api/user/daily');
    const legacyIndex = requests.findIndex((r) => r.url === '/api/user/checkin');
    expect(dailyIndex).toBeGreaterThanOrEqual(0);
    expect(legacyIndex).toBeGreaterThan(dailyIndex);
  });

  it('reaches the agent-program check-in when the fork disabled the generic one', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_AGENT_PROGRAM_TOKEN, 11494);

    expect(result).toEqual({
      success: true,
      message: '签到成功',
      reward: '20',
    });
    expect(requests.some((r) => r.url === '/api/user/sota-agent-checkin')).toBe(true);
    const agentRequest = requests.find((r) => r.url === '/api/user/sota-agent-checkin');
    expect(agentRequest?.headers['new-api-user']).toBe('11494');
  });

  it('reports the agent-program already-checked-in verdict', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_AGENT_PROGRAM_ALREADY_TOKEN, 11494);

    expect(result.success).toBe(false);
    expect(result.message).toBe('今日已签到');
  });

  it('keeps the disabled-feature verdict when the agent-program route is missing', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, CHECKIN_FEATURE_OFF_TOKEN, 11494);

    // The probe is attempted - the standard routes did report the feature as
    // off - but the missing route leaves the site's own verdict in place.
    expect(requests.some((r) => r.url === '/api/user/sota-agent-checkin')).toBe(true);
    expect(result.success).toBe(false);
    expect(result.message).toBe('签到功能未启用');
  });

  it('does not probe the agent-program route when the generic check-in answers', async () => {
    const adapter = new NewApiAdapter();
    await adapter.checkin(baseUrl, CHECKIN_DAILY_TOKEN, 11494);

    expect(requests.some((r) => r.url === '/api/user/sota-agent-checkin')).toBe(false);
  });

  it('uses the daily endpoint for cookie credentials as well', async () => {
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, `session=${CHECKIN_DAILY_COOKIE_TOKEN}`, 131936);

    expect(result).toEqual({
      success: true,
      message: 'checked-in-daily-cookie',
      reward: '0.00111',
    });
    expect(requests.some((r) => r.url === '/api/user/checkin')).toBe(false);
  });

  it('returns clean groups from data object without envelope keys', async () => {
    const adapter = new NewApiAdapter();
    const groups = await adapter.getUserGroups(baseUrl, 'session-token', 11494);

    expect(groups).toEqual(['default', 'gemini']);
    expect(groups).not.toContain('success');
    expect(groups).not.toContain('message');
  });

  it('throws expired-session error when group endpoint reports invalid access token', async () => {
    const adapter = new NewApiAdapter();
    await expect(adapter.getUserGroups(baseUrl, GROUP_EXPIRED_TOKEN, 11494)).rejects.toThrow('账号会话可能已过期');
  });

  it('sends all compatibility user-id headers when userId is known', async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
    const receivedHeaders: Record<string, string> = {};
    server = createServer((req, res) => {
      for (const name of ['new-api-user', 'veloera-user', 'voapi-user', 'user-id', 'rix-api-user', 'neo-api-user']) {
        const val = req.headers[name];
        if (val) receivedHeaders[name] = String(val);
      }
      if (req.url === '/api/user/self') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data: { id: 42, username: 'test', quota: 500000, used_quota: 0 } }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    const adapter = new NewApiAdapter();
    const fakeJwt = `header.${Buffer.from(JSON.stringify({ id: 42 })).toString('base64url')}.sig`;
    await adapter.getBalance(baseUrl, fakeJwt, 42);

    expect(receivedHeaders['new-api-user']).toBe('42');
    expect(receivedHeaders['veloera-user']).toBe('42');
    expect(receivedHeaders['voapi-user']).toBe('42');
    expect(receivedHeaders['user-id']).toBe('42');
    expect(receivedHeaders['rix-api-user']).toBe('42');
    expect(receivedHeaders['neo-api-user']).toBe('42');
  });

  it('normalizes the global site notice from /api/notice', async () => {
    const adapter = new NewApiAdapter();
    const rows = await adapter.getSiteAnnouncements(baseUrl, 'session-token');

    expect(rows).toEqual([
      {
        sourceKey: `notice:${createHash('sha1').update('Welcome to the site').digest('hex')}`,
        title: 'Site notice',
        content: 'Welcome to the site',
        level: 'info',
        sourceUrl: '/api/notice',
        rawPayload: { success: true, data: 'Welcome to the site' },
      },
    ]);
  });
});
