/**
 * Builds `ccswitch://` deep links so a downstream key can be imported into
 * CC Switch (https://github.com/farion1231/cc-switch) with one click.
 *
 * CC Switch's v1 provider protocol is
 * `ccswitch://v1/import?resource=provider&app=...&name=...&endpoint=...&apiKey=...&homepage=...`
 * and it turns the endpoint into the client's own base-URL variable:
 *   - `claude` → `ANTHROPIC_BASE_URL` (Claude Code appends `/v1/messages`)
 *   - `codex`  → `base_url` in `config.toml` (Codex appends `/responses`)
 *   - `gemini` → `GOOGLE_GEMINI_BASE_URL` (Gemini CLI appends `/v1beta/...`)
 * Metapi serves those paths at the domain root, so the only app that needs a
 * path suffix is Codex.
 */

export type CcSwitchApp = 'claude' | 'codex' | 'gemini';

export type CcSwitchAppOption = {
  value: CcSwitchApp;
  label: string;
  description: string;
};

export const CC_SWITCH_APP_OPTIONS: CcSwitchAppOption[] = [
  {
    value: 'claude',
    label: 'Claude Code',
    description: '写入 ANTHROPIC_BASE_URL，走 /v1/messages',
  },
  {
    value: 'codex',
    label: 'Codex CLI',
    description: '写入 config.toml 的 base_url（自动补 /v1），走 /v1/responses',
  },
  {
    value: 'gemini',
    label: 'Gemini CLI',
    description: '写入 GOOGLE_GEMINI_BASE_URL，走 /v1beta/models',
  },
];

/** Trims the value and drops trailing slashes so the link never carries `//`. */
export function normalizeGatewayBaseUrl(raw: string | null | undefined): string {
  return String(raw ?? '').trim().replace(/\/+$/, '');
}

/**
 * The value CC Switch stores for the chosen client. Codex is the only app that
 * wants the OpenAI-style `/v1` suffix baked into the stored base URL.
 */
export function resolveCcSwitchEndpoint(app: CcSwitchApp, baseUrl: string): string {
  const base = normalizeGatewayBaseUrl(baseUrl);
  if (!base) return '';
  return app === 'codex' ? `${base}/v1` : base;
}

/**
 * Builds the base URL from the page origin, tolerating SSR/tests where
 * `window` is absent.
 */
export function resolveDefaultGatewayBaseUrl(origin?: string | null): string {
  const candidate = origin ?? (typeof window !== 'undefined' ? window.location?.origin : '');
  return normalizeGatewayBaseUrl(candidate);
}

export type CcSwitchDeepLinkInput = {
  app: CcSwitchApp;
  name: string;
  baseUrl: string;
  apiKey: string;
  model?: string | null;
  /** Import as the active provider for that app. */
  enabled?: boolean;
};

/**
 * Builds the `ccswitch://` import URL.
 *
 * Returns an empty string when a mandatory field is missing, so callers can
 * disable the action instead of handing CC Switch a link it will reject.
 */
export function buildCcSwitchDeepLink(input: CcSwitchDeepLinkInput): string {
  const name = String(input.name ?? '').trim();
  const apiKey = String(input.apiKey ?? '').trim();
  const baseUrl = normalizeGatewayBaseUrl(input.baseUrl);
  const endpoint = resolveCcSwitchEndpoint(input.app, baseUrl);

  if (!name || !apiKey || !endpoint) return '';

  const params = new URLSearchParams();
  params.set('resource', 'provider');
  params.set('app', input.app);
  params.set('name', name);
  params.set('endpoint', endpoint);
  params.set('apiKey', apiKey);
  params.set('homepage', baseUrl);
  params.set('enabled', input.enabled ? 'true' : 'false');

  const model = String(input.model ?? '').trim();
  if (model) params.set('model', model);

  // `URLSearchParams` encodes spaces as `+`; CC Switch parses the query with the
  // `url` crate, which also accepts `+`, but `%20` is the safer wire form.
  return `ccswitch://v1/import?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * Manual fallback for when CC Switch is not installed: the same values the deep
 * link would have written, as plain text the user can paste into the client.
 */
export function buildManualConfigSnippet(input: CcSwitchDeepLinkInput): string {
  const endpoint = resolveCcSwitchEndpoint(input.app, input.baseUrl);
  const apiKey = String(input.apiKey ?? '').trim();
  const model = String(input.model ?? '').trim();

  if (input.app === 'codex') {
    const modelLine = model ? `model = "${model}"` : 'model = "<模型名>"';
    return [
      modelLine,
      'model_provider = "metapi"',
      '',
      '[model_providers.metapi]',
      'name = "Metapi"',
      `base_url = "${endpoint}"`,
      'wire_api = "responses"',
      'env_key = "OPENAI_API_KEY"',
      '',
      '# 再把下游密钥写进环境变量：',
      `export OPENAI_API_KEY="${apiKey}"`,
    ].join('\n');
  }

  if (input.app === 'gemini') {
    return [
      `export GOOGLE_GEMINI_BASE_URL="${endpoint}"`,
      `export GEMINI_API_KEY="${apiKey}"`,
      ...(model ? [`export GEMINI_MODEL="${model}"`] : []),
    ].join('\n');
  }

  return [
    `export ANTHROPIC_BASE_URL="${endpoint}"`,
    `export ANTHROPIC_AUTH_TOKEN="${apiKey}"`,
    `export ANTHROPIC_API_KEY="${apiKey}"`,
    ...(model ? [`export ANTHROPIC_MODEL="${model}"`] : []),
  ].join('\n');
}
