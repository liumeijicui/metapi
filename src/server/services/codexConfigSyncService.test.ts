import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeCodexConfig } from './codexConfigSyncService.js';

describe('Codex 直连配置合并', () => {
  it('只替换当前 provider 和模型，保留思考强度与安全设置', () => {
    const merged = mergeCodexConfig({
      existing: [
        'model_provider = "custom"',
        'model = "old-model"',
        'model_reasoning_effort = "xhigh"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        '',
        '[model_providers.custom]',
        'name = "Old"',
        'base_url = "https://old.example.com/v1"',
        'wire_api = "responses"',
        '',
        '[features]',
        'multi_agent = true',
      ].join('\n'),
      model: 'gpt-5.5',
      provider: 'custom',
      providerName: 'Direct Site · gpt-5.5',
      baseUrl: 'https://direct.example.com/v1',
    });

    expect(merged).toContain('model_provider = "custom"');
    expect(merged).toContain('model = "gpt-5.5"');
    expect(merged).toContain('model_reasoning_effort = "xhigh"');
    expect(merged).toContain('approval_policy = "never"');
    expect(merged).toContain('sandbox_mode = "danger-full-access"');
    expect(merged).toContain('[features]\nmulti_agent = true');
    expect(merged).toContain('base_url = "https://direct.example.com/v1"');
    expect(merged).not.toContain('https://old.example.com/v1');
    expect(merged).not.toContain('model = "old-model"');
  });

  it('拒绝把换行或引号注入配置', () => {
    const merged = mergeCodexConfig({
      existing: '',
      model: 'safe-model',
      provider: 'custom',
      providerName: 'A "quoted" provider',
      baseUrl: 'https://example.com/v1',
    });
    expect(merged).toContain('name = "A \\"quoted\\" provider"');
  });

  it('写入后不启动目标用户 Codex 启动器，避免启动脚本把配置覆盖回模板', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/server/services/codexConfigSyncService.ts'),
      'utf8',
    );
    expect(source).not.toContain("execFileAsync('su', ['-', user, '-c', 'codex --version'])");
    expect(source).toContain('codexVersion: null');
  });
});
