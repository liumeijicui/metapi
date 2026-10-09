import { describe, expect, it } from 'vitest';
import { summarizeUpstreamError } from './upstreamError.js';

describe('summarizeUpstreamError', () => {
  it('extracts concise message from JSON error payload', () => {
    const message = summarizeUpstreamError(400, JSON.stringify({
      error: {
        message: 'messages is required',
        type: 'bad_request',
      },
    }));

    expect(message).toBe('Upstream returned HTTP 400: messages is required');
  });

  it('summarizes Cloudflare 5xx HTML page without dumping full body', () => {
    const html = `<!DOCTYPE html><html><head><title>qaq.al | 502: Bad gateway</title></head><body>Cloudflare Ray ID: abc</body></html>`;
    const message = summarizeUpstreamError(502, html);

    expect(message).toContain('Upstream returned HTTP 502');
    expect(message).toContain('Cloudflare 502: Bad gateway');
    expect(message).not.toContain('<!DOCTYPE html>');
  });

  it('truncates oversized plain text payloads', () => {
    const longText = 'x'.repeat(800);
    const message = summarizeUpstreamError(500, longText);

    expect(message).toContain('Upstream returned HTTP 500:');
    expect(message).toContain('...(truncated)');
    expect(message.length).toBeLessThan(500);
  });

  it('keeps a string-typed error field instead of collapsing it to "error"', () => {
    // anyrouter 就是这么回的：error 是字符串，外层 type 也是 "error"。
    // 之前会退化成「Upstream returned HTTP 400: error」，站点真正的原因被丢掉。
    const message = summarizeUpstreamError(400, JSON.stringify({
      error: '1m 上下文已经全量可用，请启用 1m 上下文后重试',
      type: 'error',
    }));

    expect(message).toBe('Upstream returned HTTP 400: 1m 上下文已经全量可用，请启用 1m 上下文后重试');
  });
});
