import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { Sub2ApiAdapter } from './sub2api.js';
import {
  clearModelContextLengthCache,
  getModelContextLength,
} from '../modelContextLengthCache.js';

describe('Sub2ApiAdapter', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl: string;
  let adapter: Sub2ApiAdapter;

  beforeEach(() => {
    adapter = new Sub2ApiAdapter();
  });

  afterEach(async () => {
    if (server) {
      const s = server;
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        s.close((err?: Error) => (err ? reject(err) : resolve()));
      });
    }
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void) {
    return new Promise<void>((resolve) => {
      server = createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('detects sub2api from URL', async () => {
    expect(await adapter.detect('https://sub2api.example.com')).toBe(true);
    expect(await adapter.detect('https://example.com')).toBe(false);
  });

  it('detects sub2api by auth/me unauthorized envelope even without sub2api domain', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 'UNAUTHORIZED',
          message: 'Authorization header is required',
        }));
        return;
      }
      if (req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 'API_KEY_REQUIRED',
          message: 'API key is required',
        }));
        return;
      }
      res.writeHead(404).end();
    });

    expect(await adapter.detect(baseUrl)).toBe(true);
  });

  it('does not mis-detect generic json 401 responses', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me' || req.url === '/v1/models') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>Not Sub2</title></head><body></body></html>');
    });

    expect(await adapter.detect(baseUrl)).toBe(false);
  });

  it('returns unsupported for checkin when the platform exposes no check-in route', async () => {
    await startServer((_req, res) => { res.writeHead(404).end(); });

    const result = await adapter.checkin(baseUrl, 'token');
    expect(result.success).toBe(false);
    expect(result.message).toContain('not supported');
  });

  it('checks in on the platform itself when the day is still claimable', async () => {
    let posted = false;
    await startServer((req, res) => {
      if (req.url === '/api/v1/check-in/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { enabled: true, checked_in_today: false, turnstile_required: false } }));
        return;
      }
      if (req.url === '/api/v1/check-in' && req.method === 'POST') {
        posted = true;
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
          expect(JSON.parse(rawBody || '{}')).toEqual({ turnstile_token: '' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 0, data: { checked_in_today: true, today_reward: 8 } }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin(baseUrl, 'jwt-token');

    expect(posted).toBe(true);
    expect(result).toMatchObject({ success: true, reward: '8' });
    expect(result.message).toContain('8');
  });

  it('reports the already-checked-in day without posting', async () => {
    let posted = false;
    await startServer((req, res) => {
      if (req.url === '/api/v1/check-in/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { enabled: true, checked_in_today: true, today_reward: 8 } }));
        return;
      }
      if (req.url === '/api/v1/check-in') posted = true;
      res.writeHead(404).end();
    });

    const result = await adapter.checkin(baseUrl, 'jwt-token');

    expect(posted).toBe(false);
    expect(result.success).toBe(false);
    expect(result.message).toContain('今日已签到');
  });

  it('reports the Turnstile gate on the platform check-in', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/check-in/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { enabled: true, checked_in_today: false, turnstile_required: true } }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin(baseUrl, 'jwt-token');

    expect(result.success).toBe(false);
    expect(result.message).toContain('Turnstile');
  });

  it('reports the disabled platform check-in as unsupported', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/check-in/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0, data: { enabled: false, checked_in_today: false } }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin(baseUrl, 'jwt-token');

    expect(result.success).toBe(false);
    expect(result.message).toContain('未启用');
  });

  it('logs in with email and password via /api/v1/auth/login', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
          const body = JSON.parse(rawBody || '{}');
          expect(body.email).toBe('user@example.com');
          expect(body.password).toBe('secret');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              access_token: 'jwt-access',
              refresh_token: 'rt-1',
              expires_in: 86400,
              user: { id: 341, username: '柳眉积翠', email: 'user@example.com' },
            },
          }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.login(baseUrl, 'user@example.com', 'secret');
    expect(result).toMatchObject({
      success: true,
      accessToken: 'jwt-access',
      username: '柳眉积翠',
      platformUserId: 341,
    });
  });

  it('surfaces the site message when login is rejected', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/login' && req.method === 'POST') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 401, message: 'invalid email or password', reason: 'INVALID_CREDENTIALS' }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.login(baseUrl, 'user@example.com', 'wrong');
    expect(result.success).toBe(false);
    expect(result.message).toContain('invalid email or password');
  });

  it('checks in on the external welfare site with the captured session', async () => {
    let seenCookie = '';
    let seenBody: any = null;
    await startServer((req, res) => {
      if (req.url === '/api/checkin' && req.method === 'POST') {
        seenCookie = String(req.headers.cookie || '');
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
          seenBody = JSON.parse(rawBody || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, amount: 10, userId: '341' }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 341, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({ externalCheckin: { cookieHeader: 'sidv=abc' } }),
    });

    expect(result).toMatchObject({ success: true, reward: '10' });
    expect(result.message).toContain('10');
    expect(seenCookie).toBe('sidv=abc');
    expect(seenBody).toEqual({ userId: '341', mode: 'normal' });
  });

  it('passes the configured check-in mode through to the welfare site', async () => {
    let seenBody: any = null;
    await startServer((req, res) => {
      if (req.url === '/api/checkin' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
          seenBody = JSON.parse(rawBody || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, amount: 7, userId: '341' }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 341, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({
        platformUserId: 341,
        externalCheckin: { cookieHeader: 'sidv=abc', mode: 'lucky' },
      }),
    });

    expect(result.success).toBe(true);
    expect(seenBody).toEqual({ userId: '341', mode: 'lucky' });
  });

  it('reports the already-checked-in message from the welfare site', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/checkin' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, already: true, error: '今天已经签到过了，明天再来吧' }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 341, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({ externalCheckin: { cookieHeader: 'sidv=abc' } }),
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('已经签到');
  });

  it('reports an expired welfare session on HTTP 401', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/checkin' && req.method === 'POST') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '未登录' }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 341, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({ externalCheckin: { cookieHeader: 'sidv=stale' } }),
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('LinuxDo');
  });

  it('mints a welfare session through the main site SSO and sends the validity option', async () => {
    let ssoAuth = '';
    let ssoBody: any = null;
    let exchangeBody: any = null;
    let statusAuth = '';
    let checkinAuth = '';
    let checkinBody: any = null;

    await startServer((req, res) => {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const readBody = (run: (body: any) => void) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => run(raw ? JSON.parse(raw) : {}));
      };

      if (req.url === '/api/v1/sso/code' && req.method === 'POST') {
        ssoAuth = String(req.headers.authorization || '');
        readBody((body) => {
          ssoBody = body;
          json(200, { code: 0, message: 'success', data: { code: 'sso-code-1', state: body.state } });
        });
        return;
      }
      if (req.url === '/api/auth/sso/exchange' && req.method === 'POST') {
        readBody((body) => {
          exchangeBody = body;
          json(200, { code: 0, message: 'success', data: { access_token: 'welfare-token-1' } });
        });
        return;
      }
      if (req.url === '/api/checkin/status') {
        statusAuth = String(req.headers.authorization || '');
        json(200, {
          code: 0,
          message: 'success',
          data: {
            enabled: true,
            checked_in_today: false,
            can_check_in: true,
            validity_choice_enabled: true,
            validity_policy_version: 3,
          },
        });
        return;
      }
      if (req.url === '/api/checkin' && req.method === 'POST') {
        checkinAuth = String(req.headers.authorization || '');
        readBody((body) => {
          checkinBody = body;
          json(200, {
            code: 0,
            message: 'success',
            data: {
              status: 'pending_credit',
              amount: 0.76,
              validity_option_id: 'permanent',
              validity_label_snapshot: '永久',
            },
          });
        });
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin(baseUrl, 'main-site-token', 2975, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({
        externalCheckin: { ssoClientId: 'welfare', userId: 6130, validityOptionId: 'permanent' },
      }),
    });

    expect(result.success).toBe(true);
    expect(result.reward).toBe('0.76');
    expect(result.message).toContain('永久');
    expect(ssoAuth).toBe('Bearer main-site-token');
    expect(ssoBody.client_id).toBe('welfare');
    expect(ssoBody.redirect_uri).toBe(`${baseUrl}/auth/callback`);
    expect(typeof ssoBody.state).toBe('string');
    expect(ssoBody.state.length).toBeGreaterThan(0);
    expect(exchangeBody.code).toBe('sso-code-1');
    expect(exchangeBody.state).toBe(ssoBody.state);
    expect(statusAuth).toBe('Bearer welfare-token-1');
    expect(checkinAuth).toBe('Bearer welfare-token-1');
    expect(checkinBody).toEqual({ validity_option_id: 'permanent', validity_policy_version: 3 });
  });

  it('uses the stored bearer token when the welfare binding has no SSO client id', async () => {
    let seenAuth = '';
    await startServer((req, res) => {
      const json = (payload: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/checkin/status') {
        json({ code: 0, message: 'success', data: { enabled: true, checked_in_today: false, can_check_in: true } });
        return;
      }
      if (req.url === '/api/checkin' && req.method === 'POST') {
        seenAuth = String(req.headers.authorization || '');
        json({ code: 0, message: 'success', data: { status: 'credited', amount: 4 } });
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 2975, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({ externalCheckin: { bearerToken: 'welfare-bearer' } }),
    });

    expect(result).toMatchObject({ success: true, reward: '4' });
    expect(seenAuth).toBe('Bearer welfare-bearer');
  });

  it('reports the welfare validity service check-in as already done today', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/checkin/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { enabled: true, checked_in_today: true, can_check_in: false },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 2975, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({ externalCheckin: { bearerToken: 'welfare-bearer' } }),
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('今日已签到');
  });

  it('reports an expired welfare bearer session on HTTP 401', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/checkin/status') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 401, message: 'missing bearer token' }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 2975, {
      externalCheckinUrl: baseUrl,
      extraConfig: JSON.stringify({ externalCheckin: { bearerToken: 'stale-bearer' } }),
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('会话已失效');
  });

  it('asks for the welfare session when none is bound', async () => {
    const result = await adapter.checkin('https://api.example.com', 'jwt-token', 341, {
      externalCheckinUrl: 'https://checkin.example.com',
      extraConfig: JSON.stringify({ platformUserId: 341 }),
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('未绑定');
  });

  it('fetches balance from /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 12.5 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const balance = await adapter.getBalance(baseUrl, 'jwt-token');
    expect(balance.balance).toBeGreaterThan(0);
    expect(balance.used).toBe(0);
  });

  it('includes subscription summary from /api/v1/subscriptions/summary when available', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 12.5 },
        }));
        return;
      }
      if (req.url === '/api/v1/subscriptions/summary') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            active_count: 1,
            total_used_usd: 3.75,
            subscriptions: [
              {
                id: 3,
                group_name: 'Pro',
                status: 'active',
                expires_at: '2026-04-01T00:00:00Z',
                monthly_used_usd: 3.75,
                monthly_limit_usd: 20,
              },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const balance = await adapter.getBalance(baseUrl, 'jwt-token');
    expect(balance.subscriptionSummary).toEqual({
      activeCount: 1,
      totalUsedUsd: 3.75,
      subscriptions: [
        {
          id: 3,
          groupName: 'Pro',
          status: 'active',
          expiresAt: '2026-04-01T00:00:00.000Z',
          monthlyUsedUsd: 3.75,
          monthlyLimitUsd: 20,
        },
      ],
    });
  });

  it('falls back to active subscriptions when summary endpoint is unavailable', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 12.5 },
        }));
        return;
      }
      if (req.url === '/api/v1/subscriptions/summary') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'not found' }));
        return;
      }
      if (req.url === '/api/v1/subscriptions/active') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: [
            {
              id: 9,
              group_name: 'Fallback',
              expires_at: '2026-05-01T00:00:00Z',
              monthly_used_usd: 2.5,
              monthly_limit_usd: 15,
            },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const balance = await adapter.getBalance(baseUrl, 'jwt-token');
    expect(balance.subscriptionSummary).toEqual({
      activeCount: 1,
      totalUsedUsd: 2.5,
      subscriptions: [
        {
          id: 9,
          groupName: 'Fallback',
          expiresAt: '2026-05-01T00:00:00.000Z',
          monthlyUsedUsd: 2.5,
          monthlyLimitUsd: 15,
        },
      ],
    });
  });

  it('fetches user info from /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 5.0 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const userInfo = await adapter.getUserInfo(baseUrl, 'jwt-token');
    expect(userInfo).not.toBeNull();
    expect(userInfo!.username).toBe('testuser');
  });

  it('falls back to email local part when username is empty', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: '', email: 'alice@example.com', balance: 0 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const userInfo = await adapter.getUserInfo(baseUrl, 'jwt-token');
    expect(userInfo!.username).toBe('alice');
  });

  it('fetches models via /v1/models', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'gpt-4o' }, { id: 'claude-3-opus' }],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(baseUrl, 'jwt-token');
    expect(models).toEqual(['gpt-4o', 'claude-3-opus']);
  });

  it('caches context lengths from model discovery under the provided scope', async () => {
    clearModelContextLengthCache();
    await startServer((req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'gpt-4o', context_length: 128000 }],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const scope = 'account:sub2api-context-test';
    await adapter.getModels(baseUrl, 'jwt-token', undefined, scope);

    expect(getModelContextLength('gpt-4o', scope)).toBe(128000);
  });

  it('fetches gemini models via /v1beta/models when ai base url already targets gemini endpoint', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1beta/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash' },
            { name: 'models/gemini-2.5-pro' },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(`${baseUrl}/v1beta`, 'gemini-key');
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('falls back to /v1beta/models when openai-compatible model endpoints are unavailable', async () => {
    await startServer((req, res) => {
      if (req.url === '/v1/models' || req.url === '/api/v1/models') {
        res.writeHead(404).end();
        return;
      }
      if (req.url === '/v1beta/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash-lite' },
            { name: 'models/gemini-3-pro-preview' },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(baseUrl, 'gemini-key');
    expect(models).toEqual(['gemini-2.5-flash-lite', 'gemini-3-pro-preview']);
  });

  it('uses the api/v1 model endpoint directly when the ai base already includes /api/v1', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ id: 'gpt-4o-mini' }, { id: 'claude-3-5-sonnet' }],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(`${baseUrl}/api/v1`, 'jwt-token');
    expect(models).toEqual(['gpt-4o-mini', 'claude-3-5-sonnet']);
  });

  it('fetches models via api key discovered from /api/v1/keys when JWT cannot call /v1/models directly', async () => {
    await startServer((req, res) => {
      const auth = req.headers.authorization || '';
      if (req.url === '/v1/models' && auth === 'Bearer jwt-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 'API_KEY_REQUIRED',
          message: 'API key is required',
        }));
        return;
      }
      if (req.url === '/api/v1/keys?page=1&page_size=100' && auth === 'Bearer jwt-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 1, key: 'sk-sub2-active', name: 'default', status: 'active' },
              { id: 2, key: 'sk-sub2-disabled', name: 'old', status: 'inactive' },
            ],
          },
        }));
        return;
      }
      if (req.url === '/v1/models' && auth === 'Bearer sk-sub2-active') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'gpt-4o-mini' }, { id: 'claude-3-5-sonnet' }],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(baseUrl, 'jwt-token');
    expect(models).toEqual(['gpt-4o-mini', 'claude-3-5-sonnet']);
  });

  it('discovers an api key for gemini /v1beta/models when session JWT cannot call the endpoint directly', async () => {
    await startServer((req, res) => {
      const auth = req.headers.authorization || '';
      if (req.url === '/v1beta/models' && auth === 'Bearer jwt-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 401,
            message: 'API key is required',
            status: 'UNAUTHENTICATED',
          },
        }));
        return;
      }
      if (req.url === '/api/v1/keys?page=1&page_size=100' && auth === 'Bearer jwt-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 1, key: 'sk-sub2-gemini', name: 'gemini', status: 'active' },
            ],
          },
        }));
        return;
      }
      if (req.url === '/v1beta/models' && auth === 'Bearer sk-sub2-gemini') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash' },
            { name: 'models/gemini-3.1-pro-preview' },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(`${baseUrl}/v1beta`, 'jwt-token');
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-3.1-pro-preview']);
  });

  it('strips a bare antigravity suffix before listing api keys for jwt fallback', async () => {
    await startServer((req, res) => {
      const auth = req.headers.authorization || '';
      if (req.url === '/antigravity/v1beta/models' && auth === 'Bearer jwt-token') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            code: 401,
            message: 'API key is required',
            status: 'UNAUTHENTICATED',
          },
        }));
        return;
      }
      if (req.url === '/api/v1/keys?page=1&page_size=100' && auth === 'Bearer jwt-token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 1, key: 'sk-sub2-antigravity', name: 'gemini', status: 'active' },
            ],
          },
        }));
        return;
      }
      if (req.url === '/antigravity/v1beta/models' && auth === 'Bearer sk-sub2-antigravity') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash' },
            { name: 'models/gemini-2.5-pro' },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const models = await adapter.getModels(`${baseUrl}/antigravity`, 'jwt-token');
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
  });

  it('handles non-zero code as error in /api/v1/auth/me', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 401,
          message: 'token expired',
          data: null,
        }));
        return;
      }
      res.writeHead(404).end();
    });

    await expect(adapter.getBalance(baseUrl, 'expired-token')).rejects.toThrow();
  });

  it('login returns unsupported', async () => {
    const result = await adapter.login('http://localhost', 'user', 'pass');
    expect(result.success).toBe(false);
  });

  it('accepts bearer-prefixed access tokens when verifying session tokens', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/auth/me') {
        const auth = req.headers.authorization || '';
        if (auth !== 'Bearer jwt-token') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 401, message: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 1, username: 'testuser', email: 'test@example.com', balance: 5.0 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const result = await adapter.verifyToken(baseUrl, 'Bearer jwt-token');
    expect(result.tokenType).toBe('session');
    expect(result.userInfo?.username).toBe('testuser');
  });

  it('lists api keys when access token includes Bearer prefix', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/keys?page=1&page_size=100') {
        const auth = req.headers.authorization || '';
        if (auth !== 'Bearer jwt-token') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 401, message: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 11, key: 'sk-active', name: 'default', status: 'active' },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const tokens = await adapter.getApiTokens(baseUrl, 'Bearer jwt-token');
    expect(tokens).toEqual([{ key: 'sk-active', name: 'default', enabled: true }]);
  });

  it('lists api keys from /api/v1/keys and picks active key as default api token', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/keys?page=1&page_size=100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 10, key: 'sk-disabled', name: 'old', status: 'inactive' },
              { id: 11, key: 'sk-active', name: 'default', status: 'active' },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const tokens = await adapter.getApiTokens(baseUrl, 'jwt-token');
    expect(tokens).toEqual([
      { key: 'sk-disabled', name: 'old', enabled: false },
      { key: 'sk-active', name: 'default', enabled: true },
    ]);
    expect(await adapter.getApiToken(baseUrl, 'jwt-token')).toBe('sk-active');
  });

  it('fetches user groups from /api/v1/groups', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/groups?page=1&page_size=100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 1, name: 'default' },
              { id: 2, name: 'vip' },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const groups = await adapter.getUserGroups(baseUrl, 'jwt-token');
    expect(groups).toEqual(['1', '2']);
  });

  it('fetches user groups from /api/v1/groups/available', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/groups/available') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: [
            { id: 5, name: 'basic' },
            { id: 6, name: 'pro' },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const groups = await adapter.getUserGroups(baseUrl, 'jwt-token');
    expect(groups).toEqual(['5', '6']);
  });

  it('falls back to infer groups from /api/v1/keys when group endpoint is unavailable', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/groups?page=1&page_size=100') {
        res.writeHead(404).end();
        return;
      }
      if (req.url === '/api/v1/groups') {
        res.writeHead(404).end();
        return;
      }
      if (req.url === '/api/v1/group?page=1&page_size=100') {
        res.writeHead(404).end();
        return;
      }
      if (req.url === '/api/v1/group') {
        res.writeHead(404).end();
        return;
      }
      if (req.url === '/api/v1/keys?page=1&page_size=100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 11, key: 'sk-1', group_id: 7, status: 'active' },
              { id: 12, key: 'sk-2', group_id: 7, status: 'inactive' },
              { id: 13, key: 'sk-3', group_id: 9, status: 'active' },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const groups = await adapter.getUserGroups(baseUrl, 'jwt-token');
    expect(groups).toEqual(['7', '9']);
  });

  it('creates api key via /api/v1/keys', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/keys' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
          const body = JSON.parse(rawBody || '{}');
          expect(body.name).toBe('metapi-e2e');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              id: 1,
              key: 'sk-created',
              name: body.name,
            },
          }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    const created = await adapter.createApiToken(baseUrl, 'jwt-token', undefined, { name: 'metapi-e2e' });
    expect(created).toBe(true);
  });

  // This family prints a key once, in the create response, and answers
  // `****...****` from then on. Dropping that value leaves a key on the site
  // that nothing here can route through.
  it('returns the key the create response printed', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/keys' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 7, key: 'sk-printed-once', name: 'metapi', group_id: 17 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const created = await adapter.createApiTokenWithValue(baseUrl, 'jwt-token', undefined, {
      name: 'metapi',
      group: '17',
    });

    expect(created).toEqual({ name: 'metapi', key: 'sk-printed-once', tokenGroup: '17' });
  });

  it('reports no value when the create response is masked too', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/keys' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 8, key: '****...****', name: 'metapi', group_id: 17 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const created = await adapter.createApiTokenWithValue(baseUrl, 'jwt-token', undefined, { name: 'metapi' });

    // A placeholder is not a key: the caller must fall back to the listing
    // rather than storing something unusable as if it were real.
    expect(created?.key).toBeNull();
  });

  it('binds an available group when creating a key without an explicit group', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/groups/available') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: [
            { id: 5, name: 'vip', status: 'active' },
            { id: 6, name: 'free', status: 'active' },
          ],
        }));
        return;
      }
      if (req.url === '/api/v1/keys' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
          const body = JSON.parse(rawBody || '{}');
          expect(body.group_id).toBe(6);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            message: 'success',
            data: { id: 1, key: 'sk-created', name: body.name, group_id: body.group_id },
          }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    const created = await adapter.createApiToken(baseUrl, 'jwt-token', undefined, { name: 'metapi-e2e' });
    expect(created).toBe(true);
  });

  it('falls back to a group-less create when the site rejects the group-bound payload', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/groups/available') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: [{ id: 6, name: 'free', status: 'active' }],
        }));
        return;
      }
      if (req.url === '/api/v1/keys' && req.method === 'POST') {
        let rawBody = '';
        req.on('data', (chunk) => { rawBody += chunk; });
        req.on('end', () => {
          const body = JSON.parse(rawBody || '{}');
          if (body.group_id === 6) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 400, message: 'invalid group' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            message: 'success',
            data: { id: 2, key: 'sk-created', name: body.name },
          }));
        });
        return;
      }
      res.writeHead(404).end();
    });

    const created = await adapter.createApiToken(baseUrl, 'jwt-token', undefined, { name: 'metapi-e2e' });
    expect(created).toBe(true);
  });

  it('deletes api key by key value via /api/v1/keys/:id', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/keys?page=1&page_size=100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              { id: 31, key: 'sk-delete-me', name: 'to-delete', status: 'active' },
            ],
          },
        }));
        return;
      }
      if (req.url === '/api/v1/keys/31' && req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: { id: 31 },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const deleted = await adapter.deleteApiToken(baseUrl, 'jwt-token', 'sk-delete-me');
    expect(deleted).toBe(true);
  });

  it('normalizes announcements from /api/v1/announcements', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/announcements?page=1&page_size=100') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            items: [
              {
                id: 11,
                title: 'Maintenance',
                content: 'Window starts at 10:00',
                starts_at: '2026-03-20T10:00:00Z',
                ends_at: '2026-03-20T12:00:00Z',
                created_at: '2026-03-20T09:00:00Z',
                updated_at: '2026-03-20T09:30:00Z',
              },
              {
                id: 12,
                title: 'New model online',
                content: 'gpt-4.1 is available',
                read_at: '2026-03-20T12:05:00Z',
                created_at: '2026-03-20T12:00:00Z',
                updated_at: '2026-03-20T12:01:00Z',
              },
            ],
          },
        }));
        return;
      }
      res.writeHead(404).end();
    });

    const rows = await adapter.getSiteAnnouncements(baseUrl, 'jwt-token');

    expect(rows).toEqual([
      {
        sourceKey: 'announcement:11',
        title: 'Maintenance',
        content: 'Window starts at 10:00',
        level: 'info',
        startsAt: '2026-03-20T10:00:00Z',
        endsAt: '2026-03-20T12:00:00Z',
        upstreamCreatedAt: '2026-03-20T09:00:00Z',
        upstreamUpdatedAt: '2026-03-20T09:30:00Z',
        rawPayload: {
          id: 11,
          title: 'Maintenance',
          content: 'Window starts at 10:00',
          starts_at: '2026-03-20T10:00:00Z',
          ends_at: '2026-03-20T12:00:00Z',
          created_at: '2026-03-20T09:00:00Z',
          updated_at: '2026-03-20T09:30:00Z',
        },
      },
      {
        sourceKey: 'announcement:12',
        title: 'New model online',
        content: 'gpt-4.1 is available',
        level: 'info',
        upstreamCreatedAt: '2026-03-20T12:00:00Z',
        upstreamUpdatedAt: '2026-03-20T12:01:00Z',
        rawPayload: {
          id: 12,
          title: 'New model online',
          content: 'gpt-4.1 is available',
          read_at: '2026-03-20T12:05:00Z',
          created_at: '2026-03-20T12:00:00Z',
          updated_at: '2026-03-20T12:01:00Z',
        },
      },
    ]);
  });

  // --- Daily lottery ---

  it('reads the lottery state from the site envelope', async () => {
    await startServer((req, res) => {
      if (req.url === '/api/v1/lottery/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          code: 0,
          message: 'success',
          data: {
            enabled: true,
            window_open: true,
            can_draw: true,
            today_draws: 4,
            daily_draw_limit: 10,
            today_remaining: 6,
            bonus_draws: 2,
            free_balance: 880.5,
            costs: { free: { enabled: true, amount: '88' } },
            batch_draw: { enabled: true, max_count: 3 },
          },
        }));
        return;
      }
      res.writeHead(404).end('page not found');
    });

    expect(await adapter.getLotteryStatus(baseUrl, 'jwt')).toEqual({
      enabled: true,
      canDraw: true,
      todayDraws: 4,
      dailyDrawLimit: 10,
      todayRemaining: 6,
      bonusDraws: 2,
      freeBalance: 880.5,
      batchMax: 3,
      freeCost: { enabled: true, amount: 88 },
    });
  });

  it('reports a site without a lottery route as having none, not as a failure', async () => {
    await startServer((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 page not found');
    });

    expect(await adapter.getLotteryStatus(baseUrl, 'jwt')).toBeNull();
  });

  it('draws a batch through the batch route and reads every prize', async () => {
    const bodies: any[] = [];
    await startServer((req, res) => {
      if (req.url === '/api/v1/lottery/draw-batch') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              draws: [
                { cost_type: 'free', prize_type: 'free', prize_amount_actual: 30, status: 'win' },
                { cost_type: 'free', prize_type: 'none', prize_amount_actual: 0, status: 'miss' },
                { cost_type: 'free', prize_type: 'paid', prize_amount_actual: 1, status: 'win' },
              ],
              today_draws: 7,
            },
          }));
        });
        return;
      }
      res.writeHead(404).end('page not found');
    });

    const outcome = await adapter.drawLottery(baseUrl, 'jwt', {
      costType: 'free',
      count: 3,
      idempotencyKey: 'key-1',
    });

    expect(bodies).toEqual([{ cost_type: 'free', count: 3, idempotency_key: 'key-1' }]);
    expect(outcome.todayDraws).toBe(7);
    expect(outcome.draws).toEqual([
      { costType: 'free', prizeType: 'free', prizeAmount: 30, status: 'win' },
      { costType: 'free', prizeType: 'none', prizeAmount: 0, status: 'miss' },
      { costType: 'free', prizeType: 'paid', prizeAmount: 1, status: 'win' },
    ]);
  });

  it('falls back to the single-draw route on a build that has no batch route', async () => {
    const keys: string[] = [];
    await startServer((req, res) => {
      if (req.url === '/api/v1/lottery') {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          keys.push(JSON.parse(raw).idempotency_key);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              draw: {
                cost_type: 'free',
                prize_type: 'free',
                prize_amount_actual: 100,
                status: 'win',
              },
              today_draws: 2,
            },
          }));
        });
        return;
      }
      res.writeHead(404).end('page not found');
    });

    const outcome = await adapter.drawLottery(baseUrl, 'jwt', {
      costType: 'free',
      count: 2,
      idempotencyKey: 'key-2',
    });

    expect(keys).toEqual(['key-2-0', 'key-2-1']);
    expect(outcome.todayDraws).toBe(2);
    expect(outcome.draws).toHaveLength(2);
    expect(outcome.draws[0]).toEqual({
      costType: 'free',
      prizeType: 'free',
      prizeAmount: 100,
      status: 'win',
    });
  });
});
