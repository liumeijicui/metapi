import { FastifyInstance, FastifyReply } from 'fastify';
import {
  PromptLibraryError,
  createSimplePromptCase,
  createPromptCase,
  createPromptSuite,
  deletePromptCase,
  deletePromptSuite,
  getPromptSuite,
  importBuiltinPromptPreset,
  listBuiltinPromptPresets,
  listEnabledPromptCasesWithSuite,
  listPromptCases,
  listPromptSuites,
  listSimplePromptCases,
  updateSimplePromptCase,
  updatePromptCase,
  updatePromptSuite,
  type SimplePromptCaseInput,
  type PromptCaseInput,
  type PromptSuiteInput,
} from '../../services/promptLibraryService.js';

function sendPromptLibraryError(reply: FastifyReply, error: unknown) {
  if (error instanceof PromptLibraryError) {
    return reply.code(400).send({ success: false, message: error.message });
  }
  throw error;
}

export async function promptLibraryRoutes(app: FastifyInstance) {
  app.get('/api/prompt-suites', async () => {
    const suites = await listPromptSuites();
    return { success: true, suites };
  });

  app.get<{ Params: { id: string } }>('/api/prompt-suites/:id', async (request, reply) => {
    try {
      const suite = await getPromptSuite(request.params.id);
      if (!suite) {
        return reply.code(404).send({ success: false, message: '题库不存在' });
      }
      return { success: true, suite };
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.post<{ Body: PromptSuiteInput }>('/api/prompt-suites', async (request, reply) => {
    try {
      const suite = await createPromptSuite(request.body ?? { name: '' });
      return reply.code(201).send({ success: true, suite });
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: PromptSuiteInput }>('/api/prompt-suites/:id', async (request, reply) => {
    try {
      const suite = await updatePromptSuite(request.params.id, request.body ?? { name: '' });
      return { success: true, suite };
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/prompt-suites/:id', async (request, reply) => {
    try {
      await deletePromptSuite(request.params.id);
      return { success: true };
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>('/api/prompt-suites/:id/cases', async (request, reply) => {
    try {
      const cases = await listPromptCases(request.params.id);
      return { success: true, cases };
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.post<{ Body: PromptCaseInput }>('/api/prompt-cases', async (request, reply) => {
    try {
      const promptCase = await createPromptCase(request.body ?? ({} as PromptCaseInput));
      return reply.code(201).send({ success: true, case: promptCase });
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: Partial<PromptCaseInput> }>('/api/prompt-cases/:id', async (request, reply) => {
    try {
      const promptCase = await updatePromptCase(request.params.id, request.body ?? {});
      return { success: true, case: promptCase };
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/prompt-cases/:id', async (request, reply) => {
    try {
      await deletePromptCase(request.params.id);
      return { success: true };
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  // 对话弹窗的快捷提示词：一次拿全部启用题目（带题库名），省去逐个题库请求。
  app.get('/api/prompt-cases', async () => {
    const cases = await listEnabledPromptCasesWithSuite();
    return { success: true, cases };
  });

  // 简化版提示词管理：一个平铺列表，只有题目名称 / 描述 / 答案。
  app.get('/api/prompt-library/cases', async () => {
    const cases = await listSimplePromptCases();
    return { success: true, cases };
  });

  app.post<{ Body: SimplePromptCaseInput }>('/api/prompt-library/cases', async (request, reply) => {
    try {
      const promptCase = await createSimplePromptCase(request.body ?? {});
      return reply.code(201).send({ success: true, case: promptCase });
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });

  app.put<{ Params: { id: string }; Body: SimplePromptCaseInput }>(
    '/api/prompt-library/cases/:id',
    async (request, reply) => {
      try {
        const promptCase = await updateSimplePromptCase(request.params.id, request.body ?? {});
        return { success: true, case: promptCase };
      } catch (error) {
        return sendPromptLibraryError(reply, error);
      }
    },
  );

  app.get('/api/prompt-presets', async () => {
    const presets = await listBuiltinPromptPresets();
    return { success: true, presets };
  });

  app.post<{ Params: { slug: string } }>('/api/prompt-presets/:slug/import', async (request, reply) => {
    try {
      const result = await importBuiltinPromptPreset(request.params.slug);
      return { success: true, ...result };
    } catch (error) {
      return sendPromptLibraryError(reply, error);
    }
  });
}
