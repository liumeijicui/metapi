import { AsyncLocalStorage } from 'node:async_hooks';
import { db, schema } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { config } from '../config.js';
import { lookup as dnsLookup } from 'node:dns';
import { isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { SocksClient } from 'socks';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { Agent as UndiciAgent, ProxyAgent } from 'undici';
import { mergeHeadersWithSiteCustomHeaders, type SiteCustomHeadersMergePriority } from './siteCustomHeaders.js';
import { resolveProxyUrlFromExtraConfig } from './accountExtraConfig.js';
import { stripTrailingSlashes } from './urlNormalization.js';
import { siteUrlRequiresSystemProxy } from './siteProfiles.js';

const SITE_PROXY_CACHE_TTL_MS = 3_000;
const SUPPORTED_PROXY_PROTOCOLS = new Set([
  'http:',
  'https:',
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);
const SOCKS_PROXY_PROTOCOLS = new Set([
  'socks:',
  'socks4:',
  'socks4a:',
  'socks5:',
  'socks5h:',
]);
const DEFAULT_PROXY_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS = 60_000;

type SiteProxyRow = {
  siteUrl: string;
  proxyUrl: string | null;
  useSystemProxy: boolean;
  customHeaders: unknown;
  customHeadersOverrideRequestHeaders: boolean;
};
type SiteProxyQueryRow = {
  siteUrl: string;
  proxyUrl: string | null;
  useSystemProxy: boolean | null;
  customHeaders: unknown;
  customHeadersOverrideRequestHeaders: boolean | null;
};

type ParsedSiteProxyInput = {
  present: boolean;
  valid: boolean;
  proxyUrl: string | null;
};

export type SiteProxyConfigLike = {
  proxyUrl?: string | null;
  useSystemProxy?: boolean | null;
  customHeaders?: unknown;
  customHeadersOverrideRequestHeaders?: boolean | null;
};

let siteProxyCache: {
  loadedAt: number;
  rows: SiteProxyRow[];
  systemProxyUrl: string | null;
} = {
  loadedAt: 0,
  rows: [],
  systemProxyUrl: null,
};

const dispatcherCache = new Map<string, Dispatcher>();

const accountProxyOverride = new AsyncLocalStorage<string | null>();

/**
 * Identity of the account whose credential the current call is using.
 *
 * A rotating credential (`new_api_refresh`) replaces itself on every successful
 * exchange, and the server only returns the new secret in `Set-Cookie`. Without
 * knowing which account row to write back to, the rotated value is lost and the
 * chain dies after the first use - which is exactly how bound accounts ended up
 * unusable a few seconds after they were created.
 */
type AccountCredentialContext = {
  /** Absent while a brand-new account is still being created. */
  accountId?: number;
  siteId: number;
  /**
   * Newest secret an adapter observed while rotating this credential.
   *
   * A bind flow verifies the credential and then verifies it again while
   * creating the account row; the first exchange retires the secret the caller
   * still holds. Tracking the replacement here lets the whole chain converge on
   * the live value instead of repeatedly presenting a dead one.
   */
  rotated?: { cookieName: string; value: string };
};

const accountCredentialContext = new AsyncLocalStorage<AccountCredentialContext>();

export function getAccountCredentialContext(): AccountCredentialContext | undefined {
  return accountCredentialContext.getStore();
}

/** Remembers the replacement secret without writing it anywhere yet. */
export function recordRotatedCredential(cookieName: string, value: string): void {
  const context = accountCredentialContext.getStore();
  if (context) context.rotated = { cookieName, value };
}


export function withAccountCredentialContext<T>(
  context: AccountCredentialContext,
  fn: () => Promise<T>,
): Promise<T> {
  // Nested scopes appear when a flow that already tracks a credential creates another
  // (the assisted-login bind verifies, then creates the row, then starts the token
  // sync). Carry the rotation discovered so far into the inner scope instead of
  // dropping it, so the secret stays consistent no matter which layer writes.
  const current = accountCredentialContext.getStore();
  if (!current) return accountCredentialContext.run(context, fn);
  return accountCredentialContext.run({ ...context, rotated: current.rotated }, fn);
}

export function withAccountProxyOverride<T>(
  proxyUrl: string | null | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return fn();
  return accountProxyOverride.run(normalized, fn);
}

type ParsedSocksProxyConfig = {
  shouldLookup: boolean;
  proxy: {
    host: string;
    port: number;
    type: 4 | 5;
    userId?: string;
    password?: string;
  };
};

type UndiciConnectOptions = {
  hostname: string;
  host?: string;
  protocol: string;
  port: string;
  servername?: string;
  localAddress?: string | null;
  httpSocket?: Socket;
};

export function normalizeSiteUrl(value: string): string {
  const trimmed = (value || '').trim();
  if (!trimmed) return '';

  try {
    const parsed = new URL(trimmed);
    const normalizedPath = stripTrailingSlashes(parsed.pathname);
    return `${parsed.origin}${normalizedPath}`;
  } catch {
    return stripTrailingSlashes(trimmed);
  }
}

async function getCachedSiteProxyRows(nowMs = Date.now()): Promise<SiteProxyRow[]> {
  if ((nowMs - siteProxyCache.loadedAt) < SITE_PROXY_CACHE_TTL_MS) {
    return siteProxyCache.rows;
  }

  try {
    const [rows, systemProxySetting] = await Promise.all([
      db
        .select({
          siteUrl: schema.sites.url,
          proxyUrl: schema.sites.proxyUrl,
          useSystemProxy: schema.sites.useSystemProxy,
          customHeaders: schema.sites.customHeaders,
          customHeadersOverrideRequestHeaders: schema.sites.customHeadersOverrideRequestHeaders,
        })
        .from(schema.sites)
        .all() as Promise<SiteProxyQueryRow[]>,
      db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, 'system_proxy_url'))
        .get(),
    ]);
    const parsedSystemProxyUrl = normalizeSiteProxyUrl(
      typeof systemProxySetting?.value === 'string'
        ? (() => {
          try {
            return JSON.parse(systemProxySetting.value);
          } catch {
            return systemProxySetting.value;
          }
        })()
        : systemProxySetting?.value,
    );

    siteProxyCache = {
      loadedAt: nowMs,
      rows: rows.map((row) => ({
        siteUrl: normalizeSiteUrl(row.siteUrl),
        proxyUrl: normalizeSiteProxyUrl(row.proxyUrl),
        useSystemProxy: !!row.useSystemProxy,
        customHeaders: row.customHeaders ?? null,
        customHeadersOverrideRequestHeaders: !!row.customHeadersOverrideRequestHeaders,
      })),
      systemProxyUrl: parsedSystemProxyUrl,
    };
  } catch {
    siteProxyCache = { loadedAt: nowMs, rows: [], systemProxyUrl: null };
  }

  return siteProxyCache.rows;
}

