import { describe, expect, it } from 'vitest';
import {
  MODEL_FAMILY_IDS,
  isModelFamilyId,
  modelFamilyLabel,
  resolveModelFamily,
} from './modelFamilies.js';

describe('modelFamilies', () => {
  it('按名字里的关键字归类，前缀（站点/供应商 / 方括号）不影响判断', () => {
    expect(resolveModelFamily('[官B]claude-opus-4-8-thinking')).toBe('claude');
    expect(resolveModelFamily('[满血A]gemini-3.1-pro-preview')).toBe('gemini');
    expect(resolveModelFamily('z-ai/glm-5.3')).toBe('glm');
    expect(resolveModelFamily('nvidia/glm-5.3-flash')).toBe('glm');
    expect(resolveModelFamily('moonshotai/kimi-k3')).toBe('kimi');
    expect(resolveModelFamily('MiniMax-M2.1-highspeed')).toBe('minimax');
    expect(resolveModelFamily('sunapi/deepseek-v4.1-flash')).toBe('deepseek');
    expect(resolveModelFamily('qwen-image-turbo')).toBe('qwen');
    expect(resolveModelFamily('grok-4.5-high')).toBe('grok');
    expect(resolveModelFamily('llama-3.1-nemoguard-8b-topic')).toBe('llama');
    expect(resolveModelFamily('voxtral-small-latest')).toBe('mistral');
    expect(resolveModelFamily('ministral-3b-latest')).toBe('mistral');
    expect(resolveModelFamily('gpt-oss-120b')).toBe('openai');
    expect(resolveModelFamily('dall-e-3')).toBe('openai');
    expect(resolveModelFamily('codex-auto-review')).toBe('openai');
    expect(resolveModelFamily('o3-mini')).toBe('openai');
  });

  it('一个名字里带两个家族时按更专有的那个算', () => {
    // DeepSeek 的蒸馏 Qwen：算 DeepSeek 更贴切。
    expect(resolveModelFamily('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b')).toBe('deepseek');
    expect(resolveModelFamily('@cf/openai/gpt-oss-120b')).toBe('openai');
    expect(resolveModelFamily('openrouter/deepseek-v4.1-flash-free')).toBe('deepseek');
  });

  it('认不出来的进 other，短前缀不能误伤', () => {
    expect(resolveModelFamily('model-O')).toBe('other');
    expect(resolveModelFamily('nemotron-3-nano-30b-a3b')).toBe('other');
    expect(resolveModelFamily('openrouter-free')).toBe('other');
    expect(resolveModelFamily('nano-banana')).toBe('other');
    expect(resolveModelFamily('')).toBe('other');
    expect(resolveModelFamily(null)).toBe('other');
  });

  it('下拉用的 id / 文案 / 校验', () => {
    expect(MODEL_FAMILY_IDS).toContain('deepseek');
    expect(MODEL_FAMILY_IDS.at(-1)).toBe('other');
    expect(modelFamilyLabel('deepseek')).toBe('DeepSeek');
    expect(modelFamilyLabel('other')).toBe('其他');
    // 认不出的 label 也回落到「其他」，不至于渲染成 undefined。
    expect(modelFamilyLabel('nope')).toBe('其他');
    expect(isModelFamilyId('claude')).toBe(true);
    expect(isModelFamilyId('bogus')).toBe(false);
    expect(isModelFamilyId(null)).toBe(false);
  });
});
