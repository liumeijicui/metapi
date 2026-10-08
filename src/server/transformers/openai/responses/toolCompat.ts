function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const ADDITIONAL_TOOL_ITEM_TYPE = 'additional_tools';
const NAMESPACE_TOOL_TYPE = 'namespace';

const CUSTOM_TOOL_INPUT_ARGUMENT_KEYS = [
  'input',
  'code',
  'command',
  'content',
  'text',
  'patch',
  'script',
];

function toolNameOf(tool: Record<string, unknown>): string {
  return asTrimmedString(tool.name);
}

export function flattenResponsesToolList(rawTools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rawTools)) return [];
  const flattened: Array<Record<string, unknown>> = [];
  for (const item of rawTools) {
    if (!isRecord(item)) continue;
    if (asTrimmedString(item.type).toLowerCase() === NAMESPACE_TOOL_TYPE) {
      flattened.push(...flattenResponsesToolList(item.tools));
      continue;
    }
    flattened.push(item);
  }
  return flattened;
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
  const type = asTrimmedString(item.type).toLowerCase();
  if (type === ADDITIONAL_TOOL_ITEM_TYPE) return true;
  if (!Array.isArray(item.tools) || item.tools.length <= 0) return false;
  const role = asTrimmedString(item.role).toLowerCase();
  return role === 'developer' || role === 'system';
}

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

export function collectResponsesCustomToolNames(body: Record<string, unknown>): string[] {
  const tools = flattenResponsesToolList(hoistResponsesAdditionalTools(body).tools);
  const names = new Set<string>();
  for (const tool of tools) {
    if (asTrimmedString(tool.type).toLowerCase() !== 'custom') continue;
    const name = toolNameOf(tool);
    if (name) names.add(name);
  }
  return Array.from(names);
}

export function extractPartialCustomToolCallInput(rawArguments: unknown): string {
  const raw = typeof rawArguments === 'string'
    ? rawArguments
    : String(rawArguments ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!trimmed.startsWith('{')) return raw;
  for (const key of CUSTOM_TOOL_INPUT_ARGUMENT_KEYS) {
    const partial = extractPartialJsonStringField(trimmed, key);
    if (partial !== null) return partial;
  }
  return '';
}

export function convertResponsesCustomToolToChatTool(
  tool: Record<string, unknown>,
): Record<string, unknown> | null {
  const name = toolNameOf(tool);
  if (!name) return null;
  const fn: Record<string, unknown> = {
    name,
    parameters: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Free-form input for this tool, passed through verbatim.',
        },
      },
      required: ['input'],
      additionalProperties: false,
    },
  };
  const description = asTrimmedString(tool.description);
  if (description) fn.description = description;
  return {
    type: 'function',
    function: fn,
  };
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
      const singleKey = Object.keys(parsed);
      if (singleKey.length === 1) {
        const value = parsed[singleKey[0]];
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