function getDispatcherByProxyUrl(proxyUrl: string, skipCache = false): Dispatcher | undefined {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return undefined;

  if (!skipCache) {
    const cached = dispatcherCache.get(normalized);
    if (cached) return cached;
  }

  try {
    const parsedProxyUrl = new URL(normalized);
    const dispatcher = SOCKS_PROXY_PROTOCOLS.has(parsedProxyUrl.protocol.toLowerCase())
      ? createSocksDispatcher(parsedProxyUrl)
      : new ProxyAgent(normalized);
    if (!skipCache) {
      dispatcherCache.set(normalized, dispatcher);
    }
    return dispatcher;
  } catch {
    return undefined;
  }
}

function parseSocksProxyUrl(proxyUrl: URL): ParsedSocksProxyConfig {
  let shouldLookup = false;
  let type: 4 | 5 = 5;

  switch (proxyUrl.protocol.toLowerCase()) {
    case 'socks4:':
      shouldLookup = true;
      type = 4;
      break;
    case 'socks4a:':
      type = 4;
      break;
    case 'socks5:':
      shouldLookup = true;
      type = 5;
      break;
    case 'socks:':
    case 'socks5h:':
      type = 5;
      break;
    default:
      throw new TypeError(`Unsupported SOCKS proxy protocol: ${proxyUrl.protocol}`);
  }

  const proxy: ParsedSocksProxyConfig['proxy'] = {
    host: proxyUrl.hostname,
    port: Number.parseInt(proxyUrl.port, 10) || 1080,
    type,
  };

  if (proxyUrl.username) {
    proxy.userId = decodeURIComponent(proxyUrl.username);
  }
  if (proxyUrl.password) {
    proxy.password = decodeURIComponent(proxyUrl.password);
  }

  return { shouldLookup, proxy };
}

function applySocketDefaults(socket: Socket | TLSSocket) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, DEFAULT_PROXY_KEEPALIVE_INITIAL_DELAY_MS);
}

async function resolveSocksDestinationHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dnsLookup(hostname, {}, (error, address) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(address);
    });
  });
}

