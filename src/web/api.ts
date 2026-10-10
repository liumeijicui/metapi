import { clearAuthSession, getAuthToken } from "./authSession.js";

type BufferLike = {
  from(data: ArrayBuffer): { toString(encoding: "base64"): string };
};

const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: BufferLike })
  .Buffer;

type RequestOptions = RequestInit & {
  timeoutMs?: number;
  /**
   * 收到 401 / 403 时是否按「本系统会话过期」处理（清 token + 刷新回登录页）。
   *
   * 默认开启，因为绝大多数接口的 401 确实来自 authMiddleware。但「代上游发请求」的接口
   * 必须关掉：上游站点自己回 401（例如 agentrouter 的 unauthorized client detected）
   * 不是我们的登录失效，原样处理会把用户无故踢下线。
   */
  clearSessionOnAuthError?: boolean;
};

function requireAuthToken(): string {
  const token = getAuthToken(localStorage);
  if (!token) {
    const hadToken = !!localStorage.getItem("auth_token");
    clearAuthSession(localStorage);
    if (
      hadToken &&
      typeof window !== "undefined" &&
      typeof window.location?.reload === "function"
    ) {
      window.location.reload();
    }
    throw new Error("Session expired");
  }
  return token;
}

async function extractResponseErrorMessage(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        if (json?.message && typeof json.message === "string") {
          message = json.message;
        } else if (json?.error && typeof json.error === "string") {
          message = json.error;
        } else if (
          json?.error?.message &&
          typeof json.error.message === "string"
        ) {
          message = json.error.message;
        } else {
          message = `${message}: ${text.slice(0, 120)}`;
        }
      } catch {
        message = `${message}: ${text.slice(0, 120)}`;
      }
    }
  } catch {}
  return message;
}

function parseContentDispositionFilename(
  headerValue: string | null,
): string | null {
  if (!headerValue) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(headerValue);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const bareMatch = /filename=([^;]+)/i.exec(headerValue);
  return bareMatch?.[1]?.trim() || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (nodeBuffer) {
    return nodeBuffer.from(buffer).toString("base64");
  }

  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fetchAuthenticatedResponse(
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 30_000,
    signal: externalSignal,
    clearSessionOnAuthError = true,
    ...fetchOptions
  } = options;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let cleanupExternalSignal = () => {};

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const abortHandler = () => controller.abort();
      externalSignal.addEventListener("abort", abortHandler, { once: true });
      cleanupExternalSignal = () =>
        externalSignal.removeEventListener("abort", abortHandler);
    }
  }

  const token = requireAuthToken();
  const headers = new Headers(fetchOptions.headers ?? {});
  headers.set("Authorization", `Bearer ${token}`);
  if (fetchOptions.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers,
    });
    if (clearSessionOnAuthError && (res.status === 401 || res.status === 403)) {
      const hadToken = !!getAuthToken(localStorage);
      clearAuthSession(localStorage);
      if (
        hadToken &&
        typeof window !== "undefined" &&
        typeof window.location?.reload === "function"
      ) {
        window.location.reload();
      }
      throw new Error("Session expired");
    }
    return res;
  } catch (error: any) {
    if (error?.name === "AbortError") {
      if (externalSignal?.aborted) throw error;
      throw new Error(
        `请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）`,
      );
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    cleanupExternalSignal();
  }
}

async function request<T = any>(
  url: string,
  options: RequestOptions = {},
): Promise<T> {
  const res = await fetchAuthenticatedResponse(url, options);
  if (!res.ok) {
    throw new Error(await extractResponseErrorMessage(res));
  }
  return res.json() as Promise<T>;
}

async function streamSse(
  url: string,
  handlers: {
    onLog?: (entry: any) => void;
    onDone?: (payload: any) => void;
    signal?: AbortSignal;
  },
) {
  const response = await fetchAuthenticatedResponse(url, {
    method: "GET",
    signal: handlers.signal,
    headers: {
      Accept: "text/event-stream",
    },
    timeoutMs: 120_000,
  });

  if (!response.ok) {
    throw new Error(await extractResponseErrorMessage(response));
  }
  if (!response.body) {
    throw new Error("响应未返回流式内容");
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  const flushBuffer = (final = false) => {
    const chunks = final ? [...buffer.split("\n\n"), ""] : buffer.split("\n\n");
    if (!final) buffer = chunks.pop() || "";
    else buffer = "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let eventName = "message";
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice("event:".length).trim() || "message";
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).trim());
        }
      }

      if (dataLines.length <= 0) continue;
      let payload: any = dataLines.join("\n");
      try {
        payload = JSON.parse(payload);
      } catch {
        // keep string payload
      }

      if (eventName === "log") {
        handlers.onLog?.(payload);
      } else if (eventName === "done") {
        handlers.onDone?.(payload);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flushBuffer(false);
  }

  if (buffer.trim()) {
    flushBuffer(true);
  }
}

function buildQueryString(
  params?: Record<string, string | number | boolean | null | undefined>,
) {
  if (!params) return "";
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : "";
}

type TestChatRequestPayload = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  targetFormat?: "openai" | "claude" | "responses" | "gemini";
  stream?: boolean;
  forcedChannelId?: number | null;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

export type ProxyTestMethod = "POST" | "GET" | "DELETE";
export type ProxyTestRequestKind = "json" | "multipart" | "empty";

export type ProxyTestMultipartFile = {
  field: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type ProxyTestRequestEnvelope = {
  method: ProxyTestMethod;
  path: string;
  requestKind: ProxyTestRequestKind;
  stream?: boolean;
  jobMode?: boolean;
  rawMode?: boolean;
  forcedChannelId?: number | null;
  jsonBody?: unknown;
  rawJsonText?: string;
  multipartFields?: Record<string, string>;
  multipartFiles?: ProxyTestMultipartFile[];
};

const DEFAULT_PROXY_TEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_PROXY_TEST_TIMEOUT_MS = 150_000;

function resolveProxyTestTimeoutMs(data: ProxyTestRequestEnvelope) {
  if (data.jobMode) return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/images/generations")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/images/edits")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === "/v1/videos" && data.method === "POST")
    return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  return DEFAULT_PROXY_TEST_TIMEOUT_MS;
}

function proxyTestRequest(data: ProxyTestRequestEnvelope) {
  return request("/api/test/proxy", {
    method: "POST",
    body: JSON.stringify(data),
    timeoutMs: resolveProxyTestTimeoutMs(data),
  });
}

