import { describe, expect, it } from 'vitest';
import {
  convertDowngradedFunctionCallItem,
  convertDowngradedFunctionCallsInResponsesPayload,
  downgradeResponsesCustomToolCallHistory,
  downgradeResponsesCustomToolDeclarations,
  normalizeResponsesCustomToolCallItemIds,
  toResponsesFunctionCallItemId,
  toResponsesCustomToolCallItemId,
} from './customToolDowngrade.js';

const execCustomTool = {
  type: 'custom',
  name: 'exec',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: SOURCE' },
};
const applyPatchCustomTool = {
  type: 'custom',
  name: 'apply_patch',
  format: { type: 'grammar', syntax: 'lark', definition: 'start: PATCH' },
};
const readFileFunctionTool = { type: 'function', name: 'read_file', parameters: { type: 'object' } };

describe('customToolDowngrade', () => {
  it('只把指定的 custom 声明改写成 function，其他声明原样保留', () => {
    const body = { model: 'deepseek-v4-flash', tools: [execCustomTool, applyPatchCustomTool, readFileFunctionTool] };

    const downgraded = downgradeResponsesCustomToolDeclarations(body, ['exec']) as any;

    // 注意是 Responses 形态的 function 声明（name 在顶层），不是 chat 形态。
    expect(downgraded.tools[0]).toMatchObject({ type: 'function', name: 'exec' });
    expect(downgraded.tools[0].function).toBeUndefined();
    expect(downgraded.tools[0].parameters).toMatchObject({
      required: ['input'],
      additionalProperties: false,
    });
    // 语法说明要带上，否则模型不知道 input 该长什么样。
    expect(String(downgraded.tools[0].description)).toContain('start: SOURCE');
    // 站点认的 apply_patch 仍然是自定义工具，别动它。
    expect(downgraded.tools[1]).toEqual(applyPatchCustomTool);
    expect(downgraded.tools[2]).toEqual(readFileFunctionTool);
  });

  it('没有要降级的工具时返回原对象，不做无谓拷贝', () => {
    const body = { tools: [applyPatchCustomTool] };
    expect(downgradeResponsesCustomToolDeclarations(body, [])).toBe(body);
    expect(downgradeResponsesCustomToolDeclarations(body, ['exec'])).toBe(body);
  });

  it('强制指定被降级的自定义工具时，tool_choice 也跟着改成 function', () => {
    const body = {
      tools: [execCustomTool],
      tool_choice: { type: 'custom', name: 'exec' },
    };

    const downgraded = downgradeResponsesCustomToolDeclarations(body, ['exec']) as any;

    expect(downgraded.tool_choice).toEqual({ type: 'function', name: 'exec' });
    // 没被降级的强制选择项不要动。
    expect(
      downgradeResponsesCustomToolDeclarations(
        { tools: [execCustomTool], tool_choice: { type: 'custom', name: 'apply_patch' } },
        ['exec'],
      ),
    ).toMatchObject({ tool_choice: { type: 'custom', name: 'apply_patch' } });
    // auto / required 这类字符串选择项不受影响。
    const autoBody = { tools: [execCustomTool], tool_choice: 'auto' };
    expect(downgradeResponsesCustomToolDeclarations(autoBody, ['exec'])).toMatchObject({
      tool_choice: 'auto',
    });
  });

  it('回程把降级过的 function_call 还原成 custom_tool_call 并拆出原始输入', () => {
    const item = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'exec',
      arguments: '{"input":"echo hi"}',
    };

    const converted = convertDowngradedFunctionCallItem(item, ['exec']);

    expect(converted).toMatchObject({
      type: 'custom_tool_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'exec',
      input: 'echo hi',
    });
    expect(converted.arguments).toBeUndefined();
  });

  it('没被降级的 function_call 保持原样', () => {
    const item = { type: 'function_call', name: 'read_file', arguments: '{"path":"a"}' };
    expect(convertDowngradedFunctionCallItem(item, ['exec'])).toBe(item);
    expect(convertDowngradedFunctionCallItem(item, [])).toBe(item);
  });

  it('非流式终态 payload 的 output 也会被还原', () => {
    const payload = {
      object: 'response',
      output: [
        { type: 'reasoning', id: 'r1', summary: [] },
        { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'exec', arguments: '{"input":"run"}' },
        { type: 'function_call', id: 'fc_2', call_id: 'c2', name: 'read_file', arguments: '{"path":"a"}' },
      ],
    };

    const converted: any = convertDowngradedFunctionCallsInResponsesPayload(payload, ['exec']);

    expect(converted.output[0]).toEqual(payload.output[0]);
    expect(converted.output[1]).toMatchObject({ type: 'custom_tool_call', name: 'exec', input: 'run' });
    expect(converted.output[2]).toEqual(payload.output[2]);
    // 原 payload 不能被改坏。
    expect(payload.output[1]).toMatchObject({ type: 'function_call' });
  });

  it('custom_tool_call 的 item id 统一归一成 ctc_ 前缀', () => {
    // 已经是 ctc_ 的、以及没有 id 的都原样返回。
    expect(toResponsesCustomToolCallItemId('ctc_abc')).toBe('ctc_abc');
    expect(toResponsesCustomToolCallItemId('')).toBe('');
    // 转发站自造的各种前缀都要换成 ctc_，而不是叠一层前缀。
    expect(toResponsesCustomToolCallItemId('fc_0d2c01fa')).toBe('ctc_0d2c01fa');
    expect(toResponsesCustomToolCallItemId('fc_tmp_ukxb1i9c3k')).toBe('ctc_tmp_ukxb1i9c3k');
    expect(toResponsesCustomToolCallItemId('call_1')).toBe('ctc_1');
    expect(toResponsesCustomToolCallItemId('toolu_1')).toBe('ctc_1');
    expect(toResponsesCustomToolCallItemId('whatever')).toBe('ctc_whatever');
  });

  it('发往上游前把历史里对不上类型的 custom_tool_call id 改成 ctc_（冰山 400 那条）', () => {
    const body = {
      model: 'gpt-6.1-sol',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        {
          type: 'custom_tool_call',
          id: 'fc_tmp_ukxb1i9c3k',
          call_id: 'call_1',
          name: 'exec',
          input: 'ls',
        },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
      ],
    };

    const normalized: any = normalizeResponsesCustomToolCallItemIds(body);

    expect(normalized.input[1]).toMatchObject({ id: 'ctc_tmp_ukxb1i9c3k', call_id: 'call_1' });
    // 输出项是按 call_id 配对的，call_id 不能被改。
    expect(normalized.input[2]).toMatchObject({ call_id: 'call_1' });
    // 原对象不能被改坏。
    expect(body.input[1]).toMatchObject({ id: 'fc_tmp_ukxb1i9c3k' });
  });

  it('引用被改名 item 的 item_reference 也要跟着改，没得改时不做无谓拷贝', () => {
    const body = {
      input: [
        { type: 'custom_tool_call', id: 'fc_1', call_id: 'call_1', name: 'exec', input: 'ls' },
        { type: 'custom_tool_call_output', call_id: 'call_1', item_reference: 'fc_1', output: 'ok' },
      ],
    };
    expect((normalizeResponsesCustomToolCallItemIds(body) as any).input[1].item_reference).toBe('ctc_1');

    // 前缀本来就对、也没有引用关系时返回原对象。
    const untouched = {
      input: [{ type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: 'ls' }],
    };
    expect(normalizeResponsesCustomToolCallItemIds(untouched)).toBe(untouched);
    // 不是 Responses 形态（input 不是数组）时直接返回。
    const chatLike = { input: 'hello' };
    expect(normalizeResponsesCustomToolCallItemIds(chatLike)).toBe(chatLike);
  });

  it('回程还原出来的 custom_tool_call 带的是上游 function_call 的 fc_ id', () => {
    // 这个 id 我们照原样回给客户端，客户端回放时由
    // normalizeResponsesCustomToolCallItemIds 在发上游前归一（见上一条用例）。
    const item = { type: 'function_call', id: 'fc_tmp_ukxb1i9c3k', call_id: 'call_1', name: 'exec', arguments: '{"input":"ls"}' };
    expect(convertDowngradedFunctionCallItem(item, ['exec'])).toMatchObject({
      type: 'custom_tool_call',
      id: 'fc_tmp_ukxb1i9c3k',
      call_id: 'call_1',
    });
  });

  it('声明降级时，历史里的 custom_tool_call / output 一起降级成 function（君の公益 400 那条）', () => {
    const body = {
      model: 'deepseek-v4.1-flash',
      tools: [execCustomTool, applyPatchCustomTool],
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        { type: 'custom_tool_call', id: 'ctc_tmp_1', call_id: 'call_1', name: 'exec', input: 'ls -la' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'ok' },
        { type: 'custom_tool_call', id: 'ctc_2', call_id: 'call_2', name: 'apply_patch', input: 'PATCH' },
        { type: 'custom_tool_call_output', call_id: 'call_2', output: 'done' },
      ],
    };

    const downgraded = downgradeResponsesCustomToolDeclarations(body, ['exec']) as any;

    // exec 被降级：调用变成 function_call，freeform input 包进唯一的 input 参数。
    expect(downgraded.input[1]).toMatchObject({
      type: 'function_call',
      name: 'exec',
      call_id: 'call_1',
      arguments: '{"input":"ls -la"}',
    });
    // 类型换成 function_call，id 前缀也要跟着从 ctc_ 换成 fc_（上游按类型校验前缀，
    // 配错会回 `Expected an ID that begins with 'fc'`）。
    expect(downgraded.input[1].id).toBe('fc_tmp_1');
    expect(downgraded.input[1].input).toBeUndefined();
    expect(downgraded.input[2]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' });
    // 站点认的 apply_patch 不降级，它的调用和输出都别动。
    expect(downgraded.input[3]).toMatchObject({ type: 'custom_tool_call', name: 'apply_patch' });
    expect(downgraded.input[4]).toMatchObject({ type: 'custom_tool_call_output' });
    // 原对象不能被改坏。
    expect(body.input[1]).toMatchObject({ type: 'custom_tool_call', input: 'ls -la' });
  });

  it('历史降级时 function_call 的 id 前缀归一到 fc_，item_reference 跟着改', () => {
    expect(toResponsesFunctionCallItemId('ctc_tmp_1')).toBe('fc_tmp_1');
    expect(toResponsesFunctionCallItemId('fc_1')).toBe('fc_1');
    expect(toResponsesFunctionCallItemId('call_1')).toBe('fc_1');
    expect(toResponsesFunctionCallItemId('whatever')).toBe('fc_whatever');

    const body = {
      tools: [execCustomTool],
      input: [
        { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: 'ls' },
        { type: 'custom_tool_call_output', call_id: 'call_1', item_reference: 'ctc_1', output: 'ok' },
      ],
    };
    const downgraded = downgradeResponsesCustomToolDeclarations(body, ['exec']) as any;

    expect(downgraded.input[0]).toMatchObject({ type: 'function_call', id: 'fc_1', call_id: 'call_1' });
    expect(downgraded.input[1]).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_1',
      item_reference: 'fc_1',
    });
  });

  it('历史降级只认名字：没有匹配调用时不动 output，没有历史时也不拷贝', () => {
    // output 的 call_id 对不上任何被降级的调用 → 保持 custom_tool_call_output。
    const stray = {
      input: [{ type: 'custom_tool_call_output', call_id: 'other', output: 'ok' }],
    };
    expect(downgradeResponsesCustomToolCallHistory(stray, ['exec'])).toBe(stray);

    // 没有 input / 没有要降级的工具时原样返回。
    const noInput = { tools: [] };
    expect(downgradeResponsesCustomToolCallHistory(noInput, ['exec'])).toBe(noInput);
    const untouched = { input: [{ type: 'message', role: 'user', content: 'hi' }] };
    expect(downgradeResponsesCustomToolCallHistory(untouched, ['exec'])).toBe(untouched);
    expect(downgradeResponsesCustomToolCallHistory(untouched, [])).toBe(untouched);
  });
});
