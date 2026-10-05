import { and, asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { requireInsertedRowId } from '../db/insertHelpers.js';

export class PromptLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptLibraryError';
  }
}

export const PROMPT_JUDGE_MODES = ['exact', 'contains', 'regex', 'manual'] as const;
export type PromptJudgeMode = (typeof PROMPT_JUDGE_MODES)[number];

export type PromptSuiteRow = {
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

export type PromptCaseRow = {
  id: number;
  suiteId: number;
  title: string;
  prompt: string;
  expectedAnswer: string | null;
  answerNotes: string | null;
  judgeMode: PromptJudgeMode;
  tags: string[];
  sortOrder: number;
  enabled: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PromptSuiteInput = {
  name: string;
  slug?: string | null;
  description?: string | null;
  category?: string | null;
  sourceUrl?: string | null;
  tags?: unknown;
  sortOrder?: number | null;
};

export type PromptCaseInput = {
  suiteId: number;
  title: string;
  prompt: string;
  expectedAnswer?: string | null;
  answerNotes?: string | null;
  judgeMode?: string | null;
  tags?: unknown;
  sortOrder?: number | null;
  enabled?: boolean | null;
};

export type BuiltinPromptPresetCase = {
  title: string;
  prompt: string;
  expectedAnswer: string | null;
  answerNotes: string | null;
  judgeMode: PromptJudgeMode;
  tags: string[];
  sortOrder: number;
};

export type BuiltinPromptPreset = {
  name: string;
  slug: string;
  description: string;
  category: string;
  sourceUrl: string | null;
  tags: string[];
  sortOrder: number;
  cases: BuiltinPromptPresetCase[];
};

/**
 * 内置题库预设。这里只登记「题目和答案」，导入后写入 prompt_suites / prompt_cases，
 * 用户可以自由改名、加题、删题，重复导入不会覆盖已有内容（按 slug / (suiteId,title) 去重）。
 */
export const BUILTIN_PROMPT_PRESETS: BuiltinPromptPreset[] = [
  {
    name: '鹈鹕测试',
    slug: 'pelican-benchmark',
    description:
      'Pelican Benchmark：让模型用 SVG 画「骑自行车的鹈鹕」。考的是模型把相互冲突的物体组合成结构正确图形、并直接产出可渲染代码的能力，属于主观视觉题，没有唯一标准答案。',
    category: '视觉生成',
    sourceUrl: 'https://simonwillison.net/2024/Aug/18/pelican-benchmark/',
    tags: ['视觉', 'SVG', '通用能力'],
    sortOrder: 10,
    cases: [
      {
        title: '鹈鹕骑自行车（原版）',
        prompt: 'Generate an SVG of a pelican riding a bicycle',
        expectedAnswer: null,
        answerNotes:
          '主观视觉题，无唯一答案。评分要点：①输出为可直接渲染的 <svg> 代码，而不是文字描述、Markdown 图片链接或 base64 图片；②自行车结构成立（两个车轮、辐条、车架、车把、脚踏/链条）；③鹈鹕特征可辨认（大喙、喉囊、身体、翅膀）；④鹈鹕与自行车正确结合（脚踩在脚踏上、翅/鳍扶车把均可）；⑤图形比例不过分离谱。',
        judgeMode: 'manual',
        tags: ['原版'],
        sortOrder: 10,
      },
      {
        title: '鹈鹕骑自行车（动画 / 无背景）',
        prompt: 'Draw a pelican riding a bicycle as an SVG, animated, no background',
        expectedAnswer: null,
        answerNotes:
          '在原版基础上增加两条硬性要求：①包含动画（<animate>/<animateTransform> 或 CSS 动画，车轮转动、场景位移等均可）；②无背景（不画天空/地面/背景色矩形）。其余评分要点同原版。常见失败：只画静态图、加了背景矩形、用文字说明代替代码。',
        judgeMode: 'manual',
        tags: ['动画', '无背景'],
        sortOrder: 20,
      },
      {
        title: '鹈鹕骑自行车（中文指令）',
        prompt: '请画一只骑自行车的鹈鹕，输出 SVG，不要任何解释文字',
        expectedAnswer: null,
        answerNotes:
          '中文指令版，额外考察是否遵守「只输出 SVG、不要解释文字」的格式约束。评分要点同原版，另外注意答案是否夹带前言后语。',
        judgeMode: 'manual',
        tags: ['中文'],
        sortOrder: 30,
      },
    ],
  },
  {
    name: '糖果测试',
    slug: 'candy-count',
    description:
      '经典的视觉计数题：给出一张混有圆形糖果和五角星糖果的图片，问一共有多少颗。大模型经常数错，用来考察视觉计数与「被形状干扰」时的稳定性。',
    category: '视觉计数',
    sourceUrl: null,
    tags: ['视觉', '计数', '有标准答案'],
    sortOrder: 20,
    cases: [
      {
        title: '糖果一共有多少颗',
        prompt: 'How many candies are in the image?',
        expectedAnswer: '21',
        answerNotes:
          '需配合题目配图使用：图中 9 个圆形糖果 + 12 个五角星形糖果，共 21 个。模型常见错误答案是 24 / 18 / 30。若只发文字不附图，模型无法作答，判为无效样本。',
        judgeMode: 'exact',
        tags: ['标准答案21'],
        sortOrder: 10,
      },
      {
        title: '圆形糖果有多少颗',
        prompt: 'How many round candies are in the image?',
        expectedAnswer: '9',
        answerNotes: '同一张配图，只数圆形糖果：9 颗。用来确认模型是「数错」还是「把五角星也算进去了」。',
        judgeMode: 'exact',
        tags: ['标准答案9'],
        sortOrder: 20,
      },
    ],
  },
  {
    name: '经典推理测试',
    slug: 'classic-reasoning',
    description:
      '几个流传很广、带唯一标准答案的陷阱题，专门用来暴露模型在字符计数和数值比较上的失误。',
    category: '文本推理',
    sourceUrl: null,
    tags: ['文本', '推理', '有标准答案'],
    sortOrder: 30,
    cases: [
      {
        title: 'strawberry 里有几个字母 r',
        prompt: "How many 'r' letters are in the word 'strawberry'?",
        expectedAnswer: '3',
        answerNotes: "s-t-r-a-w-b-e-r-r-y，共 3 个 r。常见错误答案：2。",
        judgeMode: 'contains',
        tags: ['字符计数', '标准答案3'],
        sortOrder: 10,
      },
      {
        title: '9.11 和 9.9 哪个大',
        prompt: '9.11 和 9.9 这两个数字，哪个更大？',
        expectedAnswer: '9.9',
        answerNotes:
          '按数值比较是 9.9 更大（9.9 = 9.90 > 9.11）。常见错误：按字符串/版本号比较得出 9.11 更大。',
        judgeMode: 'contains',
        tags: ['数值比较', '标准答案9.9'],
        sortOrder: 20,
      },
      {
        title: '一公斤棉花和一公斤铁哪个重',
        prompt: '一公斤棉花和一公斤铁，哪个更重？',
        expectedAnswer: '一样重',
        answerNotes:
          '质量相同，一样重（这里指质量而非体积/密度）。陷阱在于受「铁比棉花重」的直觉误导。',
        judgeMode: 'contains',
        tags: ['常识陷阱'],
        sortOrder: 30,
      },
    ],
  },
  {
    name: '时钟测试',
    slug: 'clock-test',
    description:
      '让模型画一个指向固定时刻的 SVG 时钟。表盘刻度、指针角度、指针长度都要对，是检验「几何关系 + 是否真的把指针画到 10:10 而不是 1:50」的经典视觉题。',
    category: '视觉生成',
    sourceUrl: null,
    tags: ['视觉', 'SVG', '几何'],
    sortOrder: 40,
    cases: [
      {
        title: 'SVG 时钟指向 10:10',
        prompt: 'Generate an SVG of an analog clock showing the time 10:10',
        expectedAnswer: null,
        answerNotes:
          '主观视觉题，无唯一答案。评分要点：①输出可直接渲染的 <svg>（不是文字描述或图片链接）；②12 个时刻刻度齐全，数字或刻度线位置正确；③时针指向 10 与 11 之间偏 10（10:10 时时针约在 10 点的 1/6 处，不是正对 10）、分针正对 2；④时针比分针短；⑤中心有转轴。常见失败：指针角度反了（画成 1:50）、两根指针一样长、刻度缺失。',
        judgeMode: 'manual',
        tags: ['几何', '指针角度'],
        sortOrder: 10,
      },
    ],
  },
  {
    name: '六边形弹跳球',
    slug: 'hexagon-bounce',
    description:
      '要求用一个 HTML 文件画出「小球在一个旋转的六边形里弹跳并遵守物理规律」。考验模型把几何、碰撞与动画写进一份可运行代码的能力，是 GPT-5 发布时用来演示代码能力的题目。',
    category: '代码生成',
    sourceUrl: null,
    tags: ['代码', '物理', '动画'],
    sortOrder: 50,
    cases: [
      {
        title: '旋转六边形里的弹跳球（单文件）',
        prompt:
          'Write a single HTML file with JavaScript that renders a ball bouncing inside a rotating hexagon. The ball must obey the laws of physics (gravity, no energy loss on wall collisions, correct collision detection against the rotating walls). Include the drawing code as well.',
        expectedAnswer: null,
        answerNotes:
          '主观代码题，无唯一答案。评分要点：①是可独立运行的单文件（内联 <script>/<canvas>，不需要外部依赖）；②六边形在持续旋转；③小球受重力、会随时间下落到下壁；④与旋转的边做碰撞检测（把球速变换到墙面坐标系处理），碰壁后速度方向正确、速率基本守恒；⑤球不会穿墙或卡住；⑥能实际跑起来。常见失败：六边形不转、球穿墙、把碰撞写成「碰到屏幕边缘反弹」、需要外部库导致跑不起来。',
        judgeMode: 'manual',
        tags: ['单文件', '碰撞检测'],
        sortOrder: 10,
      },
    ],
  },
];

function normalizeTags(input: unknown): string[] {
  let source: unknown[] = [];
  if (Array.isArray(input)) {
    source = input;
  } else if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) source = parsed;
    } catch {
      source = raw.split(',');
    }
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const item of source) {
    const text = String(item ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    tags.push(text);
  }
  return tags;
}

