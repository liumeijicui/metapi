export type JudgeMode = 'exact' | 'contains' | 'regex' | 'manual';

export type PromptSuite = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  category: string | null;
  sourceUrl: string | null;
  tags: string[];
  sortOrder: number;
  caseCount: number;
  enabledCaseCount: number;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PromptCase = {
  id: number;
  suiteId: number;
  title: string;
  prompt: string;
  expectedAnswer: string | null;
  answerNotes: string | null;
  judgeMode: JudgeMode;
  tags: string[];
  sortOrder: number;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type BuiltinPresetCase = {
  title: string;
  prompt: string;
  expectedAnswer: string | null;
  answerNotes: string | null;
  judgeMode: JudgeMode;
  tags: string[];
  sortOrder: number;
};

export type BuiltinPreset = {
  name: string;
  slug: string;
  description: string;
  category: string;
  sourceUrl: string | null;
  tags: string[];
  sortOrder: number;
  cases: BuiltinPresetCase[];
  imported: boolean;
  suiteId: number | null;
};

export const JUDGE_MODE_OPTIONS: Array<{ value: JudgeMode; label: string; description: string }> = [
  { value: 'manual', label: '人工评分', description: '主观题，按评分要点人工判断' },
  { value: 'exact', label: '精确匹配', description: '答案需与标准答案完全一致' },
  { value: 'contains', label: '包含匹配', description: '答案中包含标准答案即可' },
  { value: 'regex', label: '正则匹配', description: '用标准答案作为正则表达式匹配' },
];

export function judgeModeLabel(mode: JudgeMode | string): string {
  return JUDGE_MODE_OPTIONS.find((item) => item.value === mode)?.label ?? '人工评分';
}

export function parseTagInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,，\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function formatTagInput(tags: string[] | null | undefined): string {
  return (tags ?? []).join(', ');
}
