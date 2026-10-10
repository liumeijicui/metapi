export type ModelFamilyId =
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'deepseek'
  | 'glm'
  | 'kimi'
  | 'qwen'
  | 'grok'
  | 'minimax'
  | 'llama'
  | 'mistral'
  | 'other';

export type ModelFamilyDef = {
  id: Exclude<ModelFamilyId, 'other'>;
  label: string;
  /** 命中任意一条即算这个家族。 */
  patterns: RegExp[];
};

/** 顺序即优先级，前面的先认。 */
export declare const MODEL_FAMILY_DEFS: readonly ModelFamilyDef[];

export declare const MODEL_FAMILY_IDS: readonly ModelFamilyId[];

/** 模型名归到哪个家族；认不出来就是 `other`。 */
export declare function resolveModelFamily(modelName: string | null | undefined): ModelFamilyId;

export declare function modelFamilyLabel(id: ModelFamilyId | string): string;

/** 请求参数里带上来的家族名，非法值一律当「不筛」。 */
export declare function isModelFamilyId(value: unknown): value is ModelFamilyId;
