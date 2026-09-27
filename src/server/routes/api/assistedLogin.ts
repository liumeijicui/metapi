import { FastifyInstance } from 'fastify';
import { assistedLoginSessions } from '../../services/assistedLogin/sessionRegistry.js';
import { getAssistedLoginWatcher } from '../../services/assistedLogin/watchers.js';
import {
  buildAssistedLoginHandlers,
  createAssistedLoginCaptureLimiter,
  createAssistedLoginStatusLimiter,
} from '../../services/assistedLogin/routeHandlers.js';

const limitStatus = createAssistedLoginStatusLimiter();
const limitCapture = createAssistedLoginCaptureLimiter();

const UNKNOWN_PROVIDER_MESSAGE = '未知的快捷登录提供方';

type ProviderParams = { provider: string };

function providerIdFrom(params: ProviderParams): string {
  return (params.provider || '').trim().toLowerCase();
}

/**
 * Registers the `/api/assisted-login/:provider/*` routes plus the
 * `/api/linuxdo/*` and `/api/github/*` aliases. The Linux.do routes were the
 * original implementation of assisted login, so the alias keeps old clients and
 * bookmarks working.
 */
export async function assistedLoginRoutes(app: FastifyInstance) {
  app.get('/api/assisted-login/providers', { preHandler: [limitStatus] }, async () => ({
    providers: assistedLoginSessions.all().map((session) => ({
      id: session.provider.id,
      label: session.provider.label,
    })),
  }));

  app.get<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/status',
    { preHandler: [limitStatus] },
    async (request) => buildAssistedLoginHandlers(providerIdFrom(request.params)).status(),
  );

  app.post<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/login-window',
    { preHandler: [limitStatus] },
    async (request, reply) => {
      const handlers = buildAssistedLoginHandlers(providerIdFrom(request.params));
      if (!handlers.session) return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      try {
        const result = await handlers.openLoginWindow();
        return { success: true, url: result.url };
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '无法打开登录窗口' });
      }
    },
  );

  app.post<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/check-session',
    { preHandler: [limitStatus] },
    async (request, reply) => {
      const providerId = providerIdFrom(request.params);
      if (!getAssistedLoginWatcher(providerId)) {
        return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      }
      return buildAssistedLoginHandlers(providerId).checkSession();
    },
  );

  app.post<{ Params: ProviderParams; Body: unknown }>(
    '/api/assisted-login/:provider/capture',
    { preHandler: [limitCapture] },
    async (request, reply) => {
      const handlers = buildAssistedLoginHandlers(providerIdFrom(request.params));
      if (!handlers.session) return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      return handlers.capture(request.body, reply);
    },
  );

  // Re-fetch credentials for an existing account. The account page calls this
  // when a token expired, so recovery is a button click instead of hand-editing
  // a token.
  app.post<{ Params: ProviderParams; Body: unknown }>(
    '/api/assisted-login/:provider/refresh-account',
    { preHandler: [limitCapture] },
    async (request, reply) => {
      const handlers = buildAssistedLoginHandlers(providerIdFrom(request.params));
      if (!handlers.session) return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      return handlers.refreshAccount(request.body, reply);
    },
  );

  app.post<{ Params: ProviderParams; Body: unknown }>(
    '/api/assisted-login/:provider/bind',
    { preHandler: [limitCapture] },
    async (request, reply) => {
      const handlers = buildAssistedLoginHandlers(providerIdFrom(request.params));
      if (!handlers.session) return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      return handlers.bind(request.body, reply);
    },
  );

  // Legacy aliases (identical handlers, fixed provider id).
  for (const providerId of ['linuxdo', 'github'] as const) {
    const prefix = `/api/${providerId}`;

    app.get(`${prefix}/status`, { preHandler: [limitStatus] }, async () =>
      buildAssistedLoginHandlers(providerId).status());

    app.post(`${prefix}/login-window`, { preHandler: [limitStatus] }, async (_request, reply) => {
      try {
        const result = await buildAssistedLoginHandlers(providerId).openLoginWindow();
        return { success: true, url: result.url };
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '无法打开登录窗口' });
      }
    });

    app.post(`${prefix}/check-session`, { preHandler: [limitStatus] }, async () =>
      buildAssistedLoginHandlers(providerId).checkSession());

    app.post<{ Body: unknown }>(`${prefix}/capture`, { preHandler: [limitCapture] }, async (request, reply) =>
      buildAssistedLoginHandlers(providerId).capture(request.body, reply));

    app.post<{ Body: unknown }>(`${prefix}/bind`, { preHandler: [limitCapture] }, async (request, reply) =>
      buildAssistedLoginHandlers(providerId).bind(request.body, reply));

    app.post<{ Body: unknown }>(`${prefix}/refresh-account`, { preHandler: [limitCapture] }, async (request, reply) =>
      buildAssistedLoginHandlers(providerId).refreshAccount(request.body, reply));
  }
}
