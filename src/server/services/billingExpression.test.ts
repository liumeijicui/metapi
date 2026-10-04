import { describe, expect, it } from 'vitest';
import {
  evaluateBillingExpression,
  resolveBillingExpressionPricing,
} from './billingExpression.js';

describe('billingExpression (new-api tiered_expr)', () => {
  it('把 flat 表达式还原成输入/输出单价（美元 / 1M）', () => {
    expect(resolveBillingExpressionPricing('tier("base", p * 0.3 + c * 1.2 + cr * 0.006)'))
      .toMatchObject({ unit: 'token', inputPerMillion: 0.3, outputPerMillion: 1.2 });
  });

  it('还原 happycoding 的真实价目（原来被 model_ratio 顶成 $75/$75）', () => {
    expect(resolveBillingExpressionPricing('tier("base", p * 1.4 + c * 4.4 + cr * 0.26)'))
      .toMatchObject({ unit: 'token', inputPerMillion: 1.4, outputPerMillion: 4.4 });
    expect(resolveBillingExpressionPricing('tier("base", p * 0.15 + c * 0.5 + cr * 0.03)'))
      .toMatchObject({ unit: 'token', inputPerMillion: 0.15, outputPerMillion: 0.5 });
  });

  it('多档表达式取最短上下文那档', () => {
    expect(resolveBillingExpressionPricing(
      'len <= 200000 ? tier("0_200k", p * 1.25 + cr * 0.2 + c * 2.5) : tier("200k_plus", p * 2.5 + cr * 0.4 + c * 5)',
    )).toMatchObject({ unit: 'token', inputPerMillion: 1.25, outputPerMillion: 2.5 });
  });

  it('跳过「探测价」分支，落回正式价', () => {
    const expr = '(((((p <= 50)))) && (((((c <= 100))) && ((c > 0))))) ? (tier(" 探测", fixed(0.3))) : (tier("base", p * 1.4 + c * 4.3999999999998 + cr * 0.3000000000004))';
    expect(resolveBillingExpressionPricing(expr))
      .toMatchObject({ unit: 'token', inputPerMillion: 1.4, outputPerMillion: 4.4 });
  });

  it('fixed() 识别为按次计费', () => {
    expect(resolveBillingExpressionPricing('tier("base", fixed(0.6))'))
      .toMatchObject({ unit: 'request', perRequestUsd: 0.6 });
    expect(resolveBillingExpressionPricing('tier("standard", fixed(4))'))
      .toMatchObject({ unit: 'request', perRequestUsd: 4 });
  });

  it('时间档按当前时间选档', () => {
    const expr = 'weekday("UTC") >= 1 && weekday("UTC") <= 5 && ((hour("UTC") >= 1 && hour("UTC") < 4) || (hour("UTC") >= 6 && hour("UTC") < 10)) ? tier("peak", p * 1.32 + cr * 0.044 + c * 3.96) : tier("off_peak", p * 0.66 + cr * 0.022 + c * 1.98)';
    // 2026-10-05 是周一，02:00 UTC 属于高峰段。
    expect(resolveBillingExpressionPricing(expr, { now: new Date('2026-10-05T02:00:00Z') }))
      .toMatchObject({ inputPerMillion: 1.32, outputPerMillion: 3.96, matchedTier: 'peak' });
    // 2026-10-04 是周日，全天走非高峰价。
    expect(resolveBillingExpressionPricing(expr, { now: new Date('2026-10-04T12:00:00Z') }))
      .toMatchObject({ inputPerMillion: 0.66, outputPerMillion: 1.98, matchedTier: 'off_peak' });
  });

  it('零价也如实还原成 0，而不是 null', () => {
    expect(resolveBillingExpressionPricing('tier("base", p * 0 + c * 0)'))
      .toMatchObject({ unit: 'token', inputPerMillion: 0, outputPerMillion: 0 });
  });

  it('解析不了的表达式返回 null，调用方好退回老逻辑', () => {
    expect(resolveBillingExpressionPricing('tier("base", p * )')).toBeNull();
    expect(resolveBillingExpressionPricing('')).toBeNull();
    expect(evaluateBillingExpression('unknown_fn(1)', {})).toBeNull();
  });
});
