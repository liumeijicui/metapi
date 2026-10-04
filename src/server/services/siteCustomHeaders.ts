import { Headers, type HeadersInit } from 'undici';

export type SiteCustomHeadersRecord = Record<string, string>;
export type SiteCustomHeadersMergePriority = 'request' | 'site';

export type SiteCustomHeadersMergeOptions = {
  priority?: SiteCustomHeadersMergePriority;
};

export type ParsedSiteCustomHeadersInput = {
  present: boolean;
  valid: boolean;
  customHeaders: string | null;
  headers: SiteCustomHeadersRecord | null;
  error?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeSiteCustomHeadersRecord(input: Record<string, unknown>): SiteCustomHeadersRecord | null {
  const normalized = new Headers();

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) {
      throw new Error('Header name cannot be empty.');
    }
    if (typeof rawValue !== 'string') {
      throw new Error(`Header "${key}" must use a string value.`);
    }
    normalized.set(key, rawValue);
  }

  const entries = Array.from(normalized.entries()).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return null;
  }

  return Object.fromEntries(entries);
}

export function parseSiteCustomHeadersInput(input: unknown): ParsedSiteCustomHeadersInput {
  if (input === undefined) {
    return { present: false, valid: true, customHeaders: null, headers: null };
  }
  if (input === null) {
    return { present: true, valid: true, customHeaders: null, headers: null };
  }

  let parsedInput: unknown = input;
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) {
      return { present: true, valid: true, customHeaders: null, headers: null };
    }
    try {
      parsedInput = JSON.parse(trimmed);
    } catch {
      return {
        present: true,
        valid: false,
        customHeaders: null,
        headers: null,
        error: 'Invalid customHeaders. Expected a JSON object like {"x-header":"value"}.',
      };
    }
  }

  if (!isPlainObject(parsedInput)) {
    return {
      present: true,
      valid: false,
      customHeaders: null,
      headers: null,
      error: 'Invalid customHeaders. Expected a JSON object like {"x-header":"value"}.',
    };
  }

  try {
    const headers = normalizeSiteCustomHeadersRecord(parsedInput);
    return {
      present: true,
      valid: true,
      customHeaders: headers ? JSON.stringify(headers) : null,
      headers,
    };
  } catch (error) {
    return {
      present: true,
      valid: false,
      customHeaders: null,
      headers: null,
      error: error instanceof Error
        ? `Invalid customHeaders. ${error.message}`
        : 'Invalid customHeaders. Expected a JSON object like {"x-header":"value"}.',
    };
  }
}

export function readSiteCustomHeaders(input: unknown): SiteCustomHeadersRecord | null {
  const parsed = parseSiteCustomHeadersInput(input);
  if (!parsed.valid) {
    return null;
  }
  return parsed.headers;
}

/**
 * Merges two `Cookie` headers pair by pair instead of letting one replace the other.
 *
 * A shield such as Cloudflare hands the site a `cf_clearance` cookie that has to
 * be replayed on every request, and the account credential can itself be a cookie
 * (`new_api_refresh=…`). Both live in the single `Cookie` header, so treating it
 * like any other header means one of them disappears: the request either loses the
 * shield pass (403) or loses the login (401). Pairwise merging keeps both, with the
 * higher-priority side winning when the same name appears twice.
 */
function mergeCookieHeaders(base: string | null, override: string | null): string | null {
  const basePairs = (base || '').split(';').map((part) => part.trim()).filter(Boolean);
  if (basePairs.length === 0) return override;
  const overridePairs = (override || '').split(';').map((part) => part.trim()).filter(Boolean);
  if (overridePairs.length === 0) return base;

  const overrideNames = new Set(
    overridePairs.map((pair) => pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('=')).trim().toLowerCase()),
  );
  const kept = basePairs.filter((pair) => {
    const name = pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('=')).trim().toLowerCase();
    return !overrideNames.has(name);
  });
  return [...kept, ...overridePairs].join('; ');
}

export function mergeHeadersWithSiteCustomHeaders(
  siteCustomHeaders: unknown,
  requestHeaders?: HeadersInit,
  options: SiteCustomHeadersMergeOptions = {},
): HeadersInit | undefined {
  const normalizedSiteHeaders = readSiteCustomHeaders(siteCustomHeaders);
  if (!normalizedSiteHeaders) {
    return requestHeaders;
  }

  const priority = options.priority ?? 'request';
  const merged = new Headers(priority === 'site' ? requestHeaders : normalizedSiteHeaders);
  const headersToApplyLast = new Headers(priority === 'site' ? normalizedSiteHeaders : requestHeaders);
  const cookies = mergeCookieHeaders(
    merged.get('cookie'),
    headersToApplyLast.get('cookie'),
  );
  headersToApplyLast.forEach((value, key) => {
    if (key.toLowerCase() === 'cookie') return;
    merged.set(key, value);
  });
  if (cookies) merged.set('cookie', cookies);
  return merged;
}