async function createSocksSocket(
  connectOptions: UndiciConnectOptions,
  socksProxy: ParsedSocksProxyConfig,
): Promise<Socket | TLSSocket> {
  if (!connectOptions.hostname) {
    throw new Error('Missing hostname for SOCKS proxy request');
  }

  const destinationHost = socksProxy.shouldLookup
    ? await resolveSocksDestinationHost(connectOptions.hostname)
    : connectOptions.hostname;
  const destinationPort = Number.parseInt(connectOptions.port, 10)
    || (connectOptions.protocol === 'https:' ? 443 : 80);

  const { socket } = await SocksClient.createConnection({
    proxy: socksProxy.proxy,
    destination: {
      host: destinationHost,
      port: destinationPort,
    },
    command: 'connect',
    timeout: DEFAULT_PROXY_CONNECT_TIMEOUT_MS,
    socket_options: connectOptions.localAddress
      ? { localAddress: connectOptions.localAddress } as any
      : undefined,
  });
  applySocketDefaults(socket);

  if (connectOptions.protocol !== 'https:') {
    return socket;
  }

  return await new Promise<TLSSocket>((resolve, reject) => {
    const tlsSocket = tlsConnect({
      socket,
      host: connectOptions.hostname,
      servername: connectOptions.servername || (!isIP(connectOptions.hostname) ? connectOptions.hostname : undefined),
      ALPNProtocols: ['http/1.1'],
    });

    const cleanup = (error: Error) => {
      socket.destroy();
      tlsSocket.destroy();
      reject(error);
    };

    tlsSocket.once('secureConnect', () => {
      tlsSocket.off('error', cleanup);
      applySocketDefaults(tlsSocket);
      resolve(tlsSocket);
    });
    tlsSocket.once('error', cleanup);
  });
}

function createSocksDispatcher(proxyUrl: URL): Dispatcher {
  const socksProxy = parseSocksProxyUrl(proxyUrl);
  return new UndiciAgent({
    connect: (connectOptions, callback) => {
      void createSocksSocket(connectOptions, socksProxy)
        .then((socket) => callback(null, socket))
        .catch((error) => {
          callback(error instanceof Error ? error : new Error(String(error)), null as any);
        });
    },
  });
}

export function normalizeSiteProxyUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null;
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

export function parseSiteProxyUrlInput(input: unknown): ParsedSiteProxyInput {
  if (input === undefined) {
    return { present: false, valid: true, proxyUrl: null };
  }
  if (input === null) {
    return { present: true, valid: true, proxyUrl: null };
  }

  if (typeof input !== 'string') {
    return { present: true, valid: false, proxyUrl: null };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { present: true, valid: true, proxyUrl: null };
  }

  const normalized = normalizeSiteProxyUrl(trimmed);
  if (!normalized) {
    return { present: true, valid: false, proxyUrl: null };
  }

  return {
    present: true,
    valid: true,
    proxyUrl: normalized,
  };
}

export function invalidateSiteProxyCache(): void {
  siteProxyCache = { loadedAt: 0, rows: [], systemProxyUrl: null };
}

function findBestMatchingSiteRow(rows: SiteProxyRow[], normalizedRequestUrl: string): SiteProxyRow | null {
  let bestMatch: SiteProxyRow | null = null;
  let bestMatchLength = -1;

  for (const row of rows) {
    if (!row.siteUrl) continue;

    const isPrefixMatch = (
      normalizedRequestUrl === row.siteUrl
      || normalizedRequestUrl.startsWith(`${row.siteUrl}/`)
      || normalizedRequestUrl.startsWith(`${row.siteUrl}?`)
    );
    if (!isPrefixMatch) continue;

    if (row.siteUrl.length > bestMatchLength) {
      bestMatch = row;
      bestMatchLength = row.siteUrl.length;
    }
  }

  return bestMatch;
}

async function resolveSiteRequestConfigByRequestUrl(requestUrl: string): Promise<{
  proxyUrl: string | null;
  customHeaders: unknown;
  customHeadersOverrideRequestHeaders: boolean;
}> {
  const normalizedRequestUrl = normalizeSiteUrl(requestUrl);
  if (!normalizedRequestUrl) {
    return { proxyUrl: null, customHeaders: null, customHeadersOverrideRequestHeaders: false };
  }

  const rows = await getCachedSiteProxyRows();
  const matchedRow = findBestMatchingSiteRow(rows, normalizedRequestUrl);
  // A site profile can declare that the host is only reachable through the
  // system proxy (some registries are blocked from the local network). That is a
  // fact about the site, so it applies even when the row has no proxy configured.
  const profileProxyUrl = siteUrlRequiresSystemProxy(normalizedRequestUrl)
    ? siteProxyCache.systemProxyUrl
    : null;
  const proxyUrl = profileProxyUrl
    || matchedRow?.proxyUrl
    || (matchedRow?.useSystemProxy ? siteProxyCache.systemProxyUrl : null);
  return {
    proxyUrl: proxyUrl || null,
    customHeaders: matchedRow?.customHeaders ?? null,
    customHeadersOverrideRequestHeaders: !!matchedRow?.customHeadersOverrideRequestHeaders,
  };
}

