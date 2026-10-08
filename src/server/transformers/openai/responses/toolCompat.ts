function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const ADDITIONAL_TOOL_ITEM_TYPE = 'additional_tools';
const NAMESPACE_TOOL_TYPE = 'namespace';
const CUSTOM_TOOL_TYPE = 'custom';

/**
 * Namespace Codex declares its ordinary tools in. Calls to these tools come
 * back by bare name with no namespace, so they need no namespace on the way
 * out either.
 */
export const DEFAULT_RESPONSES_TOOL_NAMESPACE = 'functions';

/** The single function argument that carries a custom tool's raw input. */
export const CUSTOM_TOOL_INPUT_ARGUMENT = 'input';

const CUSTOM_TOOL_INPUT_ARGUMENT_KEYS = [
  CUSTOM_TOOL_INPUT_ARGUMENT,
  'code',
  'command',
  'content',
  'text',
  'patch',
  'script',
];

/** Tool declarations and their namespaces, as sent to an upstream. */
export type ResponsesToolState = {
  /** Upstream names of Responses custom (freeform) tools. */
  customToolNames: string[];
  /** Upstream name of each tool declared in a non-default namespace. */
  toolNamespaces: Record<string, string>;
};

function toolNameOf(tool: Record<string, unknown>): string {
  return asTrimmedString(tool.name);
}

function toolTypeOf(tool: Record<string, unknown>): string {
  return asTrimmedString(tool.type).toLowerCase();
}

export function decodeResponsesToolList(rawTools: unknown): {
  tools: Array<Record<string, unknown>>;
  toolNamespaces: Record<string, string>;
} {
  const tools: Array<Record<string, unknown>> = [];
  const toolNamespaces: Record<string, string> = {};

  const visit = (rawList: unknown, namespace: string): void => {
    if (!Array.isArray(rawList)) return;
    for (const item of rawList) {
      if (!isRecord(item)) continue;
      if (toolTypeOf(item) === NAMESPACE_TOOL_TYPE) {
        const nestedNamespace = asTrimmedString(item.name) || namespace;
        visit(item.tools, nestedNamespace);
        continue;
      }
      const name = toolNameOf(item);
      tools.push(item);
      if (
        name
        && namespace
        && namespace !== DEFAULT_RESPONSES_TOOL_NAMESPACE
        && toolNamespaces[name] === undefined
      ) {
        toolNamespaces[name] = namespace;
      }
    }
  };

  visit(rawTools, '');
  return { tools, toolNamespaces };
}

export function flattenResponsesToolList(rawTools: unknown): Array<Record<string, unknown>> {
  return decodeResponsesToolList(rawTools).tools;
}

function dedupeResponsesTools(
  tools: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const deduped: Array<Record<string, unknown>> = [];
  for (const tool of tools) {
    const name = toolNameOf(tool);
    if (name) {
      if (seen.has(name)) continue;
      seen.add(name);
    }
    deduped.push(tool);
  }
  return deduped;
}

function isAdditionalToolsInputItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  const type = toolTypeOf(item);
  if (type === ADDITIONAL_TOOL_ITEM_TYPE) return true;
  if (!Array.isArray(item.tools) || item.tools.length <= 0) return false;
  const role = asTrimmedString(item.role).toLowerCase();
  return role === 'developer' || role === 'system';
}

/**
 * Moves the `additional_tools` items Codex uses to declare tools out of the
 * input and onto the top-level tool list. No protocol has an input item that
 * declares tools, and leaving them in place makes Responses upstreams reject
 * the request for a missing `content`.
 */
export function hoistResponsesAdditionalTools(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input) || input.length <= 0) return body;

  const hoisted: Array<Record<string, unknown>> = [];
  const remaining: unknown[] = [];
  let changed = false;

  for (const item of input) {
    if (!isAdditionalToolsInputItem(item)) {
      remaining.push(item);
      continue;
    }
    changed = true;
    hoisted.push(...flattenResponsesToolList(isRecord(item) ? item.tools : undefined));
  }

  if (!changed) return body;

  const existing = flattenResponsesToolList(body.tools);
  const merged = dedupeResponsesTools([...existing, ...hoisted]);
  const next: Record<string, unknown> = { ...body, input: remaining };
  if (merged.length > 0) {
    next.tools = merged;
  } else {
    delete next.tools;
  }
  return next;
}

/**
 * Collects how the request's tools reach the upstream: which ones are custom
 * (freeform) tools, and which belong to a non-default namespace. The response
 * side uses this to restore the item shape Codex expects.
 */
export function collectResponsesToolState(body: Record<string, unknown>): ResponsesToolState {
  const toolNamespaces: Record<string, string> = {};
  const mergeNamespaces = (source: Record<string, string>): void => {
    for (const [name, namespace] of Object.entries(source)) {
      if (toolNamespaces[name] === undefined) toolNamespaces[name] = namespace;
    }
  };

  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!isAdditionalToolsInputItem(item)) continue;
    mergeNamespaces(
      decodeResponsesToolList(isRecord(item) ? item.tools : undefined).toolNamespaces,
    );
  }
  mergeNamespaces(decodeResponsesToolList(body.tools).toolNamespaces);

  const customToolNames = new Set<string>();
  for (const tool of flattenResponsesToolList(hoistResponsesAdditionalTools(body).tools)) {
    if (toolTypeOf(tool) !== CUSTOM_TOOL_TYPE) continue;
    const name = toolNameOf(tool);
    if (name) customToolNames.add(name);
  }

  return {
    customToolNames: Array.from(customToolNames),
    toolNamespaces,
  };
}

