import { describe, expect, it } from 'vitest';

import {
  detectPlatformByUrlHint,
  normalizePlatformAlias,
} from './platformIdentity.js';

describe('platformIdentity', () => {
  it('normalizes shared platform aliases', () => {
    expect(normalizePlatformAlias('chatgpt-codex')).toBe('codex');
    expect(normalizePlatformAlias('anti-gravity')).toBe('antigravity');
    expect(normalizePlatformAlias('one api')).toBe('one-api');
    expect(normalizePlatformAlias('orcarouter')).toBe('orcarouter');
    expect(normalizePlatformAlias('xapi')).toBe('xapi');
    expect(normalizePlatformAlias('x-api')).toBe('xapi');
    expect(normalizePlatformAlias('X-API.CFD')).toBe('xapi');
    expect(normalizePlatformAlias('pipi-image')).toBe('pipi-image');
    expect(normalizePlatformAlias('PIPI')).toBe('pipi-image');
    expect(normalizePlatformAlias('')).toBe('');
  });

  it('detects platform by well-known url hints', () => {
    expect(detectPlatformByUrlHint('https://api.openai.com/v1/models')).toBe('openai');
    expect(detectPlatformByUrlHint('https://chatgpt.com/backend-api/codex')).toBe('codex');
    expect(detectPlatformByUrlHint('https://api.anthropic.com/v1/messages')).toBe('claude');
    expect(detectPlatformByUrlHint('https://generativelanguage.googleapis.com/v1beta')).toBe('gemini');
    expect(detectPlatformByUrlHint('https://cloudcode-pa.googleapis.com')).toBe('gemini-cli');
    expect(detectPlatformByUrlHint('http://127.0.0.1:8317/v1/models')).toBe('cliproxyapi');
    expect(detectPlatformByUrlHint('https://api.orcarouter.ai/v1/models')).toBe('orcarouter');
    expect(detectPlatformByUrlHint('https://gateway.orcarouter.ai/v1/models')).toBe('orcarouter');
    expect(detectPlatformByUrlHint('https://x-api.cfd/v1/models')).toBe('xapi');
    expect(detectPlatformByUrlHint('https://x-api.cfd/console/models')).toBe('xapi');
    expect(detectPlatformByUrlHint('https://evil.example.com/orcarouter/v1/models')).toBeUndefined();
    expect(detectPlatformByUrlHint('https://evil.example.com/x-api.cfd/v1/models')).toBeUndefined();
    expect(detectPlatformByUrlHint('https://evil.example.com/?next=https://x-api.cfd/v1/models')).toBeUndefined();
    expect(detectPlatformByUrlHint('https://evil.example.com/?next=https://api.orcarouter.ai/v1/models')).toBeUndefined();
    expect(detectPlatformByUrlHint('https://evil.example.com/?next=https://api.openai.com/v1/models')).toBeUndefined();
    // 皮皮旺把出图站和 API 站拆成两个域名，只有出图站是自研面板；
    // `ai.pipiwangcom.com` 仍然是 new-api，不能被这条规则抢走。
    expect(detectPlatformByUrlHint('https://img.pipiwangcom.com/')).toBe('pipi-image');
    expect(detectPlatformByUrlHint('https://img.pipiwangcom.com/?page=points')).toBe('pipi-image');
    expect(detectPlatformByUrlHint('https://ai.pipiwangcom.com/pricing')).toBeUndefined();
    expect(detectPlatformByUrlHint('https://evil.example.com/?next=https://img.pipiwangcom.com/')).toBeUndefined();
  });
});
