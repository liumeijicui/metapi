/**
 * Per-site quirks discovered by hand, expressed as code.
 *
 * Some registries cannot be reached or cannot be logged into without special
 * handling, and re-deriving that from scratch every time is expensive: the
 * "why is this site stuck" investigation takes minutes of browser probing. When
 * a quirk is confirmed, record it here so the runtime applies it automatically.
 *
 * This is a declaration of *site* behaviour, not user configuration. Anything a
 * user is expected to toggle belongs in the sites table instead; the entries
 * below are facts about the site that the user cannot reasonably know.
 */

/**
 * Hosts that are unreachable from this network unless the request goes through
 * the configured system proxy (the local Clash instance during development).
 *
 * Confirmed by direct connect failing while the proxied request succeeds, and
 * by the assisted-login capture flipping from needs_provider_login/timeout to a
 * successful bind once the proxy applies.
 */
export const SITES_REQUIRING_SYSTEM_PROXY: readonly string[] = [
  'happycoding.xyz',
  'anyrouter.top',
  'welfare.darkforger.com',
  'sub2api.remixjc.cn',
  // Its edge throttles direct requests by source IP after a short burst;
  // the proxy exit keeps daily balance and check-in calls stable.
  'kunyou.asia',
  'cloudcode-pa.googleapis.com',
  // The site answers direct requests, but its Turnstile challenge loads from
  // brunhild.challenges.cloudflare.com, which does not resolve on this network.
  // The browser check-in therefore needs the proxy for the challenge script.
  'chinahk.qzz.io',
  // Direct connections return empty responses for everything except the
  // status endpoint (even the sign-in page transfers zero bytes), while the
  // proxy receives the normal pages and API replies.
  'motomoto.lol',
  // Direct connections time out for every route; the proxy reaches the site,
  // and its OAuth provider (connect.linux.do) needs the proxy as well.
  'agentrouter.org',
  // github.com resolves to addresses this network cannot open from Node (curl
  // reaches it, undici's fetch times out), which silently broke every GitHub
  // OAuth replay that runs over plain HTTP — the authorize hop never answered.
  'github.com',
];

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\./, '');
}

/**
 * True when the host (or one of its subdomains) is known to require the system
 * proxy. Subdomain matching keeps `api.example.com` covered by an entry for
 * `example.com`, which is how these registries are usually deployed.
 */
export function siteRequiresSystemProxy(host: string | null | undefined): boolean {
  const normalized = normalizeHost(String(host || ''));
  if (!normalized) return false;
  return SITES_REQUIRING_SYSTEM_PROXY.some(
    (candidate) => normalized === candidate || normalized.endsWith(`.${candidate}`),
  );
}

/** Convenience wrapper that accepts a full URL and tolerates malformed input. */
export function siteUrlRequiresSystemProxy(rawUrl: string | null | undefined): boolean {
  try {
    return siteRequiresSystemProxy(new URL(String(rawUrl || '')).host);
  } catch {
    return false;
  }
}

/**
 * Inference-endpoint client fingerprint requirement.
 *
 * agentrouter.org gates its **inference** API (`/v1/models`, `/v1/chat/completions`,
 * `/v1/messages`) by client identity: anything that does not look like its accepted
 * Claude Code CLI gets `401 unauthorized client detected`, no matter how valid the key
 * is. Its **console** API (`/api/status`, `/api/log/self`, `/api/user/self`) does not
 * care, which is why check-in and login work while chat does not.
 *
 * Measured against the live site (proxied, same key):
 *   - no User-Agent / browser UA / `Claude-Code/1.0.0` -> 401
 *   - `claude-cli/2.0.0` .. `claude-cli/2.1.50`        -> 200
 *   - `claude-cli/2.1.63` (the newest we knew of)      -> 403
 * So the accepted set is a version window, not a single exact string; pick one in the
 * middle and let the site's own custom headers override it if it ever drifts again.
 */
const SITE_INFERENCE_USER_AGENTS: ReadonlyArray<{ host: string; userAgent: string }> = [
  { host: 'agentrouter.org', userAgent: 'claude-cli/2.0.30 (external, cli)' },
];

/**
 * The User-Agent an inference request must carry, or null when the site does not
 * fingerprint clients.
 *
 * `requireInferencePath` 默认开启，只有 `/v1/*` 才算推理接口 —— 控制台接口
 * （`/api/status`、`/api/log/self`、`/api/user/self`）本来就不卡指纹，签到和登录
 * 必须保持原样。调用方如果拿到的只是站点根地址（例如上游请求构造器只知道
 * `site.url`，路径是后面才拼的），可以传 `requireInferencePath: false`：那个调用点
 * 本身就只用来发推理请求。
 */
export function resolveSiteInferenceUserAgent(
  rawUrl: string | null | undefined,
  options?: { requireInferencePath?: boolean },
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
  if (options?.requireInferencePath !== false && !parsed.pathname.startsWith('/v1/')) return null;
  const host = normalizeHost(parsed.host);
  const match = SITE_INFERENCE_USER_AGENTS.find(
    (entry) => host === entry.host || host.endsWith(`.${entry.host}`),
  );
  return match ? match.userAgent : null;
}

/**
 * Custom (freeform) tools a site's own Responses endpoint accepts.
 *
 * These registries run their own Codex-compatible endpoint and validate the tool
 * list themselves. agentrouter answers
 * `400 Unsupported custom tool: 'exec'. Only 'apply_patch' is supported.`
 * to anything but `apply_patch`, while the same payload sent to
 * `/v1/chat/completions` (where we declare the custom tools as functions) works.
 * Codex always sends `exec` next to `apply_patch`, so its native endpoint is
 * unusable for Codex clients and the chat endpoint has to be tried first.
 */
