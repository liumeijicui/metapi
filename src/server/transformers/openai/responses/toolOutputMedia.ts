/**
 * 把工具结果里的图片/音频内容「搬」到紧随其后的一条 user 消息。
 *
 * 薄壳站点的 `/v1/responses`（new-api / sub2api 这类把 Responses 转成 Chat
 * Completions 再转发出去实现）不认「工具输出里带图片」：Chat Completions 的 `tool`
 * 消息只允许文本，图片会被原样丢给只收文本的上游，上游直接回
 * `400 invalid_request`。同一张图片放在普通 `message` 里就完全正常。
 *
 * 实测君の公益（`muyuan.do`，账号 3145215575 / `deepseek-v4.1-flash`，走系统代理）：
 *   - `function_call_output.output = [{type:input_text}, {type:input_image, image_url:data:...}]`
 *     → 400 `{"error":{"message":"invalid_request","type":"upstream_error","param":"","code":"invalid_request"}}`
 *     （7KB 的小图和 2.2MB 的大图回的是同一条错误，跟请求体积无关）
 *   - 同一张图片放进普通 `message.content` → 200
 *   - 把图片从工具输出里挪到紧随其后的 user 消息 → 200
 *
 * 所以这里做的是「搬运」而不是「丢弃」：工具输出只留文本（一个文本块都不剩时补一句
 * 占位），图片块原样放进后一条 user 消息，模型照样看得到图。
 *
 * 只对「转发薄壳」站点启用（`resolveResponsesToolOutputMediaPolicy`），原生
 * Responses 实现（openai / codex 平台）原样透传。
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 工具结果里允许出现的 item 类型。 */
const TOOL_OUTPUT_ITEM_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

/** 判定媒体块时看的类型关键字（`input_image` / `input_audio` / `computer_screenshot` …）。 */
const TOOL_OUTPUT_MEDIA_TYPE_HINTS = ['image', 'audio', 'video', 'screenshot'] as const;

/** 判定媒体块时看的内联数据字段（有些实现只给字段不给 type）。 */
const TOOL_OUTPUT_MEDIA_DATA_KEYS = ['image_url', 'audio_url', 'video_url', 'image_data'] as const;

/** 图片被搬到后一条消息时，前置的那句说明（给模型看，用英文避免转义问题）。 */
export const RESPONSES_TOOL_OUTPUT_MEDIA_NOTE = 'Images returned by the previous tool call:';

/** 工具输出里一个文本块都不剩时的占位文本。 */
const TOOL_OUTPUT_MEDIA_ONLY_PLACEHOLDER =
  '(the tool returned image data; it is attached in the next message)';

/** 这个内容块是不是图片/音频这类「不能待在工具输出里」的媒体块。 */
export function isResponsesToolOutputMediaPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  const type = asTrimmedString(part.type).toLowerCase();
  if (TOOL_OUTPUT_MEDIA_TYPE_HINTS.some((hint) => type.includes(hint))) return true;
  return TOOL_OUTPUT_MEDIA_DATA_KEYS.some((key) => part[key] !== undefined);
}

export type ResponsesToolOutputMediaSplit = {
  /** 留在工具输出里的块（文本等）。 */
  textParts: Record<string, unknown>[];
  /** 需要搬到后一条 user 消息的块。 */
  mediaParts: Record<string, unknown>[];
  hasMedia: boolean;
};

/**
 * 把工具输出拆成「文本块」和「媒体块」两堆。字符串输出（纯文本）没有媒体块。
 * 不是数组也不是对象的输出只当文本处理，由调用方原样带下去。
 */
export function splitResponsesToolOutputMedia(output: unknown): ResponsesToolOutputMediaSplit {
  const parts = Array.isArray(output)
    ? output
    : (isRecord(output) ? [output] : null);
  if (!parts) return { textParts: [], mediaParts: [], hasMedia: false };

  const textParts: Record<string, unknown>[] = [];
  const mediaParts: Record<string, unknown>[] = [];
  let sawNonObject = false;
  for (const part of parts) {
    if (!isRecord(part)) {
      sawNonObject = true;
      continue;
    }
    if (isResponsesToolOutputMediaPart(part)) mediaParts.push(part);
    else textParts.push(part);
  }
  return {
    textParts,
    mediaParts,
    // 数组里混着字符串这类非对象项时不做任何改写，交给原来的路径处理。
    hasMedia: mediaParts.length > 0 && !sawNonObject,
  };
}

/**
 * 把 `input` 里所有工具输出中的媒体块搬到后一条 user 消息。没有媒体块时原样返回
 * （同一个对象，调用方可以按引用判断有没有改动）。
 */
export function hoistResponsesToolOutputMedia(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const input = body.input;
  if (!Array.isArray(input)) return body;

  let changed = false;
  const nextInput: unknown[] = [];
  for (const item of input) {
    if (!isRecord(item) || !TOOL_OUTPUT_ITEM_TYPES.has(asTrimmedString(item.type).toLowerCase())) {
      nextInput.push(item);
      continue;
    }
    const split = splitResponsesToolOutputMedia(item.output);
    if (!split.hasMedia) {
      nextInput.push(item);
      continue;
    }
    changed = true;
    nextInput.push({
      ...item,
      output: split.textParts.length > 0
        ? split.textParts
        : [{ type: 'input_text', text: TOOL_OUTPUT_MEDIA_ONLY_PLACEHOLDER }],
    });
    nextInput.push({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: RESPONSES_TOOL_OUTPUT_MEDIA_NOTE },
        ...split.mediaParts,
      ],
    });
  }

  return changed ? { ...body, input: nextInput } : body;
}

/** Chat Completions 里那句前置说明（给模型看，用英文避免转义问题）。 */
export const CHAT_TOOL_MESSAGE_MEDIA_NOTE = 'Images returned by the previous tool call:';

/**
 * 把 Chat Completions `messages` 里 `role: 'tool'` 消息中的图片搬到后一条 user
 * 消息。
 *
 * Chat Completions 协议里 `tool` 消息的 `content` 只能是文本（数组也只能是文本块），
 * 图片放进去是非法的：上游要么 400，要么把图片悄悄丢掉。而工具结果里的图片（
 * 截图、`view_image` 这类）在下游客户端很常见，直接丢会让模型「看不见图」却仍然
 * 照常回答，所以这里搬到后一条 user 消息，一张都不丢。
 *
 * 实测同一条 Chat 请求（工具消息里带 `image_url` 块）打到君の公益
 * `/v1/chat/completions` → 400 `invalid_request`，搬到 user 消息后 200。
 */
export function hoistChatToolMessageMedia(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = body.messages;
  if (!Array.isArray(messages)) return body;

  let changed = false;
  const nextMessages: unknown[] = [];
  for (const message of messages) {
    if (!isRecord(message) || asTrimmedString(message.role).toLowerCase() !== 'tool') {
      nextMessages.push(message);
      continue;
    }
    const split = splitResponsesToolOutputMedia(message.content);
    if (!split.hasMedia) {
      nextMessages.push(message);
      continue;
    }
    changed = true;
    nextMessages.push({
      ...message,
      content: split.textParts.length > 0 ? split.textParts : '',
    });
    nextMessages.push({
      role: 'user',
      content: [
        { type: 'text', text: CHAT_TOOL_MESSAGE_MEDIA_NOTE },
        ...split.mediaParts,
      ],
    });
  }

  return changed ? { ...body, messages: nextMessages } : body;
}
