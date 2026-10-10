import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NewApiAdapter } from './newApi.js';

/**
 * Covers the check-in flow of forks that gate the daily reward behind a locally
 * rendered image captcha (简直了 / jianzhile.vip). The site refuses the plain
 * call with wording about a missing captcha, which is what has to route the
 * caller into the two-step captcha exchange.
 */

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '__fixtures__',
  'captcha-jianzhile',
);

const COOKIE_TOKEN = 'checkin-captcha-session';
const USER_ID = 319;

interface Fixture {
  name: string;
  answer: string;
  dataUri: string;
}

function loadFixtures(): Fixture[] {
  const answers = JSON.parse(
    readFileSync(join(FIXTURE_DIR, 'answers.json'), 'utf8'),
  ) as Record<string, string>;
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => ({
      name,
      answer: answers[name],
      dataUri: `data:image/png;base64,${readFileSync(join(FIXTURE_DIR, name)).toString('base64')}`,
    }));
}

describe('NewApiAdapter captcha check-in', () => {
  let server: ReturnType<typeof createServer> | undefined;
  let baseUrl: string;
  let requests: Array<{ url: string; method: string; body: string; headers: IncomingMessage['headers'] }> = [];
  const fixtures = loadFixtures();

  beforeEach(() => {
    requests = [];
  });

  afterEach(async () => {
    if (!server) return;
    const closing = server;
    server = undefined;
    await new Promise<void>((resolve, reject) => {
      closing.close((err?: Error) => (err ? reject(err) : resolve()));
    });
  });

  function startServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void) {
    return new Promise<void>((resolve) => {
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          requests.push({ url: req.url || '', method: req.method || '', body, headers: req.headers });
          handler(req, res, body);
        });
      });
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
        resolve();
      });
    });
  }

  function json(res: ServerResponse, payload: unknown) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  /**
   * Stands in for the fork: the plain call demands a captcha, the captcha route
   * hands out fixture images, and the check-in route only pays out when the
   * posted answer matches the image it issued.
   */
  function startCaptchaSite(options: {
    rejectFirstAttempt?: boolean;
    captchaRouteMissing?: boolean;
  } = {}) {
    let issuedIndex = -1;
    let attempts = 0;
    const issuedIds: string[] = [];
    return startServer((req, res, body) => {
      const url = req.url || '';
      if (url === '/api/user/sign_in') {
        json(res, { success: false, message: 'Invalid URL (POST /api/user/sign_in)' });
        return;
      }
      if (url === '/api/user/daily') {
        json(res, { error: { message: 'Invalid URL (POST /api/user/daily)' } });
        return;
      }
      if (url === '/api/user/checkin/captcha') {
        if (options.captchaRouteMissing) {
          json(res, { error: { message: 'Invalid URL (POST /api/user/checkin/captcha)' } });
          return;
        }
        issuedIndex = (issuedIndex + 1) % fixtures.length;
        issuedIds.push(String(issuedIndex));
        json(res, {
          success: true,
          data: { captcha_id: `cap-${issuedIndex}`, captcha_image: fixtures[issuedIndex].dataUri },
        });
        return;
      }
      if (url === '/api/user/checkin') {
        const parsed = body ? (JSON.parse(body) as { captcha_id?: string }) : {};
        if (!parsed.captcha_id) {
          json(res, { success: false, message: '请输入验证码' });
          return;
        }
        attempts += 1;
        if (options.rejectFirstAttempt && attempts === 1) {
          json(res, { success: false, message: '验证码错误，请重试' });
          return;
        }
        const expected = fixtures[Number(parsed.captcha_id.replace('cap-', ''))].answer;
        const posted = (JSON.parse(body) as { captcha_answer?: string }).captcha_answer || '';
        if (posted !== expected) {
          json(res, { success: false, message: '验证码错误，请重试' });
          return;
        }
        json(res, { success: true, message: '签到成功', data: { quota_awarded: 5000000 } });
        return;
      }
      json(res, { error: { message: `Invalid URL (${req.method} ${url})` } });
    });
  }

  it('answers the captcha and reports the site reward when the plain call demands one', async () => {
    await startCaptchaSite();
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, `session=${COOKIE_TOKEN}`, USER_ID);

    expect(result.success).toBe(true);
    expect(result.message).toBe('签到成功');
    const captchaRequest = requests.find((r) => r.url === '/api/user/checkin/captcha');
    expect(captchaRequest, 'the captcha route must be exercised').toBeTruthy();
    expect(captchaRequest!.headers['new-api-user']).toBe(String(USER_ID));
    const solved = requests.filter((r) => r.url === '/api/user/checkin' && r.body.includes('captcha_answer'));
    expect(solved).toHaveLength(1);
  });

  it('re-reads a brand new captcha after a rejected answer', async () => {
    await startCaptchaSite({ rejectFirstAttempt: true });
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, `session=${COOKIE_TOKEN}`, USER_ID);

    expect(result.success).toBe(true);
    const captchaRequests = requests.filter((r) => r.url === '/api/user/checkin/captcha');
    expect(captchaRequests).toHaveLength(2);
    const solved = requests.filter((r) => r.url === '/api/user/checkin' && r.body.includes('captcha_answer'));
    expect(solved).toHaveLength(2);
    const firstId = (JSON.parse(solved[0].body) as { captcha_id: string }).captcha_id;
    const secondId = (JSON.parse(solved[1].body) as { captcha_id: string }).captcha_id;
    expect(firstId).not.toBe(secondId);
  });

  it('reports the site wording instead of a generic failure when the captcha route is absent', async () => {
    await startCaptchaSite({ captchaRouteMissing: true });
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, `session=${COOKIE_TOKEN}`, USER_ID);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/captcha|验证码/i);
  });

  it('does not touch the captcha route when the plain call succeeds', async () => {
    await startServer((req, res) => {
      const url = req.url || '';
      if (url === '/api/user/sign_in') {
        json(res, { success: false, message: 'Invalid URL (POST /api/user/sign_in)' });
        return;
      }
      if (url === '/api/user/checkin') {
        json(res, { success: true, message: 'checked-in-plain', data: { reward: 7 } });
        return;
      }
      json(res, { error: { message: `Invalid URL (${req.method} ${url})` } });
    });
    const adapter = new NewApiAdapter();
    const result = await adapter.checkin(baseUrl, `session=${COOKIE_TOKEN}`, USER_ID);

    expect(result.success).toBe(true);
    expect(result.message).toBe('checked-in-plain');
    expect(requests.some((r) => r.url === '/api/user/checkin/captcha')).toBe(false);
  });
});
