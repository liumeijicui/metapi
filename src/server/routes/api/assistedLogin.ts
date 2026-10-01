import { FastifyInstance } from 'fastify';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { assistedLoginSessions } from '../../services/assistedLogin/sessionRegistry.js';
import { getAssistedLoginWatcher } from '../../services/assistedLogin/watchers.js';
import {
  buildAssistedLoginHandlers,
  createAssistedLoginCaptureLimiter,
  createAssistedLoginStatusLimiter,
} from '../../services/assistedLogin/routeHandlers.js';
import {
  clearGitHubAutoLogin,
  getGitHubAutoLoginState,
  renewGitHubSession,
  saveGitHubAutoLogin,
} from '../../services/assistedLogin/sites/githubPasswordLogin.js';
import {
  startLiveLogin,
  getLiveLoginStatus,
  getLiveLoginFrame,
  sendLiveLoginInput,
  finishLiveLogin,
  stopLiveLogin,
} from '../../services/assistedLogin/liveLogin.js';

const limitStatus = createAssistedLoginStatusLimiter();
const limitCapture = createAssistedLoginCaptureLimiter();

// The remote-login view polls frames as fast as it can paint, so this bucket is
// deliberately far larger than the interactive limits above.
const limitLiveFrame = createRateLimitGuard({ bucket: 'assisted-login-live-frame', max: 1800, windowMs: 60_000 });

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

  // Imported provider session: the browser-free path for servers that cannot host
  // a managed Chrome. The operator pastes a DevTools cookie once and the server
  // keeps re-running the handoff with it.
  app.get<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/session',
    { preHandler: [limitStatus] },
    async (request) => buildAssistedLoginHandlers(providerIdFrom(request.params)).readImportedSessionState(),
  );

  app.post<{ Params: ProviderParams; Body: unknown }>(
    '/api/assisted-login/:provider/session',
    { preHandler: [limitCapture] },
    async (request, reply) => {
      const handlers = buildAssistedLoginHandlers(providerIdFrom(request.params));
      if (!handlers.session) return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      return handlers.saveImportedSessionState(request.body, reply);
    },
  );

  app.delete<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/session',
    { preHandler: [limitCapture] },
    async (request) => buildAssistedLoginHandlers(providerIdFrom(request.params)).clearImportedSessionState(),
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

  app.post<{ Params: ProviderParams; Body: unknown }>(
    '/api/assisted-login/:provider/live/start',
    { preHandler: [limitStatus] },
    async (request, reply) => {
      const providerId = providerIdFrom(request.params);
      if (!buildAssistedLoginHandlers(providerId).session) {
        return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      }
      const payload = (request.body ?? {}) as Record<string, unknown>;
      const targetUrl = typeof payload.url === 'string' ? payload.url : undefined;
      try {
        return { success: true, ...(await startLiveLogin(providerId, targetUrl)) };
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '无法启动远程登录' });
      }
    },
  );

  app.post<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/live/status',
    { preHandler: [limitStatus] },
    async (request) => ({ success: true, ...getLiveLoginStatus(providerIdFrom(request.params)) }),
  );

  // Returns a raw JPEG so the client can paint it straight into an <img>.
  app.get<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/live/frame',
    { preHandler: [limitLiveFrame] },
    async (request, reply) => {
      const providerId = providerIdFrom(request.params);
      if (!buildAssistedLoginHandlers(providerId).session) {
        return reply.code(404).send({ success: false, message: UNKNOWN_PROVIDER_MESSAGE });
      }
      try {
        const result = await getLiveLoginFrame(providerId);
        if (!result) return reply.code(409).send({ success: false, message: '远程登录窗口未打开' });
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'no-store, no-cache, must-revalidate')
          .header('X-Live-Url', encodeURIComponent(result.url))
          .send(result.frame);
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '截取画面失败' });
      }
    },
  );

  app.post<{ Params: ProviderParams; Body: unknown }>(
    '/api/assisted-login/:provider/live/input',
    { preHandler: [limitStatus] },
    async (request, reply) => {
      try {
        return { success: true, ...(await sendLiveLoginInput(providerIdFrom(request.params), request.body)) };
      } catch (error) {
        return reply.code(400).send({ success: false, message: (error as Error)?.message || '输入转发失败' });
      }
    },
  );

  // Detects the completed provider login, harvests the cookies it produced and
  // stores them as the imported session.
  app.post<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/live/finish',
    { preHandler: [limitStatus] },
    async (request, reply) => {
      try {
        return { success: true, ...(await finishLiveLogin(providerIdFrom(request.params))) };
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '获取会话失败' });
      }
    },
  );

  app.post<{ Params: ProviderParams }>(
    '/api/assisted-login/:provider/live/stop',
    { preHandler: [limitStatus] },
    async (request) => {
      await stopLiveLogin(providerIdFrom(request.params));
      return { success: true };
    },
  );

  // GitHub is the only provider the server can sign back into by itself: the
  // operator stores a username/password once and the managed browser replays it
  // whenever the session is found signed out.
  app.get('/api/assisted-login/github/auto-login', { preHandler: [limitStatus] }, async () => ({
    success: true,
    autoLogin: await getGitHubAutoLoginState(),
  }));

  app.post<{ Body: unknown }>(
    '/api/assisted-login/github/auto-login',
    { preHandler: [limitCapture] },
    async (request, reply) => {
      const payload = (request.body ?? {}) as Record<string, unknown>;
      try {
        return {
          success: true,
          autoLogin: await saveGitHubAutoLogin({ username: payload.username, password: payload.password }),
        };
      } catch (error) {
        return reply.code(400).send({ success: false, message: (error as Error)?.message || '保存失败' });
      }
    },
  );

  app.delete('/api/assisted-login/github/auto-login', { preHandler: [limitCapture] }, async () => {
    await clearGitHubAutoLogin();
    return { success: true, autoLogin: await getGitHubAutoLoginState() };
  });

  // Force a renewal now, bypassing the cooldown, so the operator can verify the
  // stored credentials without waiting for the next keep-alive tick.
  app.post('/api/assisted-login/github/auto-login/run', { preHandler: [limitCapture] }, async () => {
    const outcome = await renewGitHubSession({ force: true });
    return { success: outcome.ok, ...outcome, autoLogin: await getGitHubAutoLoginState() };
  });

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

    app.get(`${prefix}/session`, { preHandler: [limitStatus] }, async () =>
      buildAssistedLoginHandlers(providerId).readImportedSessionState());

    app.post<{ Body: unknown }>(`${prefix}/session`, { preHandler: [limitCapture] }, async (request, reply) =>
      buildAssistedLoginHandlers(providerId).saveImportedSessionState(request.body, reply));

    app.delete(`${prefix}/session`, { preHandler: [limitCapture] }, async () =>
      buildAssistedLoginHandlers(providerId).clearImportedSessionState());

    app.post<{ Body: unknown }>(`${prefix}/capture`, { preHandler: [limitCapture] }, async (request, reply) =>
      buildAssistedLoginHandlers(providerId).capture(request.body, reply));

    app.post<{ Body: unknown }>(`${prefix}/bind`, { preHandler: [limitCapture] }, async (request, reply) =>
      buildAssistedLoginHandlers(providerId).bind(request.body, reply));

    app.post<{ Body: unknown }>(`${prefix}/refresh-account`, { preHandler: [limitCapture] }, async (request, reply) =>
      buildAssistedLoginHandlers(providerId).refreshAccount(request.body, reply));

    app.post(`${prefix}/live/start`, { preHandler: [limitStatus] }, async (request, reply) => {
      const payload = (request.body ?? {}) as Record<string, unknown>;
      const targetUrl = typeof payload.url === 'string' ? payload.url : undefined;
      try {
        return { success: true, ...(await startLiveLogin(providerId, targetUrl)) };
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '无法启动远程登录' });
      }
    });

    app.post(`${prefix}/live/status`, { preHandler: [limitStatus] }, async () => ({
      success: true,
      ...getLiveLoginStatus(providerId),
    }));

    app.get(`${prefix}/live/frame`, { preHandler: [limitLiveFrame] }, async (_request, reply) => {
      try {
        const result = await getLiveLoginFrame(providerId);
        if (!result) return reply.code(409).send({ success: false, message: '远程登录窗口未打开' });
        return reply
          .header('Content-Type', 'image/jpeg')
          .header('Cache-Control', 'no-store, no-cache, must-revalidate')
          .header('X-Live-Url', encodeURIComponent(result.url))
          .send(result.frame);
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '截取画面失败' });
      }
    });

    app.post(`${prefix}/live/input`, { preHandler: [limitStatus] }, async (request, reply) => {
      try {
        return { success: true, ...(await sendLiveLoginInput(providerId, request.body)) };
      } catch (error) {
        return reply.code(400).send({ success: false, message: (error as Error)?.message || '输入转发失败' });
      }
    });

    app.post(`${prefix}/live/finish`, { preHandler: [limitStatus] }, async (_request, reply) => {
      try {
        return { success: true, ...(await finishLiveLogin(providerId)) };
      } catch (error) {
        return reply.code(500).send({ success: false, message: (error as Error)?.message || '获取会话失败' });
      }
    });

    app.post(`${prefix}/live/stop`, { preHandler: [limitStatus] }, async () => {
      await stopLiveLogin(providerId);
      return { success: true };
    });
  }
}