async function directChatStreamRequest(
  data: {
    siteId: number;
    accountId: number;
    tokenId?: number | null;
    model: string;
    messages: Array<{ role: string; content: string }>;
    /** 思考强度（reasoning_effort）；留空表示按站点默认。 */
    reasoningEffort?: string;
  },
  signal?: AbortSignal,
) {
  // 直连上游：不经网关路由，所以单独走一个接口。
  // 注意这里的 timeoutMs 只覆盖「等到上游响应头」这一段（拿到响应头后计时器就清了，
  // 不会截断后面的流），真正的超时策略在服务端按「空闲」判定；
  // 这里给 30 分钟，保证先开口报错的一定是服务端那句有原因的话，而不是模糊的客户端超时。
  return fetchAuthenticatedResponse("/api/model-monitor/chat/stream", {
    method: "POST",
    signal,
    body: JSON.stringify(data),
    timeoutMs: 30 * 60_000,
    // 上游站点自己的 401（凭据被拒、风控等）不能当成我们的登录失效，
    // 否则一对话就被踢回登录页。真实状态码由服务端写进错误文案。
    clearSessionOnAuthError: false,
  });
}

async function proxyTestStreamRequest(
  data: ProxyTestRequestEnvelope,
  signal?: AbortSignal,
) {
  return fetchAuthenticatedResponse("/api/test/proxy/stream", {
    method: "POST",
    signal,
    body: JSON.stringify(data),
    timeoutMs: resolveProxyTestTimeoutMs(data),
  });
}

export type ProxyTestJobResponse = {
  jobId: string;
  status: "pending" | "succeeded" | "failed" | "cancelled";
  result?: unknown;
  error?: unknown;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
};

export type SystemProxyTestRequest = {
  proxyUrl?: string;
};

export type SystemProxyTestResponse = {
  success: true;
  proxyUrl: string;
  probeUrl: string;
  finalUrl: string;
  reachable: true;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
};

export type RuntimeRoutingWeightsPayload = {
  baseWeightFactor?: number;
  valueScoreFactor?: number;
  costWeight?: number;
  balanceWeight?: number;
  usageWeight?: number;
};

export type RuntimeSettingsPayload = {
  proxyToken?: string;
  systemProxyUrl?: string;
  payloadRules?: Record<string, unknown> | null;
  modelAvailabilityProbeEnabled?: boolean;
  codexUpstreamWebsocketEnabled?: boolean;
  responsesCompactFallbackToResponsesEnabled?: boolean;
  disableCrossProtocolFallback?: boolean;
  proxySessionChannelConcurrencyLimit?: number;
  proxySessionChannelQueueWaitMs?: number;
  proxyDebugTraceEnabled?: boolean;
  proxyDebugCaptureHeaders?: boolean;
  proxyDebugCaptureBodies?: boolean;
  proxyDebugCaptureStreamChunks?: boolean;
  proxyDebugTargetSessionId?: string;
  proxyDebugTargetClientKind?: string;
  proxyDebugTargetModel?: string;
  proxyDebugRetentionHours?: number;
  proxyDebugMaxBodyBytes?: number;
  checkinCron?: string;
  checkinScheduleMode?: "cron" | "interval";
  checkinIntervalHours?: number;
  balanceRefreshCron?: string;
  logCleanupCron?: string;
  logCleanupUsageLogsEnabled?: boolean;
  logCleanupProgramLogsEnabled?: boolean;
  logCleanupRetentionDays?: number;
  webhookUrl?: string;
  barkUrl?: string;
  webhookEnabled?: boolean;
  barkEnabled?: boolean;
  serverChanEnabled?: boolean;
  serverChanKey?: string;
  telegramEnabled?: boolean;
  telegramApiBaseUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  telegramUseSystemProxy?: boolean;
  telegramMessageThreadId?: string;
  smtpEnabled?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  smtpFrom?: string;
  smtpTo?: string;
  notifyCooldownSec?: number;
  adminIpAllowlist?: string[] | string;
  routingFallbackUnitCost?: number;
  proxyFirstByteTimeoutSec?: number;
  tokenRouterFailureCooldownMaxSec?: number;
  routingWeights?: RuntimeRoutingWeightsPayload;
  proxyErrorKeywords?: string[] | string;
  proxyEmptyContentFailEnabled?: boolean;
  globalBlockedBrands?: string[];
  globalAllowedModels?: string[];
};

export type ProxyLogStatusFilter = "all" | "success" | "failed";
export type ProxyLogClientConfidence = "exact" | "heuristic" | "unknown" | null;
export type ProxyLogUsageSource = "upstream" | "self-log" | "unknown" | null;

export type ProxyLogBillingDetails = {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
} | null;

export type ProxyLogRouteKind = 'forward' | 'legacy';

export type ProxyLogListItem = {
  id: number;
  createdAt: string;
  modelRequested: string;
  modelActual: string;
  routeKind?: ProxyLogRouteKind | null;
  status: string;
  latencyMs: number;
  isStream?: boolean | null;
  firstByteLatencyMs?: number | null;
  totalTokens: number | null;
  retryCount: number;
  accountId?: number | null;
  siteId?: number | null;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string | null;
  downstreamKeyId?: number | null;
  downstreamKeyName?: string | null;
  downstreamKeyGroupName?: string | null;
  downstreamKeyTags?: string[];
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: ProxyLogClientConfidence;
  usageSource?: ProxyLogUsageSource;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCost?: number | null;
};

export type ProxyLogDetail = ProxyLogListItem & {
  routeId?: number | null;
  channelId?: number | null;
  httpStatus?: number | null;
  billingDetails?: ProxyLogBillingDetails;
};

export type ProxyLogsSummary = {
  totalCount: number;
  successCount: number;
  failedCount: number;
  totalCost: number;
  totalTokensAll: number;
};

export type ProxyLogsQuery = {
  limit?: number;
  offset?: number;
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: string;
  siteId?: number;
  from?: string;
  to?: string;
};

export type ProxyLogClientOption = {
  value: string;
  label: string;
};

export type ProxyLogsResponse = {
  items: ProxyLogListItem[];
  total: number;
  page: number;
  pageSize: number;
  clientOptions: ProxyLogClientOption[];
  summary: ProxyLogsSummary;
};

export type ProxyDebugTraceListItem = {
  id: number;
  createdAt: string;
  downstreamPath: string;
  clientKind?: string | null;
  sessionId?: string | null;
  requestedModel?: string | null;
  selectedChannelId?: number | null;
  finalStatus?: string | null;
  finalHttpStatus?: number | null;
  finalUpstreamPath?: string | null;
};

