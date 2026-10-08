import { describe, expect, it, vi } from 'vitest';

import {
  buildNormalizedFinalToOpenAiResponsesPayload,
  normalizeOpenAiResponsesFinalToNormalized,
  openAiResponsesResponseBridge,
} from './responseBridge.js';
import { openAiResponsesOutbound } from './outbound.js';

describe('openai responses response bridge', () => {
  it('normalizes upstream responses finals into normalized final responses', () => {
    const normalized = normalizeOpenAiResponsesFinalToNormalized({
      id: 'resp_native_1',
      object: 'response',
      created_at: 1700000000,
      model: 'gpt-5',
      output: [
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'hello',
            },
          ],
        },
      ],
    }, 'gpt-5');

    expect(normalized).toMatchObject({
      id: 'resp_native_1',
      model: 'gpt-5',
      content: 'hello',
    });
  });

  it('builds responses payloads from normalized final responses', () => {
    const payload = buildNormalizedFinalToOpenAiResponsesPayload({
      upstreamPayload: {
        id: 'opaque_1',
        model: 'gpt-5',
      },
      normalized: {
        id: 'opaque_1',
        model: 'gpt-5',
        created: 1700000000,
        content: 'hello',
        reasoningContent: '',
        finishReason: 'stop',
        toolCalls: [],
      },
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    expect(payload).toEqual({
      id: 'resp_opaque_1',
      object: 'response',
      created_at: 1700000000,
      status: 'completed',
      model: 'gpt-5',
      output: [
        {
          id: 'msg_opaque_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'hello',
            },
          ],
        },
      ],
      output_text: 'hello',
      usage: {
        input_tokens: 11,
        output_tokens: 7,
        total_tokens: 18,
      },
    });
  });

  it('preserves function-call chains from response-like upstream payloads instead of flattening them into text', () => {
    const payload = buildNormalizedFinalToOpenAiResponsesPayload({
      upstreamPayload: {
        id: 'opaque_tool_chain_1',
        model: 'gpt-5',
        output: [
          {
            id: 'rs_1',
            type: 'reasoning',
            status: 'completed',
            summary: [
              {
                type: 'summary_text',
                text: 'plan first',
              },
            ],
          },
          {
            id: 'fc_1',
            type: 'function_call',
            status: 'completed',
            call_id: 'call_1',
            name: 'lookup_weather',
            arguments: '{"city":"Shanghai"}',
          },
          {
            id: 'fco_1',
            type: 'function_call_output',
            status: 'completed',
            call_id: 'call_1',
            output: [
              {
                type: 'output_text',
                text: '22C',
              },
            ],
          },
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              {
                type: 'output_text',
                text: 'done',
              },
            ],
          },
        ],
      },
      normalized: {
        id: 'opaque_tool_chain_1',
        model: 'gpt-5',
        created: 1700000000,
        content: 'done',
        reasoningContent: 'plan first',
        finishReason: 'stop',
        toolCalls: [{
          id: 'call_1',
          name: 'lookup_weather',
          arguments: '{"city":"Shanghai"}',
        }],
      },
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });

    expect(payload).toMatchObject({
      id: 'resp_opaque_tool_chain_1',
      object: 'response',
      output_text: 'done',
      output: [
        {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
          summary: [
            {
              type: 'summary_text',
              text: 'plan first',
            },
          ],
        },
        {
          id: 'fc_1',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_1',
          name: 'lookup_weather',
          arguments: '{"city":"Shanghai"}',
        },
        {
          id: 'fco_1',
          type: 'function_call_output',
          status: 'completed',
          call_id: 'call_1',
          output: [
            {
              type: 'output_text',
              text: '22C',
            },
          ],
        },
        {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'done',
            },
          ],
        },
      ],
    });
  });

  it('generates unique synthetic ids within the same millisecond fallback window', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000000);
    try {
      const first = buildNormalizedFinalToOpenAiResponsesPayload({
        upstreamPayload: {
          id: '',
          model: 'gpt-5',
          output: [
            {
              id: '',
              type: 'function_call',
              name: 'lookup_weather',
              arguments: '{"city":"Paris"}',
            },
            {
              id: '',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'first' }],
            },
          ],
        },
        normalized: {
          id: '',
          model: 'gpt-5',
          created: 1700000000,
          content: 'first',
          reasoningContent: '',
          finishReason: 'stop',
          toolCalls: [{
            id: '',
            name: 'lookup_weather',
            arguments: '{"city":"Paris"}',
          }],
        },
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      });
      const second = buildNormalizedFinalToOpenAiResponsesPayload({
        upstreamPayload: {
          id: '',
          model: 'gpt-5',
          output: [
            {
              id: '',
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'second' }],
            },
          ],
        },
        normalized: {
          id: '',
          model: 'gpt-5',
          created: 1700000000,
          content: 'second',
          reasoningContent: '',
          finishReason: 'stop',
          toolCalls: [],
        },
        usage: {
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
        },
      });

      expect(first.id).not.toBe(second.id);
      const firstOutput = first.output as Array<Record<string, unknown>>;
      const secondOutput = second.output as Array<Record<string, unknown>>;
      expect(firstOutput[1]?.id).not.toBe(secondOutput[0]?.id);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses fc_* item ids while keeping call_* ids for synthesized function_call outputs', () => {
    const payload = buildNormalizedFinalToOpenAiResponsesPayload({
      upstreamPayload: {
        id: 'opaque_tool_call_ids',
        model: 'gpt-5',
      },
      normalized: {
        id: 'opaque_tool_call_ids',
        model: 'gpt-5',
        created: 1700000000,
        content: '',
        reasoningContent: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'call_weather_1',
          name: 'lookup_weather',
          arguments: '{"city":"Paris"}',
        }],
      },
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
    });

    expect(payload.output).toEqual([
      expect.objectContaining({
        id: 'fc_weather_1',
        type: 'function_call',
        call_id: 'call_weather_1',
      }),
    ]);
  });

  it('serializes custom tool calls as custom_tool_call items when the tool was declared custom', () => {
    const payload = buildNormalizedFinalToOpenAiResponsesPayload({
      upstreamPayload: {
        id: 'chatcmpl-custom-1',
        object: 'chat.completion',
        model: 'gpt-5',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_exec_9',
              type: 'function',
              function: { name: 'exec', arguments: '{"input":"text(2+2)"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      },
      normalized: {
        id: 'chatcmpl-custom-1',
        model: 'gpt-5',
        created: 1700000000,
        content: '',
        reasoningContent: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'call_exec_9',
          name: 'exec',
          arguments: '{"input":"text(2+2)"}',
        }],
      },
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      customToolNames: ['exec'],
    });

    expect(payload.output).toEqual([
      expect.objectContaining({
        type: 'custom_tool_call',
        call_id: 'call_exec_9',
        name: 'exec',
        input: 'text(2+2)',
      }),
    ]);
  });

  it('keeps the outbound facade pointed at the response bridge object', () => {
    expect(openAiResponsesOutbound).toBe(openAiResponsesResponseBridge);
  });

  it('restores the namespace of calls to tools declared in a non-default namespace', () => {
    const payload = buildNormalizedFinalToOpenAiResponsesPayload({
      upstreamPayload: {
        id: 'chatcmpl-ns-1',
        object: 'chat.completion',
        model: 'gpt-5',
      },
      normalized: {
        id: 'chatcmpl-ns-1',
        model: 'gpt-5',
        created: 1700000000,
        content: '',
        reasoningContent: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'call_sleep_1',
          name: 'sleep',
          arguments: '{"duration_ms":1}',
        }],
      },
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      toolNamespaces: { sleep: 'clock' },
    });

    expect(payload.output).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_sleep_1',
        name: 'sleep',
        namespace: 'clock',
        arguments: '{"duration_ms":1}',
      }),
    ]);
  });

  it('leaves calls to default-namespace tools without a namespace', () => {
    const payload = buildNormalizedFinalToOpenAiResponsesPayload({
      upstreamPayload: {
        id: 'chatcmpl-ns-2',
        object: 'chat.completion',
        model: 'gpt-5',
      },
      normalized: {
        id: 'chatcmpl-ns-2',
        model: 'gpt-5',
        created: 1700000000,
        content: '',
        reasoningContent: '',
        finishReason: 'tool_calls',
        toolCalls: [{
          id: 'call_exec_1',
          name: 'exec',
          arguments: '{"input":"pwd"}',
        }],
      },
      usage: {
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
      },
      toolNamespaces: { sleep: 'clock' },
    });

    expect(payload.output).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_exec_1',
        name: 'exec',
        arguments: '{"input":"pwd"}',
      }),
    ]);
    const [item] = payload.output as Array<Record<string, unknown>>;
    expect(item.namespace).toBeUndefined();
  });
});
