/**
 * new-api「表达式计费」(`billing_mode = tiered_expr`) 的求值器。
 *
 * 站点价目表里这类模型会把 `model_ratio` 留成废字段（很多站固定 37.5），真正的
 * 价格写在 `billing_expr` 里，例如：
 *
 *   tier("base", p * 0.3 + c * 1.2 + cr * 0.006)
 *
 * 按 new-api 的定义，表达式里的系数就是「美元 / 1M tokens」的挂牌价（`p` = 输入,
 * `c` = 输出, `cr` = 缓存读取……），`fixed(x)` 则是「每次请求 x 美元」。所以这里
 * 只需要把表达式按不同 token 数量代入求值，用差分还原出输入/输出单价即可。
 *
 * 求值时用较大的 token 数取样（例如 1M / 2M），是为了让「探测价」之类的
 * 小请求分支（`p <= 50 && c <= 100 ? tier("探测", fixed(0.3)) : tier("base", ...)`）
 * 自然落到真正的正式价分支上；`len` 取小值，让上下文阶梯落到最短档（与站点
 * 价目表首档一致）。
 */

const SAMPLE_BASE_TOKENS = 1_000_000;
const SAMPLE_HIGH_TOKENS = 2_000_000;
const SAMPLE_OTHER_TOKENS = 1_000_000;
const SAMPLE_LEN_TOKENS = 1_000;
const RAW_COST_PER_USD = 1_000_000;

/** 差分求值会有浮点尾数（1.3199999999999994），落到 6 位小数足够表示单价。 */
function roundPrice(value: number): number {
  return Math.round(Math.max(0, value) * 1_000_000) / 1_000_000;
}

export type BillingExpressionBillingUnit = 'token' | 'request';

export interface BillingExpressionTokenEnv {
  p?: number;
  c?: number;
  len?: number;
  cr?: number;
  cc?: number;
  cc1h?: number;
  img?: number;
  img_cr?: number;
  img_o?: number;
  ai?: number;
  ao?: number;
  image_count?: number;
}

export interface BillingExpressionEvalResult {
  /** 表达式求值结果；按 new-api 约定除以 1e6 才是美元。 */
  rawCost: number;
  costUsd: number;
  billingUnit: BillingExpressionBillingUnit;
  fixedPriceUsd: number | null;
  matchedTier: string | null;
}

export interface BillingExpressionPricing {
  unit: BillingExpressionBillingUnit;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  /** `unit === 'request'` 时的每次请求价（美元）。 */
  perRequestUsd: number | null;
  matchedTier: string | null;
}

export class BillingExpressionError extends Error {}

type EvalValue = number | string | boolean | null;

interface EvalState {
  now: Date;
  matchedTier: string | null;
  billingUnit: BillingExpressionBillingUnit;
  fixedPriceUsd: number | null;
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

type TokenType = 'number' | 'string' | 'ident' | 'punct';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const PUNCTUATORS = [
  '&&', '||', '==', '!=', '<=', '>=',
  '?', ':', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', ',',
];

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '#' || (ch === '/' && source[i + 1] === '/')) {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] || ''))) {
      const start = i;
      while (i < source.length && isDigit(source[i])) i += 1;
      if (source[i] === '.') {
        i += 1;
        while (i < source.length && isDigit(source[i])) i += 1;
      }
      if (source[i] === 'e' || source[i] === 'E') {
        let j = i + 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        if (isDigit(source[j] || '')) {
          i = j;
          while (i < source.length && isDigit(source[i])) i += 1;
        }
      }
      tokens.push({ type: 'number', value: source.slice(start, i), pos: start });
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      let text = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1];
          if (next === 'n') text += '\n';
          else if (next === 't') text += '\t';
          else text += next;
          i += 2;
          continue;
        }
        text += source[i];
        i += 1;
      }
      if (source[i] !== quote) {
        throw new BillingExpressionError(`未闭合的字符串 (${start})`);
      }
      i += 1;
      tokens.push({ type: 'string', value: text, pos: start });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i])) i += 1;
      tokens.push({ type: 'ident', value: source.slice(start, i), pos: start });
      continue;
    }
    const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, i));
    if (!punct) {
      throw new BillingExpressionError(`无法识别的字符 ${JSON.stringify(ch)} (${i})`);
    }
    tokens.push({ type: 'punct', value: punct, pos: i });
    i += punct.length;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 时间函数（与 new-api 一致：空/非法时区退回 UTC）
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function zonedDateParts(now: Date, timezone: string | null | undefined) {
  const tz = (timezone || 'UTC').trim() || 'UTC';
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(now)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday ?? ''] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

