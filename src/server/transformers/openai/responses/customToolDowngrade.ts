import {
  CUSTOM_TOOL_INPUT_ARGUMENT,
  buildResponsesCustomToolDescription,
  unwrapCustomToolCallArguments,
} from './toolCompat.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const CUSTOM_TOOL_CALL_ITEM_ID_PREFIX = 'ctc_';

/**
 * 转发站自造的 tool call id 前缀（OpenAI 的 `fc_`、new-api/CC 类薄壳的 `ct_`、
 * 部分站点的临时 id `fc_tmp_*`、Anthropic 转出来的 `toolu_`）。
 */
const FOREIGN_TOOL_CALL_ID_PREFIXES = ['fc_', 'ct_', 'call_', 'custom_tool_call_', 'toolu_'] as const;

/**
 * `custom_tool_call` 的 item id 必须以 `ctc_` 开头（OpenAI Responses 规定的
 * item 类型前缀，严格实现会校验）。会话历史里可能是别的前缀（见
 * `normalizeResponsesCustomToolCallItemIds`），这里统一归一。
 */
export function toResponsesCustomToolCallItemId(rawId: unknown): string {
  const trimmed = asTrimmedString(rawId);
  if (!trimmed) return '';
  const lower = trimmed.toLowerCase();
  if (lower.startsWith(CUSTOM_TOOL_CALL_ITEM_ID_PREFIX)) return trimmed;
  for (const prefix of FOREIGN_TOOL_CALL_ID_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return `${CUSTOM_TOOL_CALL_ITEM_ID_PREFIX}${trimmed.slice(prefix.length)}`;
    }
  }
  return `${CUSTOM_TOOL_CALL_ITEM_ID_PREFIX}${trimmed}`;
}

/**
 * 发往上游前，把 `custom_tool_call` 的 item id 前缀归一成 `ctc_`。
 *
 * 客户端的会话历史是「我们回给它什么，它就原样回放什么」。上游回
 * `function_call` 时带的是函数调用的 id（`fc_...`，有些薄壳自造 `fc_tmp_...`、
 * `ct_...`），我们把类型还原成 `custom_tool_call` 后 id 前缀就和类型对不上了；
 * 客户端把这段历史回放给严格的上游就会直接被拒。冰山实测：
 *
 *   [ApiIdParam] [input[14].id] [invalid_id_prefix]
 *   Invalid 'input[14].id': 'fc_tmp_ukxb1i9c3k'. Expected an ID that begins with 'ctc'.
 *
 * 同一个请求只把 id 换成 `ctc_` 前缀就 200；没有 id 也不报错，说明它只校验前缀。
 * `call_id` 不动：上游是拿 `call_id` 去配 `custom_tool_call_output` 的，而且
 * `call_id` 本身不做前缀校验（实测）。
 */
export function normalizeResponsesCustomToolCallItemIds(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input)) return body;

  const renamed = new Map<string, string>();
  for (const item of input) {
    if (!isRecord(item)) continue;
    if (asTrimmedString(item.type).toLowerCase() !== 'custom_tool_call') continue;
    const id = asTrimmedString(item.id);
    if (!id) continue;
    const nextId = toResponsesCustomToolCallItemId(id);
    if (nextId !== id) renamed.set(id, nextId);
  }
  if (renamed.size === 0) return body;

  let changed = false;
  const nextInput = input.map((item) => {
    if (!isRecord(item)) return item;
    let next = item;
    if (asTrimmedString(next.type).toLowerCase() === 'custom_tool_call') {
      const mapped = renamed.get(asTrimmedString(next.id));
      if (mapped) {
        next = { ...next, id: mapped };
        changed = true;
      }
    }
    // 同一个请求里如果有 item 引用了被改名的 item，引用也要跟着改，否则上游找不到。
    const reference = asTrimmedString(next.item_reference)
      || asTrimmedString(next.itemReference)
      || (isRecord(next.reference) ? asTrimmedString(next.reference.id) : '');
    const mappedReference = reference ? renamed.get(reference) : undefined;
    if (mappedReference) {
      if (next === item) next = { ...next };
      if (asTrimmedString(next.item_reference)) next.item_reference = mappedReference;
      if (asTrimmedString(next.itemReference)) next.itemReference = mappedReference;
      if (isRecord(next.reference) && asTrimmedString(next.reference.id)) {
        next.reference = { ...next.reference, id: mappedReference };
      }
      changed = true;
    }
    return next;
  });

  return changed ? { ...body, input: nextInput } : body;
}

function toNameSet(toolNames: Iterable<string> | undefined): Set<string> {
  const names = new Set<string>();
  for (const name of toolNames ?? []) {
    const trimmed = asTrimmedString(name);
    if (trimmed) names.add(trimmed);
  }
  return names;
}

