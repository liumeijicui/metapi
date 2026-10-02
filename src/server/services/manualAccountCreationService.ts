import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { insertAndGetById } from '../db/insertHelpers.js';
import { startBackgroundTask } from './backgroundTaskService.js';
import { getAdapter } from './platforms/index.js';
import {
  guessPlatformUserIdFromUsername,
  mergeAccountExtraConfig,
  type AccountCredentialMode,
} from './accountExtraConfig.js';
import { runWithSiteApiEndpointPool } from './siteApiEndpointService.js';
import { type AccountCreatePayload } from '../contracts/accountsRoutePayloads.js';
import { convergeAccountMutation } from './accountMutationWorkflow.js';
import { applyRotatedCredential } from './accountCredentialRotation.js';
import { pruneOtherSessions } from './sessionHygiene.js';
import { getAccountCredentialContext, withAccountCredentialContext } from './siteProxy.js';

// Slow community relays can need several round trips (rolling-credential
// exchange, /api/user/self, model list) before verification answers.
const ACCOUNT_VERIFY_TIMEOUT_MS = 30_000;

type AccountInitializationParams = {
  accountId: number;
  site: typeof schema.sites.$inferSelect;
  adapter: NonNullable<ReturnType<typeof getAdapter>>;
  tokenType: 'session' | 'apikey' | 'unknown';
  accessToken: string;
  apiToken: string;
  platformUserId?: number;
  skipModelFetch?: boolean;
};

export type CreateManualAccountParams = {
  body: AccountCreatePayload;
  site: typeof schema.sites.$inferSelect;
  adapter: NonNullable<ReturnType<typeof getAdapter>>;
  credentialMode: AccountCredentialMode;
  rawAccessToken: string;
  usernameOverride?: string;
};

export type CreateManualAccountResult = {
  account: typeof schema.accounts.$inferSelect;
  tokenType: 'session' | 'apikey' | 'unknown';
  modelCount: number;
  apiTokenFound: boolean;
  usernameDetected: boolean;
  queued: boolean;
  jobId?: string;
  message?: string;
};

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildAccountVerifyTimeoutMessage(): string {
  return `Token verification timed out (${Math.max(1, Math.round(ACCOUNT_VERIFY_TIMEOUT_MS / 1000))}s)`;
}

async function getNextAccountSortOrder(): Promise<number> {
  const rows = await db.select({ sortOrder: schema.accounts.sortOrder }).from(schema.accounts).all();
  const max = rows.reduce((currentMax, row) => Math.max(currentMax, row.sortOrder || 0), -1);
  return max + 1;
}

async function getModelsWithSiteApiEndpointPool(
  site: typeof schema.sites.$inferSelect,
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
  accessToken: string,
  platformUserId?: number,
): Promise<string[]> {
  const timeoutMessage = buildAccountVerifyTimeoutMessage();
  const deadline = Date.now() + ACCOUNT_VERIFY_TIMEOUT_MS;
  return runWithSiteApiEndpointPool(site, (target) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(timeoutMessage);
    }
    return withTimeout(
      () => adapter.getModels(target.baseUrl, accessToken, platformUserId),
      remainingMs,
      timeoutMessage,
    );
  });
}

async function initializeAccountInBackground({
  accountId,
  site,
  adapter,
  tokenType,
  accessToken,
  apiToken,
  platformUserId,
  skipModelFetch,
}: AccountInitializationParams) {
  const summary = {
    accountId,
    syncedTokenCount: 0,
    refreshedBalance: false,
    refreshedModels: false,
    rebuiltRoutes: false,
  };

  let fetchedUpstreamTokens: Array<{ name?: string | null; key?: string | null; enabled?: boolean | null; tokenGroup?: string | null }> = [];
  if (tokenType === 'session' && accessToken) {
    try {
      const syncedTokens = await adapter.getApiTokens(site.url, accessToken, platformUserId);
      summary.syncedTokenCount = Array.isArray(syncedTokens) ? syncedTokens.length : 0;
      fetchedUpstreamTokens = Array.isArray(syncedTokens) ? syncedTokens : [];
    } catch {}
  }

  const convergence = await convergeAccountMutation({
    accountId,
    preferredApiToken: tokenType === 'session' ? apiToken : null,
    defaultTokenSource: 'manual',
    ensurePreferredTokenBeforeSync: tokenType === 'session',
    upstreamTokens: fetchedUpstreamTokens,
    refreshBalance: tokenType === 'session',
    refreshModels: skipModelFetch !== true,
    rebuildRoutes: skipModelFetch !== true,
    continueOnError: true,
  });
  summary.refreshedBalance = convergence.refreshedBalance;
  summary.refreshedModels = convergence.refreshedModels;
  summary.rebuiltRoutes = convergence.rebuiltRoutes;

  return summary;
}

