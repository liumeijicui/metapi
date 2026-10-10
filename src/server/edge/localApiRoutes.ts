import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { proxyLogRoutes } from '../routes/api/proxyLogRoutes.js';
import {
  ModelForwardError,
  listModelForwardOptions,
  listModelForwardRules,
} from '../services/modelForwardService.js';
import { syncEdgeForwardRules } from './configSync.js';
import {
  moveLocalForwardTarget,
  resetLocalForwardEdits,
  setLocalForwardRuleEnabled,
  setLocalForwardTargetEnabled,
} from './forwardLocalEdits.js';
import { rehydrateLocalRuntimeSettings } from './localSettingsPolicy.js';

/** 日志页调试面板能改的字段：请求体字段名 → settings 表的键。 */
const EDGE_DEBUG_SETTINGS: Array<{ field: string; key: string; kind: 'boolean' | 'integer' | 'string' }> = [
  { field: 'proxyDebugTraceEnabled', key: 'proxy_debug_trace_enabled', kind: 'boolean' },
  { field: 'proxyDebugCaptureHeaders', key: 'proxy_debug_capture_headers', kind: 'boolean' },
  { field: 'proxyDebugCaptureBodies', key: 'proxy_debug_capture_bodies', kind: 'boolean' },
  { field: 'proxyDebugCaptureStreamChunks', key: 'proxy_debug_capture_stream_chunks', kind: 'boolean' },
  { field: 'proxyDebugTargetSessionId', key: 'proxy_debug_target_session_id', kind: 'string' },
  { field: 'proxyDebugTargetClientKind', key: 'proxy_debug_target_client_kind', kind: 'string' },
  { field: 'proxyDebugTargetModel', key: 'proxy_debug_target_model', kind: 'string' },
  { field: 'proxyDebugRetentionHours', key: 'proxy_debug_retention_hours', kind: 'integer' },
  { field: 'proxyDebugMaxBodyBytes', key: 'proxy_debug_max_body_bytes', kind: 'integer' },
];

/** 日志页调试面板要的那几项，读的是本地内存库热加载后的 config。 */
function readEdgeRuntimeSettings() {
  return {
    proxyDebugTraceEnabled: config.proxyDebugTraceEnabled,
    proxyDebugCaptureHeaders: config.proxyDebugCaptureHeaders,
    proxyDebugCaptureBodies: config.proxyDebugCaptureBodies,
    proxyDebugCaptureStreamChunks: config.proxyDebugCaptureStreamChunks,
    proxyDebugTargetSessionId: config.proxyDebugTargetSessionId,
    proxyDebugTargetClientKind: config.proxyDebugTargetClientKind,
    proxyDebugTargetModel: config.proxyDebugTargetModel,
    proxyDebugRetentionHours: config.proxyDebugRetentionHours,
    proxyDebugMaxBodyBytes: config.proxyDebugMaxBodyBytes,
  };
}

/**
 * 解析路径里的 id：不合法就抛 ModelForwardError，交给下面的统一错误处理回 400。
 */
function parseLocalId(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new ModelForwardError(`${label} id 不合法`);
  return numeric;
}

/** 本机镜像上的写操作：只把 ModelForwardError 翻成 400，其它错误照原样抛。 */
async function runLocalForwardEdit<T>(
  reply: FastifyReply,
  handler: () => Promise<T>,
): Promise<T | void> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof ModelForwardError) {
      return reply.code(400).send({ success: false, message: error.message });
    }
    throw error;
  }
}

