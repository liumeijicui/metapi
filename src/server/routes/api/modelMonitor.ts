import { FastifyInstance } from 'fastify';
import { config } from '../../config.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { insertProxyLog } from '../../services/proxyLogStore.js';
import {
  isAnthropicNativeDirectChatPath,
  listSiteDirectChatTargets,
  relaySiteDirectChatStream,
  requestSiteDirectChat,
  toClientFacingDirectChatFailure,
} from '../../services/siteDirectChatService.js';
import {
  isModelMonitorRunning,
  loadModelMonitorOverview,
  resolveChatTargetForSiteModel,
  runModelMonitorFetch,
} from '../../services/modelMonitorService.js';

function parseOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

/** 直连对话也写一条使用日志：route / channel 留空，标明「模型测试」+ 直连。 */
async function recordDirectChatLog(input: {
  accountId: number;
  model: string;
  startedAt: number;
  status: 'success' | 'failed';
  httpStatus: number;
  errorMessage: string | null;
  /**
   * 首字耗时（首个响应体到达）。和网关路由记的是同一套口径，
   * 拿不到就写 null —— 日志里显示「--」，不拿总耗时冒充。
   */
  firstByteLatencyMs?: number | null;
}): Promise<void> {
  await insertProxyLog({
    routeId: null,
    channelId: null,
    accountId: input.accountId,
    modelRequested: input.model,
    modelActual: input.model,
    status: input.status,
    httpStatus: input.httpStatus,
    latencyMs: Date.now() - input.startedAt,
    // 直连对话永远是流式，首字耗时是排查「卡多久才出字」的关键指标。
    isStream: true,
    firstByteLatencyMs: input.firstByteLatencyMs ?? null,
    errorMessage: input.errorMessage,
    retryCount: 0,
    clientAppName: '模型测试',
    clientFamily: 'internal',
    clientConfidence: 'exact',
  });
}

export function parseModelMonitorSort(value: unknown): string {
  const normalized = String(value || '').trim();
  return ['success', 'latency', 'tps', 'site'].includes(normalized) ? normalized : 'success';
}

