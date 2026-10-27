import { describe, expect, it, vi } from 'vitest';
import {
  createModelBatchSseParser,
  runModelBatchTestQueue,
  type ModelBatchTestResult,
  type ModelBatchTestTarget,
} from './modelMonitorBatchTest.js';

function target(key: string): ModelBatchTestTarget {
  return {
    key,
    siteId: Number(key.replace(/\D/g, '')) || 1,
    siteName: `站点 ${key}`,
    modelName: `模型 ${key}`,
  };
}

function success(durationMs = 10): ModelBatchTestResult {
  return {
    status: 'success',
    firstByteMs: 5,
    durationMs,
    message: '测试成功',
    preview: 'ok',
  };
}

describe('modelMonitorBatchTest', () => {
  it('runs targets in order and stops the queue as soon as the signal aborts', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const result = runModelBatchTestQueue({
      targets: [target('a1'), target('b2'), target('c3')],
      signal: controller.signal,
      runOne: async (item, signal) => {
        calls.push(item.key);
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
        return success();
      },
    });

    controller.abort();
    const completed = await result;

    expect(calls).toEqual(['a1']);
    expect(completed).toHaveLength(1);
    expect(completed[0].result.status).toBe('cancelled');
  });

  it('continues with the next target after one model fails', async () => {
    const calls: string[] = [];
    const completed = await runModelBatchTestQueue({
      targets: [target('a1'), target('b2')],
      signal: new AbortController().signal,
      runOne: async (item) => {
        calls.push(item.key);
        if (item.key === 'a1') throw new Error('上游 500');
        return success();
      },
    });

    expect(calls).toEqual(['a1', 'b2']);
    expect(completed.map((item) => item.result.status)).toEqual(['failed', 'success']);
    expect(completed[0].result.message).toContain('上游 500');
  });

  it('parses streamed content and error events across chunk boundaries', () => {
    const parser = createModelBatchSseParser();
    parser.push('data: {"choices":[{"delta":{"content":"你"}}]}\n');
    parser.push('\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    const parsed = parser.finish();
    expect(parsed.preview).toBe('你好');
    expect(parsed.error).toBeNull();

    const failedParser = createModelBatchSseParser();
    failedParser.push('data: {"error":{"message":"限流了"}}\n\n');
    expect(failedParser.getError()).toBe('限流了');
  });
});