/** 把请求里的值转成 settings 表该存的形式；返回 null 表示取值不合法。 */
function normalizeDebugSettingValue(kind: 'boolean' | 'integer' | 'string', raw: unknown): unknown {
  if (kind === 'boolean') return typeof raw === 'boolean' ? raw : null;
  if (kind === 'string') return typeof raw === 'string' ? raw.trim() : null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

/**
 * exe 本地页面要用的接口，只有两个页面：模型转发与使用日志。
 *
 * - 使用日志直接复用主服务那份只读接口（proxyLogRoutes），路径与服务器一致；
 * - 模型转发：读取走镜像；顺序 / 启停的写接口只改本机内存镜像（见 forwardLocalEdits），
 *   路径与主服务完全一致，所以前端页面不用为 exe 分叉；规则的增删改仍然只在服务器上做；
 * - 绝不向配置源（服务器）写任何东西：这几个写接口的落点全是本机内存库。
 * - `/api/settings/runtime` 只认日志页调试面板那几项，其余运行设置在服务器上配；
 *   改完只写进内存库，进程退出即失效。
 */
export async function edgeLocalApiRoutes(app: FastifyInstance) {
  await app.register(proxyLogRoutes);

  app.get('/api/model-forward-rules', async () => ({
    success: true,
    rules: await listModelForwardRules(),
  }));

  app.get('/api/model-forward-options', async () => ({
    success: true,
    ...(await listModelForwardOptions()),
  }));

  // 下面四个写接口只动本机镜像（exe 自己的转发顺序），不回写服务器。
  // 路径与主服务一致，所以「模型转发」页面在服务器和 exe 里是同一份代码。
  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/model-forward-rules/:id/enabled',
    async (request, reply) => runLocalForwardEdit(reply, async () => ({
      success: true,
      rule: await setLocalForwardRuleEnabled(
        parseLocalId(request.params.id, '规则'),
        !!request.body?.enabled,
      ),
    })),
  );

  app.post<{ Params: { id: string; targetId: string }; Body: { action?: string } }>(
    '/api/model-forward-rules/:id/targets/:targetId/move',
    async (request, reply) => runLocalForwardEdit(reply, async () => {
      const action = String(request.body?.action ?? '').trim().toLowerCase();
      if (action !== 'up' && action !== 'down' && action !== 'top') {
        throw new ModelForwardError('action 只支持 up / down / top');
      }
      return {
        success: true,
        rule: await moveLocalForwardTarget(
          parseLocalId(request.params.id, '规则'),
          parseLocalId(request.params.targetId, '目标'),
          action,
        ),
      };
    }),
  );

  app.post<{ Params: { id: string; targetId: string }; Body: { enabled?: boolean } }>(
    '/api/model-forward-rules/:id/targets/:targetId/enabled',
    async (request, reply) => runLocalForwardEdit(reply, async () => ({
      success: true,
      rule: await setLocalForwardTargetEnabled(
        parseLocalId(request.params.id, '规则'),
        parseLocalId(request.params.targetId, '目标'),
        !!request.body?.enabled,
      ),
    })),
  );

  // 「恢复服务器顺序」：丢掉本机改动，并强制重新拉一次服务器快照（以服务器为准）。
  app.post('/api/edge/model-forward-local-edits/reset', async () => {
    await resetLocalForwardEdits();
    const sync = await syncEdgeForwardRules();
    return {
      ok: true,
      synced: sync.ok,
      message: sync.ok ? null : sync.message,
      rules: await listModelForwardRules(),
    };
  });

  app.get('/api/settings/runtime', async () => readEdgeRuntimeSettings());

  // 日志页的调试面板保存按钮：只接受上面那 9 项，写内存库后热加载，绝不落盘。
  app.put<{ Body: unknown }>('/api/settings/runtime', async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    const pending: Array<{ key: string; value: unknown }> = [];
    for (const item of EDGE_DEBUG_SETTINGS) {
      const raw = body[item.field];
      if (raw === undefined) continue;
      const value = normalizeDebugSettingValue(item.kind, raw);
      if (value === null) {
        return reply.code(400).send({ success: false, message: `${item.field} 的取值无效` });
      }
      pending.push({ key: item.key, value });
    }

    for (const entry of pending) {
      await upsertSetting(entry.key, entry.value);
    }
    // 先落库再热加载，顺序和 configSync 保持一致。
    await rehydrateLocalRuntimeSettings();
    return readEdgeRuntimeSettings();
  });
}
