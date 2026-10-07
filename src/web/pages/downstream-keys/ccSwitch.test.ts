import { describe, expect, it } from 'vitest';
import {
  buildCcSwitchDeepLink,
  buildManualConfigSnippet,
  normalizeGatewayBaseUrl,
  resolveCcSwitchEndpoint,
  resolveDefaultGatewayBaseUrl,
} from './ccSwitch.js';

function parse(link: string): URLSearchParams {
  return new URLSearchParams(link.slice(link.indexOf('?') + 1));
}

describe('normalizeGatewayBaseUrl', () => {
  it('trims and drops trailing slashes', () => {
    expect(normalizeGatewayBaseUrl('  https://gw.example.com//  ')).toBe('https://gw.example.com');
  });

  it('tolerates empty input', () => {
    expect(normalizeGatewayBaseUrl(undefined)).toBe('');
    expect(normalizeGatewayBaseUrl(null)).toBe('');
  });
});

describe('resolveCcSwitchEndpoint', () => {
  it('keeps the root for Claude Code and Gemini CLI', () => {
    expect(resolveCcSwitchEndpoint('claude', 'https://gw.example.com/')).toBe('https://gw.example.com');
    expect(resolveCcSwitchEndpoint('gemini', 'https://gw.example.com')).toBe('https://gw.example.com');
  });

  it('appends /v1 for Codex', () => {
    expect(resolveCcSwitchEndpoint('codex', 'https://gw.example.com/')).toBe('https://gw.example.com/v1');
  });
});

describe('resolveDefaultGatewayBaseUrl', () => {
  it('uses the provided origin when present', () => {
    expect(resolveDefaultGatewayBaseUrl('https://panel.example.com/')).toBe('https://panel.example.com');
  });

  it('falls back to an empty string when there is no origin', () => {
    expect(resolveDefaultGatewayBaseUrl('')).toBe('');
  });
});

describe('buildCcSwitchDeepLink', () => {
  it('builds a v1 provider import link', () => {
    const link = buildCcSwitchDeepLink({
      app: 'claude',
      name: '项目 A',
      baseUrl: 'https://gw.example.com/',
      apiKey: 'sk-abcdef123456',
      enabled: true,
    });

    expect(link.startsWith('ccswitch://v1/import?')).toBe(true);
    const params = parse(link);
    expect(params.get('resource')).toBe('provider');
    expect(params.get('app')).toBe('claude');
    expect(params.get('name')).toBe('项目 A');
    expect(params.get('endpoint')).toBe('https://gw.example.com');
    expect(params.get('homepage')).toBe('https://gw.example.com');
    expect(params.get('apiKey')).toBe('sk-abcdef123456');
    expect(params.get('enabled')).toBe('true');
    expect(params.get('model')).toBeNull();
  });

  it('never emits a raw space or plus sign', () => {
    const link = buildCcSwitchDeepLink({
      app: 'claude',
      name: 'my key name',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-abcdef123456',
    });

    expect(link).not.toMatch(/[ +]/);
    expect(parse(link).get('name')).toBe('my key name');
  });

  it('marks enabled=false when the user does not want to switch', () => {
    const link = buildCcSwitchDeepLink({
      app: 'claude',
      name: 'k',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-abcdef123456',
      enabled: false,
    });
    expect(parse(link).get('enabled')).toBe('false');
  });

  it('passes the model through, with /v1 baked in for Codex', () => {
    const link = buildCcSwitchDeepLink({
      app: 'codex',
      name: 'codex',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-abcdef123456',
      model: 'gpt-5-codex',
    });
    const params = parse(link);
    expect(params.get('endpoint')).toBe('https://gw.example.com/v1');
    expect(params.get('model')).toBe('gpt-5-codex');
  });

  it('returns an empty link when a required field is missing', () => {
    const base = { app: 'claude' as const, name: 'k', baseUrl: 'https://gw.example.com', apiKey: 'sk-x' };
    expect(buildCcSwitchDeepLink({ ...base, apiKey: '' })).toBe('');
    expect(buildCcSwitchDeepLink({ ...base, name: '  ' })).toBe('');
    expect(buildCcSwitchDeepLink({ ...base, baseUrl: '' })).toBe('');
  });
});

describe('buildManualConfigSnippet', () => {
  it('lists the Claude Code variables', () => {
    const text = buildManualConfigSnippet({
      app: 'claude',
      name: 'k',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-abcdef123456',
      model: 'claude-sonnet-4-5',
    });
    expect(text).toContain('ANTHROPIC_BASE_URL="https://gw.example.com"');
    expect(text).toContain('ANTHROPIC_AUTH_TOKEN="sk-abcdef123456"');
    expect(text).toContain('ANTHROPIC_MODEL="claude-sonnet-4-5"');
  });

  it('writes a Codex config.toml block with the /v1 base URL', () => {
    const text = buildManualConfigSnippet({
      app: 'codex',
      name: 'k',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-abcdef123456',
    });
    expect(text).toContain('[model_providers.metapi]');
    expect(text).toContain('base_url = "https://gw.example.com/v1"');
    expect(text).toContain('wire_api = "responses"');
  });

  it('lists the Gemini CLI variables', () => {
    const text = buildManualConfigSnippet({
      app: 'gemini',
      name: 'k',
      baseUrl: 'https://gw.example.com',
      apiKey: 'sk-abcdef123456',
    });
    expect(text).toContain('GOOGLE_GEMINI_BASE_URL="https://gw.example.com"');
    expect(text).toContain('GEMINI_API_KEY="sk-abcdef123456"');
  });
});
