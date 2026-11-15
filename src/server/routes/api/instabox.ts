import { FastifyInstance, FastifyReply } from 'fastify';
import type { Readable } from 'node:stream';
import {
  INSTABOX_UPLOAD_MAX_BYTES,
  InstaboxApiError,
  clearInstaboxApiKey,
  createInstaboxUploadCommand,
  createInstaboxMachine,
  deleteInstaboxMachine,
  getInstaboxConfigStatus,
  getInstaboxMachine,
  getInstaboxOverview,
  getInstaboxUsage,
  listInstaboxMachines,
  listInstaboxOrgs,
  listInstaboxPorts,
  listInstaboxTemplates,
  publishInstaboxPort,
  restartInstaboxMachine,
  runInstaboxMachineAction,
  saveInstaboxApiKey,
  testInstaboxConnection,
  unpublishInstaboxPort,
  uploadInstaboxFileStream,
} from '../../services/instaboxService.js';
import {
  getInstaboxKeepaliveStatus,
  setInstaboxKeepaliveEnabled,
} from '../../services/instaboxKeepaliveService.js';
import {
  getInstaboxSshAccess,
  getInstaboxSshSchedulerStatus,
} from '../../services/instaboxSshService.js';

function getMachineId(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

/**
 * Upstream 401/403 表示 InstaBox 的 API Key 失效，不是 Metapi 登录失效。
 * 绝不能原样返回 401/403，否则前端会误以为管理会话过期并直接把用户踢下线。
 */
function sendInstaboxError(reply: FastifyReply, error: unknown) {
  if (error instanceof InstaboxApiError) {
    const upstreamStatus = error.status;
    const status = upstreamStatus === 401 || upstreamStatus === 403 || upstreamStatus === 402
      ? 400
      : upstreamStatus === 404
        ? 404
        : upstreamStatus === 409
          ? 409
          : upstreamStatus === 429
            ? 429
          : upstreamStatus === 413
            ? 413
            : upstreamStatus >= 500
              ? 502
              : 400;
    return reply.code(status).send({
      success: false,
      message: error.message,
      code: error.code,
      requestId: error.requestId,
      retryable: error.retryable,
    });
  }
  throw error;
}

export async function instaboxRoutes(app: FastifyInstance) {
  // Binary uploads are streamed straight to InstaBox. Buffering here would turn a
  // legitimate multi-gigabyte upload into equivalent server RAM usage.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  app.get('/api/instabox/config', async () => ({
    success: true,
    config: await getInstaboxConfigStatus(),
  }));

  app.put<{ Body: { apiKey?: unknown } }>(
    '/api/instabox/config',
    { bodyLimit: 8 * 1024 },
    async (request, reply) => {
      try {
        const config = await saveInstaboxApiKey(request.body?.apiKey);
        return { success: true, config };
      } catch (error) {
        return sendInstaboxError(reply, error);
      }
    },
  );

  app.delete('/api/instabox/config', async () => {
    await clearInstaboxApiKey();
    return { success: true };
  });

  app.post('/api/instabox/config/test', async (_request, reply) => {
    try {
      return { success: true, ...(await testInstaboxConnection()) };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.get('/api/instabox/overview', async (_request, reply) => {
    try {
      const [overview, keepalive] = await Promise.all([
        getInstaboxOverview(),
        getInstaboxKeepaliveStatus(),
      ]);
      return { success: true, ...overview, keepalive };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.get('/api/instabox/keepalive', async () => ({
    success: true,
    keepalive: await getInstaboxKeepaliveStatus(),
  }));

  app.get('/api/instabox/ssh', async () => ({
    success: true,
    scheduler: getInstaboxSshSchedulerStatus(),
  }));

  app.put<{ Body: { enabled?: unknown } }>(
    '/api/instabox/keepalive',
    { bodyLimit: 4 * 1024 },
    async (request, reply) => {
      if (typeof request.body?.enabled !== 'boolean') {
        return reply.code(400).send({ success: false, message: 'enabled 必须是布尔值' });
      }
      return {
        success: true,
        keepalive: await setInstaboxKeepaliveEnabled(request.body.enabled),
      };
    },
  );

  app.get('/api/instabox/machines', async (_request, reply) => {
    try {
      return { success: true, ...(await listInstaboxMachines()) };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.post<{
    Body: { name?: unknown; templateId?: unknown; templateVersion?: unknown; desiredState?: unknown };
  }>('/api/instabox/machines', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      const operation = await createInstaboxMachine(request.body ?? {});
      return reply.code(202).send({ success: true, operation });
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/instabox/machines/:id', async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return { success: true, machine: await getInstaboxMachine(id) };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/instabox/machines/:id/ssh', async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return { success: true, ssh: await getInstaboxSshAccess(id, { verify: true }) };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>('/api/instabox/machines/:id/ssh/refresh', async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return { success: true, ssh: await getInstaboxSshAccess(id, { force: true }) };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.put<{
    Params: { id: string };
    Querystring: { path?: string; overwrite?: string; mode?: string };
  }>('/api/instabox/machines/:id/files', {
    bodyLimit: INSTABOX_UPLOAD_MAX_BYTES,
  }, async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    const body = request.body;
    if (!body || typeof (body as Readable).pipe !== 'function') {
      return reply.code(400).send({
        success: false,
        message: '文件内容必须通过 application/octet-stream 请求体发送',
      });
    }
    try {
      const overwrite = ['1', 'true', 'yes'].includes(String(request.query?.overwrite || '').toLowerCase());
      const rawContentLength = request.headers['content-length'];
      const contentLength = typeof rawContentLength === 'string' && rawContentLength.trim()
        ? Number(rawContentLength)
        : undefined;
      const file = await uploadInstaboxFileStream(id, {
        path: request.query?.path,
        stream: body as Readable,
        contentLength,
        overwrite,
        mode: request.query?.mode,
      });
      return reply.code(file.created ? 201 : 200).send({ success: true, file });
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.post<{
    Params: { id: string };
    Body: { path?: unknown; localPath?: unknown };
  }>('/api/instabox/machines/:id/files/upload-command', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return {
        success: true,
        ...(await createInstaboxUploadCommand(id, request.body ?? {})),
      };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  const actionRoutes = ['start', 'stop', 'suspend', 'resume'] as const;
  for (const action of actionRoutes) {
    app.post<{ Params: { id: string } }>(`/api/instabox/machines/:id/${action}`, async (request, reply) => {
      const id = getMachineId(request.params.id);
      if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
      try {
        return reply.code(202).send({
          success: true,
          operation: await runInstaboxMachineAction(id, action),
        });
      } catch (error) {
        return sendInstaboxError(reply, error);
      }
    });
  }

  app.post<{ Params: { id: string } }>('/api/instabox/machines/:id/restart', async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return reply.code(202).send({
        success: true,
        operation: await restartInstaboxMachine(id),
      });
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/instabox/machines/:id', async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return reply.code(202).send({
        success: true,
        operation: await deleteInstaboxMachine(id),
      });
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/instabox/machines/:id/ports', async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return { success: true, ...(await listInstaboxPorts(id)) };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.post<{
    Params: { id: string };
    Body: { port?: unknown; name?: unknown; access?: unknown; protocol?: unknown };
  }>('/api/instabox/machines/:id/ports', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    const id = getMachineId(request.params.id);
    if (!id) return reply.code(400).send({ success: false, message: '机器 ID 不能为空' });
    try {
      return reply.code(201).send({
        success: true,
        port: await publishInstaboxPort(id, request.body ?? {}),
      });
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.delete<{ Params: { id: string; port: string } }>(
    '/api/instabox/machines/:id/ports/:port',
    async (request, reply) => {
      const id = getMachineId(request.params.id);
      const port = Math.trunc(Number(request.params.port));
      if (!id || !Number.isInteger(port)) {
        return reply.code(400).send({ success: false, message: '机器 ID 或端口不正确' });
      }
      try {
        await unpublishInstaboxPort(id, port);
        return { success: true };
      } catch (error) {
        return sendInstaboxError(reply, error);
      }
    },
  );

  app.get('/api/instabox/usage', async (_request, reply) => {
    try {
      return { success: true, usage: await getInstaboxUsage() };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.get('/api/instabox/templates', async (_request, reply) => {
    try {
      return { success: true, templates: await listInstaboxTemplates() };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });

  app.get('/api/instabox/orgs', async (_request, reply) => {
    try {
      return { success: true, orgs: await listInstaboxOrgs() };
    } catch (error) {
      return sendInstaboxError(reply, error);
    }
  });
}
