import { describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { XApiAdapter } from './xapi.js';
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

describe('XApiAdapter', () => {
  it('is reachable through the xapi platform name and its aliases', () => {
    expect(getAdapter('xapi')?.platformName).toBe('xapi');
    expect(getAdapter('x-api')?.platformName).toBe('xapi');
    expect(getAdapter('X-API.CFD')?.platformName).toBe('xapi');
  });

  it('detects the official host and rejects look-alike URLs', async () => {
    const adapter = new XApiAdapter();
    expect(await adapter.detect('https://x-api.cfd/console/models')).toBe(true);
    expect(await adapter.detect('https://evil.example.com/x-api.cfd')).toBe(false);
    expect(await adapter.detect('https://evil.example.com/?next=https://x-api.cfd')).toBe(false);

    const detected = await detectPlatform('https://x-api.cfd');
    expect(detected?.platformName).toBe('xapi');
  });

  it('lists models from the OpenAI-compatible /v1/models endpoint', async () => {
    const adapter = new XApiAdapter();
    const seen: Array<string | undefined> = [];
    await withHttpServer((req, res) => {
      seen.push(req.headers.authorization as string | undefined);
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'grok-4.7' },
            { id: 'grok-4.6' },
            { id: 'translation' },
            { id: '   ' },
          ],
        }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const models = await adapter.getModels(baseUrl, 'xapi-test-key');
      expect(models).toEqual(['grok-4.7', 'grok-4.6', 'translation']);
      expect(seen).toEqual(['Bearer xapi-test-key']);
    });
  });

  it('reports login and check-in as unsupported instead of failing the account', async () => {
    const adapter = new XApiAdapter();
    const login = await adapter.login('https://x-api.cfd', 'user', 'pass');
    expect(login.success).toBe(false);
    expect(login.message).toContain('Linux.do');

    const checkin = await adapter.checkin('https://x-api.cfd', 'xapi-test-key');
    expect(checkin.success).toBe(false);
    expect(checkin.message).toContain('签到');

    // No quota endpoint is exposed for API-key connections, so the balance is
    // reported as zero rather than as a failed refresh.
    expect(adapter.balanceUnavailableReason).toBeUndefined();
    expect(await adapter.getBalance('https://x-api.cfd', 'xapi-test-key')).toEqual({
      balance: 0,
      used: 0,
      quota: 0,
    });
  });
});
