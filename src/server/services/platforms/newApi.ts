import { ApiTokenInfo, BasePlatformAdapter, CheckinResult, BalanceInfo, UserInfo, TokenVerifyResult, CreateApiTokenOptions, type CheckinContext, type SiteAnnouncement, type SiteSessionInfo, type LoginResult, type PerfMetricsModel, type PerfMetricsOutcome, type PerfMetricsSample, type PerfMetricsSummary } from './base.js';
import type { RequestInit as UndiciRequestInit } from 'undici';
import { createContext, runInContext } from 'node:vm';
import { withSiteProxyRequestInit } from '../siteProxy.js';
import { fetchJsonWithShieldCookieRetry, isEdgeRateLimitResponse } from './newApiShield.js';
import { getAccountCredentialContext, recordRotatedCredential } from '../siteProxy.js';
import {
  persistRotatedRefreshCookie,
  persistRotatedRefreshCookieByCredentials,
} from '../accountCredentialRotation.js';
import {
  buildEndpointModelContextLengthScope,
  extractContextLengthsFromPayload,
  setModelContextLengths,
} from '../modelContextLengthCache.js';
import { normalizeCheckinReward, quotaToUsd } from './quota.js';
import { runMintWheelCheckin } from './mintWheelCheckin.js';
import { isCloudflareChallengeResponse, refreshCloudflareClearance } from '../cloudflareClearance.js';
import { getExternalCheckinSessionFromExtraConfig } from '../accountExtraConfig.js';

/**
 * A refresh cookie yields a short-lived access token. Exchanging it on every
 * single API call would be wasteful and can trip upstream rate limits, so
 * tokens are cached until shortly before their own expiry.
 */
const REFRESH_TOKEN_CACHE = new Map<string, { accessToken: string; expiresAtMs: number }>();
const REFRESH_TOKEN_CACHE_LEAD_MS = 60 * 1000;

/** Quota units per dollar used by new-api when it reports balances and awards. */
export const QUOTA_PER_UNIT = 500000;

/**
 * The edge throttled the exchange, so there is no fresh access token *and* no
 * verdict about the credential.
 *
 * This is thrown rather than returned as `null`: a caller that cannot tell the
 * two apart falls back to sending the refresh cookie as a bearer token, the
 * site answers `invalid access token`, and an account that was merely throttled
 * gets recorded as expired and dropped from the daily check-in. The wording
 * stays clear of every "token expired" phrase so the classification cannot
 * make the same mistake downstream.
 */
export class SiteThrottledError extends Error {
  constructor() {
    super('站点当前限流（HTTP 429），本次未取得访问令牌，稍后会自动重试');
    this.name = 'SiteThrottledError';
  }
}

type JsonFetchOutcome<T> = {
  data: T | null;
  cookieHeader: string;
  /** The site's edge refused this call while the shared egress IP was throttled. */
  edgeRateLimited: boolean;
};

/**
 * Verdict collected during one verification attempt. Throttling is observed
 * deep inside the fetch funnel, so the fact is carried back out instead of
 * being re-derived with another upstream round trip.
 */
type EdgeRateLimitProbe = { edgeRateLimited: boolean };

function recordEdgeRateLimit(
  probe: EdgeRateLimitProbe | undefined,
  outcome: JsonFetchOutcome<unknown>,
): void {
  if (probe && outcome.edgeRateLimited) probe.edgeRateLimited = true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() ? Number.parseFloat(value) : Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

function describePerfMetricsHttpFailure(status: number): string {
  if (status === 401) return 'HTTP 401：站点判定当前凭据无效';
  if (status === 403) return 'HTTP 403：被站点边缘 / WAF 拦截（可能需要过盾）';
  if (status === 429) return 'HTTP 429：站点限流';
  if (status === 200) return 'HTTP 200：返回内容不是 JSON（可能被盾拦截）';
  return `HTTP ${status}：模型监控接口未返回可用数据`;
}

/**
 * 归一化 `GET /api/perf-metrics/summary`。
 *
 * 同一接口在上游有两个版本的形状：新版本给 `summary` + `window_*` +
 * `recent_success_series`（每个点带 ts），旧版本只给 `models[]`，并且用
 * `recent_success_rates`（纯数字数组，没有时间轴）。两种都要能吃下，
 * 否则一半站点会变成「解析失败」。
 */
export function parsePerfMetricsSummaryPayload(payload: unknown): PerfMetricsSummary | null {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null;
  const rawData = record && 'data' in record ? record.data : payload;
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData)
    ? rawData as Record<string, unknown>
    : null;
  if (!data || !Array.isArray(data.models)) return null;

  const models: PerfMetricsModel[] = [];
  for (const rawModel of data.models as unknown[]) {
    if (!rawModel || typeof rawModel !== 'object') continue;
    const model = rawModel as Record<string, unknown>;
    const modelName = typeof model.model_name === 'string' ? model.model_name.trim() : '';
    if (!modelName) continue;

    const recentSuccess: PerfMetricsSample[] = [];
    if (Array.isArray(model.recent_success_series)) {
      for (const rawPoint of model.recent_success_series as unknown[]) {
        const point = rawPoint && typeof rawPoint === 'object' ? rawPoint as Record<string, unknown> : null;
        const rate = toFiniteNumber(point?.success_rate);
        if (rate === null) continue;
        recentSuccess.push({ ts: toFiniteNumber(point?.ts), rate });
      }
    }
    if (!recentSuccess.length && Array.isArray(model.recent_success_rates)) {
      for (const rawRate of model.recent_success_rates as unknown[]) {
        const rate = toFiniteNumber(rawRate);
        if (rate === null) continue;
        recentSuccess.push({ ts: null, rate });
      }
    }

    models.push({
      modelName,
      avgLatencyMs: toFiniteNumber(model.avg_latency_ms) ?? 0,
      successRate: toFiniteNumber(model.success_rate) ?? 0,
      avgTps: toFiniteNumber(model.avg_tps) ?? 0,
      recentSuccess,
    });
  }

  const rawSummary = data.summary && typeof data.summary === 'object'
    ? data.summary as Record<string, unknown>
    : null;

  return {
    summary: rawSummary
      ? {
        avgLatencyMs: toFiniteNumber(rawSummary.avg_latency_ms) ?? 0,
        successRate: toFiniteNumber(rawSummary.success_rate) ?? 0,
        avgTps: toFiniteNumber(rawSummary.avg_tps) ?? 0,
      }
      : null,
    windowStart: toFiniteNumber(data.window_start),
    windowEnd: toFiniteNumber(data.window_end),
    showThroughput: typeof data.show_throughput === 'boolean' ? data.show_throughput : null,
    models,
  };
}

export class NewApiAdapter extends BasePlatformAdapter {
  readonly platformName: string = 'new-api';

  /**
   * Backoff applied when the site's edge throttles a management call. Empty by
   * default so ordinary sites fail fast; adapters for shared/free relays
   * override it (see AnyRouterAdapter).
   */
  protected get edgeRateLimitRetryDelaysMs(): readonly number[] {
    return [];
  }

  async detect(url: string): Promise<boolean> {
    try {
      const res = await this.fetchJson<any>(`${url}/api/status`);
      return res?.success === true && typeof res?.data?.system_name === 'string';
    } catch {
      return false;
    }
  }

  override async getSiteAnnouncements(baseUrl: string, _accessToken: string): Promise<SiteAnnouncement[]> {
    try {
      const payload = await this.fetchJson<any>(`${baseUrl}/api/notice`);
      const content = typeof payload?.data === 'string'
        ? payload.data.trim()
        : (typeof payload === 'string' ? payload.trim() : '');
      if (!content) return [];
      return [{
        sourceKey: this.buildNoticeSourceKey(content),
        title: 'Site notice',
        content,
        level: 'info',
        sourceUrl: '/api/notice',
        rawPayload: payload,
      }];
    } catch {
      return [];
    }
  }

  /**
   * 站点自己的模型监控读数（成功率 / 延迟 / 吞吐）。
   *
   * 这个接口是给已登录用户看的，普通用户权限即可；凭据既可能是会话 cookie
   * 也可能是 access token，所以统一走 `buildCredentialRequestHeaders`。
   */
  async getPerfMetricsSummary(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    hours = 24,
  ): Promise<PerfMetricsOutcome> {
    const root = (baseUrl || '').replace(/\/+$/, '');
    if (!root) return { ok: false, unsupported: true, message: '站点地址为空' };

    const safeHours = Number.isFinite(hours) && hours > 0 ? Math.trunc(hours) : 24;
    const url = `${root}/api/perf-metrics/summary?hours=${safeHours}`;

    let bearer = accessToken;
    try {
      bearer = await this.resolveBearerToken(root, accessToken);
    } catch (error) {
      return { ok: false, unsupported: false, message: (error as Error)?.message || '凭据兑换失败' };
    }

    const headers = this.buildCredentialRequestHeaders(bearer, platformUserId);
    const unsupportedMessage = '站点没有 /api/perf-metrics 接口（版本较旧）';

    try {
      // 先做一次带状态码的探查：通用 JSON 通道会把 404 与「被盾拦住」都吞成
      // null，只有它能区分「站点版本旧」和「这次请求失败」。
      const probed = await this.probePerfMetricsEndpoint(url, headers);
      if (probed.status === 200 && probed.data) {
        const parsed = parsePerfMetricsSummaryPayload(probed.data);
        return parsed
          ? { ok: true, data: parsed }
          : { ok: false, unsupported: false, message: '上游返回的模型监控数据无法解析' };
      }

      // 站点可能挂着一层 shield 挑战：再走通用通道一次，它负责解挑战并刷新
      // Cloudflare 凭证。
      const retried = await this.fetchJsonRaw<unknown>(url, { method: 'GET', headers });
      if (retried) {
        const parsed = parsePerfMetricsSummaryPayload(retried);
        if (parsed) return { ok: true, data: parsed };
      }

      if (probed.status === 404) {
        return { ok: false, unsupported: true, message: unsupportedMessage };
      }
      return { ok: false, unsupported: false, message: describePerfMetricsHttpFailure(probed.status) };
    } catch (error) {
      return { ok: false, unsupported: false, message: `请求上游失败：${(error as Error)?.message || 'unknown error'}` };
    }
  }