export type ProxyDebugTraceDetail = {
  trace: {
    id: number;
    createdAt?: string | null;
    updatedAt?: string | null;
    downstreamPath?: string | null;
    clientKind?: string | null;
    sessionId?: string | null;
    traceHint?: string | null;
    requestedModel?: string | null;
    stickySessionKey?: string | null;
    stickyHitChannelId?: number | null;
    selectedChannelId?: number | null;
    selectedRouteId?: number | null;
    selectedAccountId?: number | null;
    selectedSiteId?: number | null;
    selectedSitePlatform?: string | null;
    endpointCandidatesJson?: string | null;
    endpointRuntimeStateJson?: string | null;
    decisionSummaryJson?: string | null;
    requestHeadersJson?: string | null;
    requestBodyJson?: string | null;
    finalStatus?: string | null;
    finalHttpStatus?: number | null;
    finalUpstreamPath?: string | null;
    finalResponseHeadersJson?: string | null;
    finalResponseBodyJson?: string | null;
  };
  attempts: Array<{
    id: number;
    attemptIndex: number;
    endpoint: string;
    requestPath: string;
    targetUrl: string;
    runtimeExecutor?: string | null;
    requestHeadersJson?: string | null;
    requestBodyJson?: string | null;
    responseStatus?: number | null;
    responseHeadersJson?: string | null;
    responseBodyJson?: string | null;
    rawErrorText?: string | null;
    recoverApplied?: boolean | null;
    downgradeDecision?: boolean | null;
    downgradeReason?: string | null;
    memoryWriteJson?: string | null;
    createdAt?: string | null;
  }>;
};

export type ProxyDebugTracesResponse = {
  items: ProxyDebugTraceListItem[];
};

export type OAuthProviderInfo = {
  provider: string;
  label: string;
  platform: string;
  enabled: boolean;
  loginType: "oauth";
  requiresProjectId: boolean;
  supportsDirectAccountRouting: boolean;
  supportsCloudValidation: boolean;
  supportsNativeProxy: boolean;
};

export type OAuthProvidersResponse = {
  providers: OAuthProviderInfo[];
  defaults?: {
    systemProxyConfigured?: boolean;
  };
};

export type OAuthRouteUnitStrategy = "round_robin" | "stick_until_unavailable";

export type OAuthRouteUnitSummary = {
  id?: number;
  routeUnitId?: number;
  name: string;
  strategy: OAuthRouteUnitStrategy;
  memberCount: number;
};

export type OAuthRouteParticipation =
  | {
      kind: "single";
    }
  | ({
      kind: "route_unit";
    } & OAuthRouteUnitSummary);

export type OAuthStartInstructions = {
  redirectUri: string;
  callbackPort: number;
  callbackPath: string;
  manualCallbackDelayMs: number;
  sshTunnelCommand?: string;
  sshTunnelKeyCommand?: string;
};

export type OAuthStartResponse = {
  provider: string;
  state: string;
  authorizationUrl: string;
  instructions: OAuthStartInstructions;
};

export type OAuthSessionInfo = {
  provider: string;
  state: string;
  status: "pending" | "success" | "error";
  accountId?: number;
  siteId?: number;
  error?: string;
};

export type OAuthQuotaWindowInfo = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string | null;
};

export type OAuthQuotaInfo = {
  status: "supported" | "unsupported" | "error";
  source: "official" | "reverse_engineered";
  lastSyncAt?: string | null;
  lastError?: string | null;
  providerMessage?: string | null;
  subscription?: {
    planType?: string | null;
    activeStart?: string | null;
    activeUntil?: string | null;
  } | null;
  windows: {
    fiveHour: OAuthQuotaWindowInfo;
    sevenDay: OAuthQuotaWindowInfo;
  };
  lastLimitResetAt?: string | null;
};

export type OAuthConnectionInfo = {
  accountId: number;
  siteId: number;
  provider: string;
  username?: string | null;
  email?: string | null;
  accountKey?: string | null;
  planType?: string | null;
  projectId?: string | null;
  modelCount: number;
  modelsPreview: string[];
  status: "healthy" | "abnormal";
  quota?: OAuthQuotaInfo | null;
  routeChannelCount?: number;
  lastModelSyncAt?: string | null;
  lastModelSyncError?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  routeUnit?: OAuthRouteUnitSummary | null;
  routeParticipation?: OAuthRouteParticipation | null;
  site?: { id: number; name: string; url: string; platform: string } | null;
};

export type OAuthConnectionsResponse = {
  items: OAuthConnectionInfo[];
  total: number;
  limit: number;
  offset: number;
};

export type OAuthQuotaBatchRefreshResponse = {
  success: boolean;
  refreshed: number;
  failed: number;
  items: Array<{
    accountId: number;
    success: boolean;
    quota?: OAuthQuotaInfo;
    error?: string;
  }>;
};

export type OAuthImportResponse = {
  success: boolean;
  imported: number;
  skipped: number;
  failed: number;
  items: Array<{
    name: string;
    status: "imported" | "skipped" | "failed";
    accountId?: number;
    provider?: string;
    message?: string;
  }>;
};

export type OAuthRouteUnitMutationResponse = {
  success: boolean;
  routeUnit?: OAuthRouteUnitSummary;
};

export type DownstreamApiKeyTrendBucket = {
  startUtc: string | null;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  successRate: number | null;
  totalTokens: number;
  totalCost: number;
};

export type DownstreamApiKeyTrendResponse = {
  success: boolean;
  range: "24h" | "7d" | "all";
  item: {
    id: number;
    name: string;
  };
  bucketSeconds: number;
  timeZone?: string | null;
  buckets: DownstreamApiKeyTrendBucket[];
};

