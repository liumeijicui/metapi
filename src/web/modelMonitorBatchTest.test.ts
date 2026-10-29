import { describe, expect, it, vi } from 'vitest';
import {
  createModelBatchSseParser,
  interleaveModelBatchTargets,
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

  it('打散同一个站点的模型，相邻两项不来自同一站点', () => {
    const targets: ModelBatchTestTarget[] = [
      { key: 'a1', siteId: 1, siteName: 'A', modelName: 'a-1' },
      { key: 'a2', siteId: 1, siteName: 'A', modelName: 'a-2' },
      { key: 'a3', siteId: 1, siteName: 'A', modelName: 'a-3' },
      { key: 'b4', siteId: 2, siteName: 'B', modelName: 'b-1' },
      { key: 'b5', siteId: 2, siteName: 'B', modelName: 'b-2' },
      { key: 'c6', siteId: 3, siteName: 'C', modelName: 'c-1' },
    ];

    const ordered = interleaveModelBatchTargets(targets, () => 0.42);

    expect([...ordered].sort((left, right) => left.key.localeCompare(right.key)))
      .toEqual([...targets].sort((left, right) => left.key.localeCompare(right.key)));
    for (let index = 1; index < ordered.length; index += 1) {
      expect(ordered[index].siteId).not.toBe(ordered[index - 1].siteId);
    }
  });

  it('站点数量不足时仍保持全部目标，且不丢模型', () => {
    const targets: ModelBatchTestTarget[] = [
      { key: 'a1', siteId: 1, siteName: 'A', modelName: 'a-1' },
      { key: 'a2', siteId: 1, siteName: 'A', modelName: 'a-2' },
      { key: 'a3', siteId: 1, siteName: 'A', modelName: 'a-3' },
      { key: 'a4', siteId: 1, siteName: 'A', modelName: 'a-4' },
      { key: 'b5', siteId: 2, siteName: 'B', modelName: 'b-1' },
    ];

    const ordered = interleaveModelBatchTargets(targets, () => 0.1);
    expect(ordered).toHaveLength(targets.length);
    // 只有一个站点占多数时无法完全避开，但开头两轮就要轮到 B，不能先把 A 全打完。
    expect(ordered.slice(0, 2).some((item) => item.siteId === 2)).toBe(true);
  });
});