  private async probePerfMetricsEndpoint(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; data: unknown }> {
    const { fetch } = await import('undici');
    const merged: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': this.resolveUserAgent(),
      ...this.normalizeHeaders(headers),
    };
    const requestOrigin = this.deriveRequestOrigin(url);
    if (requestOrigin) {
      if (!merged['Origin']) merged['Origin'] = requestOrigin;
      if (!merged['Referer']) merged['Referer'] = `${requestOrigin}/`;
    }
    const res = await fetch(url, await withSiteProxyRequestInit(url, { method: 'GET', headers: merged }));
    const text = await res.text();
    return { status: res.status, data: this.parseJsonSafe<unknown>(text) };
  }

  private tryDecodeUserId(token: string): number | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (typeof payload?.id === 'number') return payload.id;
      if (typeof payload?.sub === 'string' || typeof payload?.sub === 'number') {
        const n = Number.parseInt(String(payload.sub), 10);
        if (!Number.isNaN(n)) return n;
      }
    } catch {}
    return null;
  }

  private authHeaders(accessToken: string, userId?: number): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    this.appendUserIdCompatibilityHeaders(headers, userId);
    return headers;
  }

  private appendUserIdCompatibilityHeaders(headers: Record<string, string>, userId?: number | null): void {
    if (!userId) return;
    const value = String(userId);
    headers['New-API-User'] = value;
    headers['Veloera-User'] = value;
    headers['voapi-user'] = value;
    headers['User-id'] = value;
    headers['X-User-Id'] = value;
    headers['Rix-Api-User'] = value;
    headers['neo-api-user'] = value;
  }

  private buildCookieCandidates(token: string): string[] {
    const trimmed = (token || '').trim();
    if (!trimmed) return [];

    const raw = trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
    if (this.isCookieHeaderCredential(raw)) {
      return [raw];
    }

    return [`session=${raw}`, `token=${raw}`];
  }

  private isCookieHeaderCredential(token: string): boolean {
    return /(^|;\s*)(session|token|auth_token|access_token|jwt|jwt_token|new_api_refresh)=/i.test(token);
  }

  /**
   * Newer new-api deployments stop exposing a long-lived session and instead
   * keep only a `new_api_refresh` cookie in the browser. The access token lives
   * in page memory, so the refresh cookie is the only durable credential and it
   * has to be exchanged for a bearer token before any management API works.
   */
  private isRefreshCookieCredential(token: string): boolean {
    return /(^|;\s*)new_api_refresh=/i.test(token || '');
  }

  private extractRefreshCookie(token: string): string | null {
    return this.readRefreshCookieValue(token);
  }

  /** Reads the `new_api_refresh` value out of a cookie or `Set-Cookie` string. */
  private readRefreshCookieValue(cookieSource: string | null | undefined): string | null {
    const match = (cookieSource || '').match(/(?:^|;\s*)new_api_refresh=([^;]+)/i);
    return match?.[1]?.trim() || null;
  }

  /**
   * Exchanges the refresh cookie for a short-lived access token. Returns null
   * when the credential is not a refresh cookie or the exchange fails.
   */
  private async exchangeRefreshCookie(baseUrl: string, token: string): Promise<string | null> {
    // Cache on the secret *the caller passed in*, not on the newest one this
    // process has seen. Exchanging rolls the secret, so keying on the live value
    // makes every later call with the same credential a cache miss: a flow that
    // touches the API many times (listing sessions, then deleting each one)
    // would roll the credential once per request. Each roll is a chance to lose
    // the replacement, and a rolled secret presented again after the server's
    // replay window looks like theft. One exchange per credential, reused for its
    // 15 minute lifetime, keeps the chain short.
    const presentedValue = this.extractRefreshCookie(token);
    if (!presentedValue) return null;

    const cacheKey = `${baseUrl}::${presentedValue}`;
    const cached = REFRESH_TOKEN_CACHE.get(cacheKey);
    if (cached && cached.expiresAtMs - Date.now() > REFRESH_TOKEN_CACHE_LEAD_MS) {
      return cached.accessToken;
    }

    const refreshValue = this.resolveLiveRefreshValue(presentedValue) || presentedValue;

    let edgeRateLimited = false;
    try {
      // Some deployments reject the exchange unless it looks same-origin
      // (AUTH_ORIGIN_FORBIDDEN), so the site's own origin is sent along.
      const siteOrigin = (() => {
        try {
          return new URL(baseUrl).origin;
        } catch {
          return '';
        }
      })();
      const res = await this.fetchJsonRawWithCookie<any>(`${baseUrl}/api/user/auth/refresh`, {
        method: 'POST',
        headers: {
          Cookie: `new_api_refresh=${refreshValue}`,
          Accept: 'application/json',
          ...(siteOrigin ? { Origin: siteOrigin, Referer: `${siteOrigin}/` } : {}),
        },
      });
      edgeRateLimited = res.edgeRateLimited === true;
      const accessToken = res.data?.data?.access_token;
      // The exchange rolls the refresh secret and returns the replacement only in
      // Set-Cookie. Dropping it makes the credential single-use: the next call
      // would present a retired secret and the account would look revoked.
      this.captureRotatedRefreshValue(res.cookieHeader, refreshValue);
      if (getAccountCredentialContext()) {
        await this.persistRotatedRefreshCookie(res.cookieHeader, refreshValue);
      } else {
        // No context to name the row with. The replacement still has to land
        // somewhere: an exchange with nowhere to write it leaves the account
        // holding the secret the server just retired, which reads as
        // `AUTH_SESSION_REVOKED` on every request after this one.
        await this.persistRotatedRefreshCookieByCredentials(baseUrl, res.cookieHeader, refreshValue);
      }
      if (typeof accessToken === 'string' && accessToken.trim()) {
        const expiresRaw = Number(res?.data?.access_expires_at);
        const expiresAtMs = Number.isFinite(expiresRaw) && expiresRaw > 0
          ? expiresRaw * 1000
          : Date.now() + 5 * 60 * 1000;
        REFRESH_TOKEN_CACHE.set(cacheKey, { accessToken: accessToken.trim(), expiresAtMs });
        return accessToken.trim();
      }
    } catch {}
    // Thrown outside the swallow above: a throttle is not a failure to hide.
    if (edgeRateLimited) throw new SiteThrottledError();
    return null;
  }

  /**
   * Prefers the newest secret this call chain has already seen.
   *
   * A bind flow performs several exchanges in a row (verify, then account
   * creation, then token sync) from one credential string. Each exchange retires
   * the previous secret, so reusing the original string makes every step after
   * the first one fail as if the account were revoked.
   */
  private resolveLiveRefreshValue(refreshValue: string | null): string | null {
    if (!refreshValue) return null;
    const rotated = getAccountCredentialContext()?.rotated;
    if (rotated && rotated.cookieName.toLowerCase() === 'new_api_refresh' && rotated.value) {
      return rotated.value;
    }
    return refreshValue;
  }

  /**
   * Records the replacement secret for the rest of this call chain, so a later
   * exchange in the same flow presents the live value instead of a retired one.
   */
  private captureRotatedRefreshValue(cookieHeader: string, previousValue: string): void {
    const match = (cookieHeader || '').match(/(?:^|;\s*)new_api_refresh=([^;]+)/i);
    const nextValue = match?.[1]?.trim();
    if (!nextValue || nextValue === previousValue) return;
    recordRotatedCredential('new_api_refresh', nextValue);
  }

  /**
   * Writes a rolled refresh secret back to the account row it came from.
   *
   * Only the request that owns the account credential context may do this; a
   * bare probe has no row to update and is left alone.
   */
  private async persistRotatedRefreshCookie(
    cookieHeader: string,
    previousValue: string,
  ): Promise<void> {
    const context = getAccountCredentialContext();
    if (!context) return;
    const match = (cookieHeader || '').match(/(?:^|;\s*)new_api_refresh=([^;]+)/i);
    const nextValue = match?.[1]?.trim();
    if (!nextValue || nextValue === previousValue) return;
    await persistRotatedRefreshCookie({
      accountId: context.accountId,
      siteId: context.siteId,
      cookieName: 'new_api_refresh',
      previousValue,
      nextValue,
    });
  }
  private async resolveBearerToken(baseUrl: string, token: string): Promise<string> {
    if (!this.isRefreshCookieCredential(token)) return token;
    // A throttled exchange throws, so it never reaches the fallback below;
    // `token` here means the site answered and refused the session itself.
    return (await this.exchangeRefreshCookie(baseUrl, token)) || token;
  }

  /**
   * Writes a rolled secret back to whichever account still holds the old one.
   *
   * Only for the exchanges that run without a credential context, which is the
   * case a bare probe has: it does not know which row the credential came from,
   * so the row is found by the spent secret instead of being left behind.
   */
  private async persistRotatedRefreshCookieByCredentials(
    baseUrl: string,
    cookieHeader: string,
    previousValue: string,
  ): Promise<void> {
    const match = (cookieHeader || '').match(/(?:^|;\s*)new_api_refresh=([^;]+)/i);
    const nextValue = match?.[1]?.trim();
    if (!nextValue || nextValue === previousValue) return;
    await persistRotatedRefreshCookieByCredentials({
      cookieName: 'new_api_refresh',
      previousValue,
      nextValue,
      siteUrl: baseUrl,
    });
  }

  private decodeBase64Loose(value: string): string | null {
    if (!value) return null;
    try {
      return Buffer.from(value, 'base64').toString('utf8');
    } catch {}
    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(normalized, 'base64').toString('utf8');
    } catch {}
    return null;
  }

  private decodeBase64BufferLoose(value: string): Buffer | null {
    if (!value) return null;
    try {
      return Buffer.from(value, 'base64');
    } catch {}
    try {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      return Buffer.from(normalized, 'base64');
    } catch {}
    return null;
  }

  private decodeGobSignedInt(encoded: Buffer): number | null {
    if (!encoded.length) return null;

    let unsigned = 0n;
    if (encoded[0] < 0x80) {
      unsigned = BigInt(encoded[0]);
    } else {
      const width = 0x100 - encoded[0];
      if (width <= 0 || encoded.length !== width + 1) return null;
      for (let i = 1; i < encoded.length; i += 1) {
        unsigned = (unsigned << 8n) | BigInt(encoded[i]);
      }
    }

    const signed = (unsigned & 1n) === 0n
      ? unsigned >> 1n
      : -((unsigned >> 1n) + 1n);
    if (signed <= 0n || signed > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(signed);
  }

  private extractGobFieldInts(payload: Buffer, fieldName: string): number[] {
    const ids: number[] = [];
    const push = (value: number | null) => {
      if (typeof value !== 'number' || Number.isNaN(value)) return;
      if (value <= 0 || value > 10_000_000) return;
      if (!ids.includes(value)) ids.push(value);
    };

    const marker = Buffer.concat([
      Buffer.from(fieldName, 'utf8'),
      Buffer.from([0x03]),
      Buffer.from('int', 'utf8'),
      Buffer.from([0x04]),
    ]);

    let start = 0;
    while (start < payload.length) {
      const position = payload.indexOf(marker, start);
      if (position < 0) break;

      const encodedLength = payload[position + marker.length];
      const delimiter = payload[position + marker.length + 1];
      if (typeof encodedLength === 'number' && delimiter === 0x00) {
        const byteLength = encodedLength - 1;
        const valueStart = position + marker.length + 2;
        const valueEnd = valueStart + byteLength;
        if (byteLength > 0 && valueEnd <= payload.length) {
          push(this.decodeGobSignedInt(payload.subarray(valueStart, valueEnd)));
        }
      }

      start = position + marker.length;
    }

    return ids;
  }

  private extractLikelyUserIds(token: string): number[] {
    const ids: number[] = [];
    const push = (value: unknown) => {
      const n = Number.parseInt(String(value), 10);
      if (Number.isNaN(n)) return;
      if (n <= 0 || n > 10_000_000) return;
      if (!ids.includes(n)) ids.push(n);
    };

    const raw = (token || '').trim();
    if (!raw) return ids;

    const cookieCandidates = this.buildCookieCandidates(raw);
    const sessionValues = new Set<string>();
    for (const candidate of cookieCandidates) {
      const match = candidate.match(/(?:^|;\s*)session=([^;]+)/i);
      if (match?.[1]) sessionValues.add(match[1].trim());
    }

    if (raw && !raw.includes('=')) {
      sessionValues.add(raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw);
    }

    for (const sessionValue of sessionValues) {
      const decodedBuffer = this.decodeBase64BufferLoose(sessionValue);
      if (!decodedBuffer) continue;

      const decoded = decodedBuffer.toString('utf8');

      const payloadCandidates: string[] = [decoded];
      const payloadBuffers: Buffer[] = [decodedBuffer];
      const parts = decoded.split('|');
      if (parts.length >= 2) {
        const middlePayloadBuffer = this.decodeBase64BufferLoose(parts[1]);
        if (middlePayloadBuffer) {
          payloadCandidates.push(middlePayloadBuffer.toString('utf8'));
          payloadBuffers.push(middlePayloadBuffer);
        }
      }

      for (const payload of payloadCandidates) {
        for (const m of payload.matchAll(/_(\d{4,8})(?!\d)/g)) {
          push(m[1]);
        }
        for (const m of payload.matchAll(/(?:user(?:name)?|uid|id)[^\d]{0,16}(\d{4,8})(?!\d)/gi)) {
          push(m[1]);
        }
      }

      for (const payload of payloadBuffers) {
        for (const value of this.extractGobFieldInts(payload, 'id')) {
          push(value);
        }
      }
    }

    return ids;
  }

  private buildUserIdProbeCandidates(token: string): number[] {
    const candidates: number[] = [];
    const push = (value: number | null) => {
      if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) return;
      if (!candidates.includes(value)) candidates.push(value);
    };

    push(this.tryDecodeUserId(token));
    for (const guessed of this.extractLikelyUserIds(token)) {
      push(guessed);
    }
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 50, 100, 8899, 11494]) {
      push(id);
    }

    return candidates;
  }

  private parseTokenItems(payload: any): any[] {
    if (Array.isArray(payload?.data)) return payload.data;
    if (Array.isArray(payload?.data?.items)) return payload.data.items;
    if (Array.isArray(payload?.data?.data)) return payload.data.data;
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.list)) return payload.list;
    if (Array.isArray(payload?.data?.list)) return payload.data.list;
    return [];
  }

  private isTokenListResponse(payload: any): boolean {
    if (!payload || typeof payload !== 'object') return false;
    if (payload?.success === true) return true;
    return (
      Array.isArray(payload?.data)
      || Array.isArray(payload?.data?.items)
      || Array.isArray(payload?.data?.data)
      || Array.isArray(payload?.items)
      || Array.isArray(payload?.list)
      || Array.isArray(payload?.data?.list)
    );
  }

  private normalizeTokenKeyForCompare(value?: string | null): string {
    const trimmed = (value || '').trim();
    return trimmed.startsWith('Bearer ') ? trimmed.slice(7).trim() : trimmed;
  }

  private parseGroupKeys(payload: any): string[] {
    if (payload && typeof payload === 'object' && payload?.success === false) {
      return [];
    }

    const source = payload?.data ?? payload;
    if (Array.isArray(source)) {
      return source
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    }

    if (source && typeof source === 'object') {
      return Object.keys(source)
        .map((key) => key.trim())
        .filter((key) => !['success', 'message', 'code', 'data', 'error'].includes(key.toLowerCase()))
        .filter(Boolean);
    }

    return [];
  }

  private resolveGroupFetchErrorMessage(payload: any): string {
    const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
    const normalized = message.toLowerCase();
    const indicatesExpired = normalized.includes('expired')
      || normalized.includes('invalid token')
      || normalized.includes('access token')
      || normalized.includes('unauthorized')
      || normalized.includes('forbidden')
      || normalized.includes('未登录')
      || normalized.includes('登录')
      || normalized.includes('过期');
    if (indicatesExpired) return '账号会话可能已过期，请重新登录后再拉取分组';
    return message || '拉取分组失败';
  }

  private normalizeTokenItems(items: any[]): ApiTokenInfo[] {
    const normalized: ApiTokenInfo[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      if (!key) continue;
      const rawName = typeof item?.name === 'string' ? item.name.trim() : '';
      const rawGroup = typeof item?.group === 'string'
        ? item.group.trim()
        : (typeof item?.group_name === 'string'
          ? item.group_name.trim()
          : (typeof item?.token_group === 'string' ? item.token_group.trim() : ''));
      const status = typeof item?.status === 'number' ? item.status : undefined;
      const tokenInfo: ApiTokenInfo = {
        name: rawName || (index === 0 ? 'default' : `token-${index + 1}`),
        key,
        enabled: status === undefined ? true : status === 1,
      };
      if (rawGroup) tokenInfo.tokenGroup = rawGroup;
      normalized.push(tokenInfo);
    }
    return normalized;
  }

  /**
   * True when the site printed a key as `C5XJ**********Lemx`.
   *
   * Forks that police distribution list every key masked: the list endpoint
   * answers with a placeholder, so a caller that stores it verbatim has a token
   * row that cannot call anything. The placeholder is worth recognising so the
   * reveal below can be attempted, and so a reveal that comes back masked is not
   * mistaken for a real key.
   */
  private isMaskedTokenKey(key: string | null | undefined): boolean {
    const value = (key || '').trim();
    return value.includes('*') || value.includes('•');
  }

  /**
   * Asks the site for one token's plaintext.
   *
   * Masking the list is not the same as withholding the key: these forks ship a
   * per-row reveal (`POST /api/token/{id}/key`) that the web UI itself calls when
   * the operator clicks 复制. A fork without it answers 404, which is exactly the
   * old behaviour, so nothing is lost by trying.
   */
  private async revealTokenKey(
    baseUrl: string,
    headers: Record<string, string>,
    tokenId: number,
  ): Promise<string | null> {
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/token/${tokenId}/key`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      const key = typeof res?.data?.key === 'string' ? res.data.key.trim() : '';
      if (!key || this.isMaskedTokenKey(key)) return null;
      return key;
    } catch {
      return null;
    }
  }

  /**
   * Replaces masked keys in place with the values the site is willing to hand out.
   *
   * Best-effort and bounded: one extra request per masked row (the rows that
   * already carry a real key cost nothing), and a refusal leaves the masked value
   * in place for the caller to record as pending. Sequential rather than
   * parallel — these are the free relays that throttle by egress IP, and a burst
   * is what earns a 429.
   */
  private async revealMaskedTokenKeys(
    baseUrl: string,
    headers: Record<string, string>,
    items: any[],
    limit = 20,
  ): Promise<void> {
    let attempted = 0;
    for (const item of items) {
      if (attempted >= limit) return;
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      if (!key || !this.isMaskedTokenKey(key)) continue;
      const tokenId = Number(item?.id);
      if (!Number.isFinite(tokenId) || tokenId <= 0) continue;
      attempted += 1;
      const revealed = await this.revealTokenKey(baseUrl, headers, tokenId);
      if (revealed) item.key = revealed;
    }
  }

  private parseUserInfo(data: any): UserInfo {
    return {
      username: data?.username || data?.display_name || '',
      displayName: data?.display_name,
      email: data?.email,
      role: data?.role,
    };
  }

  private parseBalance(data: any): BalanceInfo {
    const quota = quotaToUsd(data?.quota || 0, QUOTA_PER_UNIT);
    const used = quotaToUsd(data?.used_quota || 0, QUOTA_PER_UNIT);
    const total = quota + used;
    const todayIncome = Number.isFinite(data?.today_income) ? quotaToUsd(data.today_income, QUOTA_PER_UNIT) : undefined;
    const todayQuotaConsumption = Number.isFinite(data?.today_quota_consumption) ? quotaToUsd(data.today_quota_consumption, QUOTA_PER_UNIT) : undefined;
    return { balance: quota, used, quota: total, todayIncome, todayQuotaConsumption };
  }

  private extractLoginAccessToken(payload: any): string | null {
    const candidates: unknown[] = [
      payload?.data,
      payload?.token,
      payload?.accessToken,
      payload?.access_token,
      payload?.data?.token,
      payload?.data?.accessToken,
      payload?.data?.access_token,
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const token = candidate.trim();
      if (token) return token;
    }
    return null;
  }

  private buildDefaultTokenPayload(options?: CreateApiTokenOptions): Record<string, unknown> {
    const normalizedName = (options?.name || '').trim() || 'metapi';
    const unlimitedQuota = options?.unlimitedQuota ?? true;
    const remainQuota = Number.isFinite(options?.remainQuota)
      ? Math.max(0, Math.trunc(options?.remainQuota as number))
      : 0;
    const expiredTime = Number.isFinite(options?.expiredTime)
      ? Math.trunc(options?.expiredTime as number)
      : -1;
    return {
      name: normalizedName,
      unlimited_quota: unlimitedQuota,
      expired_time: expiredTime,
      remain_quota: remainQuota,
      allow_ips: (options?.allowIps || '').trim(),
      model_limits_enabled: options?.modelLimitsEnabled ?? false,
      model_limits: (options?.modelLimits || '').trim(),
      group: (options?.group || '').trim(),
    };
  }

  private parseChallengeArg1(html: string): string | null {
    const match = html.match(/var\s+arg1\s*=\s*['"]([0-9a-fA-F]+)['"]/);
    return match?.[1]?.toUpperCase() || null;
  }

  private parseChallengeMapping(html: string): number[] | null {
    const match = html.match(/for\(var m=\[([^\]]+)\],p=L\(0x115\)/);
    if (!match?.[1]) return null;

    const values = match[1].split(',').map((raw) => {
      const v = raw.trim().toLowerCase();
      if (!v) return Number.NaN;
      if (v.startsWith('0x')) return Number.parseInt(v.slice(2), 16);
      return Number.parseInt(v, 10);
    });
    if (values.some((v) => Number.isNaN(v))) return null;
    return values;
  }

  private parseChallengeXorSeed(html: string): string | null {
    const fnStart = html.indexOf('function a0i()');
    const bStart = html.indexOf('function b(');
    const rotateStart = html.indexOf('(function(a,c){');
    const rotateEnd = html.indexOf('),!(function', rotateStart);
    if (fnStart < 0 || bStart < 0 || bStart <= fnStart || rotateStart < 0 || rotateEnd < 0) {
      return null;
    }

    const helperCode = html.slice(fnStart, bStart);
    const rotateCode = `${html.slice(rotateStart, rotateEnd + 1)})`;

    try {
      const sandbox: Record<string, unknown> = { decodeURIComponent };
      createContext(sandbox);
      runInContext(helperCode, sandbox, { timeout: 100 });
      runInContext(rotateCode, sandbox, { timeout: 100 });
      const decoder = sandbox['a0j'];
      if (typeof decoder !== 'function') return null;
      const seed = (decoder as (idx: number) => unknown)(0x115);
      if (typeof seed !== 'string' || !/^[0-9a-f]+$/i.test(seed)) return null;
      return seed;
    } catch {
      return null;
    }
  }

  private solveAcwScV2(html: string): string | null {
    const arg1 = this.parseChallengeArg1(html);
    const mapping = this.parseChallengeMapping(html);
    const xorSeed = this.parseChallengeXorSeed(html);
    if (!arg1 || !mapping || !xorSeed) return null;

    const q: string[] = [];
    for (let i = 0; i < arg1.length; i += 1) {
      const ch = arg1[i];
      for (let j = 0; j < mapping.length; j += 1) {
        if (mapping[j] === i + 1) {
          q[j] = ch;
        }
      }
    }

    const reordered = q.join('');
    let out = '';
    for (let i = 0; i < reordered.length && i < xorSeed.length; i += 2) {
      const left = Number.parseInt(reordered.slice(i, i + 2), 16);
      const right = Number.parseInt(xorSeed.slice(i, i + 2), 16);
      if (Number.isNaN(left) || Number.isNaN(right)) return null;
      out += (left ^ right).toString(16).padStart(2, '0');
    }

    return out || null;
  }

  private upsertCookie(cookieHeader: string, name: string, value: string): string {
    const parts = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
    let replaced = false;
    const next = parts.map((part) => {
      const eq = part.indexOf('=');
      if (eq < 0) return part;
      const key = part.slice(0, eq).trim();
      if (key !== name) return part;
      replaced = true;
      return `${name}=${value}`;
    });
    if (!replaced) next.push(`${name}=${value}`);
    return next.join('; ');
  }

  /**
   * Returns the browser UA that the managed Chrome build actually uses. Shields
   * that fingerprint the UA version would reject a mismatched constant, so the
   * installed version is preferred and a current default is the fallback.
   */
  private resolveUserAgent(): string {
    const version = (process.env.METAPI_BROWSER_UA_VERSION || '').trim() || '154.0.0.0';
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
  }

  private deriveRequestOrigin(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  private mergeSetCookiePairs(cookieHeader: string, setCookieHeaders: string[]): string {
    let merged = cookieHeader;
    for (const raw of setCookieHeaders) {
      if (!raw) continue;
      const firstPair = raw.split(';')[0]?.trim();
      if (!firstPair) continue;
      const eq = firstPair.indexOf('=');
      if (eq <= 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1);
      merged = this.upsertCookie(merged, name, value);
    }
    return merged;
  }

  private parseJsonSafe<T>(text: string): T | null {
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  private extractHtmlErrorSummary(payloadRaw: string): string | null {
    const text = (payloadRaw || '').trim();
    if (!text || !/<html|<!doctype/i.test(text)) return null;

    const titleMatch = text.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    let title = titleMatch?.[1]?.trim() || '';
    if (title.includes('|')) {
      title = title.split('|')[0]?.trim() || title;
    }
    if (!title && /cloudflare tunnel error/i.test(text)) {
      title = 'Cloudflare Tunnel error';
    }
    if (!title) return null;

    const codeMatch = text.match(/<span[^>]*>\s*Error\s*<\/span>\s*<span[^>]*>\s*(\d{3,4})\s*<\/span>/i)
      || text.match(/\bError\s*(\d{3,4})\b/i);
    const code = codeMatch?.[1];
    return code ? `${title} (Error ${code})` : title;
  }

  private formatRequestErrorMessage(err: unknown): string | null {
    const raw = typeof (err as { message?: unknown })?.message === 'string'
      ? (err as { message: string }).message.trim()
      : '';
    if (!raw) return null;

    const httpMatch = raw.match(/^(HTTP\s+\d+):\s*([\s\S]+)$/);
    if (!httpMatch) return raw;

    const [, prefix, payloadRaw] = httpMatch;
    const payload = this.parseJsonSafe<any>(payloadRaw);
    const bodyMessage = this.extractResponseMessage(payload);
    if (bodyMessage) return `${prefix}: ${bodyMessage}`;
    const htmlSummary = this.extractHtmlErrorSummary(payloadRaw);
    if (htmlSummary) return `${prefix}: ${htmlSummary}`;
    return raw;
  }

  private extractResponseMessage(payload: any): string {
    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
    if (typeof payload?.error?.message === 'string' && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload?.msg === 'string' && payload.msg.trim()) {
      return payload.msg.trim();
    }
    return '';
  }

  /**
   * Words a login refusal so an operator can act on it.
   *
   * Forks that cap concurrent sessions answer a second sign-in with `409` and a
   * bare `{"code":"AUTH_SESSION_LIMIT","message":"Conflict"}`. "Conflict" alone
   * reads like a transient clash and says nothing about what to do; the code is
   * the part that names the cause — the account already has a session, and that
   * one has to be signed out before another can be opened.
   */
  private describeLoginRefusal(payload: any): string {
    const message = this.extractResponseMessage(payload)
      || '登录失败：未获取到可用会话凭据，请改用 Cookie/Token 导入';
    const code = typeof payload?.code === 'string' ? payload.code.trim() : '';
    if (!code || message.includes(code)) return message;
    return `${message}（${code}）`;
  }

  private isHtmlJsonParseErrorMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes("unexpected token '<'")
      || (text.includes('not valid json') && (text.includes('<html') || text.includes('<script')))
    );
  }

  private isShieldChallenge(contentType: string, text: string): boolean {
    const ct = (contentType || '').toLowerCase();
    if (ct.includes('text/html') && /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)) {
      return true;
    }
    return /var\s+arg1\s*=/.test(text);
  }

  private normalizeHeaders(headers?: UndiciRequestInit['headers']): Record<string, string> {
    const output: Record<string, string> = {};
    if (!headers) return output;

    if (Array.isArray(headers)) {
      for (const [k, v] of headers) {
        output[String(k)] = String(v);
      }
      return output;
    }

    const maybeIterable = headers as { forEach?: (fn: (v: string, k: string) => void) => void };
    if (typeof maybeIterable.forEach === 'function') {
      maybeIterable.forEach((v, k) => {
        output[String(k)] = String(v);
      });
      return output;
    }

    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      output[k] = String(v);
    }
    return output;
  }

  private hasUsableSessionCookie(cookieHeader: string): boolean {
    if (!cookieHeader) return false;
    const ignored = new Set(['acw_tc', 'acw_sc__v2', 'cdn_sec_tc']);
    const pairs = cookieHeader.split(';').map((part) => part.trim()).filter(Boolean);
    for (const pair of pairs) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim().toLowerCase();
      if (!name || ignored.has(name)) continue;
      if (
        name === 'session'
        || name === 'token'
        || name === 'auth_token'
        || name === 'access_token'
        || name === 'jwt'
        || name === 'jwt_token'
        || name.includes('session')
        || name.includes('token')
        || name.includes('auth')
      ) {
        return true;
      }
    }
    return false;
  }

  private shouldFallbackToCookieCheckin(message?: string | null): boolean {
    if (!message) return true;
    const text = message.toLowerCase();
    return (
      text.includes('unexpected token') ||
      text.includes('not valid json') ||
      text.includes('<html') ||
      text.includes('new-api-user') ||
      text.includes('access token') ||
      text.includes('unauthorized') ||
      text.includes('forbidden') ||
      text.includes('not login') ||
      text.includes('not logged') ||
      text.includes('invalid url (post /api/user/checkin)') ||
      text.includes('invalid url (post /api/user/daily)') ||
      (text.includes('http 404') && (text.includes('/api/user/checkin') || text.includes('/api/user/daily'))) ||
      text.includes('未登录') ||
      text.includes('未提供')
    );
  }

  private isMissingCheckinEndpointMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes('invalid url (post /api/user/checkin)') ||
      text.includes('invalid url (post /api/user/daily)') ||
      (text.includes('http 404') && (text.includes('/api/user/checkin') || text.includes('/api/user/daily'))) ||
      text.includes('checkin endpoint not found') ||
      text.includes('check-in is not supported') ||
      text.includes('checkin is not supported') ||
      text.includes('does not support checkin') ||
      text.includes('not support checkin')
    );
  }

  /**
   * True for a route that simply does not exist on this deployment.
   *
   * Deployments disagree on the check-in route (`/api/user/sign_in` on older
   * forks, `/api/user/checkin` on newer ones, `/api/user/daily` on the
   * QuantumNous-style forks), so the probe that walks them always gets a 404
   * for the foreign routes. That 404 must never outrank a real answer from the
   * route the deployment actually exposes.
   */
  private isMissingRouteMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    if (/^http\s+404:/i.test(text)) return true;
    return /invalid url \(post \/api\/user\/(sign_in|checkin|daily|sota-agent-checkin)\)/.test(text);
  }

  /**
   * True when the deployment exposes the check-in route but the operator has
   * turned the feature off.
   *
   * The message is a configuration verdict rather than a failing account, and
   * it is also the only signal that the daily reward may be waiting behind a
   * fork-specific route instead.
   */
  private isDisabledCheckinFeatureMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      message.includes('签到功能未启用')
      || message.includes('签到未启用')
      || text.includes('checkin is disabled')
      || text.includes('check-in is disabled')
      || text.includes('checkin disabled')
      || text.includes('check-in disabled')
      || text.includes('checkin is not enabled')
      || text.includes('check-in is not enabled')
    );
  }

  /**
   * Answers the daily reward on forks that moved it behind an agent program.
   *
   * SOTA Model keeps a working `/api/user/sota-agent-checkin` while answering
   * "签到功能未启用" on both `/api/user/daily` and `/api/user/checkin`. The probe
   * is only worth a request once the standard routes have reported the feature
   * as off, and deployments that never had the route answer 404, so nothing
   * else is affected.
   */
  private async tryAgentProgramCheckin(
    baseUrl: string,
    headers: Record<string, string>,
    previousFailure?: string | null,
  ): Promise<CheckinResult | null> {
    if (!this.isDisabledCheckinFeatureMessage(previousFailure)) return null;
    let message = '';
    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/sota-agent-checkin`, {
        method: 'POST',
        headers,
      });
      if (res?.success) {
        return {
          success: true,
          message: res.message || 'checkin success',
          reward: this.extractCheckinReward(res),
        };
      }
      message = this.extractResponseMessage(res) || '';
    } catch (err) {
      message = this.formatRequestErrorMessage(err) || '';
    }
    // A deployment without the route keeps the original verdict; an answer from
    // the route (today's reward already claimed, for instance) replaces it.
    if (!message || this.isMissingRouteMessage(message)) return null;
    return { success: false, message };
  }

  /**
   * Pulls the awarded quota out of a check-in response. Official new-api
   * deployments put it in `data.reward`; the QuantumNous-style forks report it
   * as `data.quota_awarded`. Both are raw quota, so they are scaled to the
   * dollar-based reward column the same way `parseBalance` scales balances.
   */
  private extractCheckinReward(payload: any): string | undefined {
    const raw = payload?.data?.reward ?? payload?.data?.quota_awarded;
    return normalizeCheckinReward(raw, QUOTA_PER_UNIT);
  }

  private isCookieSessionFailureMessage(message?: string | null): boolean {
    if (!message) return false;
    const text = message.toLowerCase();
    return (
      text.includes('access token') ||
      text.includes('unauthorized') ||
      text.includes('forbidden') ||
      text.includes('new-api-user') ||
      text.includes('user id') ||
      text.includes('invalid token') ||
      text.includes('expired') ||
      text.includes('无权') ||
      text.includes('未登录') ||
      text.includes('未提供') ||
      text.includes('未授权') ||
      text.includes('not login') ||
      text.includes('not logged')
    );
  }

  private shouldPreferCheckinFailureMessage(
    currentMessage: string | undefined,
    nextMessage: string | null | undefined,
  ): boolean {
    const next = typeof nextMessage === 'string' ? nextMessage.trim() : '';
    if (!next) return false;
    if (!currentMessage) return true;

    if (this.isHtmlJsonParseErrorMessage(currentMessage) && !this.isHtmlJsonParseErrorMessage(next)) {
      return true;
    }

    // A 404 from the *other* check-in route is noise: the very next message is
    // the site's real verdict ("签到功能未启用", "already checked in", ...), and
    // reporting the 404 makes a working account look broken.
    const currentLooksLikeMissingEndpoint =
      this.isMissingCheckinEndpointMessage(currentMessage)
      || this.isMissingRouteMessage(currentMessage);
    if (currentLooksLikeMissingEndpoint && !this.isMissingRouteMessage(next)) {
      return true;
    }
    if (currentLooksLikeMissingEndpoint && this.isCookieSessionFailureMessage(next)) {
      return true;
    }

    return false;
  }

  private async detectCookieSessionFailureMessage(
    baseUrl: string,
    accessToken: string,
    candidateUserIds: Array<number | null | undefined>,
  ): Promise<string | null> {
    let failureMessage: string | null = null;
    const rememberFailure = (message: string) => {
      if (failureMessage) return;
      const text = message.trim();
      if (!this.isCookieSessionFailureMessage(text)) return;
      failureMessage = text;
    };

    const uniqueCandidateUserIds = Array.from(new Set(
      candidateUserIds.filter((value): value is number => typeof value === 'number' && value > 0),
    ));

    if (uniqueCandidateUserIds.length === 0) {
      await this.fetchUserSelfByCookie(baseUrl, accessToken, undefined, rememberFailure);
      return failureMessage;
    }

    for (const userId of uniqueCandidateUserIds) {
      await this.fetchUserSelfByCookie(baseUrl, accessToken, userId, rememberFailure);
      if (failureMessage) {
        return failureMessage;
      }
    }

    return failureMessage;
  }

  private async fetchJsonRawWithCookie<T>(
    url: string,
    options?: UndiciRequestInit,
  ): Promise<JsonFetchOutcome<T>> {
    const retryDelays = this.edgeRateLimitRetryDelaysMs;
    let outcome = await this.performJsonFetch<T>(url, options);
    for (const delayMs of retryDelays) {
      if (!outcome.edgeRateLimited) break;
      await sleep(delayMs);
      outcome = await this.performJsonFetch<T>(url, options);
    }
    return outcome;
  }

  private async performJsonFetch<T>(
    url: string,
    options?: UndiciRequestInit,
  ): Promise<JsonFetchOutcome<T>> {
    const { fetch } = await import('undici');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // Some shields bind the verification cookie to a specific browser build
      // and reject any other UA version, so the configured Chrome version is
      // used instead of a hard-coded one.
      'User-Agent': this.resolveUserAgent(),
      ...this.normalizeHeaders(options?.headers),
    };

    let cookieHeader = headers['Cookie'] || headers['cookie'] || '';
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
      delete headers['cookie'];

    // Some deployments check that a request looks same-origin before serving
    // the management API; their own frontend always calls from the site origin.
    // Without this, a shield-protected site answers 403 even with valid cookies.
    const requestOrigin = this.deriveRequestOrigin(url);
    if (requestOrigin) {
      if (!headers['Origin']) headers['Origin'] = requestOrigin;
      if (!headers['Referer']) headers['Referer'] = requestOrigin + '/';
    }
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestOptions: UndiciRequestInit = {
        ...options,
        body: options?.body ?? undefined,
        headers,
      };
      const proxiedRequestOptions = await withSiteProxyRequestInit(url, requestOptions);
      const res = await fetch(url, proxiedRequestOptions);
      const text = await res.text();
      const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
      if (typeof getSetCookie === 'function') {
        cookieHeader = this.mergeSetCookiePairs(cookieHeader, getSetCookie.call(res.headers) || []);
      }
      const parsed = this.parseJsonSafe<T>(text);
      if (parsed) return { data: parsed, cookieHeader, edgeRateLimited: false };

      // The edge rejects throttled calls before the shield dance runs, so the
      // throttled verdict is checked first: solving another challenge would
      // only spend the quota the edge just refused.
      if (isEdgeRateLimitResponse(res.status, res.headers.get('x-tengine-error'), text)) {
        return { data: null, cookieHeader, edgeRateLimited: true };
      }

      // A Cloudflare-hosted site answers a visitor it has not cleared with its
      // own interstitial, which no cookie arithmetic can satisfy: the clearance
      // is earned by a real browser and, crucially, is bound to the exit IP and
      // the browser's User-Agent. Re-clear it in the managed browser and retry -
      // the refreshed pair is written onto the site record, so the next attempt
      // (through `withSiteProxyRequestInit`) picks it up.
      if (isCloudflareChallengeResponse({
        contentType: res.headers.get('content-type'),
        body: text,
        mitigated: res.headers.get('cf-mitigated'),
      })) {
        const refreshed = await refreshCloudflareClearance(url);
        if (refreshed.ok) continue;
        return { data: null, cookieHeader, edgeRateLimited: false };
      }

      if (!this.isShieldChallenge(res.headers.get('content-type') || '', text)) {
        return { data: null, cookieHeader, edgeRateLimited: false };
      }
      if (!cookieHeader) {
        return { data: null, cookieHeader, edgeRateLimited: false };
      }

      const acwScV2 = this.solveAcwScV2(text);
      if (!acwScV2) {
        return { data: null, cookieHeader, edgeRateLimited: false };
      }
      cookieHeader = this.upsertCookie(cookieHeader, 'acw_sc__v2', acwScV2);
      headers['Cookie'] = cookieHeader;
    }

    return { data: null, cookieHeader, edgeRateLimited: false };
  }

  private async fetchJsonRaw<T>(url: string, options?: UndiciRequestInit): Promise<T | null> {
    const result = await this.fetchJsonRawWithCookie<T>(url, options);
    return result.data;
  }

  /**
   * Reads a management endpoint with whichever credential the account holds.
   *
   * `fetchJsonRaw` is bearer-only, but plenty of accounts are bound through a
   * cookie session, and some deployments answer an unauthenticated caller with a
   * JS challenge instead of JSON (anyrouter.top's edge does). Subclasses that
   * need a site endpoint the generic flows do not touch — /api/status is the
   * usual one — go through here rather than rebuilding the credential shape.
   */
  protected async fetchSiteJson<T>(
    url: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<T | null> {
    try {
      return await this.fetchJsonRaw<T>(url, {
        headers: this.buildCredentialRequestHeaders(accessToken, platformUserId),
      });
    } catch {
      return null;
    }
  }

  /** Headers that carry either a cookie session or a bearer token, plus the id. */
  private buildCredentialRequestHeaders(
    accessToken: string,
    platformUserId?: number,
  ): Record<string, string> {
    const raw = (accessToken || '').trim().startsWith('Bearer ')
      ? (accessToken || '').trim().slice(7).trim()
      : (accessToken || '').trim();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (this.isCookieHeaderCredential(raw)) headers['Cookie'] = raw;
    else headers['Authorization'] = `Bearer ${raw}`;
    this.appendUserIdCompatibilityHeaders(headers, platformUserId);
    return headers;
  }

  private async fetchUserSelfByCookie(
    baseUrl: string,
    token: string,
    platformUserId?: number,
    onFailureMessage?: (message: string) => void,
    edgeProbe?: EdgeRateLimitProbe,
  ): Promise<any | null> {
    for (const cookie of this.buildCookieCandidates(token)) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        this.appendUserIdCompatibilityHeaders(headers, platformUserId);
        const outcome = await this.fetchJsonRawWithCookie<any>(`${baseUrl}/api/user/self`, { headers });
        recordEdgeRateLimit(edgeProbe, outcome);
        const res = outcome.data;
        if (res?.success && res?.data) return res;
        if (typeof res?.message === 'string' && res.message.trim()) {
          onFailureMessage?.(res.message.trim());
        }
      } catch {}
    }
    return null;
  }

  private async probeUserIdByCookie(
    baseUrl: string,
    token: string,
    edgeProbe?: EdgeRateLimitProbe,
  ): Promise<number | null> {
    const candidates = this.buildUserIdProbeCandidates(token);
    for (const cookie of this.buildCookieCandidates(token)) {
      for (const id of candidates) {
        try {
          const headers: Record<string, string> = { Cookie: cookie };
          this.appendUserIdCompatibilityHeaders(headers, id);
          const outcome = await this.fetchJsonRawWithCookie<any>(`${baseUrl}/api/user/self`, { headers });
          recordEdgeRateLimit(edgeProbe, outcome);
          const res = outcome.data;
          if (res?.success && res?.data) return id;
        } catch {}
      }
    }
    return null;
  }

  private async probeAlternateUserIdByCookie(
    baseUrl: string,
    token: string,
    currentUserId?: number | null,
    edgeProbe?: EdgeRateLimitProbe,
  ): Promise<number | null> {
    const probed = await this.probeUserIdByCookie(baseUrl, token, edgeProbe);
    if (!probed) return null;
    if (typeof currentUserId === 'number' && currentUserId > 0 && probed === currentUserId) {
      return null;
    }
    return probed;
  }

  private async getApiTokensByCookie(baseUrl: string, token: string, userId?: number | null): Promise<ApiTokenInfo[]> {
    for (const cookie of this.buildCookieCandidates(token)) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        this.appendUserIdCompatibilityHeaders(headers, userId);
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/?p=0&size=100`, { headers });
        const rawItems = this.parseTokenItems(res);
        await this.revealMaskedTokenKeys(baseUrl, headers, rawItems);
        const normalized = this.normalizeTokenItems(rawItems);
        if (normalized.length > 0) return normalized;
      } catch {}
    }
    return [];
  }

  private async getSessionModelsByCookie(baseUrl: string, token: string, userId?: number | null): Promise<string[]> {
    for (const cookie of this.buildCookieCandidates(token)) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        this.appendUserIdCompatibilityHeaders(headers, userId);
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/models`, { headers });
        if (Array.isArray(res?.data) && res.data.length > 0) return res.data.filter(Boolean);
        if (res?.data && typeof res.data === 'object') {
          const keys = Object.keys(res.data).filter(Boolean);
          if (keys.length > 0) return keys;
        }
      } catch {}
    }
    return [];
  }

  private extractOpenAiModels(payload: any, sourceScope: string): string[] {
    if (!Array.isArray(payload?.data)) return [];
    const contextLengths = extractContextLengthsFromPayload(payload);
    setModelContextLengths(contextLengths, sourceScope);
    return payload.data.map((m: any) => m?.id).filter(Boolean);
  }

  private async getOpenAiModelsViaShieldCookie(
    baseUrl: string,
    token: string,
    sourceScope: string,
  ): Promise<string[]> {
    for (const cookie of this.buildCookieCandidates(token)) {
      try {
        const { data } = await fetchJsonWithShieldCookieRetry<any>(`${baseUrl}/v1/models`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Cookie: cookie,
          },
        });
        const models = this.extractOpenAiModels(data, sourceScope);
        if (models.length > 0) return models;
      } catch {}
    }
    return [];
  }

  private async getOpenAiModels(baseUrl: string, token: string, contextSourceScope?: string): Promise<string[]> {
    const sourceScope = contextSourceScope || buildEndpointModelContextLengthScope(baseUrl);
    const shouldTryShieldCookie = this.platformName === 'anyrouter' || token.includes('=');
    if (shouldTryShieldCookie) {
      const shieldModels = await this.getOpenAiModelsViaShieldCookie(baseUrl, token, sourceScope);
      if (shieldModels.length > 0) return shieldModels;
    }

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return this.extractOpenAiModels(res, sourceScope);
    } catch {
      return [];
    }
  }

  private async discoverUserId(baseUrl: string, accessToken: string): Promise<number | null> {
    const jwtId = this.tryDecodeUserId(accessToken);
    if (jwtId) {
      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
          headers: this.authHeaders(accessToken, jwtId),
        });
        if (res?.success && res?.data) return jwtId;
      } catch {}
    }

    try {
      const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res?.success && res?.data?.id) return res.data.id;
    } catch {}

    try {
      const cookieRes = await this.fetchUserSelfByCookie(baseUrl, accessToken);
      if (cookieRes?.success && cookieRes?.data?.id) return cookieRes.data.id;
    } catch {}

    const cookieId = await this.probeUserIdByCookie(baseUrl, accessToken);
    if (cookieId) return cookieId;

    return null;
  }

  override async getUserInfo(baseUrl: string, accessToken: string, platformUserId?: number): Promise<UserInfo | null> {
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    try {
      const directRes = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (directRes?.success && directRes?.data) {
        return this.parseUserInfo(directRes.data);
      }
    } catch {}

    try {
      const cookieRes = await this.fetchUserSelfByCookie(baseUrl, accessToken, platformUserId);
      if (cookieRes?.success && cookieRes?.data) {
        return this.parseUserInfo(cookieRes.data);
      }
    } catch {}

    try {
      const fallbackUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, platformUserId);
      if (fallbackUserId) {
        const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, accessToken, fallbackUserId);
        if (cookieRetry?.success && cookieRetry?.data) {
          return this.parseUserInfo(cookieRetry.data);
        }
      }
    } catch {}

    return null;
  }

  override async login(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<LoginResult> {
    try {
      const { data: res, cookieHeader } = await this.fetchJsonRawWithCookie<any>(`${baseUrl}/api/user/login`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (!res) {
        return {
          success: false,
          // The site answered the login POST with its anti-bot challenge page
          // instead of a verdict. Only a browser can clear that, so the wording
          // has to say "challenge" for the caller to reach for one.
          message: '登录被站点人机校验拦截（shield challenge blocked login）',
        };
      }

      const accessToken = this.extractLoginAccessToken(res);
      const platformUserId = this.extractLoginUserId(res);
      // Every sign-in also mints a server-side session, and newer deployments
      // hand back a rotatable `new_api_refresh` cookie as the durable credential
      // while the body token is a 15 minute JWT. Storing the JWT makes the
      // account sign in again the moment it lapses, and each of those sign-ins
      // adds another entry to the site's concurrent-session list — on a fork
      // that caps that list the account eventually locks itself out with
      // `AUTH_SESSION_LIMIT`. The cookie is exchangeable for access tokens
      // indefinitely, so it is the one worth keeping; the JWT is reported
      // alongside for the work this flow does before the first exchange.
      const refreshCookie = this.readRefreshCookieValue(cookieHeader);
      if (res?.success && refreshCookie) {
        return {
          success: true,
          accessToken: `new_api_refresh=${refreshCookie}`,
          bearerToken: accessToken || undefined,
          username,
          platformUserId,
        };
      }
      if (res?.success && accessToken) {
        return {
          success: true,
          accessToken,
          username,
          platformUserId,
        };
      }
      if (res?.success && this.hasUsableSessionCookie(cookieHeader)) {
        return {
          success: true,
          accessToken: cookieHeader,
          username,
          platformUserId,
        };
      }

      return {
        success: false,
        message: this.describeLoginRefusal(res),
      };
    } catch (err: any) {
      return {
        success: false,
        message: this.formatRequestErrorMessage(err) || err?.message || '登录请求失败',
      };
    }
  }

  /**
   * Reads the account's sign-in sessions.
   *
   * A fork that caps concurrent sessions lists them here so the operator can
   * sign the others out. Nothing else in the API exposes the cap or the session
   * ids, so a site that answers 404 is simply one without the feature — the
   * caller gets `null` rather than an error to interpret.
   */
  async listSessions(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
  ): Promise<SiteSessionInfo[] | null> {
    // The caller may hold the rotatable cookie rather than an access token, and
    // this endpoint is reachable before the cookie has been exchanged.
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    try {
      const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/sessions`, {
        method: 'GET',
        headers: this.authHeaders(accessToken, platformUserId),
      });
      const rows = Array.isArray(res?.data) ? res.data : null;
      if (!rows) return null;

      return rows
        .map((row: any): SiteSessionInfo | null => {
          const sid = typeof row?.sid === 'string' ? row.sid.trim() : '';
          if (!sid) return null;
          return {
            sid,
            current: row?.current === true,
            loginMethod: typeof row?.login_method === 'string' ? row.login_method : null,
            ip: typeof row?.ip === 'string' ? row.ip : null,
            userAgent: typeof row?.user_agent === 'string' ? row.user_agent : null,
            createdAt: toNullableNumber(row?.created_at),
            lastActiveAt: toNullableNumber(row?.last_active_at),
            expiresAt: toNullableNumber(row?.expires_at),
          };
        })
        .filter((row: SiteSessionInfo | null): row is SiteSessionInfo => row !== null);
    } catch {
      return null;
    }
  }

  /**
   * Retires one session. A session that is already gone counts as retired: the
   * goal is that it can no longer be counted against the cap, and a second
   * cleanup pass racing the first must not report a failure for work already
   * done.
   */
  async revokeSession(
    baseUrl: string,
    accessToken: string,
    platformUserId: number | undefined,
    sid: string,
  ): Promise<boolean> {
    if (!sid) return false;
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    try {
      const res = await this.fetchJsonRaw<any>(
        `${baseUrl}/api/user/sessions/${encodeURIComponent(sid)}`,
        { method: 'DELETE', headers: this.authHeaders(accessToken, platformUserId) },
      );
      if (res && (res.success === true || res.code === 'AUTH_SESSION_NOT_FOUND')) return true;
      if (res?.code === 'AUTH_SESSION_NOT_FOUND') return true;
      return Boolean(res?.success);
    } catch {
      return false;
    }
  }

  override async verifyToken(baseUrl: string, token: string, platformUserId?: number): Promise<TokenVerifyResult> {
    // A `new_api_refresh` cookie is not itself a usable credential; swap it for
    // a bearer token first so downstream calls see a normal session.
    const resolvedToken = await this.resolveBearerToken(baseUrl, token);
    const edgeProbe: EdgeRateLimitProbe = { edgeRateLimited: false };

    const openAiModels = await this.getOpenAiModels(baseUrl, resolvedToken);
    if (openAiModels.length > 0) {
      return { tokenType: 'apikey', models: openAiModels };
    }

    try {
      const directOutcome = await this.fetchJsonRawWithCookie<any>(`${baseUrl}/api/user/self`, {
        headers: { Authorization: `Bearer ${resolvedToken}` },
      });
      recordEdgeRateLimit(edgeProbe, directOutcome);
      const directRes = directOutcome.data;
      if (directRes?.success && directRes?.data) {
        const userId = directRes.data.id;
        const userInfo = this.parseUserInfo(directRes.data);
        const balance = this.parseBalance(directRes.data);
        let apiToken: string | null = null;
        try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
        return { tokenType: 'session', userInfo, balance, apiToken };
      }

      if (directRes?.message?.includes('New-Api-User')) {
        const userId = platformUserId || await this.probeUserId(baseUrl, token);
        if (userId) {
          const retryOutcome = await this.fetchJsonRawWithCookie<any>(`${baseUrl}/api/user/self`, {
            headers: this.authHeaders(token, userId),
          });
          recordEdgeRateLimit(edgeProbe, retryOutcome);
          const res = retryOutcome.data;
          if (res?.success && res?.data) {
            const userInfo = this.parseUserInfo(res.data);
            const balance = this.parseBalance(res.data);
            let apiToken: string | null = null;
            try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
            return { tokenType: 'session', userInfo, balance, apiToken };
          }
          if (
            platformUserId &&
            typeof res?.message === 'string' &&
            /娑撳秴灏柊宄緈ismatch/i.test(res.message)
          ) {
            return { tokenType: 'unknown' };
          }
        }
      }
    } catch {}

    const cookieRes = await this.fetchUserSelfByCookie(baseUrl, token, platformUserId, undefined, edgeProbe);
    if (cookieRes?.success && cookieRes?.data) {
      const userId = cookieRes.data.id;
      const userInfo = this.parseUserInfo(cookieRes.data);
      const balance = this.parseBalance(cookieRes.data);
      let apiToken: string | null = null;
      try { apiToken = await this.getApiTokenWithUser(baseUrl, token, userId); } catch {}
      return { tokenType: 'session', userInfo, balance, apiToken };
    }

    const cookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, token, platformUserId, edgeProbe);
    if (cookieUserId) {
      const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, token, cookieUserId, undefined, edgeProbe);
      if (cookieRetry?.success && cookieRetry?.data) {
        const userInfo = this.parseUserInfo(cookieRetry.data);
        const balance = this.parseBalance(cookieRetry.data);
        let apiToken: string | null = null;
        try { apiToken = await this.getApiTokenWithUser(baseUrl, token, cookieUserId); } catch {}
        return { tokenType: 'session', userInfo, balance, apiToken };
      }
    }

    // Throttling is a statement about the site, not about the credential, so it
    // is reported separately instead of being folded into "unknown".
    if (edgeProbe.edgeRateLimited) {
      return { tokenType: 'unknown', failureReason: 'rate-limited' };
    }
    return { tokenType: 'unknown' };
  }

  private async probeUserId(baseUrl: string, accessToken: string): Promise<number | null> {
    const jwtId = this.tryDecodeUserId(accessToken);
    if (jwtId) {
      const valid = await this.testUserId(baseUrl, accessToken, jwtId);
      if (valid) return jwtId;
    }

    for (const id of this.buildUserIdProbeCandidates(accessToken)) {
      if (id === jwtId) continue;
      if (await this.testUserId(baseUrl, accessToken, id)) return id;
    }

    return null;
  }

  private async testUserId(baseUrl: string, accessToken: string, userId: number): Promise<boolean> {
    try {
      const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self`, {
        headers: this.authHeaders(accessToken, userId),
      });
      return res?.success === true && !!res?.data;
    } catch {
      return false;
    }
  }

  async checkin(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    context?: CheckinContext,
  ): Promise<CheckinResult> {
    // A site may hand its daily check-in to a separate welfare deployment
    // (`up.x666.me` for x666.me). That wheel speaks its own protocol and
    // authenticates with its own Linux.do session, so when one is declared the
    // relay's own check-in route is not what the operator wants run.
    const externalCheckinUrl = (context?.externalCheckinUrl || '').trim();
    if (externalCheckinUrl) {
      const session = getExternalCheckinSessionFromExtraConfig(context?.extraConfig);
      if (!session) {
        return {
          success: false,
          message: '外部签到站会话未绑定：请先完成签到站的 Linux.do 授权，再重试签到',
        };
      }
      return runMintWheelCheckin(externalCheckinUrl, session);
    }

    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    let firstFailureMessage: string | undefined;
    const rememberFailure = (message?: string | null) => {
      if (this.shouldPreferCheckinFailureMessage(firstFailureMessage, message)) {
        firstFailureMessage = String(message).trim();
      }
    };

    const rawCredential = (accessToken || '').trim().startsWith('Bearer ')
      ? (accessToken || '').trim().slice(7).trim()
      : (accessToken || '').trim();
    if (!this.isCookieHeaderCredential(rawCredential)) {
      const headers = this.authHeaders(accessToken, resolvedUserId || undefined);

      // QuantumNous-style forks moved the real check-in endpoint to
      // /api/user/daily; their legacy /api/user/checkin answers "success"
      // without persisting anything. Prefer daily, and only fall through to
      // the legacy route when daily is missing or gives no verdict.
      let dailyRouteMissing = false;
      let dailyRouteAnswered = false;
      try {
        const dailyRes = await this.fetchJson<any>(`${baseUrl}/api/user/daily`, {
          method: 'POST',
          headers,
        });
        if (dailyRes?.success) {
          return {
            success: true,
            message: dailyRes.message || 'checkin success',
            reward: this.extractCheckinReward(dailyRes),
          };
        }
        const dailyMessage = this.extractResponseMessage(dailyRes);
        dailyRouteMissing = this.isMissingRouteMessage(dailyMessage);
        dailyRouteAnswered = !!dailyMessage && !dailyRouteMissing;
        if (!dailyRouteMissing) rememberFailure(dailyMessage);
      } catch (err) {
        const parsed = this.formatRequestErrorMessage(err);
        dailyRouteMissing = this.isMissingRouteMessage(parsed);
        dailyRouteAnswered = !!parsed && !dailyRouteMissing;
        if (!dailyRouteMissing) rememberFailure(parsed);
      }

      if (!dailyRouteAnswered) {
        try {
          const res = await this.fetchJson<any>(`${baseUrl}/api/user/checkin`, {
            method: 'POST',
            headers,
          });
          if (res?.success) {
            return {
              success: true,
              message: res.message || 'checkin success',
              reward: this.extractCheckinReward(res),
            };
          }
          const directMessage = this.extractResponseMessage(res);
          rememberFailure(directMessage);
        } catch (err) {
          const parsed = this.formatRequestErrorMessage(err);
          rememberFailure(parsed);
        }
      }

      // Some forks switch the generic check-in off and pay the daily reward
      // through their own agent program instead. SOTA Model answers
      // "签到功能未启用" on both standard routes while
      // /api/user/sota-agent-checkin still pays out, so the disabled-feature
      // verdict is what triggers the probe. The probe runs only on that verdict,
      // and a deployment without the route answers 404, which is ignored.
      const agentResult = await this.tryAgentProgramCheckin(
        baseUrl,
        headers,
        firstFailureMessage,
      );
      if (agentResult) return agentResult;
    }

    if (firstFailureMessage && !this.shouldFallbackToCookieCheckin(firstFailureMessage)) {
      return { success: false, message: firstFailureMessage };
    }

    const tryCookieCheckin = async (cookieUserId?: number | null): Promise<CheckinResult | null> => {
      for (const cookie of this.buildCookieCandidates(accessToken)) {
        try {
          const headers: Record<string, string> = {
            Cookie: cookie,
            'X-Requested-With': 'XMLHttpRequest',
          };
          this.appendUserIdCompatibilityHeaders(headers, cookieUserId);
          const signInRes = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/sign_in`, {
            method: 'POST',
            body: '{}',
            headers,
          });
          if (signInRes?.success) {
            return {
              success: true,
              message: signInRes.message || 'checked in',
              reward: this.extractCheckinReward(signInRes),
            };
          }
          const signInMessage = this.extractResponseMessage(signInRes);
          rememberFailure(signInMessage);
        } catch (err) {
          const parsed = this.formatRequestErrorMessage(err);
          rememberFailure(parsed);
        }

        // Same fork split as the bearer path: consult /api/user/daily before
        // the legacy route, which cannot be trusted on these forks.
        let dailyMissing = false;
        let dailyAnswered = false;
        try {
          const headers: Record<string, string> = {
            Cookie: cookie,
            'X-Requested-With': 'XMLHttpRequest',
          };
          this.appendUserIdCompatibilityHeaders(headers, cookieUserId);
          const dailyRes = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/daily`, {
            method: 'POST',
            headers,
          });
          if (dailyRes?.success) {
            return {
              success: true,
              message: dailyRes.message || 'checkin success',
              reward: this.extractCheckinReward(dailyRes),
            };
          }
          const dailyMessage = this.extractResponseMessage(dailyRes);
          dailyMissing = this.isMissingRouteMessage(dailyMessage);
          dailyAnswered = !!dailyMessage && !dailyMissing;
          if (!dailyMissing) rememberFailure(dailyMessage);
        } catch (err) {
          const parsed = this.formatRequestErrorMessage(err);
          dailyMissing = this.isMissingRouteMessage(parsed);
          dailyAnswered = !!parsed && !dailyMissing;
          if (!dailyMissing) rememberFailure(parsed);
        }

        if (!dailyAnswered) {
          try {
            const headers: Record<string, string> = { Cookie: cookie };
            this.appendUserIdCompatibilityHeaders(headers, cookieUserId);
            const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/checkin`, {
              method: 'POST',
              headers,
            });
            if (res?.success) {
              return {
                success: true,
                message: res.message || 'checkin success',
                reward: this.extractCheckinReward(res),
              };
            }
            const cookieMessage = this.extractResponseMessage(res);
            rememberFailure(cookieMessage);
          } catch (err) {
            const parsed = this.formatRequestErrorMessage(err);
            rememberFailure(parsed);
          }
        }
      }

      return null;
    };

    const initialCookieResult = await tryCookieCheckin(resolvedUserId);
    if (initialCookieResult) return initialCookieResult;

    const alternateCookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, resolvedUserId);
    if (alternateCookieUserId) {
      const retriedCookieResult = await tryCookieCheckin(alternateCookieUserId);
      if (retriedCookieResult) return retriedCookieResult;
    }

    if (this.isMissingCheckinEndpointMessage(firstFailureMessage)) {
      const cookieSessionFailureMessage = await this.detectCookieSessionFailureMessage(
        baseUrl,
        accessToken,
        [resolvedUserId, alternateCookieUserId],
      );
      if (cookieSessionFailureMessage) {
        return { success: false, message: cookieSessionFailureMessage };
      }
    }

    return { success: false, message: firstFailureMessage || 'checkin failed' };
  }

  async getBalance(baseUrl: string, accessToken: string, platformUserId?: number): Promise<BalanceInfo> {
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    let failureMessage: string | null = null;
    const rememberFailure = (message?: string | null) => {
      const text = typeof message === 'string' ? message.trim() : '';
      if (!text) return;
      if (!failureMessage) {
        failureMessage = text;
        return;
      }
      if (this.isHtmlJsonParseErrorMessage(failureMessage) && !this.isHtmlJsonParseErrorMessage(text)) {
        failureMessage = text;
      }
    };

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/self`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success && res?.data) {
        return this.parseBalance(res.data);
      }
      rememberFailure(typeof res?.message === 'string' ? res.message : null);
    } catch (err) {
      rememberFailure(this.formatRequestErrorMessage(err));
    }

    const cookieRes = await this.fetchUserSelfByCookie(
      baseUrl,
      accessToken,
      resolvedUserId || undefined,
      rememberFailure,
    );
    if (cookieRes?.success && cookieRes?.data) {
      return this.parseBalance(cookieRes.data);
    }

    const cookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, resolvedUserId);
    if (cookieUserId) {
      const cookieRetry = await this.fetchUserSelfByCookie(baseUrl, accessToken, cookieUserId, rememberFailure);
      if (cookieRetry?.success && cookieRetry?.data) {
        return this.parseBalance(cookieRetry.data);
      }
    }

    throw new Error(failureMessage || 'failed to fetch balance');
  }

  async getModels(
    baseUrl: string,
    token: string,
    platformUserId?: number,
    contextSourceScope?: string,
  ): Promise<string[]> {
     token = await this.resolveBearerToken(baseUrl,  token);
    const openAiModels = await this.getOpenAiModels(baseUrl, token, contextSourceScope);
    if (openAiModels.length > 0) return openAiModels;

    const userId = platformUserId || await this.discoverUserId(baseUrl, token);
    if (userId) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}/api/user/models`, {
          headers: this.authHeaders(token, userId),
        });
        if (Array.isArray(res?.data)) {
          return res.data.filter(Boolean);
        }
        if (res?.data && typeof res.data === 'object') {
          return Object.keys(res.data).filter(Boolean);
        }
      } catch {}
    }

    const cookieModels = await this.getSessionModelsByCookie(baseUrl, token, userId || platformUserId);
    if (cookieModels.length > 0) return cookieModels;

    const alternateCookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, token, userId || platformUserId);
    if (alternateCookieUserId) {
      const fallbackModels = await this.getSessionModelsByCookie(baseUrl, token, alternateCookieUserId);
      if (fallbackModels.length > 0) return fallbackModels;
    }

    return [];
  }

  async getApiToken(baseUrl: string, accessToken: string, platformUserId?: number): Promise<string | null> {
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    const userId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    const tokens = await this.getApiTokensWithUser(baseUrl, accessToken, userId);
    return tokens.find((token) => token.enabled !== false)?.key || tokens[0]?.key || null;
  }

  async getApiTokens(baseUrl: string, accessToken: string, platformUserId?: number): Promise<ApiTokenInfo[]> {
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    const userId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    return this.getApiTokensWithUser(baseUrl, accessToken, userId);
  }

  private async getApiTokenWithUser(baseUrl: string, accessToken: string, userId: number | null): Promise<string | null> {
    const tokens = await this.getApiTokensWithUser(baseUrl, accessToken, userId);
    return tokens.find((token) => token.enabled !== false)?.key || tokens[0]?.key || null;
  }

  async createApiToken(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    options?: CreateApiTokenOptions,
  ): Promise<boolean> {
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    const payload = JSON.stringify(this.buildDefaultTokenPayload(options));
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/token/`, {
        method: 'POST',
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
        body: payload,
      });
      if (res?.success) return true;
    } catch {}

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    for (const cookie of this.buildCookieCandidates(accessToken)) {
      try {
        const headers: Record<string, string> = { Cookie: cookie };
        this.appendUserIdCompatibilityHeaders(headers, cookieUserId);
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/`, {
          method: 'POST',
          headers,
          body: payload,
        });
        if (res?.success) return true;
      } catch {}
    }

    return false;
  }

  async getUserGroups(baseUrl: string, accessToken: string, platformUserId?: number): Promise<string[]> {
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);
    const dedupe = (groups: string[]) => Array.from(new Set(groups.map((item) => item.trim()).filter(Boolean)));
    let terminalError: string | null = null;

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user/self/groups`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success === false) {
        terminalError = this.resolveGroupFetchErrorMessage(res);
      }
      const parsed = dedupe(this.parseGroupKeys(res));
      if (parsed.length > 0) return parsed;
    } catch {}

    try {
      const res = await this.fetchJson<any>(`${baseUrl}/api/user_group_map`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      if (res?.success === false) {
        terminalError = this.resolveGroupFetchErrorMessage(res);
      }
      const parsed = dedupe(this.parseGroupKeys(res));
      if (parsed.length > 0) return parsed;
    } catch {}

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    for (const cookie of this.buildCookieCandidates(accessToken)) {
      const headers: Record<string, string> = { Cookie: cookie };
      this.appendUserIdCompatibilityHeaders(headers, cookieUserId);

      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user/self/groups`, { headers });
        if (res?.success === false) {
          terminalError = this.resolveGroupFetchErrorMessage(res);
        }
        const parsed = dedupe(this.parseGroupKeys(res));
        if (parsed.length > 0) return parsed;
      } catch {}

      try {
        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/user_group_map`, { headers });
        if (res?.success === false) {
          terminalError = this.resolveGroupFetchErrorMessage(res);
        }
        const parsed = dedupe(this.parseGroupKeys(res));
        if (parsed.length > 0) return parsed;
      } catch {}
    }

    if (terminalError) {
      throw new Error(terminalError);
    }

    return ['default'];
  }

  async deleteApiToken(
    baseUrl: string,
    accessToken: string,
    tokenKey: string,
    platformUserId?: number,
  ): Promise<boolean> {
    accessToken = await this.resolveBearerToken(baseUrl, accessToken);
    const targetKey = this.normalizeTokenKeyForCompare(tokenKey);
    if (!targetKey) return false;
    const resolvedUserId = platformUserId || await this.discoverUserId(baseUrl, accessToken);

    const pickTokenId = (items: any[]): number | null => {
      for (const item of items) {
        const key = this.normalizeTokenKeyForCompare(item?.key);
        const id = Number.parseInt(String(item?.id), 10);
        if (key && key === targetKey && Number.isFinite(id) && id > 0) {
          return id;
        }
      }
      return null;
    };

    let tokenId: number | null = null;

    try {
      const list = await this.fetchJson<any>(`${baseUrl}/api/token/?p=0&size=100`, {
        headers: this.authHeaders(accessToken, resolvedUserId || undefined),
      });
      tokenId = pickTokenId(this.parseTokenItems(list));
      if (tokenId) {
        const res = await this.fetchJson<any>(`${baseUrl}/api/token/${tokenId}`, {
          method: 'DELETE',
          headers: this.authHeaders(accessToken, resolvedUserId || undefined),
        });
        return !!res?.success;
      }
    } catch {}

    const cookieUserId = resolvedUserId || await this.probeUserIdByCookie(baseUrl, accessToken);
    for (const cookie of this.buildCookieCandidates(accessToken)) {
      const headers: Record<string, string> = { Cookie: cookie };
      this.appendUserIdCompatibilityHeaders(headers, cookieUserId);

      try {
        if (!tokenId) {
          const list = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/?p=0&size=100`, { headers });
          tokenId = pickTokenId(this.parseTokenItems(list));
        }

        if (!tokenId) continue;

        const res = await this.fetchJsonRaw<any>(`${baseUrl}/api/token/${tokenId}`, {
          method: 'DELETE',
          headers,
        });
        if (res?.success) return true;
      } catch {}
    }

    // Upstream key already absent means local deletion is safe.
    if (!tokenId) return true;
    return false;
  }

  private async getApiTokensWithUser(baseUrl: string, accessToken: string, userId: number | null): Promise<ApiTokenInfo[]> {
    try {
      const headers = this.authHeaders(accessToken, userId || undefined);
      const res = await this.fetchJson<any>(`${baseUrl}/api/token/?p=0&size=100`, { headers });
      const rawItems = this.parseTokenItems(res);
      await this.revealMaskedTokenKeys(baseUrl, headers, rawItems);
      const normalized = this.normalizeTokenItems(rawItems);
      if (normalized.length > 0) return normalized;
      if (this.isTokenListResponse(res)) return [];
    } catch {}

    const cookieTokens = await this.getApiTokensByCookie(baseUrl, accessToken, userId);
    if (cookieTokens.length > 0) return cookieTokens;

    const alternateCookieUserId = await this.probeAlternateUserIdByCookie(baseUrl, accessToken, userId);
    if (alternateCookieUserId) {
      const fallbackTokens = await this.getApiTokensByCookie(baseUrl, accessToken, alternateCookieUserId);
      if (fallbackTokens.length > 0) return fallbackTokens;
    }

    return [];
  }
}

/**
 * Timestamps on this family of endpoints are Unix seconds. Anything else is
 * treated as absent rather than coerced, so a site that changes the shape
 * degrades to "unknown" instead of reporting a 1970 activation.
 */
function toNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
