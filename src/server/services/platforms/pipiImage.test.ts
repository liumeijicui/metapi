import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { PipiImageAdapter, isPipiImageSiteUrl } from './pipiImage.js';
import { detectPlatform, getAdapter } from './index.js';

async function withHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  }
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

describe('PipiImageAdapter', () => {
  it('is reachable through the pipi-image platform name and its aliases', () => {
    expect(getAdapter('pipi-image')?.platformName).toBe('pipi-image');
    expect(getAdapter('pipi')?.platformName).toBe('pipi-image');
  });

  it('detects only the image host, never the sibling new-api host', async () => {
    const adapter = new PipiImageAdapter();
    expect(await adapter.detect('https://img.pipiwangcom.com/')).toBe(true);
    expect(await adapter.detect('https://img.pipiwangcom.com/?page=points')).toBe(true);
    expect(await adapter.detect('https://ai.pipiwangcom.com/pricing')).toBe(false);
    expect(await adapter.detect('https://evil.example.com/img.pipiwangcom.com')).toBe(false);

    expect((await detectPlatform('https://img.pipiwangcom.com/'))?.platformName).toBe('pipi-image');
    expect(isPipiImageSiteUrl('img.pipiwangcom.com')).toBe(true);
    expect(isPipiImageSiteUrl('https://img.pipiwangcom.com.evil.com/')).toBe(false);
  });

  it('reports no models and never probes a model endpoint', async () => {
    const adapter = new PipiImageAdapter();
    let requests = 0;
    await withHttpServer((_req, res) => {
      requests += 1;
      res.writeHead(500).end();
    }, async (baseUrl) => {
      expect(await adapter.getModels(baseUrl, 'pipi-token')).toEqual([]);
    });
    expect(requests).toBe(0);
  });

  it('reads the points balance and the user from /api/v1/pc/me', async () => {
    const adapter = new PipiImageAdapter();
    const seen: Array<string | undefined> = [];
    await withHttpServer((req, res) => {
      seen.push(req.headers.authorization as string | undefined);
      if (req.url === '/api/v1/pc/me') {
        json(res, 200, { points: 480, user: { username: 'pipi_user', id: 4219 } });
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      expect(await adapter.getBalance(baseUrl, 'pipi-token')).toEqual({
        balance: 480,
        used: 0,
        quota: 480,
      });
      expect(await adapter.getUserInfo(baseUrl, 'pipi-token')).toMatchObject({ username: 'pipi_user' });
      expect(seen).toEqual(['Bearer pipi-token', 'Bearer pipi-token']);
    });
  });

  it('turns the site check-in answers into success, already-checked-in and expiry', async () => {
    const adapter = new PipiImageAdapter();
    const bodies: Array<{ url?: string; method?: string; authorization?: string }> = [];
    // The adapter always posts the same path, so the answer is picked per call.
    let mode: 'granted' | 'already' | 'dead' = 'granted';
    await withHttpServer((req, res) => {
      bodies.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization as string | undefined,
      });
      if (req.url !== '/api/v1/pc/checkin') {
        res.writeHead(404).end();
        return;
      }
      if (mode === 'granted') {
        json(res, 200, { grantedPoints: 50 });
        return;
      }
      if (mode === 'already') {
        json(res, 200, { already: true });
        return;
      }
      json(res, 401, { detail: '未登录' });
    }, async (baseUrl) => {
      const granted = await adapter.checkin(baseUrl, 'pipi-token');
      expect(granted).toEqual({ success: true, message: '签到成功 +50 积分', reward: '50' });

      mode = 'already';
      const already = await adapter.checkin(baseUrl, 'pipi-token');
      expect(already.success).toBe(true);
      expect(already.message).toBe('今日已签到');

      mode = 'dead';
      const dead = await adapter.checkin(baseUrl, 'pipi-token');
      expect(dead.success).toBe(false);
      expect(dead.message).toContain('HTTP 401');
    });
    expect(bodies.every((entry) => entry.method === 'POST')).toBe(true);
    expect(bodies.every((entry) => entry.url === '/api/v1/pc/checkin')).toBe(true);
    expect(bodies.map((entry) => entry.authorization)).toEqual([
      'Bearer pipi-token',
      'Bearer pipi-token',
      'Bearer pipi-token',
    ]);
  });

  it('refuses password login instead of pretending the site has a login form', async () => {
    const adapter = new PipiImageAdapter();
    const login = await adapter.login('https://img.pipiwangcom.com', 'user', 'pass');
    expect(login.success).toBe(false);
    expect(login.message).toContain('Linux.do');
  });
});