function toNumberValue(value: EvalValue): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  throw new BillingExpressionError(`期望数字，实际是 ${JSON.stringify(value)}`);
}

function truthy(value: EvalValue): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return false;
    return value !== 0;
  }
  if (typeof value === 'string') return value.length > 0;
  return false;
}

function compare(left: EvalValue, right: EvalValue): number | null {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

function looseEquals(left: EvalValue, right: EvalValue): boolean {
  if (typeof left === 'number' || typeof right === 'number') {
    return toNumberValue(left) === toNumberValue(right);
  }
  return left === right;
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(
    source: string,
    private readonly env: Record<string, number>,
    private readonly state: EvalState,
  ) {
    this.tokens = tokenize(source);
  }

  parse(): EvalValue {
    const value = this.parseTernary();
    if (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      throw new BillingExpressionError(`表达式尾部有多余内容 ${JSON.stringify(token.value)} (${token.pos})`);
    }
    return value;
  }

  private peek(): Token | null {
    return this.tokens[this.index] ?? null;
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new BillingExpressionError('表达式意外结束');
    this.index += 1;
    return token;
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token && token.type === 'punct' && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private matchIdent(...values: string[]): boolean {
    const token = this.peek();
    if (token && token.type === 'ident' && values.includes(token.value)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.matchPunct(value)) {
      throw new BillingExpressionError(`期望 ${value}，实际是 ${JSON.stringify(this.peek()?.value ?? 'EOF')}`);
    }
  }

  private parseTernary(): EvalValue {
    const condition = this.parseOr();
    if (this.matchPunct('?')) {
      // 两个分支都要解析（否则吃不完 token），但 `tier()` / `fixed()` 的副作用
      // 只能算「被选中」那一支的，所以这里先各自记账再回填。
      const saved = { ...this.state };
      const yes = this.parseTernary();
      const yesState = { ...this.state };
      Object.assign(this.state, saved);
      this.expectPunct(':');
      const no = this.parseTernary();
      const noState = { ...this.state };
      if (truthy(condition)) {
        Object.assign(this.state, yesState);
        return yes;
      }
      Object.assign(this.state, noState);
      return no;
    }
    return condition;
  }

  private parseOr(): EvalValue {
    let left = this.parseAnd();
    while (this.matchPunct('||') || this.matchIdent('or')) {
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): EvalValue {
    let left = this.parseEquality();
    while (this.matchPunct('&&') || this.matchIdent('and')) {
      const right = this.parseEquality();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseEquality(): EvalValue {
    let left = this.parseRelational();
    for (;;) {
      if (this.matchPunct('==')) {
        left = looseEquals(left, this.parseRelational());
      } else if (this.matchPunct('!=')) {
        left = !looseEquals(left, this.parseRelational());
      } else {
        return left;
      }
    }
  }

  private parseRelational(): EvalValue {
    let left = this.parseAdditive();
    for (;;) {
      const token = this.peek();
      if (token?.type === 'punct' && ['<', '<=', '>', '>='].includes(token.value)) {
        this.index += 1;
        const right = this.parseAdditive();
        const result = compare(left, right);
        if (result === null) return false;
        left = token.value === '<' ? result < 0
          : token.value === '<=' ? result <= 0
          : token.value === '>' ? result > 0
          : result >= 0;
        continue;
      }
      return left;
    }
  }

  private parseAdditive(): EvalValue {
    let left = this.parseMultiplicative();
    for (;;) {
      const token = this.peek();
      if (token?.type === 'punct' && (token.value === '+' || token.value === '-')) {
        this.index += 1;
        const right = this.parseMultiplicative();
        if (token.value === '+') {
          left = typeof left === 'string' || typeof right === 'string'
            ? String(left ?? '') + String(right ?? '')
            : toNumberValue(left) + toNumberValue(right);
        } else {
          left = toNumberValue(left) - toNumberValue(right);
        }
        continue;
      }
      return left;
    }
  }

  private parseMultiplicative(): EvalValue {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (token?.type === 'punct' && ['*', '/', '%'].includes(token.value)) {
        this.index += 1;
        const right = this.parseUnary();
        const a = toNumberValue(left);
        const b = toNumberValue(right);
        if (token.value === '*') left = a * b;
        else if (token.value === '/') {
          if (b === 0) throw new BillingExpressionError('表达式里出现了除以 0');
          left = a / b;
        } else {
          if (b === 0) throw new BillingExpressionError('表达式里出现了对 0 取模');
          left = a % b;
        }
        continue;
      }
      return left;
    }
  }

  private parseUnary(): EvalValue {
    if (this.matchPunct('-')) return -toNumberValue(this.parseUnary());
    if (this.matchPunct('+')) return toNumberValue(this.parseUnary());
    if (this.matchPunct('!') || this.matchIdent('not')) return !truthy(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): EvalValue {
    const token = this.next();

    if (token.type === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new BillingExpressionError(`非法数字 ${token.value}`);
      return value;
    }

    if (token.type === 'string') return token.value;

    if (token.type === 'punct' && token.value === '(') {
      const value = this.parseTernary();
      this.expectPunct(')');
      return value;
    }

    if (token.type === 'ident') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'nil' || token.value === 'null') return null;
      if (this.matchPunct('(')) {
        const args: EvalValue[] = [];
        if (!this.matchPunct(')')) {
          for (;;) {
            args.push(this.parseTernary());
            if (this.matchPunct(',')) continue;
            this.expectPunct(')');
            break;
          }
        }
        return this.callFunction(token.value, args);
      }
      if (Object.hasOwn(this.env, token.value)) return this.env[token.value];
      throw new BillingExpressionError(`未知变量 ${token.value}`);
    }

    throw new BillingExpressionError(`意外的记号 ${JSON.stringify(token.value)} (${token.pos})`);
  }

  private callFunction(name: string, args: EvalValue[]): EvalValue {
    switch (name) {
      case 'tier': {
        const label = args[0];
        const value = args[1];
        if (typeof label !== 'string') throw new BillingExpressionError('tier() 的第一个参数必须是字符串');
        this.state.matchedTier = label;
        return value ?? null;
      }
      case 'fixed': {
        const amount = toNumberValue(args[0] ?? null);
        this.state.billingUnit = 'request';
        this.state.fixedPriceUsd = amount;
        // new-api 里 fixed(x) 返回 x * 1e6，这样除以 1e6 之后正好是 x 美元。
        return amount * RAW_COST_PER_USD;
      }
      case 'min': return Math.min(...args.map(toNumberValue));
      case 'max': return Math.max(...args.map(toNumberValue));
      case 'abs': return Math.abs(toNumberValue(args[0] ?? null));
      case 'ceil': return Math.ceil(toNumberValue(args[0] ?? null));
      case 'floor': return Math.floor(toNumberValue(args[0] ?? null));
      case 'round': return Math.round(toNumberValue(args[0] ?? null));
      case 'hour': return zonedDateParts(this.state.now, args[0] as string | null).hour;
      case 'minute': return zonedDateParts(this.state.now, args[0] as string | null).minute;
      case 'weekday': return zonedDateParts(this.state.now, args[0] as string | null).weekday;
      case 'month': return zonedDateParts(this.state.now, args[0] as string | null).month;
      case 'day': return zonedDateParts(this.state.now, args[0] as string | null).day;
      case 'has': {
        const source = args[0];
        const substr = args[1];
        if (source === null || source === undefined || typeof substr !== 'string' || substr === '') return false;
        return String(source).includes(substr);
      }
      // 请求级上下文（请求体/请求头/用量明细）在价目表里取不到，按「不存在」处理。
      case 'param':
      case 'header':
      case 'u':
        return null;
      default:
        throw new BillingExpressionError(`不支持的函数 ${name}()`);
    }
  }
}

function buildEnv(overrides: BillingExpressionTokenEnv, now: Date): Record<string, number> {
  return {
    p: overrides.p ?? 0,
    c: overrides.c ?? 0,
    len: overrides.len ?? 0,
    cr: overrides.cr ?? 0,
    cc: overrides.cc ?? 0,
    cc1h: overrides.cc1h ?? 0,
    img: overrides.img ?? 0,
    img_cr: overrides.img_cr ?? 0,
    img_o: overrides.img_o ?? 0,
    ai: overrides.ai ?? 0,
    ao: overrides.ao ?? 0,
    image_count: overrides.image_count ?? 1,
  };
}

/** 代入具体 token 数量求值。解析/求值失败时返回 `null`，调用方应退回倍率逻辑。 */
export function evaluateBillingExpression(
  expression: string,
  tokens: BillingExpressionTokenEnv,
  now: Date = new Date(),
): BillingExpressionEvalResult | null {
  if (!expression || !expression.trim()) return null;
  const state: EvalState = {
    now,
    matchedTier: null,
    billingUnit: 'token',
    fixedPriceUsd: null,
  };
  try {
    const value = new Parser(expression, buildEnv(tokens, now), state).parse();
    const rawCost = toNumberValue(value);
    if (!Number.isFinite(rawCost)) return null;
    return {
      rawCost,
      costUsd: rawCost / RAW_COST_PER_USD,
      billingUnit: state.billingUnit,
      fixedPriceUsd: state.fixedPriceUsd,
      matchedTier: state.matchedTier,
    };
  } catch {
    return null;
  }
}

const SAMPLE_ENV: BillingExpressionTokenEnv = {
  p: SAMPLE_BASE_TOKENS,
  c: SAMPLE_BASE_TOKENS,
  len: SAMPLE_LEN_TOKENS,
  cr: 0,
  cc: 0,
  cc1h: 0,
  img: 0,
  ai: 0,
  ao: 0,
  image_count: 1,
};

/**
 * 还原出「每 1M tokens 的输入/输出价」。多档表达式取最短上下文那档（与站点
 * 价目表首档一致）。差分会把表达式里的固定项、`min`/`max` 等一起消掉，所以
 * 比直接取系数更稳。
 */
export function resolveBillingExpressionPricing(
  expression: string,
  options: { now?: Date; imageCount?: number } = {},
): BillingExpressionPricing | null {
  const now = options.now ?? new Date();
  const imageCount = options.imageCount ?? 1;
  const base = { ...SAMPLE_ENV, image_count: imageCount };

  const low = evaluateBillingExpression(expression, {
    ...base,
    p: SAMPLE_BASE_TOKENS,
    c: SAMPLE_BASE_TOKENS,
  }, now);
  if (!low) return null;

  if (low.billingUnit === 'request') {
    return {
      unit: 'request',
      inputPerMillion: null,
      outputPerMillion: null,
      perRequestUsd: low.fixedPriceUsd ?? low.costUsd,
      matchedTier: low.matchedTier,
    };
  }

  const inputHigh = evaluateBillingExpression(expression, {
    ...base,
    p: SAMPLE_HIGH_TOKENS,
    c: SAMPLE_OTHER_TOKENS,
  }, now);
  const inputBase = evaluateBillingExpression(expression, {
    ...base,
    p: SAMPLE_BASE_TOKENS,
    c: SAMPLE_OTHER_TOKENS,
  }, now);
  const outputHigh = evaluateBillingExpression(expression, {
    ...base,
    p: SAMPLE_OTHER_TOKENS,
    c: SAMPLE_HIGH_TOKENS,
  }, now);
  const outputBase = evaluateBillingExpression(expression, {
    ...base,
    p: SAMPLE_OTHER_TOKENS,
    c: SAMPLE_BASE_TOKENS,
  }, now);
  if (!inputHigh || !inputBase || !outputHigh || !outputBase) return null;

  const inputPerMillion = (inputHigh.costUsd - inputBase.costUsd) / (SAMPLE_HIGH_TOKENS - SAMPLE_BASE_TOKENS) * 1_000_000;
  const outputPerMillion = (outputHigh.costUsd - outputBase.costUsd) / (SAMPLE_HIGH_TOKENS - SAMPLE_BASE_TOKENS) * 1_000_000;

  const input = Number.isFinite(inputPerMillion) && inputPerMillion >= 0 ? roundPrice(inputPerMillion) : null;
  const output = Number.isFinite(outputPerMillion) && outputPerMillion >= 0 ? roundPrice(outputPerMillion) : null;
  if (input === null && output === null) return null;

  return {
    unit: 'token',
    inputPerMillion: input,
    outputPerMillion: output,
    perRequestUsd: null,
    matchedTier: low.matchedTier,
  };
}