export function collectResponsesCustomToolNames(body: Record<string, unknown>): string[] {
  return collectResponsesToolState(body).customToolNames;
}

/**
 * Resolves the tool state from the client's original body and the sanitized
 * body. Sanitizing hoists `additional_tools` items flat onto `tools`, which
 * drops the namespace wrappers, so the original body is the only place the
 * namespaces survive; the sanitized body still knows the flattened tool list.
 */
export function resolveResponsesToolState(
  rawBody: Record<string, unknown> | null | undefined,
  sanitizedBody?: Record<string, unknown> | null,
): ResponsesToolState {
  const rawState = rawBody ? collectResponsesToolState(rawBody) : null;
  const sanitizedState = sanitizedBody ? collectResponsesToolState(sanitizedBody) : null;
  return {
    customToolNames: rawState && rawState.customToolNames.length > 0
      ? rawState.customToolNames
      : (sanitizedState ? sanitizedState.customToolNames : []),
    toolNamespaces: {
      ...(sanitizedState ? sanitizedState.toolNamespaces : {}),
      ...(rawState ? rawState.toolNamespaces : {}),
    },
  };
}

/**
 * The namespace to report on a call to `name`, or an empty string when the
 * tool was declared in the default namespace (or was never declared).
 */
export function resolveResponsesToolNamespace(
  name: string,
  toolNamespaces?: Record<string, string> | null,
): string {
  if (!toolNamespaces) return '';
  return toolNamespaces[name] ?? '';
}

/**
 * Custom (freeform) tools reach a Chat Completions upstream as functions with
 * a single required string argument, so the model is told the raw input goes
 * there - plus the grammar, when one was declared.
 */
export function buildResponsesCustomToolDescription(tool: Record<string, unknown>): string {
  const parts: string[] = [];
  const description = asTrimmedString(tool.description);
  if (description) parts.push(description);
  parts.push(`This tool takes freeform text. Put the complete raw text in the "${CUSTOM_TOOL_INPUT_ARGUMENT}" argument.`);

  const format = isRecord(tool.format) ? tool.format : null;
  const definition = format ? asTrimmedString(format.definition) : '';
  if (format && asTrimmedString(format.type).toLowerCase() === 'grammar' && definition) {
    const syntax = asTrimmedString(format.syntax);
    const normalizedSyntax = syntax.toLowerCase();
    if (normalizedSyntax === 'lark') {
      parts.push(`The input must match this Lark grammar:\n${definition}`);
    } else if (normalizedSyntax === 'regex') {
      parts.push(`The input must match this regular expression:\n${definition}`);
    } else if (syntax) {
      parts.push(`The input must match this ${syntax} grammar:\n${definition}`);
    } else {
      parts.push(`The input must match this grammar:\n${definition}`);
    }
  }

  return parts.join('\n\n');
}

export function convertResponsesCustomToolToChatTool(
  tool: Record<string, unknown>,
): Record<string, unknown> | null {
  const name = toolNameOf(tool);
  if (!name) return null;
  return {
    type: 'function',
    function: {
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
    },
  };
}

function stringifyToolArgumentsValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Re-encodes a custom tool call as the Chat function arguments its declaration
 * implies: the raw input under the single `input` key.
 */
export function wrapCustomToolCallArguments(rawInput: unknown): string {
  return JSON.stringify({
    [CUSTOM_TOOL_INPUT_ARGUMENT]: stringifyToolArgumentsValue(rawInput),
  });
}

function extractPartialJsonStringField(raw: string, key: string): string | null {
  const keyToken = `"${key}"`;
  let index = raw.indexOf(keyToken);
  if (index < 0) return null;
  index += keyToken.length;
  while (index < raw.length && /\s/.test(raw[index])) index += 1;
  if (raw[index] !== ':') return null;
  index += 1;
  while (index < raw.length && /\s/.test(raw[index])) index += 1;
  if (raw[index] !== '"') return null;
  index += 1;

  let out = '';
  while (index < raw.length) {
    const char = raw[index];
    if (char === '\\') {
      const next = raw[index + 1];
      if (next === undefined) break;
      if (next === 'u') {
        const hex = raw.slice(index + 2, index + 6);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCharCode(parseInt(hex, 16));
        index += 6;
        continue;
      }
      const escapes: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        '"': '"',
        '\\': '\\',
        '/': '/',
      };
      out += escapes[next] ?? next;
      index += 2;
      continue;
    }
    if (char === '"') break;
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Unwraps the raw custom tool input from the `{"input": ...}` arguments a Chat
 * function call carries. Arguments of any other shape are returned unchanged so
 * the model's output is never dropped.
 */
export function unwrapCustomToolCallArguments(rawArguments: unknown): string {
  const raw = typeof rawArguments === 'string'
    ? rawArguments
    : String(rawArguments ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    if (isRecord(parsed)) {
      for (const key of CUSTOM_TOOL_INPUT_ARGUMENT_KEYS) {
        const value = parsed[key];
        if (typeof value === 'string') return value;
      }
      const keys = Object.keys(parsed);
      if (keys.length === 1) {
        const value = parsed[keys[0]];
        if (typeof value === 'string') return value;
      }
    }
    return raw;
  } catch {
    for (const key of CUSTOM_TOOL_INPUT_ARGUMENT_KEYS) {
      const partial = extractPartialJsonStringField(trimmed, key);
      if (partial !== null) return partial;
    }
    return raw;
  }
}
