export type ModelBatchTestTarget = {
  key: string;
  siteId: number;
  siteName: string;
  modelName: string;
};

export type ModelBatchTestResult = {
  status: 'success' | 'failed' | 'cancelled';
  firstByteMs: number | null;
  durationMs: number;
  message: string;
  preview: string;
};

export type ModelBatchTestCompleted = {
  target: ModelBatchTestTarget;
  result: ModelBatchTestResult;
};

const MAX_PREVIEW_CHARS = 12_000;

export function buildModelBatchTestKey(siteId: number, modelName: string): string {
  return `${siteId}:${modelName}`;
}

/**
 * 把待测模型按站点打散，避免连续对同一个站点测活。
 *
 * 做法是「站点分组 + 组内打乱 + 按站点轮转」：同一站点最多隔一轮就轮到别的
 * 站点。直接全局 shuffle 不够——同一个站点的模型偶尔还会挨在一起；轮转能保证
 * 只要不是单个站点独占全部目标，相邻两项一定来自不同站点。
 *
 * `random` 可注入，测试里传固定种子函数即可得到稳定结果。
 */
export function interleaveModelBatchTargets<T extends { siteId: number }>(
  targets: T[],
  random: () => number = Math.random,
): T[] {
  if (targets.length <= 2) return [...targets];

  const groups = new Map<number, T[]>();
  // 站点出现顺序也打乱：否则每次都是「第一个站点先测」，风控特征太明显。
  for (const target of targets) {
    const list = groups.get(target.siteId);
    if (list) list.push(target);
    else groups.set(target.siteId, [target]);
  }

  const shuffle = <U,>(list: U[]): U[] => {
    const copy = [...list];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
    }
    return copy;
  };

  const queues = shuffle(Array.from(groups.values()).map((group) => shuffle(group)));
  const result: T[] = [];
  let cursor = 0;
  while (queues.some((queue) => queue.length > 0)) {
    const queue = queues[cursor % queues.length];
    const next = queue.shift();
    if (next) result.push(next);
    cursor += 1;
  }
  return result;
}

function abortResult(durationMs: number): ModelBatchTestResult {
  return {
    status: 'cancelled',
    firstByteMs: null,
    durationMs,
    message: '已停止',
    preview: '',
  };
}

/**
 * 顺序执行批量测试。调用方传入的 signal 是唯一的取消源：一旦触发，
 * 当前 runOne 会收到同一个 signal（并据此中断上游请求），队列也不会
 * 再取下一个目标。不存在「页面显示已停止、后台继续跑」的分支。
 */
export async function runModelBatchTestQueue(input: {
  targets: ModelBatchTestTarget[];
  signal: AbortSignal;
  runOne: (target: ModelBatchTestTarget, signal: AbortSignal) => Promise<ModelBatchTestResult>;
  onStart?: (target: ModelBatchTestTarget) => void;
  onResult?: (completed: ModelBatchTestCompleted) => void;
}): Promise<ModelBatchTestCompleted[]> {
  const completed: ModelBatchTestCompleted[] = [];

  for (const target of input.targets) {
    if (input.signal.aborted) break;
    input.onStart?.(target);

    const startedAt = Date.now();
    let result: ModelBatchTestResult;
    try {
      result = await input.runOne(target, input.signal);
    } catch (error: any) {
      if (input.signal.aborted || error?.name === 'AbortError') {
        result = abortResult(Date.now() - startedAt);
      } else {
        result = {
          status: 'failed',
          firstByteMs: null,
          durationMs: Date.now() - startedAt,
          message: String(error?.message || error || '测试失败'),
          preview: '',
        };
      }
    }

    // 已经完成的结果照实展示（可能刚好在点停止前成功），但取消后不再
    // 启动队列里的下一个模型。
    if (input.signal.aborted && result.status === 'failed') {
      result = abortResult(result.durationMs);
    }
    completed.push({ target, result });
    input.onResult?.({ target, result });
    if (input.signal.aborted) break;
  }

  return completed;
}

type BatchSseParseState = {
  buffer: string;
  preview: string;
  error: string | null;
};

function extractSseText(payload: any): string {
  if (!payload || typeof payload !== 'object') return '';
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const choice = choices[0];
  const direct = choice?.delta?.content ?? choice?.message?.content;
  if (typeof direct === 'string') return direct;
  if (Array.isArray(direct)) {
    return direct
      .map((item) => (typeof item === 'string' ? item : item?.text || item?.content || ''))
      .join('');
  }
  if (typeof payload.delta === 'string') return payload.delta;
  if (typeof payload.output_text?.delta === 'string') return payload.output_text.delta;
  if (typeof payload.text === 'string' && String(payload.type || '').includes('output_text')) {
    return payload.text;
  }
  return '';
}

function extractSseError(payload: any): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const direct = payload.error;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (direct && typeof direct.message === 'string' && direct.message.trim()) return direct.message.trim();
  const responseError = payload.response?.error;
  if (typeof responseError === 'string' && responseError.trim()) return responseError.trim();
  if (responseError && typeof responseError.message === 'string' && responseError.message.trim()) {
    return responseError.message.trim();
  }
  if (payload.type === 'error' || payload.type === 'response.failed') {
    return String(payload.message || payload.code || '上游返回错误事件');
  }
  return null;
}

function consumeSseBlock(block: string, state: BatchSseParseState): void {
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  const data = dataLines.join('\n').trim();
  if (!data || data === '[DONE]') return;

  let payload: any;
  try {
    payload = JSON.parse(data);
  } catch {
    return;
  }
  const error = extractSseError(payload);
  if (error && !state.error) state.error = error;
  const text = extractSseText(payload);
  // 批量测试的详情面板要能看清完整回答，所以留足长度；只截断异常长的
  // 极端输出，避免一次全选几百个模型时把页面内存撑爆。
  if (text && state.preview.length < MAX_PREVIEW_CHARS) {
    state.preview += text.slice(0, MAX_PREVIEW_CHARS - state.preview.length);
  }
}

export function createModelBatchSseParser() {
  const state: BatchSseParseState = {
    buffer: '',
    preview: '',
    error: null,
  };

  return {
    push(chunk: string) {
      state.buffer += chunk;
      const blocks = state.buffer.split(/\r?\n\r?\n/);
      state.buffer = blocks.pop() || '';
      for (const block of blocks) consumeSseBlock(block, state);
    },
    getError() {
      return state.error;
    },
    finish() {
      if (state.buffer.trim()) {
        consumeSseBlock(state.buffer, state);
        state.buffer = '';
      }
      return { preview: state.preview, error: state.error };
    },
  };
}

export async function readModelBatchErrorResponse(response: Response): Promise<string> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status}`;
  }
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(trimmed);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof message === 'string' && message.trim()) return message.trim();
  } catch {
    // 不是 JSON 就退回原始文本。
  }
  return trimmed.slice(0, 500);
}