/**
 * Rewrites `custom` (freeform) tool declarations into equivalent `function`
 * declarations.
 *
 * 站点自建的 Responses 接口只接受一部分自定义工具时（agentrouter 只认
 * `apply_patch`），带别的 `custom` 工具声明过去会被直接 400 掉。声明改成
 * `function`（单一 `input` 字符串参数，语法说明写进 description）后同一个接口
 * 就能接受，客户端那边仍然是自定义工具、无需感知。
 */
export function downgradeResponsesCustomToolDeclarations(
  body: Record<string, unknown>,
  toolNames: Iterable<string> | undefined,
): Record<string, unknown> {
  const targets = toNameSet(toolNames);
  if (targets.size === 0 || !Array.isArray(body.tools)) return body;

  let changed = false;
  const tools = body.tools.map((tool) => {
    if (!isRecord(tool)) return tool;
    if (asTrimmedString(tool.type).toLowerCase() !== 'custom') return tool;
    if (!targets.has(asTrimmedString(tool.name))) return tool;
    const replacement = toResponsesFunctionToolDeclaration(tool);
    if (!replacement) return tool;
    changed = true;
    return replacement;
  });

  const nextBody = changed ? { ...body, tools } : body;
  const nextToolChoice = downgradeResponsesCustomToolChoice(nextBody.tool_choice, targets);
  return nextToolChoice ? { ...nextBody, tool_choice: nextToolChoice } : nextBody;
}

/**
 * `tool_choice` 指向被降级的自定义工具时，选择项也要跟着改成 function。
 *
 * Responses 的两种选择项形状只差一个 `type`（`{type:'custom', name}` /
 * `{type:'function', name}`）。留着 custom 的话，上游会当成「强制调用一个我没
 * 声明过的 custom 工具」处理 —— new-api 的协议转换层同样会做这层改写。
 */
function downgradeResponsesCustomToolChoice(
  toolChoice: unknown,
  targets: Set<string>,
): Record<string, unknown> | null {
  if (!isRecord(toolChoice)) return null;
  if (asTrimmedString(toolChoice.type).toLowerCase() !== 'custom') return null;
  const name = asTrimmedString(toolChoice.name);
  if (!name || !targets.has(name)) return null;
  return { ...toolChoice, type: 'function' };
}

/**
 * The Responses-shaped `function` declaration equivalent to a custom tool: the
 * freeform text travels in the single `input` string argument. Note this is the
 * Responses shape (`name` at the top level), not the Chat Completions one —
 * these declarations are sent to a `/v1/responses` endpoint.
 */
function toResponsesFunctionToolDeclaration(
  tool: Record<string, unknown>,
): Record<string, unknown> | null {
  const name = asTrimmedString(tool.name);
  if (!name) return null;
  return {
    type: 'function',
    name,
    description: buildResponsesCustomToolDescription(tool),
    parameters: {
      type: 'object',
      properties: {
        [CUSTOM_TOOL_INPUT_ARGUMENT]: {
          type: 'string',
          description: 'Raw input for the tool.',
        },
      },
      required: [CUSTOM_TOOL_INPUT_ARGUMENT],
      additionalProperties: false,
    },
  };
}

/** True when this tool name was declared as custom by the client but downgraded upstream. */
export function isDowngradedCustomToolName(
  toolNames: Set<string> | Iterable<string> | undefined,
  name: unknown,
): boolean {
  const resolved = toolNames instanceof Set ? toolNames : toNameSet(toolNames);
  const trimmed = asTrimmedString(name);
  return !!trimmed && resolved.has(trimmed);
}

/**
 * Turns an upstream `function_call` item back into the `custom_tool_call` the
 * client declared: the raw text lives under the single `input` argument.
 */
export function convertDowngradedFunctionCallItem(
  item: Record<string, unknown>,
  toolNames: Set<string> | Iterable<string> | undefined,
): Record<string, unknown> {
  if (asTrimmedString(item.type).toLowerCase() !== 'function_call') return item;
  if (!isDowngradedCustomToolName(toolNames, item.name)) return item;

  const next: Record<string, unknown> = {
    ...item,
    type: 'custom_tool_call',
    input: unwrapCustomToolCallArguments(item.arguments),
  };
  delete next.arguments;
  return next;
}

/**
 * Same conversion, applied to a whole Responses payload's `output` array. Used
 * by the non-stream path, where the upstream payload is forwarded verbatim.
 */
export function convertDowngradedFunctionCallsInResponsesPayload(
  payload: Record<string, unknown>,
  toolNames: Set<string> | Iterable<string> | undefined,
): Record<string, unknown> {
  const resolved = toolNames instanceof Set ? toolNames : toNameSet(toolNames);
  if (resolved.size === 0 || !Array.isArray(payload.output)) return payload;

  let changed = false;
  const output = payload.output.map((item) => {
    if (!isRecord(item)) return item;
    const next = convertDowngradedFunctionCallItem(item, resolved);
    if (next !== item) changed = true;
    return next;
  });

  return changed ? { ...payload, output } : payload;
}