function serializeTags(input: unknown): string | null {
  const tags = normalizeTags(input);
  return tags.length ? JSON.stringify(tags) : null;
}

function parseStoredTags(input: unknown): string[] {
  return normalizeTags(input);
}

function normalizeJudgeMode(input: unknown): PromptJudgeMode {
  const value = String(input ?? '').trim().toLowerCase();
  return (PROMPT_JUDGE_MODES as readonly string[]).includes(value)
    ? (value as PromptJudgeMode)
    : 'manual';
}

function normalizeId(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PromptLibraryError(`${label}无效`);
  }
  return Math.trunc(parsed);
}

function normalizeSortOrder(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

export function slugifySuiteName(name: string): string {
  const slug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (slug && /[a-z0-9]/.test(slug)) return slug;
  return `suite-${Date.now().toString(36)}`;
}

function toOptionalText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function toSuiteRow(
  row: typeof schema.promptSuites.$inferSelect,
  counts: { caseCount: number; enabledCaseCount: number },
): PromptSuiteRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    category: row.category ?? null,
    sourceUrl: row.sourceUrl ?? null,
    tags: parseStoredTags(row.tags),
    sortOrder: Number(row.sortOrder ?? 0),
    caseCount: counts.caseCount,
    enabledCaseCount: counts.enabledCaseCount,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

function toCaseRow(row: typeof schema.promptCases.$inferSelect): PromptCaseRow {
  return {
    id: row.id,
    suiteId: row.suiteId,
    title: row.title,
    prompt: row.prompt,
    expectedAnswer: row.expectedAnswer ?? null,
    answerNotes: row.answerNotes ?? null,
    judgeMode: normalizeJudgeMode(row.judgeMode),
    tags: parseStoredTags(row.tags),
    sortOrder: Number(row.sortOrder ?? 0),
    enabled: row.enabled !== false,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

async function countCasesBySuite(): Promise<Map<number, { caseCount: number; enabledCaseCount: number }>> {
  const rows = await db
    .select({ suiteId: schema.promptCases.suiteId, enabled: schema.promptCases.enabled })
    .from(schema.promptCases)
    .all();
  const counts = new Map<number, { caseCount: number; enabledCaseCount: number }>();
  for (const row of rows) {
    const entry = counts.get(row.suiteId) ?? { caseCount: 0, enabledCaseCount: 0 };
    entry.caseCount += 1;
    if (row.enabled !== false) entry.enabledCaseCount += 1;
    counts.set(row.suiteId, entry);
  }
  return counts;
}

export async function listPromptSuites(): Promise<PromptSuiteRow[]> {
  const rows = await db
    .select()
    .from(schema.promptSuites)
    .orderBy(asc(schema.promptSuites.sortOrder), asc(schema.promptSuites.id))
    .all();
  const counts = await countCasesBySuite();
  return rows.map((row) => toSuiteRow(row, counts.get(row.id) ?? { caseCount: 0, enabledCaseCount: 0 }));
}

export async function getPromptSuite(id: unknown): Promise<PromptSuiteRow | null> {
  const suiteId = normalizeId(id, '题库 ID');
  const row = await db
    .select()
    .from(schema.promptSuites)
    .where(eq(schema.promptSuites.id, suiteId))
    .get();
  if (!row) return null;
  const counts = await countCasesBySuite();
  return toSuiteRow(row, counts.get(row.id) ?? { caseCount: 0, enabledCaseCount: 0 });
}

export async function createPromptSuite(input: PromptSuiteInput): Promise<PromptSuiteRow> {
  const name = toOptionalText(input?.name);
  if (!name) throw new PromptLibraryError('题库名称不能为空');
  const slug = toOptionalText(input?.slug) ?? slugifySuiteName(name);
  const existing = await db
    .select()
    .from(schema.promptSuites)
    .where(eq(schema.promptSuites.slug, slug))
    .get();
  if (existing) throw new PromptLibraryError(`题库标识「${slug}」已存在`);

  const inserted = await db
    .insert(schema.promptSuites)
    .values({
      name,
      slug,
      description: toOptionalText(input?.description),
      category: toOptionalText(input?.category),
      sourceUrl: toOptionalText(input?.sourceUrl),
      tags: serializeTags(input?.tags),
      sortOrder: normalizeSortOrder(input?.sortOrder),
    })
    .run();
  const id = requireInsertedRowId(inserted, '创建题库失败');
  const created = await getPromptSuite(id);
  if (!created) throw new PromptLibraryError('创建题库失败');
  return created;
}

export async function updatePromptSuite(id: unknown, input: PromptSuiteInput): Promise<PromptSuiteRow> {
  const suiteId = normalizeId(id, '题库 ID');
  const current = await db
    .select()
    .from(schema.promptSuites)
    .where(eq(schema.promptSuites.id, suiteId))
    .get();
  if (!current) throw new PromptLibraryError('题库不存在');

  const patch: Record<string, unknown> = {};
  if (input?.name !== undefined) {
    const name = toOptionalText(input.name);
    if (!name) throw new PromptLibraryError('题库名称不能为空');
    patch.name = name;
  }
  if (input?.slug !== undefined) {
    const slug = toOptionalText(input.slug);
    if (!slug) throw new PromptLibraryError('题库标识不能为空');
    if (slug !== current.slug) {
      const duplicate = await db
        .select()
        .from(schema.promptSuites)
        .where(eq(schema.promptSuites.slug, slug))
        .get();
      if (duplicate) throw new PromptLibraryError(`题库标识「${slug}」已存在`);
    }
    patch.slug = slug;
  }
  if (input?.description !== undefined) patch.description = toOptionalText(input.description);
  if (input?.category !== undefined) patch.category = toOptionalText(input.category);
  if (input?.sourceUrl !== undefined) patch.sourceUrl = toOptionalText(input.sourceUrl);
  if (input?.tags !== undefined) patch.tags = serializeTags(input.tags);
  if (input?.sortOrder !== undefined) patch.sortOrder = normalizeSortOrder(input.sortOrder);

  if (Object.keys(patch).length > 0) {
    await db
      .update(schema.promptSuites)
      .set(patch)
      .where(eq(schema.promptSuites.id, suiteId))
      .run();
  }
  const updated = await getPromptSuite(suiteId);
  if (!updated) throw new PromptLibraryError('题库不存在');
  return updated;
}

export async function deletePromptSuite(id: unknown): Promise<void> {
  const suiteId = normalizeId(id, '题库 ID');
  const current = await db
    .select()
    .from(schema.promptSuites)
    .where(eq(schema.promptSuites.id, suiteId))
    .get();
  if (!current) throw new PromptLibraryError('题库不存在');
  await db.delete(schema.promptCases).where(eq(schema.promptCases.suiteId, suiteId)).run();
  await db.delete(schema.promptSuites).where(eq(schema.promptSuites.id, suiteId)).run();
}

export async function listPromptCases(suiteId: unknown): Promise<PromptCaseRow[]> {
  const id = normalizeId(suiteId, '题库 ID');
  const rows = await db
    .select()
    .from(schema.promptCases)
    .where(eq(schema.promptCases.suiteId, id))
    .orderBy(asc(schema.promptCases.sortOrder), asc(schema.promptCases.id))
    .all();
  return rows.map(toCaseRow);
}

export async function createPromptCase(input: PromptCaseInput): Promise<PromptCaseRow> {
  const suiteId = normalizeId(input?.suiteId, '题库 ID');
  const suite = await db
    .select()
    .from(schema.promptSuites)
    .where(eq(schema.promptSuites.id, suiteId))
    .get();
  if (!suite) throw new PromptLibraryError('题库不存在');
  const title = toOptionalText(input?.title);
  if (!title) throw new PromptLibraryError('题目标题不能为空');
  const prompt = toOptionalText(input?.prompt);
  if (!prompt) throw new PromptLibraryError('提示词内容不能为空');

  const duplicate = await db
    .select()
    .from(schema.promptCases)
    .where(and(eq(schema.promptCases.suiteId, suiteId), eq(schema.promptCases.title, title)))
    .get();
  if (duplicate) throw new PromptLibraryError(`该题库下已存在同名题目「${title}」`);

  const inserted = await db
    .insert(schema.promptCases)
    .values({
      suiteId,
      title,
      prompt,
      expectedAnswer: toOptionalText(input?.expectedAnswer),
      answerNotes: toOptionalText(input?.answerNotes),
      judgeMode: normalizeJudgeMode(input?.judgeMode),
      tags: serializeTags(input?.tags),
      sortOrder: normalizeSortOrder(input?.sortOrder),
      enabled: input?.enabled === undefined || input?.enabled === null ? true : Boolean(input.enabled),
    })
    .run();
  const newId = requireInsertedRowId(inserted, '创建题目失败');
  const created = await db
    .select()
    .from(schema.promptCases)
    .where(eq(schema.promptCases.id, newId))
    .get();
  if (!created) throw new PromptLibraryError('创建题目失败');
  return toCaseRow(created);
}

export async function updatePromptCase(id: unknown, input: Partial<PromptCaseInput>): Promise<PromptCaseRow> {
  const caseId = normalizeId(id, '题目 ID');
  const current = await db
    .select()
    .from(schema.promptCases)
    .where(eq(schema.promptCases.id, caseId))
    .get();
  if (!current) throw new PromptLibraryError('题目不存在');

  const patch: Record<string, unknown> = {};
  if (input?.title !== undefined) {
    const title = toOptionalText(input.title);
    if (!title) throw new PromptLibraryError('题目标题不能为空');
    if (title !== current.title) {
      const duplicate = await db
        .select()
        .from(schema.promptCases)
        .where(and(eq(schema.promptCases.suiteId, current.suiteId), eq(schema.promptCases.title, title)))
        .get();
      if (duplicate) throw new PromptLibraryError(`该题库下已存在同名题目「${title}」`);
    }
    patch.title = title;
  }
  if (input?.prompt !== undefined) {
    const prompt = toOptionalText(input.prompt);
    if (!prompt) throw new PromptLibraryError('提示词内容不能为空');
    patch.prompt = prompt;
  }
  if (input?.expectedAnswer !== undefined) patch.expectedAnswer = toOptionalText(input.expectedAnswer);
  if (input?.answerNotes !== undefined) patch.answerNotes = toOptionalText(input.answerNotes);
  if (input?.judgeMode !== undefined) patch.judgeMode = normalizeJudgeMode(input.judgeMode);
  if (input?.tags !== undefined) patch.tags = serializeTags(input.tags);
  if (input?.sortOrder !== undefined) patch.sortOrder = normalizeSortOrder(input.sortOrder);
  if (input?.enabled !== undefined && input?.enabled !== null) patch.enabled = Boolean(input.enabled);
  if (input?.suiteId !== undefined) {
    const nextSuiteId = normalizeId(input.suiteId, '题库 ID');
    if (nextSuiteId !== current.suiteId) {
      const suite = await db
        .select()
        .from(schema.promptSuites)
        .where(eq(schema.promptSuites.id, nextSuiteId))
        .get();
      if (!suite) throw new PromptLibraryError('目标题库不存在');
      patch.suiteId = nextSuiteId;
    }
  }

  if (Object.keys(patch).length > 0) {
    await db
      .update(schema.promptCases)
      .set(patch)
      .where(eq(schema.promptCases.id, caseId))
      .run();
  }
  const updated = await db
    .select()
    .from(schema.promptCases)
    .where(eq(schema.promptCases.id, caseId))
    .get();
  if (!updated) throw new PromptLibraryError('题目不存在');
  return toCaseRow(updated);
}

export async function deletePromptCase(id: unknown): Promise<void> {
  const caseId = normalizeId(id, '题目 ID');
  const current = await db
    .select()
    .from(schema.promptCases)
    .where(eq(schema.promptCases.id, caseId))
    .get();
  if (!current) throw new PromptLibraryError('题目不存在');
  await db.delete(schema.promptCases).where(eq(schema.promptCases.id, caseId)).run();
}

export type BuiltinPromptPresetView = BuiltinPromptPreset & {
  imported: boolean;
  suiteId: number | null;
};

export async function listBuiltinPromptPresets(): Promise<BuiltinPromptPresetView[]> {
  const existing = await db.select().from(schema.promptSuites).all();
  const bySlug = new Map<string, number>();
  for (const row of existing) {
    bySlug.set(String(row.slug), Number(row.id));
  }
  return BUILTIN_PROMPT_PRESETS.map((preset) => {
    const suiteId = bySlug.get(preset.slug) ?? null;
    return { ...preset, imported: suiteId !== null, suiteId };
  });
}

/** 启动时用：把所有内置题库补齐，已存在（按 slug）的跳过，不覆盖用户改动。 */
export async function ensureBuiltinPromptPresets(): Promise<{ imported: string[] }> {
  const existing = await db
    .select({ slug: schema.promptSuites.slug })
    .from(schema.promptSuites)
    .all();
  const present = new Set(existing.map((row) => String(row.slug)));
  const imported: string[] = [];
  for (const preset of BUILTIN_PROMPT_PRESETS) {
    if (present.has(preset.slug)) continue;
    await importBuiltinPromptPreset(preset.slug);
    imported.push(preset.slug);
  }
  return { imported };
}

/** 对话弹窗的「快捷提示词」用：一次性取出所有启用题目，带题库名。 */
export type PromptCaseWithSuite = PromptCaseRow & {
  suiteName: string;
  suiteSlug: string;
  suiteCategory: string | null;
};

export async function listEnabledPromptCasesWithSuite(): Promise<PromptCaseWithSuite[]> {
  const rows = await db
    .select({
      case: schema.promptCases,
      suiteName: schema.promptSuites.name,
      suiteSlug: schema.promptSuites.slug,
      suiteCategory: schema.promptSuites.category,
      suiteSortOrder: schema.promptSuites.sortOrder,
    })
    .from(schema.promptCases)
    .innerJoin(schema.promptSuites, eq(schema.promptSuites.id, schema.promptCases.suiteId))
    .where(eq(schema.promptCases.enabled, true))
    .orderBy(
      asc(schema.promptSuites.sortOrder),
      asc(schema.promptSuites.id),
      asc(schema.promptCases.sortOrder),
      asc(schema.promptCases.id),
    )
    .all();
  return rows.map((row) => ({
    ...toCaseRow(row.case),
    suiteName: row.suiteName,
    suiteSlug: row.suiteSlug,
    suiteCategory: row.suiteCategory ?? null,
  }));
}

export type ImportPromptPresetResult = {
  suiteId: number;
  suiteCreated: boolean;
  casesCreated: number;
  casesSkipped: number;
  preset: BuiltinPromptPresetView;
};

/** 幂等导入内置题库：按 slug 复用题库，按 (suiteId,title) 跳过已存在题目，不覆盖用户改动。 */
export async function importBuiltinPromptPreset(slug: unknown): Promise<ImportPromptPresetResult> {
  const target = String(slug ?? '').trim();
  const preset = BUILTIN_PROMPT_PRESETS.find((item) => item.slug === target);
  if (!preset) throw new PromptLibraryError(`内置题库「${target}」不存在`);

  const existing = await db
    .select()
    .from(schema.promptSuites)
    .where(eq(schema.promptSuites.slug, preset.slug))
    .get();

  let suiteId: number;
  let suiteCreated = false;
  if (existing) {
    suiteId = existing.id;
  } else {
    const inserted = await db
      .insert(schema.promptSuites)
      .values({
        name: preset.name,
        slug: preset.slug,
        description: preset.description,
        category: preset.category,
        sourceUrl: preset.sourceUrl,
        tags: serializeTags(preset.tags),
        sortOrder: preset.sortOrder,
      })
      .run();
    suiteId = requireInsertedRowId(inserted, '导入题库失败');
    suiteCreated = true;
  }

  const existingCases = await db
    .select({ title: schema.promptCases.title })
    .from(schema.promptCases)
    .where(eq(schema.promptCases.suiteId, suiteId))
    .all();
  const existingTitles = new Set(existingCases.map((row) => row.title));

  let casesCreated = 0;
  let casesSkipped = 0;
  for (const item of preset.cases) {
    if (existingTitles.has(item.title)) {
      casesSkipped += 1;
      continue;
    }
    await db
      .insert(schema.promptCases)
      .values({
        suiteId,
        title: item.title,
        prompt: item.prompt,
        expectedAnswer: item.expectedAnswer,
        answerNotes: item.answerNotes,
        judgeMode: item.judgeMode,
        tags: serializeTags(item.tags),
        sortOrder: item.sortOrder,
        enabled: true,
      })
      .run();
    casesCreated += 1;
  }

  const presetView: BuiltinPromptPresetView = { ...preset, imported: true, suiteId };
  return { suiteId, suiteCreated, casesCreated, casesSkipped, preset: presetView };
}