export const api = {
  // Sites
  getSites: () => request("/api/sites"),
  refreshSiteBalances: (ids?: number[]) =>
    request("/api/sites/refresh-balances", {
      method: "POST",
      body: JSON.stringify(ids && ids.length > 0 ? { ids } : {}),
    }),
  addSite: (data: any) =>
    request("/api/sites", { method: "POST", body: JSON.stringify(data) }),
  updateSite: (id: number, data: any) =>
    request(`/api/sites/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteSite: (id: number) => request(`/api/sites/${id}`, { method: "DELETE" }),
  batchUpdateSites: (data: any) =>
    request("/api/sites/batch", { method: "POST", body: JSON.stringify(data) }),
  detectSite: (url: string) =>
    request("/api/sites/detect", {
      method: "POST",
      body: JSON.stringify({ url }),
    }),
  getSiteDisabledModels: (siteId: number) =>
    request(`/api/sites/${siteId}/disabled-models`),
  updateSiteDisabledModels: (siteId: number, models: string[]) =>
    request(`/api/sites/${siteId}/disabled-models`, {
      method: "PUT",
      body: JSON.stringify({ models }),
    }),
  getSiteAvailableModels: (siteId: number) =>
    request(`/api/sites/${siteId}/available-models`),
  probeSiteNow: (siteId: number, options?: { scope?: 'single' | 'all'; modelName?: string; latencyThresholdMs?: number }) =>
    request(`/api/sites/${siteId}/probe-now`, {
      method: 'POST',
      body: JSON.stringify(options || {}),
      timeoutMs: options?.scope === 'all' ? 120_000 : 30_000,
    }),

  // Accounts
  getAccounts: async (params?: { includeOauth?: boolean }) => {
    const result = await request<any>(`/api/accounts${buildQueryString(params)}`);
    return Array.isArray(result?.accounts) ? result.accounts : result;
  },
  getAccountsSnapshot: (options?: { refresh?: boolean }) =>
    request(
      `/api/accounts${buildQueryString(options?.refresh ? { refresh: 1 } : undefined)}`,
    ) as Promise<{
      generatedAt: string;
      accounts: any[];
      sites: any[];
    }>,
  addAccount: (data: any) =>
    request("/api/accounts", { method: "POST", body: JSON.stringify(data) }),
  loginAccount: (data: {
    siteId: number;
    username: string;
    password: string;
  }) =>
    request("/api/accounts/login", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  verifyToken: (data: {
    siteId: number;
    accessToken: string;
    platformUserId?: number;
    credentialMode?: "auto" | "session" | "apikey";
  }) =>
    request("/api/accounts/verify-token", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  rebindAccountSession: (
    id: number,
    data: {
      accessToken: string;
      platformUserId?: number;
      refreshToken?: string;
      tokenExpiresAt?: number;
    },
  ) =>
    request(`/api/accounts/${id}/rebind-session`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAccount: (id: number, data: any) =>
    request(`/api/accounts/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAccount: (id: number) =>
    request(`/api/accounts/${id}`, { method: "DELETE" }),
  batchUpdateAccounts: (data: any) =>
    request("/api/accounts/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  refreshBalance: (id: number) =>
    request(`/api/accounts/${id}/balance`, { method: "POST" }),
  getAccountModels: (id: number) => request(`/api/accounts/${id}/models`),
  addAccountAvailableModels: (accountId: number, models: string[]) =>
    request(`/api/accounts/${accountId}/models/manual`, {
      method: "POST",
      body: JSON.stringify({ models }),
    }),
  removeAccountManualModels: (accountId: number, models: string[]) =>
    request(`/api/accounts/${accountId}/models/manual`, {
      method: "DELETE",
      body: JSON.stringify({ models }),
    }),
  refreshAccountHealth: (data?: { accountId?: number; wait?: boolean }) =>
    request("/api/accounts/health/refresh", {
      method: "POST",
      body: JSON.stringify(data || {}),
      timeoutMs: data?.wait ? 150_000 : 30_000,
    }),

  // Account tokens
  getAccountTokens: (accountId?: number) =>
    request(`/api/account-tokens${accountId ? `?accountId=${accountId}` : ""}`),
  addAccountToken: (data: any) =>
    request("/api/account-tokens", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateAccountToken: (id: number, data: any) =>
    request(`/api/account-tokens/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteAccountToken: (id: number) =>
    request(`/api/account-tokens/${id}`, { method: "DELETE" }),
  batchUpdateAccountTokens: (data: any) =>
    request("/api/account-tokens/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getAccountTokenGroups: (accountId: number) =>
    request(`/api/account-tokens/groups/${accountId}`),
  setDefaultAccountToken: (id: number) =>
    request(`/api/account-tokens/${id}/default`, { method: "POST" }),
  getAccountTokenValue: (id: number) =>
    request(`/api/account-tokens/${id}/value`),
  syncAccountTokens: (accountId: number) =>
    request(`/api/account-tokens/sync/${accountId}`, {
      method: "POST",
      timeoutMs: 45_000,
    }),
  syncAllAccountTokens: (wait = false) =>
    request("/api/account-tokens/sync-all", {
      method: "POST",
      body: JSON.stringify(wait ? { wait: true } : {}),
      timeoutMs: wait ? 150_000 : 30_000,
    }),

  /**
   * Batch-syncs the keys of the given sites; sites without a key get one created.
   */
  syncSiteApiKeys: (ids: number[] = []) =>
    request("/api/account-tokens/sync-sites", {
      method: "POST",
      body: JSON.stringify({ ids }),
      timeoutMs: 300_000,
    }),

  // Check-in
  triggerCheckinAll: () => request("/api/checkin/trigger", { method: "POST" }),
  triggerCheckin: (id: number) =>
    request(`/api/checkin/trigger/${id}`, { method: "POST" }),
  getCheckinLogs: (params?: string) =>
    request(`/api/checkin/logs${params ? "?" + params : ""}`),
  updateCheckinSchedule: (cron: string) =>
    request("/api/checkin/schedule", {
      method: "PUT",
      body: JSON.stringify({ cron }),
    }),

  // Routes
  getRoutes: () => request("/api/routes"),
  getRoutesLite: () => request("/api/routes/lite"),
  getRoutesSummary: () => request("/api/routes/summary"),
  getRouteChannels: (routeId: number) =>
    request(`/api/routes/${routeId}/channels`),
  batchAddChannels: (
    routeId: number,
    channels: Array<{
      accountId: number;
      tokenId?: number;
      sourceModel?: string;
    }>,
  ) =>
    request(`/api/routes/${routeId}/channels/batch`, {
      method: "POST",
      body: JSON.stringify({ channels }),
    }),
  // 模型转发（对外模型名 → 站点/上游模型/多账号）
  getModelForwardRules: () => request("/api/model-forward-rules"),
  attachModelForwardTarget: (data: {
    siteId: number;
    upstreamModel: string;
    modelName: string;
    accountId?: number | null;
  }) =>
    request("/api/model-forward-attach", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getModelForwardOptions: (siteId?: number) =>
    request(`/api/model-forward-options${buildQueryString(siteId ? { siteId } : undefined)}`),
  createModelForwardRule: (data: any) =>
    request("/api/model-forward-rules", { method: "POST", body: JSON.stringify(data) }),
  updateModelForwardRule: (id: number, data: any) =>
    request(`/api/model-forward-rules/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  setModelForwardRuleEnabled: (id: number, enabled: boolean) =>
    request(`/api/model-forward-rules/${id}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  moveModelForwardTarget: (ruleId: number, targetId: number, action: "up" | "down" | "top") =>
    request(`/api/model-forward-rules/${ruleId}/targets/${targetId}/move`, {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  setModelForwardTargetEnabled: (ruleId: number, targetId: number, enabled: boolean) =>
    request(`/api/model-forward-rules/${ruleId}/targets/${targetId}/enabled`, {
      method: "POST",
      body: JSON.stringify({ enabled }),
    }),
  deleteModelForwardTarget: (ruleId: number, targetId: number) =>
    request(`/api/model-forward-rules/${ruleId}/targets/${targetId}`, { method: "DELETE" }),
  deleteModelForwardRule: (id: number) =>
    request(`/api/model-forward-rules/${id}`, { method: "DELETE" }),
  addRoute: (data: any) =>
    request("/api/routes", { method: "POST", body: JSON.stringify(data) }),
  updateRoute: (id: number, data: any) =>
    request(`/api/routes/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteRoute: (id: number) =>
    request(`/api/routes/${id}`, { method: "DELETE" }),
  clearRouteCooldown: (id: number) =>
    request(`/api/routes/${id}/cooldown/clear`, { method: "POST" }),
  batchUpdateRoutes: (data: { ids: number[]; action: "enable" | "disable" }) =>
    request("/api/routes/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  addChannel: (routeId: number, data: any) =>
    request(`/api/routes/${routeId}/channels`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateChannel: (id: number, data: any) =>
    request(`/api/channels/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  batchUpdateChannels: (updates: Array<{ id: number; priority: number }>) =>
    request("/api/channels/batch", {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),
  deleteChannel: (id: number) =>
    request(`/api/channels/${id}`, { method: "DELETE" }),
  rebuildRoutes: (refreshModels = true, wait = false) =>
    request("/api/routes/rebuild", {
      method: "POST",
      body: JSON.stringify({ refreshModels, ...(wait ? { wait: true } : {}) }),
      timeoutMs: wait ? 150_000 : 30_000,
    }),
  refreshRouteDecisionSnapshots: () =>
    request("/api/routes/decision/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  getRouteDecision: (model: string) =>
    request(`/api/routes/decision?model=${encodeURIComponent(model)}`),
  getRouteDecisionsBatch: (
    models: string[],
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/batch", {
      method: "POST",
      body: JSON.stringify({
        models,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),
  getRouteDecisionsByRouteBatch: (
    items: Array<{ routeId: number; model: string }>,
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/by-route/batch", {
      method: "POST",
      body: JSON.stringify({
        items,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),
  getRouteWideDecisionsBatch: (
    routeIds: number[],
    options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) =>
    request("/api/routes/decision/route-wide/batch", {
      method: "POST",
      body: JSON.stringify({
        routeIds,
        ...(options?.refreshPricingCatalog
          ? { refreshPricingCatalog: true }
          : {}),
        ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
      }),
    }),

  // Stats
  getDashboard: () => request("/api/stats/dashboard"),
  getDashboardSnapshot: (options?: { refresh?: boolean }) =>
    request(
      `/api/stats/dashboard${buildQueryString({
        view: "summary",
        ...(options?.refresh ? { refresh: 1 } : {}),
      })}`,
    ),
  getDashboardInsights: (options?: { refresh?: boolean }) =>
    request(
      `/api/stats/dashboard${buildQueryString({
        view: "insights",
        ...(options?.refresh ? { refresh: 1 } : {}),
      })}`,
    ),
  getProxyLogs: (params?: ProxyLogsQuery) =>
    request(
      `/api/stats/proxy-logs${buildQueryString(params)}`,
    ) as Promise<ProxyLogsResponse>,
  getProxyLogsQuery: (params?: ProxyLogsQuery) =>
    request(
      `/api/stats/proxy-logs${buildQueryString({
        ...params,
        view: "query",
      })}`,
    ) as Promise<{
      items: ProxyLogsResponse["items"];
      total: number;
      page: number;
      pageSize: number;
    }>,
  getProxyLogsMeta: (
    params?: Omit<ProxyLogsQuery, "limit" | "offset"> & {
      refresh?: number | boolean;
    },
  ) => {
    const refresh =
      params?.refresh === true
        ? 1
        : typeof params?.refresh === "number"
          ? params.refresh
          : undefined;
    const queryParams = {
      ...params,
      view: "meta",
      ...(refresh !== undefined ? { refresh } : {}),
    } as Record<string, string | number | boolean | null | undefined>;
    if (refresh === undefined) delete queryParams.refresh;
    return request(
      `/api/stats/proxy-logs${buildQueryString(queryParams)}`,
    ) as Promise<{
      clientOptions: ProxyLogsResponse["clientOptions"];
      summary: ProxyLogsResponse["summary"];
      sites: Array<{ id: number; name: string; status?: string | null }>;
    }>;
  },
  getProxyLogDetail: (id: number) =>
    request(`/api/stats/proxy-logs/${id}`) as Promise<ProxyLogDetail>,
  getProxyDebugTraces: (params?: { limit?: number }) =>
    request(
      `/api/stats/proxy-debug/traces${buildQueryString(params)}`,
    ) as Promise<ProxyDebugTracesResponse>,
  getProxyDebugTraceDetail: (id: number) =>
    request(
      `/api/stats/proxy-debug/traces/${id}`,
    ) as Promise<ProxyDebugTraceDetail>,
  checkModels: (accountId: number) =>
    request(`/api/models/check/${accountId}`, { method: "POST" }),
  getSiteDistribution: () => request("/api/stats/site-distribution"),
  getSiteTrend: (days = 7) => request(`/api/stats/site-trend?days=${days}`),
  getSiteSnapshot: async (days = 7, options?: { refresh?: boolean }) => {
    const query = buildQueryString({
      days,
      ...(options?.refresh ? { refresh: 1 } : {}),
    });
    const [distribution, trend, sites] = await Promise.all([
      request<{ distribution: any[] }>(`/api/stats/site-distribution${query}`),
      request<{ trend: any[] }>(`/api/stats/site-trend${query}`),
      request<any[]>("/api/sites"),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      distribution: Array.isArray(distribution?.distribution)
        ? distribution.distribution
        : [],
      trend: Array.isArray(trend?.trend) ? trend.trend : [],
      sites: Array.isArray(sites) ? sites : [],
    };
  },
  getModelBySite: (siteId?: number, days = 7) =>
    request(
      `/api/stats/model-by-site?${siteId ? `siteId=${siteId}&` : ""}days=${days}`,
    ),

  // Search
  search: (query: string) =>
    request("/api/search", {
      method: "POST",
      body: JSON.stringify({ query, limit: 20 }),
    }),

  // OAuth
  getOAuthProviders: () =>
    request("/api/oauth/providers") as Promise<OAuthProvidersResponse>,
  startOAuthProvider: (
    provider: string,
    data?: {
      accountId?: number;
      projectId?: string;
      proxyUrl?: string | null;
      useSystemProxy?: boolean;
    },
  ) =>
    request(`/api/oauth/providers/${encodeURIComponent(provider)}/start`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    }) as Promise<OAuthStartResponse>,
  getOAuthSession: (state: string) =>
    request(
      `/api/oauth/sessions/${encodeURIComponent(state)}`,
    ) as Promise<OAuthSessionInfo>,
  submitOAuthManualCallback: (state: string, callbackUrl: string) =>
    request(
      `/api/oauth/sessions/${encodeURIComponent(state)}/manual-callback`,
      {
        method: "POST",
        body: JSON.stringify({ callbackUrl }),
      },
    ) as Promise<{ success: true }>,
  getOAuthConnections: (params?: { limit?: number; offset?: number }) =>
    request(
      `/api/oauth/connections${buildQueryString(params)}`,
    ) as Promise<OAuthConnectionsResponse>,
  refreshOAuthConnectionQuota: (accountId: number) =>
    request(`/api/oauth/connections/${accountId}/quota/refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    }) as Promise<{ success: true; quota: OAuthQuotaInfo }>,
  refreshOAuthConnectionQuotaBatch: (accountIds: number[]) =>
    request("/api/oauth/connections/quota/refresh-batch", {
      method: "POST",
      body: JSON.stringify({ accountIds }),
    }) as Promise<OAuthQuotaBatchRefreshResponse>,
  updateOAuthConnectionProxy: (
    accountId: number,
    data: { proxyUrl?: string | null; useSystemProxy?: boolean },
  ) =>
    request(`/api/oauth/connections/${accountId}/proxy`, {
      method: "PATCH",
      body: JSON.stringify(data || {}),
    }) as Promise<{ success: true }>,
  rebindOAuthConnection: (
    accountId: number,
    data?: { proxyUrl?: string | null; useSystemProxy?: boolean },
  ) =>
    request(`/api/oauth/connections/${accountId}/rebind`, {
      method: "POST",
      body: JSON.stringify(data || {}),
    }) as Promise<OAuthStartResponse>,
  deleteOAuthConnection: (accountId: number) =>
    request(`/api/oauth/connections/${accountId}`, {
      method: "DELETE",
    }) as Promise<{ success: true }>,
  importOAuthConnections: (data: Record<string, unknown>) =>
    request("/api/oauth/import", {
      method: "POST",
      body: JSON.stringify(Array.isArray(data.items) ? data : { data }),
    }) as Promise<OAuthImportResponse>,
  createOAuthRouteUnit: (data: {
    accountIds: number[];
    name: string;
    strategy: OAuthRouteUnitStrategy;
  }) =>
    request("/api/oauth/route-units", {
      method: "POST",
      body: JSON.stringify(data),
    }) as Promise<OAuthRouteUnitMutationResponse>,
  deleteOAuthRouteUnit: (routeUnitId: number) =>
    request(`/api/oauth/route-units/${routeUnitId}`, {
      method: "DELETE",
    }) as Promise<{ success: true }>,

  // Events
  getEvents: (params?: string) =>
    request(`/api/events${params ? "?" + params : ""}`),
  getEventCount: () => request("/api/events/count"),
  markEventRead: (id: number) =>
    request(`/api/events/${id}/read`, { method: "POST" }),
  markAllEventsRead: () => request("/api/events/read-all", { method: "POST" }),
  clearEvents: () => request("/api/events", { method: "DELETE" }),
  getSiteAnnouncements: (params?: string) =>
    request(`/api/site-announcements${params ? "?" + params : ""}`),
  markSiteAnnouncementRead: (id: number) =>
    request(`/api/site-announcements/${id}/read`, { method: "POST" }),
  markAllSiteAnnouncementsRead: () =>
    request("/api/site-announcements/read-all", { method: "POST" }),
  clearSiteAnnouncements: () =>
    request("/api/site-announcements", { method: "DELETE" }),
  syncSiteAnnouncements: (payload?: { siteId?: number }) =>
    request("/api/site-announcements/sync", {
      method: "POST",
      body: JSON.stringify(payload || {}),
    }),
  getTasks: (limit = 50) =>
    request(
      `/api/tasks?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`,
    ),
  getTask: (id: string) => request(`/api/tasks/${encodeURIComponent(id)}`),

  // Auth management
  getAuthInfo: () => request("/api/settings/auth/info"),
  changeAuthToken: (oldToken: string, newToken: string) =>
    request("/api/settings/auth/change", {
      method: "POST",
      body: JSON.stringify({ oldToken, newToken }),
    }),
  getRuntimeSettings: () => request("/api/settings/runtime"),
  getBrandList: () => request("/api/settings/brand-list"),
  updateRuntimeSettings: (data: RuntimeSettingsPayload) =>
    request("/api/settings/runtime", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  getUpdateCenterStatus: () => request("/api/update-center/status"),
  saveUpdateCenterConfig: (data: any) =>
    request("/api/update-center/config", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  checkUpdateCenter: () =>
    request("/api/update-center/check", {
      method: "POST",
      body: JSON.stringify({}),
    }),
  deployUpdateCenter: (data: {
    source: "github-release" | "docker-hub-tag";
    targetTag: string;
    targetDigest?: string | null;
  }) =>
    request("/api/update-center/deploy", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  rollbackUpdateCenter: (data: { targetRevision: string }) =>
    request("/api/update-center/rollback", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  streamUpdateCenterTaskLogs: (
    taskId: string,
    handlers: {
      onLog?: (entry: any) => void;
      onDone?: (payload: any) => void;
      signal?: AbortSignal;
    },
  ) =>
    streamSse(
      `/api/update-center/tasks/${encodeURIComponent(taskId)}/stream`,
      handlers,
    ),
  testSystemProxy: (data: SystemProxyTestRequest) =>
    request("/api/settings/system-proxy/test", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 20_000,
    }),
  getRuntimeDatabaseConfig: () => request("/api/settings/database/runtime"),
  updateRuntimeDatabaseConfig: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/runtime", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  testExternalDatabaseConnection: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/test-connection", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  migrateExternalDatabase: (data: {
    dialect: "sqlite" | "mysql" | "postgres";
    connectionString: string;
    overwrite?: boolean;
    ssl?: boolean;
  }) =>
    request("/api/settings/database/migrate", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }),
  getDownstreamApiKeys: () => request("/api/downstream-keys"),
  createDownstreamApiKey: (data: any) =>
    request("/api/downstream-keys", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateDownstreamApiKey: (id: number, data: any) =>
    request(`/api/downstream-keys/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteDownstreamApiKey: (id: number) =>
    request(`/api/downstream-keys/${id}`, {
      method: "DELETE",
    }),
  batchDownstreamApiKeys: (data: {
    ids: number[];
    action: "enable" | "disable" | "delete" | "resetUsage" | "updateMetadata";
    groupOperation?: "keep" | "set" | "clear";
    groupName?: string;
    tagOperation?: "keep" | "append";
    tags?: string[];
  }) =>
    request("/api/downstream-keys/batch", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  resetDownstreamApiKeyUsage: (id: number) =>
    request(`/api/downstream-keys/${id}/reset-usage`, {
      method: "POST",
    }),
  getDownstreamApiKeysSummary: (params?: {
    range?: "24h" | "7d" | "all";
    status?: "all" | "enabled" | "disabled";
    search?: string;
  }) => request(`/api/downstream-keys/summary${buildQueryString(params)}`),
  getDownstreamApiKeyOverview: (id: number) =>
    request(`/api/downstream-keys/${id}/overview`),
  getDownstreamApiKeyTrend: (
    id: number,
    params?: { range?: "24h" | "7d" | "all"; timeZone?: string },
  ) =>
    request<DownstreamApiKeyTrendResponse>(
      `/api/downstream-keys/${id}/trend${buildQueryString(params)}`,
    ),
  exportBackup: (type: "all" | "accounts" | "preferences" = "all") =>
    request(`/api/settings/backup/export?type=${encodeURIComponent(type)}`),
  importBackup: (data: any) =>
    request("/api/settings/backup/import", {
      method: "POST",
      body: JSON.stringify({ data }),
    }),
  getBackupWebdavConfig: () => request("/api/settings/backup/webdav"),
  saveBackupWebdavConfig: (data: {
    enabled: boolean;
    fileUrl: string;
    username: string;
    password?: string;
    clearPassword?: boolean;
    exportType: "all" | "accounts" | "preferences";
    autoSyncEnabled: boolean;
    autoSyncCron: string;
  }) =>
    request("/api/settings/backup/webdav", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  exportBackupToWebdav: (type?: "all" | "accounts" | "preferences") =>
    request("/api/settings/backup/webdav/export", {
      method: "POST",
      body: JSON.stringify(type ? { type } : {}),
      timeoutMs: 60_000,
    }),
  importBackupFromWebdav: () =>
    request("/api/settings/backup/webdav/import", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 60_000,
    }),
  clearRuntimeCache: () =>
    request("/api/settings/maintenance/clear-cache", { method: "POST" }),
  clearUsageData: () =>
    request("/api/settings/maintenance/clear-usage", { method: "POST" }),
  factoryReset: () =>
    request("/api/settings/maintenance/factory-reset", { method: "POST" }),
  testNotification: () =>
    request("/api/settings/notify/test", { method: "POST" }),

  // 模型监控：上游 /api/perf-metrics/summary 的采集结果（只保留最新一轮）
  getModelMonitorOverview: (params?: {
    siteId?: number | null;
    model?: string | null;
    minSuccessRate?: number | null;
    sort?: string | null;
    family?: string | null;
  }) => {
    const query = new URLSearchParams();
    if (params?.siteId) query.set("siteId", String(params.siteId));
    if (params?.model) query.set("model", params.model);
    if (params?.minSuccessRate != null) {
      query.set("minSuccessRate", String(params.minSuccessRate));
    }
    if (params?.sort) query.set("sort", params.sort);
    if (params?.family) query.set("family", params.family);
    const suffix = query.toString();
    return request(`/api/model-monitor/overview${suffix ? `?${suffix}` : ""}`, {
      timeoutMs: 60_000,
    });
  },
  refreshModelMonitor: () =>
    request("/api/model-monitor/refresh", { method: "POST" }),
  getModelMonitorChatChannels: (siteId: number, model: string) =>
    request<{
      success: boolean;
      channels: any[];
      credentials?: Array<{
        accountId: number;
        tokenId: number | null;
        accountName: string;
        tokenName: string | null;
        label: string;
        credential: 'account' | 'api_token';
      }>;
      requestedModel?: string;
      direct?: boolean;
    }>(
      `/api/model-monitor/chat-channels?siteId=${encodeURIComponent(String(siteId))}&model=${encodeURIComponent(model)}`,
      { timeoutMs: 30_000 },
    ),

  // 提示词管理：题库（suite）+ 题目（case），题目可带标准答案或评分要点
  getPromptSuites: () =>
    request<{ success: boolean; suites: any[] }>("/api/prompt-suites", {
      timeoutMs: 30_000,
    }),
  getPromptSuiteCases: (suiteId: number) =>
    request<{ success: boolean; cases: any[] }>(
      `/api/prompt-suites/${suiteId}/cases`,
      { timeoutMs: 30_000 },
    ),
  createPromptSuite: (payload: Record<string, unknown>) =>
    request("/api/prompt-suites", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    }),
  updatePromptSuite: (suiteId: number, payload: Record<string, unknown>) =>
    request(`/api/prompt-suites/${suiteId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    }),
  deletePromptSuite: (suiteId: number) =>
    request(`/api/prompt-suites/${suiteId}`, {
      method: "DELETE",
      timeoutMs: 30_000,
    }),
  createPromptCase: (payload: Record<string, unknown>) =>
    request("/api/prompt-cases", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    }),
  updatePromptCase: (caseId: number, payload: Record<string, unknown>) =>
    request(`/api/prompt-cases/${caseId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    }),
  deletePromptCase: (caseId: number) =>
    request(`/api/prompt-cases/${caseId}`, {
      method: "DELETE",
      timeoutMs: 30_000,
    }),
  // 对话弹窗的快捷提示词：一次拿全部启用题目（带题库名）
  getPromptCases: () =>
    request<{ success: boolean; cases: any[] }>("/api/prompt-cases", {
      timeoutMs: 30_000,
    }),
  // 简化版提示词管理：平铺列表，只有题目名称 / 描述 / 答案
  getSimplePromptCases: () =>
    request<{ success: boolean; cases: any[] }>("/api/prompt-library/cases", {
      timeoutMs: 30_000,
    }),
  createSimplePromptCase: (payload: Record<string, unknown>) =>
    request("/api/prompt-library/cases", {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    }),
  updateSimplePromptCase: (caseId: number, payload: Record<string, unknown>) =>
    request(`/api/prompt-library/cases/${caseId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
      timeoutMs: 30_000,
    }),
  getPromptPresets: () =>
    request<{ success: boolean; presets: any[] }>("/api/prompt-presets", {
      timeoutMs: 30_000,
    }),
  importPromptPreset: (slug: string) =>
    request(`/api/prompt-presets/${encodeURIComponent(slug)}/import`, {
      method: "POST",
      timeoutMs: 30_000,
    }),

  // Assisted login (managed browser session reused for community-site sign-in)
  getAssistedLoginProviders: () =>
    request("/api/assisted-login/providers", { timeoutMs: 30_000 }),
  getAssistedLoginStatus: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/status`, {
      timeoutMs: 60_000,
    }),
  openAssistedLoginWindow: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/login-window`, {
      method: "POST",
      timeoutMs: 60_000,
    }),
  checkAssistedLoginSession: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/check-session`, {
      method: "POST",
      timeoutMs: 90_000,
    }),
  // Imported provider session (browser-free path: paste a DevTools cookie header).
  getAssistedLoginSession: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/session`, {
      timeoutMs: 60_000,
    }),
  saveAssistedLoginSession: (provider: string, raw: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/session`, {
      method: "POST",
      body: JSON.stringify({ raw }),
      timeoutMs: 60_000,
    }),
  clearAssistedLoginSession: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/session`, {
      method: "DELETE",
      timeoutMs: 30_000,
    }),
  captureAssistedLoginCredentials: (
    provider: string,
    data: {
      siteId: number;
      bindAccount?: boolean;
      credentialMode?: "auto" | "session" | "apikey";
      skipModelFetch?: boolean;
      username?: string;
    },
  ) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/capture`, {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: 180_000,
    }),

  // Remote-browser login. The server's managed browser is exposed as pollable
  // JPEG frames plus an input channel, which is what lets a phone complete a
  // provider login without copying cookies out of another machine.
  startAssistedLoginLive: (provider: string, url?: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/live/start`, {
      method: "POST",
      body: JSON.stringify(url ? { url } : {}),
      timeoutMs: 120_000,
    }),
  getAssistedLoginLiveStatus: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/live/status`, {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 30_000,
    }),
  sendAssistedLoginLiveInput: (provider: string, input: Record<string, unknown>) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/live/input`, {
      method: "POST",
      body: JSON.stringify(input),
      timeoutMs: 30_000,
    }),
  finishAssistedLoginLive: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/live/finish`, {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 120_000,
    }),
  stopAssistedLoginLive: (provider: string) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/live/stop`, {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 30_000,
    }),
  // Returns null when no remote window is open, so callers can distinguish
  // "not started yet" from a real transport failure.
  fetchAssistedLoginLiveFrame: async (provider: string): Promise<Blob | null> => {
    const res = await fetchAuthenticatedResponse(
      `/api/assisted-login/${encodeURIComponent(provider)}/live/frame`,
      { method: "GET", timeoutMs: 30_000 },
    );
    if (res.status === 409) return null;
    if (!res.ok) throw new Error(await extractResponseErrorMessage(res));
    return res.blob();
  },

  // Re-run the assisted-login handoff for an account whose credential expired.
  refreshAssistedLoginAccount: (provider: string, accountId: number) =>
    request(`/api/assisted-login/${encodeURIComponent(provider)}/refresh-account`, {
      method: "POST",
      body: JSON.stringify({ accountId }),
      timeoutMs: 180_000,
    }),

  // GitHub password-based keep-alive. The server stores the credentials
  // encrypted and replays them in its managed browser whenever the GitHub
  // session is found signed out, which is what keeps GitHub-bound sites
  // (e.g. 澎湃AI网关) able to auto-relogin.
  getGitHubAutoLogin: () =>
    request("/api/assisted-login/github/auto-login", { timeoutMs: 30_000 }),
  saveGitHubAutoLogin: (username: string, password: string) =>
    request("/api/assisted-login/github/auto-login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
      timeoutMs: 30_000,
    }),
  clearGitHubAutoLogin: () =>
    request("/api/assisted-login/github/auto-login", {
      method: "DELETE",
      timeoutMs: 30_000,
    }),
  runGitHubAutoLogin: () =>
    request("/api/assisted-login/github/auto-login/run", {
      method: "POST",
      body: JSON.stringify({}),
      timeoutMs: 180_000,
    }),

  // Models marketplace
  getModelsMarketplace: (options?: {
    refresh?: boolean;
    includePricing?: boolean;
  }) => {
    const params = new URLSearchParams();
    if (options?.refresh) params.set("refresh", "1");
    if (options?.includePricing) params.set("includePricing", "1");
    const query = params.toString();
    return request(`/api/models/marketplace${query ? `?${query}` : ""}`, {
      timeoutMs: options?.refresh ? 45_000 : 15_000,
    });
  },
  getModelTokenCandidates: () => request("/api/models/token-candidates"),

  // Simple chat test from admin panel
  startTestChatJob: (data: TestChatRequestPayload) =>
    request("/api/test/chat/jobs", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getTestChatJob: (jobId: string) =>
    request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`),
  deleteTestChatJob: (jobId: string) =>
    request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  startProxyTestJob: (data: ProxyTestRequestEnvelope) =>
    request("/api/test/proxy/jobs", {
      method: "POST",
      body: JSON.stringify(data),
      timeoutMs: resolveProxyTestTimeoutMs(data),
    }),
  getProxyTestJob: (jobId: string) =>
    request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`),
  deleteProxyTestJob: (jobId: string) =>
    request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
    }),
  getProxyFileContentDataUrl: async (
    fileId: string,
    options: Pick<RequestOptions, "signal" | "timeoutMs"> = {},
  ) => {
    const response = await fetchAuthenticatedResponse(
      `/v1/files/${encodeURIComponent(fileId)}/content`,
      {
        method: "GET",
        ...options,
      },
    );
    if (!response.ok) {
      throw new Error(await extractResponseErrorMessage(response));
    }

    const mimeType =
      (response.headers.get("content-type") || "application/octet-stream")
        .split(";")[0]
        .trim() || "application/octet-stream";
    const filename = parseContentDispositionFilename(
      response.headers.get("content-disposition"),
    );
    const base64 = arrayBufferToBase64(await response.arrayBuffer());
    return {
      filename,
      mimeType,
      data: `data:${mimeType};base64,${base64}`,
    };
  },
  testProxy: proxyTestRequest,
  proxyTest: proxyTestRequest,
  testChat: (data: TestChatRequestPayload) =>
    request("/api/test/chat", { method: "POST", body: JSON.stringify(data) }),
  directChatStream: directChatStreamRequest,
  testProxyStream: proxyTestStreamRequest,
  proxyTestStream: proxyTestStreamRequest,
  testChatStream: async (
    data: TestChatRequestPayload,
    signal?: AbortSignal,
  ) => {
    const token = getAuthToken(localStorage);
    if (!token) {
      clearAuthSession(localStorage);
      throw new Error("Session expired");
    }
    return fetch("/api/test/chat/stream", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  },
};
