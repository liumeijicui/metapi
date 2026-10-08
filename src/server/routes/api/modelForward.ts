import { FastifyInstance, FastifyReply } from 'fastify';
import {
  ModelForwardError,
  attachModelForwardTarget,
  createModelForwardRule,
  deleteModelForwardRule,
  deleteModelForwardTarget,
  listModelForwardOptions,
  listModelForwardRules,
  moveModelForwardTarget,
  setModelForwardTargetEnabled,
  setModelForwardRuleEnabled,
  updateModelForwardRule,
} from '../../services/modelForwardService.js';

function sendModelForwardError(reply: FastifyReply, error: unknown) {
  if (error instanceof ModelForwardError) {
    return reply.code(400).send({ success: false, message: error.message });
  }
  throw error;
}

function parseId(value: unknown): number | null {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

export async function modelForwardRoutes(app: FastifyInstance) {
  app.get('/api/model-forward-rules', async () => {
    return { success: true, rules: await listModelForwardRules() };
  });

  // 模型监控页的一键操作：把「站点 + 模型」挂到某个对外模型的末尾。
  app.post('/api/model-forward-attach', async (request, reply) => {
    try {
      return { success: true, ...(await attachModelForwardTarget(request.body ?? {})) };
    } catch (error) {
      return sendModelForwardError(reply, error);
    }
  });

  app.get<{ Querystring: { siteId?: string } }>('/api/model-forward-options', async (request, reply) => {
    try {
      const siteId = parseId(request.query.siteId);
      if (request.query.siteId !== undefined && siteId === null) {
        return reply.code(400).send({ success: false, message: '站点 id 不合法' });
      }
      return { success: true, ...(await listModelForwardOptions(siteId)) };
    } catch (error) {
      return sendModelForwardError(reply, error);
    }
  });

  app.post('/api/model-forward-rules', async (request, reply) => {
    try {
      const rule = await createModelForwardRule(request.body ?? {});
      return reply.code(201).send({ success: true, rule });
    } catch (error) {
      return sendModelForwardError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/model-forward-rules/:id', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ success: false, message: '规则 id 不合法' });
    try {
      return { success: true, rule: await updateModelForwardRule(id, request.body ?? {}) };
    } catch (error) {
      return sendModelForwardError(reply, error);
    }
  });

  app.post<{ Params: { id: string }; Body: { enabled?: boolean } }>(
    '/api/model-forward-rules/:id/enabled',
    async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) return reply.code(400).send({ success: false, message: '规则 id 不合法' });
      try {
        return { success: true, rule: await setModelForwardRuleEnabled(id, !!request.body?.enabled) };
      } catch (error) {
        return sendModelForwardError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string; targetId: string }; Body: { action?: string } }>(
    '/api/model-forward-rules/:id/targets/:targetId/move',
    async (request, reply) => {
      const id = parseId(request.params.id);
      const targetId = parseId(request.params.targetId);
      if (id === null) return reply.code(400).send({ success: false, message: '规则 id 不合法' });
      if (targetId === null) return reply.code(400).send({ success: false, message: '目标 id 不合法' });
      const action = String(request.body?.action ?? '').trim().toLowerCase();
      if (action !== 'up' && action !== 'down' && action !== 'top') {
        return reply.code(400).send({ success: false, message: 'action 只支持 up / down / top' });
      }
      try {
        return { success: true, rule: await moveModelForwardTarget(id, targetId, action) };
      } catch (error) {
        return sendModelForwardError(reply, error);
      }
    },
  );

  app.post<{ Params: { id: string; targetId: string }; Body: { enabled?: boolean } }>(
    '/api/model-forward-rules/:id/targets/:targetId/enabled',
    async (request, reply) => {
      const id = parseId(request.params.id);
      const targetId = parseId(request.params.targetId);
      if (id === null) return reply.code(400).send({ success: false, message: '规则 id 不合法' });
      if (targetId === null) return reply.code(400).send({ success: false, message: '目标 id 不合法' });
      try {
        return {
          success: true,
          rule: await setModelForwardTargetEnabled(id, targetId, !!request.body?.enabled),
        };
      } catch (error) {
        return sendModelForwardError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string; targetId: string } }>(
    '/api/model-forward-rules/:id/targets/:targetId',
    async (request, reply) => {
      const id = parseId(request.params.id);
      const targetId = parseId(request.params.targetId);
      if (id === null) return reply.code(400).send({ success: false, message: '规则 id 不合法' });
      if (targetId === null) return reply.code(400).send({ success: false, message: '目标 id 不合法' });
      try {
        return { success: true, rule: await deleteModelForwardTarget(id, targetId) };
      } catch (error) {
        return sendModelForwardError(reply, error);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/model-forward-rules/:id', async (request, reply) => {
    const id = parseId(request.params.id);
    if (id === null) return reply.code(400).send({ success: false, message: '规则 id 不合法' });
    try {
      await deleteModelForwardRule(id);
      return { success: true };
    } catch (error) {
      return sendModelForwardError(reply, error);
    }
  });
}
