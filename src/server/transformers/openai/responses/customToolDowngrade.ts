import {
  CUSTOM_TOOL_INPUT_ARGUMENT,
  buildResponsesCustomToolDescription,
  unwrapCustomToolCallArguments,
  wrapCustomToolCallArguments,
} from './toolCompat.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const CUSTOM_TOOL_CALL_ITEM_ID_PREFIX = 'ctc_';
const FUNCTION_CALL_ITEM_ID_PREFIX = 'fc_';

/**
 * 转发站自造的 tool call id 前缀（OpenAI 的 `fc_`、new-api/CC 类薄壳的 `ct_`、
 * 部分站点的临时 id `fc_tmp_*`、Anthropic 转出来的 `toolu_`）。
 */
const FOREIGN_TOOL_CALL_ID_PREFIXES = ['fc_', 'ct_', 'call_', 'custom_tool_call_', 'toolu_'] as const;

/**
 * 严格的上游按 item 类型校验 id 前缀：`custom_tool_call` 必须是 `ctc_`、
 * `function_call` 必须是 `fc_`（实测同一条历史把类型和前缀配错就 400
 * `invalid_id_prefix`）。所以换类型时前缀要一起换。
 */
function rewriteItemIdPrefix(
  rawId: unknown,
  targetPrefix: string,
  foreignPrefixes: readonly string[],
): string {
  const trimmed = asTrimmedString(rawId);
  if (!trimmed) return '';
  if (trimmed.toLowerCase().startsWith(targetPrefix)) return trimmed;
  for (const prefix of foreignPrefixes) {
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return `${targetPrefix}${trimmed.slice(prefix.length)}`;
    }
  }
  return `${targetPrefix}${trimmed}`;
}

/**
 * `custom_tool_call` 的 item id 必须以 `ctc_` 开头（OpenAI Responses 规定的
 * item 类型前缀，严格实现会校验）。会话历史里可能是别的前缀（见
 * `normalizeResponsesCustomToolCallItemIds`），这里统一归一。
 */
export function toResponsesCustomToolCallItemId(rawId: unknown): string {
  return rewriteItemIdPrefix(rawId, CUSTOM_TOOL_CALL_ITEM_ID_PREFIX, FOREIGN_TOOL_CALL_ID_PREFIXES);
}

/** `function_call` 的 item id 必须以 `fc_` 开头，用不到 `fc_` 的别的前缀换掉。 */
export function toResponsesFunctionCallItemId(rawId: unknown): string {
  return rewriteItemIdPrefix(rawId, FUNCTION_CALL_ITEM_ID_PREFIX, [
    CUSTOM_TOOL_CALL_ITEM_ID_PREFIX,
    'ct_',
    'call_',
    'custom_tool_call_',
    'toolu_',
  ]);
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
  if (targets.size === 0) return body;

  let nextBody = body;
  if (Array.isArray(body.tools)) {
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
    if (changed) nextBody = { ...body, tools };
  }

  // 会话历史里的 custom_tool_call / custom_tool_call_output 也要跟着降级：声明和
  // 历史必须是同一种形状，否则薄壳站点（new-api / sub2api 这类 /v1/responses）会
  // 直接 400。见 downgradeResponsesCustomToolCallHistory。
  nextBody = downgradeResponsesCustomToolCallHistory(nextBody, targets);
  const nextToolChoice = downgradeResponsesCustomToolChoice(nextBody.tool_choice, targets);
  return nextToolChoice ? { ...nextBody, tool_choice: nextToolChoice } : nextBody;
}

const RESPONSES_CUSTOM_TOOL_CALL_TYPE = 'custom_tool_call';
const RESPONSES_CUSTOM_TOOL_CALL_OUTPUT_TYPE = 'custom_tool_call_output';

