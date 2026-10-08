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

  return changed ? { ...body, tools } : body;
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