function buildQueuedAccountInitializationMessage(
  tokenType: 'session' | 'apikey' | 'unknown',
  skipModelFetch?: boolean,
  edgeRateLimitedBind?: boolean,
) {
  if (edgeRateLimitedBind === true) {
    return '账号已添加；站点当前限流（公益站共享出口访问量过大），后台会在限流解除后自动同步令牌、余额和模型信息。';
  }
  if (tokenType === 'session' && skipModelFetch === true) {
    return '账号已添加，后台正在同步令牌和余额信息。';
  }
  if (tokenType === 'session') {
    return '账号已添加，后台正在同步令牌、余额和模型信息。';
  }
  if (skipModelFetch === true) {
    return '已添加为 API Key 账号（可用于代理转发）。';
  }
  return '已添加为 API Key 账号，后台正在同步模型和路由信息。';
}

/**
 * Creates an account row from a credential the caller already holds.
 *
 * The flow always runs inside a credential-tracking scope: verification and the
 * background token sync each exchange a rolling credential, and a plain
 * `POST /api/accounts` caller would otherwise store the value the first exchange
 * already retired.
 */
export function createManualAccount(
  params: CreateManualAccountParams,
): Promise<CreateManualAccountResult> {
  return withAccountCredentialContext(
    { siteId: params.site.id },
    () => createManualAccountInner(params),
  );
}

