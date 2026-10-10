/**
 * 模型「家族」归类：模型监控的筛选下拉按它分组。
 *
 * 上游站点给的模型名五花八门（`[满血A]gemini-3.1-pro-preview`、`z-ai/glm-5.3`、
 * `@cf/qwen/qwen3-30b-a3b-fp8`），没有统一字段可依据，只能用名字里的关键字判断。
 * 前后端共用这一份，免得服务端把 `glm-5.3` 归到 GLM、页面却显示在「其他」。
 *
 * 认不出来的统一进 `other`，宁可漏判也不要硬塞进某个家族。
 *
 * 这里是 `.js`：`src/shared` 下能被服务端引用的模块只能是 `.js` + `.d.ts`。
 * 需要单个品牌的图标/配色请用 `src/server/shared/modelBrand.ts`，那是另一回事。
 */

/**
 * 顺序即优先级，前面的先认。
 *
 * 需要顺序是因为有些名字里带着两个家族：`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`
 * 是 DeepSeek 的蒸馏模型，应该算 DeepSeek 而不是 Qwen；`@cf/openai/gpt-oss-120b`
 * 算 OpenAI 而不是别的。所以把更「专有」的家族（Claude / DeepSeek）放在通用词
 * （qwen / llama）前面。
 */
export const MODEL_FAMILY_DEFS = [
  { id: 'claude', label: 'Claude', patterns: [/claude/, /anthropic/] },
  { id: 'deepseek', label: 'DeepSeek', patterns: [/deepseek/] },
  {
    id: 'openai',
    label: 'OpenAI',
    // gpt-oss / gpt-image / codex / dall-e 都算 OpenAI；`o1`/`o3`/`o4` 这类短名
    // 要卡边界，`model-O`、`nemotron-3` 不能被误伤。
    patterns: [/gpt/, /chatgpt/, /dall-e/, /davinci/, /whisper/, /sora/, /codex/, /openai/, /(?:^|[^a-z0-9])o[1-9](?![0-9])/],
  },
  { id: 'gemini', label: 'Gemini', patterns: [/gemini/, /gemma/, /learnlm/, /palm-/] },
  { id: 'glm', label: 'GLM', patterns: [/glm/, /chatglm/, /zhipu/] },
  { id: 'kimi', label: 'Kimi', patterns: [/kimi/, /moonshot/] },
  { id: 'qwen', label: 'Qwen', patterns: [/qwen/, /qwq/] },
  { id: 'grok', label: 'Grok', patterns: [/grok/] },
  { id: 'minimax', label: 'MiniMax', patterns: [/minimax/, /abab/] },
  { id: 'llama', label: 'Llama', patterns: [/llama/] },
  {
    id: 'mistral',
    label: 'Mistral',
    patterns: [/mistral/, /mixtral/, /ministral/, /codestral/, /magistral/, /devstral/, /voxtral/],
  },
];

export const MODEL_FAMILY_IDS = [...MODEL_FAMILY_DEFS.map((def) => def.id), 'other'];

const MODEL_FAMILY_LABELS = {
  openai: 'OpenAI',
  claude: 'Claude',
  gemini: 'Gemini',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  kimi: 'Kimi',
  qwen: 'Qwen',
  grok: 'Grok',
  minimax: 'MiniMax',
  llama: 'Llama',
  mistral: 'Mistral',
  other: '其他',
};

/** 模型名归到哪个家族；认不出来就是 `other`。 */
export function resolveModelFamily(modelName) {
  const name = String(modelName || '').trim().toLowerCase();
  if (!name) return 'other';
  for (const def of MODEL_FAMILY_DEFS) {
    if (def.patterns.some((pattern) => pattern.test(name))) return def.id;
  }
  return 'other';
}

export function modelFamilyLabel(id) {
  return MODEL_FAMILY_LABELS[id] ?? MODEL_FAMILY_LABELS.other;
}

/** 请求参数里带上来的家族名，非法值一律当「不筛」。 */
export function isModelFamilyId(value) {
  return typeof value === 'string' && MODEL_FAMILY_IDS.includes(value);
}