function resolveSiteCustomHeadersMergePriority(
  site: Pick<SiteProxyConfigLike, 'customHeadersOverrideRequestHeaders'> | null | undefined,
): SiteCustomHeadersMergePriority {
  return site?.customHeadersOverrideRequestHeaders ? 'site' : 'request';
}

export async function resolveSiteProxyUrlByRequestUrl(requestUrl: string): Promise<string | null> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  return resolved.proxyUrl;
}

export async function withSiteProxyRequestInit(
  requestUrl: string,
  options?: UndiciRequestInit,
): Promise<UndiciRequestInit> {
  const resolved = await resolveSiteRequestConfigByRequestUrl(requestUrl);
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(resolved.customHeaders, options?.headers, {
    priority: resolveSiteCustomHeadersMergePriority(resolved),
  });
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }

  const alsOverride = accountProxyOverride.getStore();
  const proxyUrl = alsOverride ?? resolved.proxyUrl;

  if (!proxyUrl) {
    return nextOptions;
  }

  const dispatcher = getDispatcherByProxyUrl(proxyUrl, alsOverride != null);
  if (!dispatcher) {
    return nextOptions;
  }

  return {
    ...nextOptions,
    dispatcher,
  };
}

export function withExplicitProxyRequestInit(
  proxyUrl: string | null | undefined,
  options?: UndiciRequestInit,
  skipCache = false,
): UndiciRequestInit {
  const normalized = normalizeSiteProxyUrl(proxyUrl);
  if (!normalized) return options ?? {};

  const dispatcher = getDispatcherByProxyUrl(normalized, skipCache);
  if (!dispatcher) return options ?? {};

  return {
    ...(options || {}),
    dispatcher,
  };
}

export function resolveProxyUrlForSite(site: SiteProxyConfigLike | null | undefined): string | null {
  const explicitProxyUrl = normalizeSiteProxyUrl(site?.proxyUrl);
  if (explicitProxyUrl) return explicitProxyUrl;
  // A site profile declares hosts that are only reachable through the system
  // proxy. It applies even when the row has the toggle off, because the user
  // cannot be expected to know a registry is blocked from this network.
  if (siteUrlRequiresSystemProxy((site as { url?: string } | null | undefined)?.url)) {
    return normalizeSiteProxyUrl(config.systemProxyUrl);
  }
  if (!site?.useSystemProxy) return null;
  return normalizeSiteProxyUrl(config.systemProxyUrl);
}

export function withSiteRecordProxyRequestInit(
  site: SiteProxyConfigLike | null | undefined,
  options?: UndiciRequestInit,
  accountProxyUrl?: string | null,
): UndiciRequestInit {
  const nextOptions: UndiciRequestInit = {
    ...(options || {}),
  };
  const mergedHeaders = mergeHeadersWithSiteCustomHeaders(site?.customHeaders, options?.headers, {
    priority: resolveSiteCustomHeadersMergePriority(site),
  });
  if (mergedHeaders) {
    nextOptions.headers = mergedHeaders;
  }
  const accountNormalized = normalizeSiteProxyUrl(accountProxyUrl) ?? accountProxyOverride.getStore();
  const siteProxyUrl = resolveProxyUrlForSite(site);
  const proxyUrl = accountNormalized || siteProxyUrl;
  const isAccountOverride = !!accountNormalized && accountNormalized !== siteProxyUrl;
  return withExplicitProxyRequestInit(proxyUrl, nextOptions, isAccountOverride);
}

export function resolveChannelProxyUrl(
  site: SiteProxyConfigLike | null | undefined,
  accountExtraConfig?: string | null,
): string | null {
  if (accountExtraConfig) {
    const normalized = normalizeSiteProxyUrl(resolveProxyUrlFromExtraConfig(accountExtraConfig));
    if (normalized) return normalized;
  }
  return resolveProxyUrlForSite(site);
}