export async function modelMonitorRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      siteId?: string;
      model?: string;
      minSuccessRate?: string;
      sort?: string;
    };
  }>('/api/model-monitor/overview', async (request) => {
    const siteId = parseOptionalNumber(request.query.siteId);
    return loadModelMonitorOverview({
      siteId: siteId !== null && siteId > 0 ? Math.trunc(siteId) : null,
      model: String(request.query.model || '').trim() || null,
      minSuccessRate: parseOptionalNumber(request.query.minSuccessRate),
      sort: parseModelMonitorSort(request.query.sort),
    });
  });

  // 「对话」弹窗要固定到某个站点时，先问这里能选哪些通道。
  app.get<{ Querystring: { siteId?: string; model?: string } }>(
    '/api/model-monitor/chat-channels',
    async (request, reply) => {
      const siteId = Math.trunc(parseOptionalNumber(request.query.siteId) ?? 0);
      const model = String(request.query.model || '').trim();
      if (siteId <= 0 || !model) {
        return reply.code(400).send({ success: false, message: 'siteId 和 model 不能为空' });
      }
      // 对话只做直连：该站点自己的凭据（账号 JWT / sk- 令牌），不参与网关
      // 的新路由 / 老路由选路。凭据与路由配置无关，站点有账号或密钥就能聊。
      const [target, credentials] = await Promise.all([
        resolveChatTargetForSiteModel(siteId, model),
        listSiteDirectChatTargets(siteId),
      ]);
      return {
        success: true,
        channels: target.channels,
        credentials,
        requestedModel: target.requestedModel,
        direct: true,
      };
    },
  );

  /**
   * 直连对话：用「站点 + 账号 + 凭据」直接打上游，和路由配置完全无关。
   * 请求体里的 model 就是页面点中的那个，不做任何模型名改写。
   */
  app.post<{
    Body: {
      siteId?: number;
      accountId?: number;
      tokenId?: number | null;
      model?: string;
      messages?: Array<{ role?: string; content?: unknown }>;
      reasoningEffort?: string;
    };
  }>('/api/model-monitor/chat/stream', async (request, reply) => {
    const body = request.body || {};
    const siteId = Math.trunc(Number(body.siteId) || 0);
    const accountId = Math.trunc(Number(body.accountId) || 0);
    const tokenId = body.tokenId == null || body.tokenId === ('' as unknown)
      ? null
      : Math.trunc(Number(body.tokenId) || 0);
    const model = String(body.model || '').trim();
    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .map((item) => ({
        role: String(item?.role || 'user'),
        content: typeof item?.content === 'string' ? item.content : '',
      }));
    // 思考强度：白名单校验后原样放进 OpenAI 协议请求体（reasoning_effort）。
    // 上游不认这个字段的会忽略，认的就按选的档位思考。
    const reasoningEffort = String(body.reasoningEffort || '').trim().toLowerCase();
    const allowedReasoningEfforts = ['minimal', 'low', 'medium', 'high', 'max'];
    if (reasoningEffort && !allowedReasoningEfforts.includes(reasoningEffort)) {
      return reply.code(400).send({ error: { message: `思考强度不合法：${reasoningEffort}` } });
    }
    if (siteId <= 0 || accountId <= 0 || !model) {
      return reply.code(400).send({ error: { message: 'siteId / accountId / model 不能为空' } });
    }
    if (!messages.length) {
      return reply.code(400).send({ error: { message: 'messages 不能为空' } });
    }

    const startedAt = Date.now();
    // 对话默认不设时间上限，所以「客户端断开」就成了唯一的兜底：页面关掉 / 点了停止
    // 之后，这条 signal 会把上游请求一起中断，不让它挂在那儿白跑。
    const clientAbort = new AbortController();
    const onClientClose = () => clientAbort.abort(new Error('client disconnected'));
    request.raw.once('close', onClientClose);
    const outcome = await requestSiteDirectChat({
      siteId,
      accountId,
      tokenId,
      model,
      messages,
      stream: true,
      // 0 = 不限制（默认）；设成正数则恢复「空闲 / 总时长」两条硬线。
      timeoutMs: config.modelMonitorChatTimeoutMs,
      idleTimeoutMs: config.modelMonitorChatIdleTimeoutMs,
      extraBody: reasoningEffort ? { reasoning_effort: reasoningEffort } : null,
      signal: clientAbort.signal,
    });

    if (!outcome.ok) {
      // 上游回 401/403 是「这个站点拒绝了这次调用」，不是 Metapi 自己的登录失效：
      // 前端会把 401/403 当作本系统会话过期（清 token + 刷新回登录页），
      // 表现就是「和这个站一对话就被退出登录」。改写逻辑见
      // toClientFacingDirectChatFailure（上游真实状态码写进文案，日志仍记真实值）。
      const failure = toClientFacingDirectChatFailure({
        status: outcome.status,
        message: outcome.message,
      });
      // 直连失败也留一条日志，方便在「使用日志」里看到真实原因。
      await recordDirectChatLog({
        accountId,
        model,
        startedAt,
        status: 'failed',
        httpStatus: outcome.status,
        errorMessage: failure.message,
      }).catch(() => undefined);
      request.raw.off('close', onClientClose);
      return reply.code(failure.status).send({ error: { message: failure.message } });
    }

    const upstream = outcome.response;
    // Anthropic 原生上游（anyrouter 的 claude 模型只有 /v1/messages 能用）会在中继里
    // 被转成 OpenAI SSE 再写出，所以这里必须是 SSE 的 content-type，不能抄上游的。
    const contentType = isAnthropicNativeDirectChatPath(outcome.upstreamPath)
      ? 'text/event-stream; charset=utf-8'
      : String(upstream.headers?.get?.('content-type') || 'text/event-stream');
    reply.raw.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let bytes = 0;
    try {
      const relay = await relaySiteDirectChatStream({
        outcome,
        model,
        // 字节数在这里数：中途被掐断时也要能在日志里写清「已经输出了多少」。
        write: (chunk) => {
          bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
          reply.raw.write(chunk);
        },
      });
      if (relay.status === 'failed') {
        // 上游流中途报错（转译层识别出的 error 事件）：把原因补发给页面，别留个哑巴连接。
        const failureMessage = relay.errorMessage || '上游流式返回失败';
        try {
          reply.raw.write(`data: ${JSON.stringify({ error: { message: failureMessage } })}\n\n`);
        } catch {
          // 连接已经没了就算了，日志里仍然记录真实原因。
        }
        await recordDirectChatLog({
          accountId,
          model,
          startedAt,
          status: 'failed',
          httpStatus: 0,
          firstByteLatencyMs: bytes > 0 ? outcome.firstByteLatencyMs : null,
          errorMessage: bytes > 0
            ? `${failureMessage}（已输出 ${bytes} 字节后中断）`
            : failureMessage,
        }).catch(() => undefined);
        reply.raw.end();
        return reply;
      }
    } catch (error) {
      // 已经吐了一部分才被掐断（空闲 / 总时长超限）：把真实原因用 SSE error 事件
      // 补发给页面，让用户看到的是「上游 X 秒没有新数据」而不是莫名中断。
      const timeoutReason = outcome.timeoutReason();
      const failureMessage = timeoutReason
        || (error instanceof Error ? error.message : '流式读取失败');
      if (timeoutReason) {
        try {
          reply.raw.write(`data: ${JSON.stringify({ error: { message: timeoutReason } })}\n\n`);
        } catch {
          // 连接已经没了就算了，日志里仍然记录真实原因。
        }
      }
      await recordDirectChatLog({
        accountId,
        model,
        startedAt,
        status: 'failed',
        httpStatus: 0,
        // 已经吐过数据就说明首字到达过，失败日志一样值得记这行。
        firstByteLatencyMs: bytes > 0 ? outcome.firstByteLatencyMs : null,
        errorMessage: bytes > 0
          ? `${failureMessage}（已输出 ${bytes} 字节后中断）`
          : failureMessage,
      }).catch(() => undefined);
      reply.raw.end();
      return reply;
    } finally {
      request.raw.off('close', onClientClose);
    }
    reply.raw.end();

    await recordDirectChatLog({
      accountId,
      model,
      startedAt,
      status: 'success',
      httpStatus: upstream.status || 200,
      // 一个字节都没吐出来就没有「首字」可言，别把响应头到达时间写成首字。
      firstByteLatencyMs: bytes > 0 ? outcome.firstByteLatencyMs : null,
      errorMessage: bytes > 0 ? null : '上游没有返回任何内容',
    }).catch(() => undefined);
    return reply;
  });

  app.post('/api/model-monitor/refresh', async () => {
    if (isModelMonitorRunning()) {
      return { success: true, queued: false, running: true };
    }
    const { task, reused } = startBackgroundTask(
      {
        type: 'model-monitor-refresh',
        title: '采集模型监控',
        dedupeKey: 'model-monitor:all',
        notifyOnSuccess: false,
        notifyOnFailure: false,
      },
      // 页面上的「立即采集」：标成 manual，日志和页面都能和定时采集区分开。
      () => runModelMonitorFetch('manual'),
    );
    return { success: true, queued: !reused, reused, running: true, taskId: task.id };
  });
}