const SITE_RESPONSES_CUSTOM_TOOL_ALLOWLISTS: ReadonlyArray<{ host: string; allowed: readonly string[] }> = [
  { host: 'agentrouter.org', allowed: ['apply_patch'] },
];

/**
 * The custom tool names a site's Responses endpoint accepts, or null when the
 * site does not restrict them (every custom tool may be sent as-is).
 */
export function resolveResponsesCustomToolAllowlist(
  rawUrl: string | null | undefined,
): readonly string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return null;
  }
  const host = normalizeHost(parsed.host);
  const match = SITE_RESPONSES_CUSTOM_TOOL_ALLOWLISTS.find(
    (entry) => host === entry.host || host.endsWith(`.${entry.host}`),
  );
  return match ? match.allowed : null;
}

/**
 * The declared custom tools this site's Responses endpoint would reject, in the
 * order they were declared. Empty when the site has no restriction (or accepts
 * everything that was declared).
 */
export function resolveUnsupportedResponsesCustomToolNames(
  rawUrl: string | null | undefined,
  customToolNames: readonly string[],
): string[] {
  if (customToolNames.length === 0) return [];
  const allowed = resolveResponsesCustomToolAllowlist(rawUrl);
  if (!allowed) return [];

  const unsupported: string[] = [];
  for (const rawName of customToolNames) {
    const name = String(rawName || '').trim();
    if (!name || allowed.includes(name) || unsupported.includes(name)) continue;
    unsupported.push(name);
  }
  return unsupported;
}

/**
 * Additional `anthropic-beta` flags a site's `/v1/messages` endpoint requires.
 *
 * anyrouter 的 claude 模型只挂在 `/v1/messages` 上（`/v1/chat/completions` 一律
 * 回 404「当前 API 不支持所选模型」）。它把 1M 上下文全量放开之后，**不打这个
 * opt-in beta 的 claude 请求会被直接拒绝**，回的还是跟真实原因无关的一句
 * `400 {"error":"1m 上下文已经全量可用，请启用 1m 上下文后重试"}` —— 看着像模型不
 * 可用，其实只是少了一个头。加了这个头之后，才是上游自己的真实结论（503 / 429）。
 *
 * 实测（走系统代理，同一个 key）：
 *   - 不带 beta，`claude-sonnet-4-5-20250929` -> 400「请启用 1m 上下文后重试」
 *   - 带 `context-1m-2025-08-07`，同一模型 -> opt-in 那道 400 消失，只剩上游供应
 *     问题（当天 503）
 *   - `claude-haiku-4-5-20251001` 带不带都是 200
 * 所以这是「站点 messages 端点」的属性，不是某个模型的属性，按 host 声明。
 */
const SITE_ANTHROPIC_BETA_HEADERS: ReadonlyArray<{ host: string; betas: readonly string[] }> = [
  { host: 'anyrouter.top', betas: ['context-1m-2025-08-07'] },
];

/**
 * 站点 messages 端点额外要求的 `anthropic-beta` 值，没有就返回空数组。
 *
 * 调用方应把它**并进**已有的 anthropic-beta，而不是覆盖：站点或下游显式声明的
 * beta 不能被这个补丁弄丢。
 */
export function resolveSiteAnthropicBetaHeaders(rawUrl: string | null | undefined): string[] {
  let parsed: URL;
  try {
    parsed = new URL(String(rawUrl || ''));
  } catch {
    return [];
  }
  const host = normalizeHost(parsed.host);
  const match = SITE_ANTHROPIC_BETA_HEADERS.find(
    (entry) => host === entry.host || host.endsWith(`.${entry.host}`),
  );
  return match ? [...match.betas] : [];
}

/**
 * Force the site's required inference fingerprint onto a header bag.
 *
 * 下游客户端自带的 UA（Codex 的 `codex_cli_rs/...`）不算“人工指定过”：站点要的
 * 正是这个头，透传过去只会换回 `401 unauthorized client detected`。只有站点/账号
 * 上配置过的 UA 才算显式指定，由调用方通过 `configuredUserAgent` 提前声明。
 */
export function applySiteInferenceUserAgent(
  headers: Record<string, string>,
  rawUrl: string | null | undefined,
  options?: { requireInferencePath?: boolean; configuredUserAgent?: boolean },
): void {
  if (options?.configuredUserAgent) return;
  const required = resolveSiteInferenceUserAgent(rawUrl, options);
  if (!required) return;
  for (const key of Object.keys(headers)) {
    if (key.trim().toLowerCase() === 'user-agent') delete headers[key];
  }
  headers['User-Agent'] = required;
}

/** True when the request already carries a User-Agent we must not overwrite. */
export function hasExplicitUserAgent(headers: unknown): boolean {
  if (!headers || typeof headers !== 'object') return false;
  // undici 的 Headers 实例；按鸭子类型判断，避免在非 DOM 环境里引用全局类型。
  const maybeHeaders = headers as { has?: (name: string) => boolean; keys?: () => Iterable<string> };
  if (typeof maybeHeaders.has === 'function' && typeof maybeHeaders.keys === 'function') {
    return maybeHeaders.has('user-agent');
  }
  return Object.keys(headers as Record<string, unknown>).some(
    (key) => key.trim().toLowerCase() === 'user-agent',
  );
}