/**
 * 把会话历史里被降级的自定义工具调用改成等价的 function 调用。
 *
 * 只改声明是不够的：客户端 `input` 里回放着上一轮的 `custom_tool_call` /
 * `custom_tool_call_output`，薄壳站点的 `/v1/responses` 一见到这两个类型就回
 * `400 invalid_request`（实测君の公益 muyuan.do，账号 3145215575 / deepseek-v4.1-flash）：
 *   - 历史带 `custom_tool_call` → 400（id 用 fc_ 还是 ctc_、字段用 input 还是
 *     arguments、tools 里有没有对应声明，都一样 400）
 *   - 同一段历史换成 `function_call` / `function_call_output` → 200
 * 所以这里按「被降级的工具名」换成 function 形状，freeform 的 `input` 包成声明里
 * 那唯一的 `input` 字符串参数；回程 `convertDowngradedFunctionCallItem` 再按工具名
 * 还原，客户端拿到的仍是它自己声明的 custom_tool_call。
 */
export function downgradeResponsesCustomToolCallHistory(
  body: Record<string, unknown>,
  toolNames: Iterable<string> | undefined,
): Record<string, unknown> {
  const targets = toNameSet(toolNames);
  if (targets.size === 0 || !Array.isArray(body.input)) return body;

  const downgradedCallIds = new Set<string>();
  const renamedItemIds = new Map<string, string>();
  let convertedCalls = 0;
  const calls = body.input.map((item) => {
    if (!isRecord(item)) return item;
    if (asTrimmedString(item.type).toLowerCase() !== RESPONSES_CUSTOM_TOOL_CALL_TYPE) return item;
    const name = asTrimmedString(item.name);
    if (!name || !targets.has(name)) return item;
    convertedCalls += 1;
    const callId = asTrimmedString(item.call_id) || asTrimmedString(item.id);
    if (callId) downgradedCallIds.add(callId);
    const next: Record<string, unknown> = {
      ...item,
      type: 'function_call',
      arguments: wrapCustomToolCallArguments(item.input ?? item.arguments),
    };
    delete next.input;
    // 类型换成 function_call 之后 id 前缀也要跟着换成 fc_，否则上游按类型校验
    // 前缀，回 `Expected an ID that begins with 'fc'`。
    const itemId = asTrimmedString(item.id);
    if (itemId) {
      const nextItemId = toResponsesFunctionCallItemId(itemId);
      next.id = nextItemId;
      if (nextItemId !== itemId) renamedItemIds.set(itemId, nextItemId);
    }
    return next;
  });

  if (convertedCalls === 0) return body;

  let convertedOutputs = 0;
  const input = calls.map((item) => {
    if (!isRecord(item)) return item;
    if (asTrimmedString(item.type).toLowerCase() === RESPONSES_CUSTOM_TOOL_CALL_OUTPUT_TYPE) {
      const callId = asTrimmedString(item.call_id);
      if (callId && downgradedCallIds.has(callId)) {
        convertedOutputs += 1;
        return withRenamedItemReference({ ...item, type: 'function_call_output' }, renamedItemIds);
      }
      return item;
    }
    // 同一份请求里引用了被改名 item 的地方也要跟着改，否则上游找不到。
    return withRenamedItemReference(item, renamedItemIds);
  });

  return convertedCalls + convertedOutputs > 0 ? { ...body, input } : body;
}

function withRenamedItemReference(
  item: Record<string, unknown>,
  renamedItemIds: Map<string, string>,
): Record<string, unknown> {
  if (renamedItemIds.size === 0) return item;
  const reference = asTrimmedString(item.item_reference)
    || asTrimmedString(item.itemReference)
    || (isRecord(item.reference) ? asTrimmedString(item.reference.id) : '');
  const mapped = reference ? renamedItemIds.get(reference) : undefined;
  if (!mapped) return item;
  const next: Record<string, unknown> = { ...item };
  if (asTrimmedString(next.item_reference)) next.item_reference = mapped;
  if (asTrimmedString(next.itemReference)) next.itemReference = mapped;
  if (isRecord(next.reference) && asTrimmedString(next.reference.id)) {
    next.reference = { ...next.reference, id: mapped };
  }
  return next;
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
