import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { readAuthTokenCookie, runMintWheelCheckin, upsertAuthTokenCookie } from './mintWheelCheckin.js';

describe('runMintWheelCheckin', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl: string;
  let seen: { method?: string; url?: string; headers?: Record<string, string | string[] | undefined> } = {};

  beforeEach(() => {
    seen = {};
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
      server = createServer((req, res) => {
        seen = { method: req.method, url: req.url, headers: req.headers };
        handler(req, res);
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  it('draws the wheel and reports the prize label as the reward', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, level: 6, quota: 75000, label: '150次', message: '恭喜获得 150次！' }));
    });

    const result = await runMintWheelCheckin(baseUrl, { cookieHeader: 'auth_token=jwt-value' });

    expect(result).toEqual({ success: true, message: '恭喜获得 150次！', reward: '150次' });
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/checkin/spin');
    expect(seen.headers?.cookie).toBe('auth_token=jwt-value');
  });

  it('sends the welfare origin so the cross-site guard does not refuse the draw', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, label: '300次', message: '恭喜' }));
    });

    await runMintWheelCheckin(baseUrl, { cookieHeader: 'auth_token=jwt-value' });

    expect(seen.headers?.origin).toBe(baseUrl);
    expect(seen.headers?.referer).toBe(`${baseUrl}/`);
  });

  it('accepts a bearer binding and wraps a bare token as a cookie', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, label: '150次', message: '恭喜' }));
    });

    await runMintWheelCheckin(baseUrl, { bearerToken: 'jwt-bearer' });
    expect(seen.headers?.authorization).toBe('Bearer jwt-bearer');

    await runMintWheelCheckin(baseUrl, { cookieHeader: 'raw-jwt' });
    expect(seen.headers?.cookie).toBe('auth_token=raw-jwt');
  });

  it('treats a repeat run for the same day as a successful check-in', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: '今日已签到' }));
    });

    const result = await runMintWheelCheckin(baseUrl, { cookieHeader: 'auth_token=jwt-value' });

    expect(result.success).toBe(true);
    expect(result.message).toBe('今日已签到');
  });

  it('reports an expired welfare session on HTTP 401', async () => {
    await startServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: '未提供认证信息' }));
    });

    const result = await runMintWheelCheckin(baseUrl, { cookieHeader: 'auth_token=stale' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('已失效');
  });

  it('refuses to run without a bound session', async () => {
    const result = await runMintWheelCheckin('https://up.example.test', {});

    expect(result.success).toBe(false);
    expect(result.message).toContain('未绑定');
  });

  it('surfaces the site message when the draw is refused', async () => {
    await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: '跨站请求被拒绝（缺少 Origin）' }));
    });

    const result = await runMintWheelCheckin(baseUrl, { cookieHeader: 'auth_token=jwt-value' });

    expect(result).toEqual({ success: false, message: '跨站请求被拒绝（缺少 Origin）' });
  });
});

describe('wheel session cookie helpers', () => {
  it('swaps in a fresh token and keeps sibling cookie pairs', () => {
    expect(upsertAuthTokenCookie('auth_token=old; cf_clearance=abc', 'new')).toBe(
      'cf_clearance=abc; auth_token=new',
    );
  });

  it('creates the pair when the header had none', () => {
    expect(upsertAuthTokenCookie(undefined, 'fresh')).toBe('auth_token=fresh');
    expect(upsertAuthTokenCookie('', 'fresh')).toBe('auth_token=fresh');
  });

  it('reads the stored token back out', () => {
    expect(readAuthTokenCookie('auth_token=jwt-value; cf_clearance=abc')).toBe('jwt-value');
    expect(readAuthTokenCookie('cf_clearance=abc')).toBeUndefined();
    expect(readAuthTokenCookie(undefined)).toBeUndefined();
  });
});
