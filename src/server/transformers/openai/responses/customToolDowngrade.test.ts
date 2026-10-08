import { describe, expect, it } from 'vitest';
import {
  convertDowngradedFunctionCallItem,
  convertDowngradedFunctionCallsInResponsesPayload,
  downgradeResponsesCustomToolDeclarations,
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
});
