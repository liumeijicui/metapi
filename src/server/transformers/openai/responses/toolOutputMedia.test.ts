import { describe, expect, it } from 'vitest';
import {
  CHAT_TOOL_MESSAGE_MEDIA_NOTE,
  RESPONSES_TOOL_OUTPUT_MEDIA_NOTE,
  hoistChatToolMessageMedia,
  hoistResponsesToolOutputMedia,
  isResponsesToolOutputMediaPart,
  splitResponsesToolOutputMedia,
} from './toolOutputMedia.js';

const smallImage = { type: 'input_image', image_url: 'data:image/png;base64,AAAA' };

describe('toolOutputMedia', () => {
  it('认得图片/音频/截图块，纯文本块不算', () => {
    expect(isResponsesToolOutputMediaPart(smallImage)).toBe(true);
    expect(isResponsesToolOutputMediaPart({ type: 'input_audio', audio_url: 'data:audio/wav;base64,AA' })).toBe(true);
    expect(isResponsesToolOutputMediaPart({ type: 'computer_screenshot', image_url: 'data:image/png;base64,AA' })).toBe(true);
    // 只给字段不给 type 的（薄壳站点的常见写法）也算
    expect(isResponsesToolOutputMediaPart({ image_url: 'data:image/png;base64,AA' })).toBe(true);
    expect(isResponsesToolOutputMediaPart({ type: 'input_text', text: 'done' })).toBe(false);
    expect(isResponsesToolOutputMediaPart('done')).toBe(false);
  });

  it('把工具输出拆成文本块和媒体块两堆', () => {
    const split = splitResponsesToolOutputMedia([
      { type: 'input_text', text: 'Script completed' },
      smallImage,
    ]);

    expect(split.hasMedia).toBe(true);
    expect(split.textParts).toEqual([{ type: 'input_text', text: 'Script completed' }]);
    expect(split.mediaParts).toEqual([smallImage]);
  });

  it('字符串输出没有媒体块', () => {
    expect(splitResponsesToolOutputMedia('plain text')).toEqual({ textParts: [], mediaParts: [], hasMedia: false });
  });

  it('把图片搬到后一条 user 消息，工具输出只留文本（君の公益 400 那条）', () => {
    const body = {
      model: 'deepseek-v4.1-flash',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'function_call', call_id: 'call_1', id: 'fc_1', name: 'exec', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          id: 'ctco_1',
          output: [{ type: 'input_text', text: 'Script completed\n' }, smallImage],
        },
      ],
    };

    const next = hoistResponsesToolOutputMedia(body) as any;

    // 工具输出里不能剩图片，否则上游回 400 invalid_request。
    expect(next.input[2].output).toEqual([{ type: 'input_text', text: 'Script completed\n' }]);
    // 图片没丢，搬到紧随其后的一条 user 消息里。
    expect(next.input[3]).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: RESPONSES_TOOL_OUTPUT_MEDIA_NOTE }, smallImage],
    });
    // 原来那条工具输出对象不被改坏。
    expect(body.input[2].output).toHaveLength(2);
  });

  it('工具输出里只剩图片时补一句占位文本，output 不能是空数组', () => {
    const body = {
      input: [
        { type: 'custom_tool_call_output', call_id: 'call_1', id: 'ctco_1', output: [smallImage] },
      ],
    };

    const next = hoistResponsesToolOutputMedia(body) as any;

    expect(next.input[0].output).toHaveLength(1);
    expect(String(next.input[0].output[0].text)).toContain('image data');
    expect(next.input[0].output[0].type).toBe('input_text');
    expect(next.input[1].role).toBe('user');
    expect(next.input[1].content[1]).toEqual(smallImage);
  });

  it('没有媒体块、没有 input、input 是字符串项时都不做无谓拷贝', () => {
    const textOnly = {
      input: [
        { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'ok' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    };
    expect(hoistResponsesToolOutputMedia(textOnly)).toBe(textOnly);
    expect(hoistResponsesToolOutputMedia({ model: 'x' })).toEqual({ model: 'x' });
    expect(hoistResponsesToolOutputMedia({ input: 'hi' })).toEqual({ input: 'hi' });

    // output 里混着字符串这类非对象项时不改写，交给原来的路径处理。
    const mixed = {
      input: [
        { type: 'function_call_output', call_id: 'call_1', output: ['ok', smallImage] },
      ],
    };
    expect(hoistResponsesToolOutputMedia(mixed)).toBe(mixed);
  });

  it('普通 message 里的图片不动，只搬工具输出里的', () => {
    const body = {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看图' }, smallImage] },
      ],
    };
    expect(hoistResponsesToolOutputMedia(body)).toBe(body);
  });

  it('Chat Completions 的 tool 消息里的图片也搬到后一条 user 消息（君の公益 400 那条）', () => {
    const body = {
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [
            { type: 'text', text: 'Script completed\n' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    };

    const next = hoistChatToolMessageMedia(body) as any;

    // tool 消息只留文本，tool_call_id 不能丢
    expect(next.messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: [{ type: 'text', text: 'Script completed\n' }],
    });
    expect(next.messages[3].role).toBe('user');
    expect(next.messages[3].content[0]).toEqual({ type: 'text', text: CHAT_TOOL_MESSAGE_MEDIA_NOTE });
    expect(next.messages[3].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    expect(body.messages[2].content).toHaveLength(2);
  });

  it('Chat 侧工具消息里只剩图片时 content 留空字符串，且不碰别的角色', () => {
    const body = {
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'image_url', image_url: 'data:image/png;base64,AA' }] },
        { role: 'user', content: [{ type: 'image_url', image_url: 'data:image/png;base64,BB' }] },
      ],
    };

    const next = hoistChatToolMessageMedia(body) as any;

    expect(next.messages[0].content).toBe('');
    expect(next.messages[1].role).toBe('user');
    // 用户自己发的图片消息保持原样（同样的对象）
    expect(next.messages[2]).toBe(body.messages[1]);
  });

  it('Chat 侧没有媒体块 / 没有 messages 时不做无谓拷贝', () => {
    const textOnly = { messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }] };
    expect(hoistChatToolMessageMedia(textOnly)).toBe(textOnly);
    const noMessages = { model: 'x' };
    expect(hoistChatToolMessageMedia(noMessages)).toBe(noMessages);
  });
});