async function createManualAccountInner({
  body,
  site,
  adapter,
  credentialMode,
  rawAccessToken,
  usernameOverride,
}: CreateManualAccountParams): Promise<CreateManualAccountResult> {
  let username = typeof usernameOverride === 'string'
    ? usernameOverride.trim()
    : (body.username || '').trim();
  let accessToken = rawAccessToken;
  let apiToken = (body.apiToken || '').trim();
  let tokenType: 'session' | 'apikey' | 'unknown' = 'unknown';
  let edgeRateLimitedBind = false;
  let verifiedModels: string[] = [];

  if (credentialMode === 'apikey') {
    if (body.skipModelFetch === true) {
      tokenType = 'apikey';
      accessToken = '';
      if (!apiToken) apiToken = rawAccessToken;
    } else {
      const models = await getModelsWithSiteApiEndpointPool(
        site,
        adapter,
        rawAccessToken,
        body.platformUserId,
      );
      verifiedModels = Array.isArray(models)
        ? models.filter((item) => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (verifiedModels.length === 0) {
        const error = new Error('API Key 验证失败：未获取到可用模型');
        (error as Error & { requiresVerification?: boolean }).requiresVerification = true;
        throw error;
      }

      tokenType = 'apikey';
      accessToken = '';
      if (!apiToken) apiToken = rawAccessToken;
    }
  } else {
    const verifyResult = await withTimeout(
      () => adapter.verifyToken(site.url, rawAccessToken, body.platformUserId),
      ACCOUNT_VERIFY_TIMEOUT_MS,
      buildAccountVerifyTimeoutMessage(),
    );
    tokenType = verifyResult.tokenType;
    if (tokenType === 'unknown') {
      if (verifyResult.failureReason === 'rate-limited') {
        // A shared free relay throttles by egress IP, so this says the site is
        // busy rather than that the credential is wrong. Bind it as the session
        // the caller asked for and let the background initialisation confirm the
        // token once the throttle window clears.
        tokenType = 'session';
        edgeRateLimitedBind = true;
      } else {
        const error = new Error('Token 验证失败，请先点击“验证 Token”，验证成功后再绑定账号');
        (error as Error & { requiresVerification?: boolean }).requiresVerification = true;
        throw error;
      }
    }

    if (credentialMode === 'session' && tokenType !== 'session') {
      throw new Error('当前凭证是 API Key，请切换到 API Key 模式，或改用 Session Token');
    }

    if (tokenType === 'session') {
      if (!username && verifyResult.userInfo?.username) username = String(verifyResult.userInfo.username).trim();
      if (!apiToken && verifyResult.apiToken) apiToken = String(verifyResult.apiToken).trim();
    } else if (tokenType === 'apikey') {
      accessToken = '';
      if (!apiToken) apiToken = rawAccessToken;
      verifiedModels = Array.isArray(verifyResult.models)
        ? verifyResult.models.filter((item: unknown) => typeof item === 'string' && item.trim().length > 0)
        : [];
    }
  }

  const resolvedPlatformUserId =
    body.platformUserId || guessPlatformUserIdFromUsername(username) || undefined;
  const resolvedCredentialMode: AccountCredentialMode = tokenType === 'apikey' ? 'apikey' : 'session';
  const extraConfigPatch: Record<string, unknown> = { credentialMode: resolvedCredentialMode };
  if (resolvedPlatformUserId) {
    extraConfigPatch.platformUserId = resolvedPlatformUserId;
  }
  if ((site.platform || '').toLowerCase() === 'sub2api') {
    const managedRefreshToken = typeof body.refreshToken === 'string' ? body.refreshToken.trim() : '';
    const managedTokenExpiresAt = typeof body.tokenExpiresAt === 'number'
      ? Math.trunc(body.tokenExpiresAt)
      : (typeof body.tokenExpiresAt === 'string' ? Number.parseInt(body.tokenExpiresAt.trim(), 10) : undefined);
    if (managedRefreshToken) {
      extraConfigPatch.sub2apiAuth = managedTokenExpiresAt && Number.isFinite(managedTokenExpiresAt) && managedTokenExpiresAt > 0
        ? { refreshToken: managedRefreshToken, tokenExpiresAt: managedTokenExpiresAt }
        : { refreshToken: managedRefreshToken };
    }
  }
  const extraConfig = mergeAccountExtraConfig(undefined, extraConfigPatch);

  // Verification exchanges a rolling credential (`new_api_refresh`) and retires
  // the value the caller captured from the browser. Persist the replacement, or
  // the account is dead on arrival.
  accessToken = applyRotatedCredential(accessToken, getAccountCredentialContext()?.rotated);

  const result = await insertAndGetById<typeof schema.accounts.$inferSelect>({
    table: schema.accounts,
    idColumn: schema.accounts.id,
    values: {
      siteId: body.siteId,
      username: username || undefined,
      accessToken,
      apiToken: apiToken || undefined,
      checkinEnabled: tokenType === 'session' ? (body.checkinEnabled ?? true) : false,
      extraConfig,
      isPinned: false,
      sortOrder: await getNextAccountSortOrder(),
    },
    insertErrorMessage: '创建账号失败',
    loadErrorMessage: '创建账号失败',
  });

  // The sign-in that produced this credential also minted a server-side
  // session. On a fork that caps concurrent sessions the leftovers from earlier
  // binds are what eventually refuse the next one, so the account is left with
  // exactly the session it was just handed. Best-effort: sites without the API
  // are unaffected.
  if (tokenType === 'session') {
    const prune = await pruneOtherSessions({
      adapter,
      siteUrl: site.url,
      accessToken,
      platformUserId: resolvedPlatformUserId,
    });
    if (prune.status === 'pruned' || prune.status === 'skipped') {
      await db
        .update(schema.accounts)
        .set({
          extraConfig: mergeAccountExtraConfig(result.extraConfig, {
            sessionHygiene: {
              outcome: prune.status === 'skipped' ? prune.reason : prune.status,
              ...(prune.status === 'pruned' ? { removed: prune.removed, kept: prune.kept } : {}),
              updatedAt: new Date().toISOString(),
            },
          }),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.accounts.id, result.id))
        .run();
    }
  }

  const shouldQueueInitialization = tokenType === 'session' || body.skipModelFetch !== true;
  let queuedTaskId: string | undefined;
  let queuedMessage: string | undefined;
  if (shouldQueueInitialization) {
    const taskTitle = `初始化连接 #${result.id}`;
    const { task } = startBackgroundTask(
      {
        type: 'account-init',
        title: taskTitle,
        dedupeKey: `account-init-${result.id}`,
        notifyOnFailure: true,
        successMessage: () => `${taskTitle}已完成`,
        failureMessage: (currentTask) => `${taskTitle}失败：${currentTask.error || 'unknown error'}`,
      },
      async () => withAccountCredentialContext(
        { accountId: result.id, siteId: site.id },
        () => initializeAccountInBackground({
          accountId: result.id,
          site,
          adapter,
          tokenType,
          accessToken,
          apiToken,
          platformUserId: resolvedPlatformUserId,
          skipModelFetch: body.skipModelFetch,
        }),
      ),
    );
    queuedTaskId = task.id;
    queuedMessage = buildQueuedAccountInitializationMessage(tokenType, body.skipModelFetch, edgeRateLimitedBind);
  }

  const account = await db.select().from(schema.accounts).where(eq(schema.accounts.id, result.id)).get();
  if (!account) {
    throw new Error('创建账号失败');
  }

  return {
    account,
    tokenType,
    modelCount: verifiedModels.length,
    apiTokenFound: !!apiToken,
    usernameDetected: !!(!body.username && username),
    queued: !!queuedTaskId,
    jobId: queuedTaskId,
    message: queuedMessage,
  };
}
