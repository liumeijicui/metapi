import {
  ApiTokenInfo,
  BasePlatformAdapter,
  CheckinResult,
  BalanceInfo,
  CreateApiTokenOptions,
  LotteryDrawOutcome,
  LotteryDrawRequest,
  LotteryStatus,
  SubscriptionPlanSummary,
  SubscriptionSummary,
  type SiteAnnouncement,
  UserInfo,
} from './base.js';
import type { CheckinContext, LoginResult } from './base.js';
import { stripTrailingSlashes } from '../urlNormalization.js';
import { getExternalCheckinSessionFromExtraConfig } from '../accountExtraConfig.js';
import { withSiteProxyRequestInit } from '../siteProxy.js';
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici';
import {
  buildEndpointModelContextLengthScope,
  extractContextLengthsFromPayload,
  setModelContextLengths,
} from '../modelContextLengthCache.js';

function normalizeBaseUrl(baseUrl: string): string {
  return stripTrailingSlashes(baseUrl || '');
}

/**
 * Sub2API adapter.
 *
 * Sub2API uses JWT-based auth with endpoints under /api/v1/*.
 * Login accepts the site's email/password form. Sites that run the platform's
 * own daily check-in are served by /api/v1/check-in; sites that delegate it to
 * a separate welfare service declare it as `externalCheckinUrl` and the
 * welfare session is captured on the account (`extraConfig.externalCheckin`).
 * Balance is derived from a USD amount returned by /api/v1/auth/me.
 */
export class Sub2ApiAdapter extends BasePlatformAdapter {
  readonly platformName = 'sub2api';

  private roundCurrency(value: number): number {
    return Math.round(value * 1_000_000) / 1_000_000;
  }

  private parsePositiveInteger(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return undefined;
  }

  private parseNonNegativeInteger(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
    if (typeof raw === 'string') {
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
    }
    return undefined;
  }

  private parseNonNegativeNumber(raw: unknown): number | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      return this.roundCurrency(raw);
    }
    if (typeof raw === 'string') {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed) && parsed >= 0) {
        return this.roundCurrency(parsed);
      }
    }
    return undefined;
  }

  private parseDateTime(raw: unknown): string | undefined {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
      const ms = raw > 10_000_000_000 ? raw : raw * 1000;
      return new Date(ms).toISOString();
    }
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      const ms = numeric > 10_000_000_000 ? numeric : numeric * 1000;
      return new Date(ms).toISOString();
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    return undefined;
  }

  private parseSubscriptionItem(raw: unknown): SubscriptionPlanSummary | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const item = raw as Record<string, unknown>;
    const group = item.group && typeof item.group === 'object' && !Array.isArray(item.group)
      ? item.group as Record<string, unknown>
      : null;

    const normalized: SubscriptionPlanSummary = {};

    const id = this.parsePositiveInteger(item.id);
    if (id) normalized.id = id;

    const groupId = this.parsePositiveInteger(item.group_id ?? item.groupId ?? group?.id);
    if (groupId) normalized.groupId = groupId;

    const groupNameCandidates = [
      item.group_name,
      item.groupName,
      item.name,
      item.title,
      group?.name,
      group?.title,
    ];
    for (const candidate of groupNameCandidates) {
      if (typeof candidate !== 'string') continue;
      const trimmed = candidate.trim();
      if (!trimmed) continue;
      normalized.groupName = trimmed;
      break;
    }

    if (typeof item.status === 'string' && item.status.trim()) {
      normalized.status = item.status.trim();
    }

    const expiresAt = this.parseDateTime(
      item.expires_at
      ?? item.expiresAt
      ?? item.expired_at
      ?? item.expiredAt
      ?? item.end_at
      ?? item.endAt
      ?? item.end_time
      ?? item.endTime
      ?? item.current_period_end
      ?? item.currentPeriodEnd,
    );
    if (expiresAt) normalized.expiresAt = expiresAt;

    const dailyUsedUsd = this.parseNonNegativeNumber(item.daily_used_usd ?? item.dailyUsedUsd);
    if (dailyUsedUsd !== undefined) normalized.dailyUsedUsd = dailyUsedUsd;

    const dailyLimitUsd = this.parseNonNegativeNumber(item.daily_limit_usd ?? item.dailyLimitUsd);
    if (dailyLimitUsd !== undefined) normalized.dailyLimitUsd = dailyLimitUsd;

    const weeklyUsedUsd = this.parseNonNegativeNumber(item.weekly_used_usd ?? item.weeklyUsedUsd);
    if (weeklyUsedUsd !== undefined) normalized.weeklyUsedUsd = weeklyUsedUsd;

    const weeklyLimitUsd = this.parseNonNegativeNumber(item.weekly_limit_usd ?? item.weeklyLimitUsd);
    if (weeklyLimitUsd !== undefined) normalized.weeklyLimitUsd = weeklyLimitUsd;

    const monthlyUsedUsd = this.parseNonNegativeNumber(
      item.monthly_used_usd
      ?? item.monthlyUsedUsd
      ?? item.used_usd
      ?? item.usedUsd
      ?? item.total_used_usd
      ?? item.totalUsedUsd,
    );
    if (monthlyUsedUsd !== undefined) normalized.monthlyUsedUsd = monthlyUsedUsd;

    const monthlyLimitUsd = this.parseNonNegativeNumber(
      item.monthly_limit_usd
      ?? item.monthlyLimitUsd
      ?? item.limit_usd
      ?? item.limitUsd
      ?? item.total_limit_usd
      ?? item.totalLimitUsd,
    );
    if (monthlyLimitUsd !== undefined) normalized.monthlyLimitUsd = monthlyLimitUsd;

    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  private parseSubscriptionItems(raw: unknown): SubscriptionPlanSummary[] {
    const rawItems = (() => {
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object') {
        const body = raw as Record<string, unknown>;
        if (Array.isArray(body.subscriptions)) return body.subscriptions;
        if (Array.isArray(body.items)) return body.items;
        if (Array.isArray(body.list)) return body.list;
        if (Array.isArray(body.data)) return body.data;
      }
      return [];
    })();

    return rawItems
      .map((item) => this.parseSubscriptionItem(item))
      .filter((item): item is SubscriptionPlanSummary => !!item);
  }

  private buildSubscriptionSummary(payload: unknown): SubscriptionSummary {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const subscriptions = this.parseSubscriptionItems(payload);
    const activeCount = this.parseNonNegativeInteger(body.active_count ?? body.activeCount);
    const totalUsedUsd = this.parseNonNegativeNumber(body.total_used_usd ?? body.totalUsedUsd);
    const inferredUsedUsd = subscriptions.reduce((sum, item) => sum + (item.monthlyUsedUsd || 0), 0);

    return {
      activeCount: activeCount ?? subscriptions.length,
      totalUsedUsd: totalUsedUsd ?? this.roundCurrency(inferredUsedUsd),
      subscriptions,
    };
  }

  private async fetchSubscriptionSummary(baseUrl: string, accessToken: string): Promise<SubscriptionSummary | undefined> {
    const headers = this.buildAuthHeader(accessToken);
    const summaryEndpoint = '/api/v1/subscriptions/summary';

    try {
      const res = await this.fetchJson<any>(`${baseUrl}${summaryEndpoint}`, { headers });
      const data = this.parseSub2ApiEnvelope<any>(res, summaryEndpoint);
      return this.buildSubscriptionSummary(data);
    } catch {}

    const fallbackEndpoints = ['/api/v1/subscriptions/active'];
    for (const endpoint of fallbackEndpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, { headers });
        const data = this.parseSub2ApiEnvelope<any>(res, endpoint);
        return this.buildSubscriptionSummary(data);
      } catch {}
    }

    return undefined;
  }

  private stripBearerPrefix(value?: string | null): string {
    const trimmed = (value || '').trim();
    if (!trimmed) return '';
    return trimmed.replace(/^bearer\s+/i, '').trim();
  }

  private normalizeTokenKeyForCompare(value?: string | null): string {
    return this.stripBearerPrefix(value);
  }

  private buildAuthHeader(accessToken: string): Record<string, string> {
    const normalized = this.stripBearerPrefix(accessToken);
    return { Authorization: `Bearer ${normalized}` };
  }

  private parseTokenEnabled(status: unknown): boolean {
    if (typeof status === 'boolean') return status;
    if (typeof status === 'number') return status === 1;
    if (typeof status !== 'string') return true;
    const normalized = status.trim().toLowerCase();
    if (!normalized) return true;
    if (['inactive', 'disabled', 'false', '0', 'off'].includes(normalized)) return false;
    if (['active', 'enabled', 'true', '1', 'on'].includes(normalized)) return true;
    return true;
  }

  private parseTokenItems(payload: any): Array<{ id: number; key: string; name: string; enabled: boolean; tokenGroup: string | null }> {
    const source = payload?.data ?? payload;
    const rawItems = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.list)) return source.list;
      if (Array.isArray(source?.data)) return source.data;
      return [];
    })();

    const items: Array<{ id: number; key: string; name: string; enabled: boolean; tokenGroup: string | null }> = [];
    for (const item of rawItems) {
      const key = typeof item?.key === 'string' ? item.key.trim() : '';
      if (!key) continue;
      const id = Number.parseInt(String(item?.id), 10);
      if (!Number.isFinite(id) || id <= 0) continue;
      const name = typeof item?.name === 'string' && item.name.trim()
        ? item.name.trim()
        : `token-${id}`;
      const tokenGroup = (() => {
        const fromNumeric = Number.parseInt(String(item?.group_id ?? item?.groupId ?? ''), 10);
        if (Number.isFinite(fromNumeric) && fromNumeric > 0) return String(fromNumeric);
        const fromText = typeof item?.group_name === 'string'
          ? item.group_name.trim()
          : (typeof item?.group === 'string' ? item.group.trim() : '');
        return fromText || null;
      })();
      items.push({
        id,
        key,
        name,
        enabled: this.parseTokenEnabled(item?.status),
        tokenGroup,
      });
    }
    return items;
  }

  private parseGroupItems(payload: any): string[] {
    const source = payload?.data ?? payload;
    const rawItems = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.list)) return source.list;
      if (Array.isArray(source?.groups)) return source.groups;
      if (Array.isArray(source?.data)) return source.data;
      return [];
    })();

    const groups: string[] = [];
    for (const item of rawItems) {
      if (item == null) continue;
      if (typeof item === 'number' && Number.isFinite(item) && item > 0) {
        groups.push(String(Math.trunc(item)));
        continue;
      }
      if (typeof item === 'string') {
        const normalized = item.trim();
        if (normalized) groups.push(normalized);
        continue;
      }
      if (typeof item !== 'object') continue;

      const numericCandidates = [
        (item as any).group_id,
        (item as any).groupId,
        (item as any).id,
        (item as any).value,
      ];
      let picked = '';
      for (const candidate of numericCandidates) {
        const parsed = Number.parseInt(String(candidate), 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          picked = String(parsed);
          break;
        }
      }
      if (picked) {
        groups.push(picked);
        continue;
      }

      const textCandidates = [
        (item as any).name,
        (item as any).group_name,
        (item as any).groupName,
        (item as any).title,
        (item as any).label,
        (item as any).code,
      ];
      for (const candidate of textCandidates) {
        if (typeof candidate !== 'string') continue;
        const normalized = candidate.trim();
        if (!normalized) continue;
        groups.push(normalized);
        break;
      }
    }

    return Array.from(new Set(groups));
  }

  private async listGroups(baseUrl: string, accessToken: string): Promise<string[]> {
    const endpoints = [
      '/api/v1/groups/available',
      '/api/v1/groups?page=1&page_size=100',
      '/api/v1/groups',
      '/api/v1/group?page=1&page_size=100',
      '/api/v1/group',
    ];

    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
          headers,
        });
        const parsed = (() => {
          try {
            return this.parseSub2ApiEnvelope<any>(res, endpoint);
          } catch {
            return res;
          }
        })();
        const groups = this.parseGroupItems(parsed);
        if (groups.length > 0) return groups;
      } catch {}
    }

    return [];
  }

  private parseGroupIdsFromTokenPayload(payload: any): string[] {
    const source = payload?.data ?? payload;
    const rawItems = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.list)) return source.list;
      if (Array.isArray(source?.data)) return source.data;
      return [];
    })();

    const groups: string[] = [];
    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const groupId = Number.parseInt(String((item as any).group_id ?? (item as any).groupId ?? ''), 10);
      if (!Number.isFinite(groupId) || groupId <= 0) continue;
      groups.push(String(groupId));
    }
    return Array.from(new Set(groups));
  }

  private async inferGroupsFromKeys(baseUrl: string, accessToken: string): Promise<string[]> {
    const endpoints = [
      '/api/v1/keys?page=1&page_size=100',
      '/api/v1/api-keys?page=1&page_size=100',
    ];

    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
          headers,
        });
        const parsed = (() => {
          try {
            return this.parseSub2ApiEnvelope<any>(res, endpoint);
          } catch {
            return res;
          }
        })();
        const groups = this.parseGroupIdsFromTokenPayload(parsed);
        if (groups.length > 0) return groups;
      } catch {}
    }

    return [];
  }

  /**
   * Resolves the group a freshly created key should join when the caller did
   * not name one.
   *
   * `/api/v1/groups/available` lists exactly the groups the account may use on
   * newer deployments; older ones expose only the generic group endpoints.
   * Preference goes to a `default` group, then `free`, then the first one;
   * when nothing can be resolved the key is created without a group, which is
   * what the platform accepted before.
   */
  private async resolveDefaultGroupId(baseUrl: string, accessToken: string): Promise<number | null> {
    const groups: Array<{ id: number; name: string }> = [];
    const headers = this.buildAuthHeader(accessToken);
    const endpoints = [
      '/api/v1/groups/available',
      '/api/v1/groups?page=1&page_size=100',
      '/api/v1/groups',
    ];
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, { headers });
        const parsed = (() => {
          try {
            return this.parseSub2ApiEnvelope<any>(res, endpoint);
          } catch {
            return res;
          }
        })();
        const source = parsed?.data ?? parsed;
        const rawItems = (() => {
          if (Array.isArray(source)) return source;
          if (Array.isArray(source?.items)) return source.items;
          if (Array.isArray(source?.list)) return source.list;
          if (Array.isArray(source?.groups)) return source.groups;
          if (Array.isArray(source?.data)) return source.data;
          return [];
        })();
        for (const item of rawItems) {
          if (item == null || typeof item !== 'object') continue;
          const id = Number.parseInt(String(
            (item as any).group_id ?? (item as any).groupId ?? (item as any).id ?? (item as any).value ?? '',
          ), 10);
          if (!Number.isFinite(id) || id <= 0) continue;
          const name = String(
            (item as any).name ?? (item as any).group_name ?? (item as any).groupName
              ?? (item as any).title ?? (item as any).label ?? (item as any).code ?? '',
          ).trim();
          groups.push({ id, name });
        }
        if (groups.length > 0) break;
      } catch {}
    }

    if (groups.length === 0) return null;
    const preferred = groups.find((group) => group.name.toLowerCase() === 'default')
      ?? groups.find((group) => group.name.toLowerCase() === 'free')
      ?? groups[0];
    return preferred?.id ?? null;
  }

  private extractModelIds(payload: any): string[] {
    const source = payload?.data ?? payload;
    const rawModels = (() => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.items)) return source.items;
      if (Array.isArray(source?.models)) return source.models;
      return [];
    })();

    const models = rawModels
      .map((item: any) => (typeof item === 'string' ? item : item?.id ?? item?.name))
      .map((value: unknown) => String(value || '').trim())
      .map((value: string) => value.replace(/^models\//i, ''))
      .filter(Boolean);
    return Array.from(new Set(models));
  }

  private resolveModelEndpoints(baseUrl: string): string[] {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    if (!normalizedBase) return [];
    if (/\/models$/i.test(normalizedBase)) return [normalizedBase];
    if (/\/(?:antigravity\/)?v\d+(?:\.\d+)?(?:beta)?$/i.test(normalizedBase)) {
      return [`${normalizedBase}/models`];
    }
    if (/\/antigravity$/i.test(normalizedBase)) {
      return [
        `${normalizedBase}/v1/models`,
        `${normalizedBase}/v1beta/models`,
      ];
    }
    return [
      `${normalizedBase}/v1/models`,
      `${normalizedBase}/api/v1/models`,
      `${normalizedBase}/v1beta/models`,
      `${normalizedBase}/antigravity/v1beta/models`,
    ];
  }

  private resolveManagementBaseUrl(baseUrl: string): string {
    let normalizedBase = normalizeBaseUrl(baseUrl);
    if (!normalizedBase) return normalizedBase;

    const suffixes = [
      '/models',
      '/antigravity',
      '/antigravity/v1beta',
      '/antigravity/v1',
      '/api/v1',
      '/v1beta',
      '/v1',
    ];

    let changed = true;
    while (changed) {
      changed = false;
      for (const suffix of suffixes) {
        if (!normalizedBase.toLowerCase().endsWith(suffix)) continue;
        const trimmed = normalizeBaseUrl(normalizedBase.slice(0, -suffix.length));
        if (!trimmed || trimmed === normalizedBase) continue;
        normalizedBase = trimmed;
        changed = true;
        break;
      }
    }

    return normalizedBase;
  }

  private async listApiKeys(baseUrl: string, accessToken: string): Promise<Array<{ id: number; key: string; name: string; enabled: boolean; tokenGroup: string | null }>> {
    const endpoints = [
      '/api/v1/keys?page=1&page_size=100',
      '/api/v1/api-keys?page=1&page_size=100',
    ];

    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
          headers,
        });
        const data = this.parseSub2ApiEnvelope<any>(res, endpoint);
        const items = this.parseTokenItems(data);
        if (items.length > 0) return items;
      } catch {}
    }

    return [];
  }

  private async fetchModelsByToken(baseUrl: string, token: string, contextSourceScope?: string): Promise<string[]> {
    const authToken = this.normalizeTokenKeyForCompare(token);
    if (!authToken) return [];

    for (const url of this.resolveModelEndpoints(baseUrl)) {
      try {
        const res = await this.fetchJson<any>(url, {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        setModelContextLengths(
          extractContextLengthsFromPayload(res),
          contextSourceScope || buildEndpointModelContextLengthScope(baseUrl),
        );
        const models = this.extractModelIds(res);
        if (models.length > 0) return models;
      } catch {}
    }

    return [];
  }

  private resolveExpiresInDays(expiredTime?: number): number | undefined {
    if (!Number.isFinite(expiredTime)) return undefined;
    const raw = Math.trunc(expiredTime as number);
    if (raw <= 0) return undefined;
    const expiresAtMs = raw > 10_000_000_000 ? raw : raw * 1000;
    const deltaMs = expiresAtMs - Date.now();
    const days = Math.max(1, Math.ceil(deltaMs / (24 * 60 * 60 * 1000)));
    return Number.isFinite(days) ? Math.min(days, 3650) : undefined;
  }

  async detect(url: string): Promise<boolean> {
    const normalized = (url || '').toLowerCase();
    if (normalized.includes('sub2api')) return true;

    const base = normalizeBaseUrl(url);
    const { fetch } = await import('undici');
    const probeEndpoint = async (path: string) => {
      try {
        return await fetch(`${base}${path}`, {
          method: 'GET',
          signal: AbortSignal.timeout(5000),
        });
      } catch {
        return null;
      }
    };

    const matchSub2ApiErrorEnvelope = async (res: {
      headers: { get(name: string): string | null };
      json: () => Promise<unknown>;
    } | null): Promise<boolean> => {
      if (!res) return false;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('application/json')) return false;
      const body = await res.json().catch(() => null) as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return false;
      const rawCode = body.code;
      const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
      const message = typeof body.message === 'string' ? body.message.trim().toLowerCase() : '';

      if (code === 'UNAUTHORIZED' || code === 'API_KEY_REQUIRED') return true;
      if (
        message.includes('authorization header is required')
        || message.includes('api key is required')
      ) {
        return true;
      }

      // Some Sub2API variants return numeric success envelope for authorized calls.
      if (typeof rawCode === 'number' && rawCode === 0) {
        return Object.prototype.hasOwnProperty.call(body, 'data');
      }

      return false;
    };

    const authProbe = await probeEndpoint('/api/v1/auth/me');
    if (await matchSub2ApiErrorEnvelope(authProbe)) return true;

    const modelsProbe = await probeEndpoint('/v1/models');
    if (await matchSub2ApiErrorEnvelope(modelsProbe)) return true;

    // Last fallback: many Sub2API UIs expose an identifying title on root.
    const rootProbe = await probeEndpoint('/');
    if (!rootProbe) return false;
    const rootType = rootProbe.headers.get('content-type') || '';
    if (!rootType.toLowerCase().includes('text/html')) return false;
    const rootText = await rootProbe.text().catch(() => '');
    return /<title>\s*sub2api\b/i.test(rootText);
  }

  /**
   * Parse the Sub2API { code, message, data } envelope.
   * code === 0 means success; anything else is an error.
   */
  private parseSub2ApiEnvelope<T>(body: any, endpoint: string): T {
    if (!body || typeof body !== 'object') {
      throw new Error(`Invalid response from ${endpoint}`);
    }
    if (typeof body.code !== 'number') {
      throw new Error(`Invalid response format from ${endpoint}`);
    }
    if (body.code !== 0) {
      const message = typeof body.message === 'string' && body.message.trim()
        ? body.message.trim()
        : `Error code ${body.code} from ${endpoint}`;
      throw new Error(message);
    }
    if (body.data === undefined) {
      throw new Error(`Missing data in response from ${endpoint}`);
    }
    return body.data as T;
  }

  /**
   * Extract display name: prefer username, fall back to email local part.
   */
  private getDisplayName(username?: string, email?: string): string {
    const name = (username || '').trim();
    if (name) return name;
    const mail = (email || '').trim();
    if (!mail) return '';
    const atIndex = mail.indexOf('@');
    return atIndex > 0 ? mail.slice(0, atIndex) : mail;
  }

  /**
   * Fetch user data from /api/v1/auth/me.
   */
  private async fetchAuthMe(baseUrl: string, accessToken: string): Promise<{
    id: number;
    username: string;
    email: string;
    balance: number;
  }> {
    const endpoint = '/api/v1/auth/me';
    const res = await this.fetchJson<any>(`${baseUrl}${endpoint}`, {
      headers: this.buildAuthHeader(accessToken),
    });
    const data = this.parseSub2ApiEnvelope<any>(res, endpoint);

    const id = typeof data.id === 'number' ? data.id
      : typeof data.id === 'string' ? Number.parseInt(data.id, 10)
      : NaN;
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error(`Invalid user ID in response from ${endpoint}`);
    }

    const balance = typeof data.balance === 'number' ? data.balance
      : typeof data.balance === 'string' ? Number.parseFloat(data.balance)
      : 0;

    return {
      id,
      username: typeof data.username === 'string' ? data.username : '',
      email: typeof data.email === 'string' ? data.email : '',
      balance: Number.isFinite(balance) ? balance : 0,
    };
  }

  /**
   * Convert USD balance to internal quota unit.
   * Uses the same conversion factor as all-api-hub (500000 per USD).
   */
  private usdToQuota(balanceUsd: number): number {
    return Math.round(Math.max(0, balanceUsd) * 500000);
  }

  // --- Login: the site's own email/password form ---

  /** Turns a thrown `HTTP <status>: <json>` into the site's own message. */
  private describeLoginFailure(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const statusMatch = /^HTTP (\d+):/i.exec(raw.trim());
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const body = JSON.parse(raw.slice(jsonStart)) as { message?: unknown };
        const siteMessage = typeof body?.message === 'string' ? body.message.trim() : '';
        if (siteMessage) {
          return statusMatch ? `${siteMessage}（HTTP ${statusMatch[1]}）` : siteMessage;
        }
      } catch {
        // Not a JSON body; fall back to the raw message.
      }
    }
    return raw || 'login failed';
  }

  override async login(
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<LoginResult> {
    let payload: any;
    try {
      payload = await this.fetchJson<any>(`${normalizeBaseUrl(baseUrl)}/api/v1/auth/login`, {
        method: 'POST',
        body: JSON.stringify({ email: username, password }),
      });
    } catch (error) {
      return { success: false, message: this.describeLoginFailure(error) };
    }

    const data = payload?.data;
    const accessToken = typeof data?.access_token === 'string' ? data.access_token.trim() : '';
    if (!accessToken) {
      const siteMessage = typeof payload?.message === 'string' ? payload.message.trim() : '';
      return { success: false, message: siteMessage || '登录失败：站点未返回访问令牌' };
    }

    const user = data?.user;
    const displayName = typeof user?.username === 'string' && user.username.trim()
      ? user.username.trim()
      : typeof user?.email === 'string' && user.email.trim()
        ? user.email.trim()
        : username;
    return {
      success: true,
      accessToken,
      username: displayName,
      platformUserId: this.parsePositiveInteger(user?.id),
    };
  }

  // --- User Info ---
  override async getUserInfo(baseUrl: string, accessToken: string): Promise<UserInfo | null> {
    try {
      const user = await this.fetchAuthMe(baseUrl, accessToken);
      return {
        username: this.getDisplayName(user.username, user.email),
        email: user.email || undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Checks in on the platform's own daily check-in, when it exposes one.
   *
   * `/api/v1/check-in/status` is the only honest source for the day's state:
   * `POST /api/v1/check-in` answers with the resulting state in both the
   * "claimed just now" and "claimed earlier" cases, so the status gate keeps
   * a repeat run from looking like a fresh reward. Sites without the route
   * (the platform does not ship a check-in everywhere) keep answering the
   * historical "not supported" verdict.
   */
  private async checkinOnPlatform(baseUrl: string, accessToken: string): Promise<CheckinResult> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const headers = this.buildAuthHeader(accessToken);

    let status: any;
    try {
      status = this.parseSub2ApiEnvelope<any>(
        await this.fetchJson<any>(`${normalizedBase}/api/v1/check-in/status`, { headers }),
        '/api/v1/check-in/status',
      );
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      if (raw.includes('HTTP 404')) {
        return { success: false, message: 'Check-in is not supported by Sub2API' };
      }
      return { success: false, message: `check-in status failed: ${raw}` };
    }

    if (status?.enabled === false) {
      return { success: false, message: '站点签到未启用' };
    }
    if (status?.checked_in_today === true) {
      return { success: false, message: '今日已签到' };
    }
    if (status?.turnstile_required === true) {
      return { success: false, message: '站点开启了 Turnstile 校验，需要人工签到' };
    }

    let payload: any;
    try {
      payload = this.parseSub2ApiEnvelope<any>(
        await this.fetchJson<any>(`${normalizedBase}/api/v1/check-in`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ turnstile_token: '' }),
        }),
        '/api/v1/check-in',
      );
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      return { success: false, message: `check-in failed: ${raw}` };
    }

    if (payload?.checked_in_today !== true) {
      return { success: false, message: 'check-in did not register' };
    }
    const reward = typeof payload.today_reward === 'number' && Number.isFinite(payload.today_reward)
      ? payload.today_reward
      : 0;
    return {
      success: true,
      message: reward > 0 ? `签到成功，获得 $${reward}` : '签到成功',
      ...(reward > 0 ? { reward: String(reward) } : {}),
    };
  }

  /**
   * Checks in on the site's external welfare service, when one is declared.
   *
   * The welfare service is not Sub2API: it authenticates through its own
   * LinuxDO binding, so its credential is the captured session cookie and the
   * id it checks in with is the bound welfare user id (the same numeric id the
   * login payload reports as the platform user id).
   */
  async checkin(
    baseUrl: string,
    accessToken: string,
    platformUserId?: number,
    context?: CheckinContext,
  ): Promise<CheckinResult> {
    const externalCheckinUrl = (context?.externalCheckinUrl || '').trim();
    if (!externalCheckinUrl) {
      return this.checkinOnPlatform(baseUrl, accessToken);
    }

    const session = getExternalCheckinSessionFromExtraConfig(context?.extraConfig);
    if (!session) {
      return {
        success: false,
        message: '外部签到站会话未绑定：请先完成签到站的 LinuxDo 授权，再重试签到',
      };
    }

    const userId = session.userId ?? platformUserId;
    if (!userId) {
      return { success: false, message: '外部签到缺少用户 ID：请在账号配置中补充 platformUserId' };
    }

    const endpoint = `${stripTrailingSlashes(externalCheckinUrl)}/api/checkin`;
    const requestInit: UndiciRequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify({ userId: String(userId), mode: session.mode || 'normal' }),
      signal: AbortSignal.timeout(20_000),
    };

    const { fetch } = await import('undici');
    let response: UndiciResponse;
    try {
      response = await fetch(endpoint, await withSiteProxyRequestInit(endpoint, requestInit));
    } catch (error) {
      return { success: false, message: `外部签到请求失败：${(error as Error)?.message || '网络错误'}` };
    }

    const rawBody = await response.text();
    let payload: any = null;
    try { payload = JSON.parse(rawBody); } catch {}

    if (response.status === 401) {
      return { success: false, message: '外部签到会话已失效（HTTP 401 未登录），请重新完成签到站的 LinuxDo 授权' };
    }
    if (!response.ok) {
      const siteMessage = typeof payload?.error === 'string' ? payload.error.trim() : '';
      return { success: false, message: `外部签到失败：HTTP ${response.status}${siteMessage ? ` ${siteMessage}` : ''}` };
    }
    if (payload?.ok === true) {
      const amount = typeof payload.amount === 'number' && Number.isFinite(payload.amount) ? payload.amount : undefined;
      return {
        success: true,
        message: amount === undefined ? '外部签到成功' : `外部签到成功，获得 ${amount}`,
        ...(amount === undefined ? {} : { reward: String(amount) }),
      };
    }

    const siteMessage = typeof payload?.error === 'string' ? payload.error.trim() : '';
    return { success: false, message: siteMessage || `外部签到失败：HTTP ${response.status}` };
  }

  // --- Daily lottery ---

  /**
   * Reads the site's lottery state.
   *
   * Answers null when the route is absent, which is the only way to tell a
   * build without a lottery apart from one whose draw is failing: several
   * Sub2API sites ship no `/lottery` at all, and reporting that as a broken
   * draw every day would be noise the operator cannot act on.
   */
  async getLotteryStatus(baseUrl: string, accessToken: string): Promise<LotteryStatus | null> {
    const endpoint = '/api/v1/lottery/status';
    let res: any;
    try {
      res = await this.fetchJson<any>(`${normalizeBaseUrl(baseUrl)}${endpoint}`, {
        headers: this.buildAuthHeader(accessToken),
      });
    } catch (error) {
      if (String(error instanceof Error ? error.message : error).includes('HTTP 404')) return null;
      throw error;
    }
    const data = this.parseSub2ApiEnvelope<any>(res, endpoint);
    const freeCost = data?.costs?.free;
    const freeAmount = typeof freeCost?.amount === 'number'
      ? freeCost.amount
      : Number.parseFloat(String(freeCost?.amount ?? ''));
    return {
      enabled: data?.enabled !== false,
      canDraw: data?.can_draw === true,
      todayDraws: this.parseNonNegativeInteger(data?.today_draws) ?? 0,
      dailyDrawLimit: this.parseNonNegativeInteger(data?.daily_draw_limit) ?? 0,
      todayRemaining: this.parseNonNegativeInteger(data?.today_remaining) ?? 0,
      bonusDraws: this.parseNonNegativeInteger(data?.bonus_draws) ?? 0,
      freeBalance: typeof data?.free_balance === 'number' && Number.isFinite(data.free_balance)
        ? data.free_balance
        : Number.parseFloat(String(data?.free_balance ?? '')) || 0,
      batchMax: this.parsePositiveInteger(data?.batch_draw?.max_count) ?? 1,
      freeCost: {
        enabled: freeCost?.enabled === true,
        amount: Number.isFinite(freeAmount) && freeAmount > 0 ? freeAmount : 0,
      },
    };
  }

  /**
   * Draws a batch and reports each prize.
   *
   * The batch route is the one the site's own UI uses, so it is tried first;
   * the single-draw route is the fallback for a build that predates it. Both
   * carry the same envelope, and the batch shape differs between builds
   * (`draws`, `items`, or a lone `draw`), so all three are read.
   */
  async drawLottery(
    baseUrl: string,
    accessToken: string,
    request: LotteryDrawRequest,
  ): Promise<LotteryDrawOutcome> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const headers = this.buildAuthHeader(accessToken);
    const body = JSON.stringify({
      cost_type: request.costType,
      count: request.count,
      idempotency_key: request.idempotencyKey,
    });

    const batchEndpoint = '/api/v1/lottery/draw-batch';
    try {
      const res = await this.fetchJson<any>(`${normalizedBase}${batchEndpoint}`, {
        method: 'POST',
        headers,
        body,
      });
      const data = this.parseSub2ApiEnvelope<any>(res, batchEndpoint);
      return {
        draws: this.readLotteryDraws(data),
        todayDraws: this.parseNonNegativeInteger(data?.today_draws),
      };
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error);
      if (!message.includes('HTTP 404')) throw error;
    }

    const singleEndpoint = '/api/v1/lottery';
    const draws: LotteryDrawOutcome['draws'] = [];
    let todayDraws: number | undefined;
    for (let index = 0; index < request.count; index += 1) {
      const res = await this.fetchJson<any>(`${normalizedBase}${singleEndpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          cost_type: request.costType,
          idempotency_key: `${request.idempotencyKey}-${index}`,
        }),
      });
      const data = this.parseSub2ApiEnvelope<any>(res, singleEndpoint);
      draws.push(...this.readLotteryDraws(data));
      todayDraws = this.parseNonNegativeInteger(data?.today_draws) ?? todayDraws;
    }
    return { draws, todayDraws };
  }

  private readLotteryDraws(data: any): LotteryDrawOutcome['draws'] {
    const raw = Array.isArray(data?.draws)
      ? data.draws
      : Array.isArray(data?.items)
        ? data.items
        : data?.draw
          ? [data.draw]
          : [];
    return raw.map((entry: any) => ({
      costType: String(entry?.cost_type ?? ''),
      prizeType: String(entry?.prize_type ?? ''),
      prizeAmount: typeof entry?.prize_amount_actual === 'number'
        ? entry.prize_amount_actual
        : Number.parseFloat(String(entry?.prize_amount_actual ?? entry?.prize_amount ?? '')) || 0,
      status: String(entry?.status ?? ''),
    }));
  }

  // --- Balance ---
  async getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const [user, subscriptionSummary] = await Promise.all([
      this.fetchAuthMe(normalizedBase, accessToken),
      this.fetchSubscriptionSummary(normalizedBase, accessToken),
    ]);
    const quotaValue = this.usdToQuota(user.balance);
    // Sub2API only provides current balance, no usage breakdown
    return {
      balance: quotaValue / 500000,
      used: 0,
      quota: quotaValue / 500000,
      subscriptionSummary,
    };
  }

  // --- Models: Standard OpenAI-compatible endpoint ---
  async getModels(
    baseUrl: string,
    apiToken: string,
    _platformUserId?: number,
    contextSourceScope?: string,
  ): Promise<string[]> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const managementBase = this.resolveManagementBaseUrl(normalizedBase);
    const directModels = await this.fetchModelsByToken(normalizedBase, apiToken, contextSourceScope);
    if (directModels.length > 0) return directModels;

    // Session JWT cannot access /v1/models directly; discover a user key first.
    const discoveredApiToken = await this.getApiToken(managementBase, apiToken);
    if (!discoveredApiToken) return [];
    if (this.normalizeTokenKeyForCompare(discoveredApiToken) === this.normalizeTokenKeyForCompare(apiToken)) {
      return [];
    }
    return this.fetchModelsByToken(normalizedBase, discoveredApiToken, contextSourceScope);
  }

  override async getSiteAnnouncements(baseUrl: string, accessToken: string): Promise<SiteAnnouncement[]> {
    try {
      const endpoint = '/api/v1/announcements?page=1&page_size=100';
      const res = await this.fetchJson<any>(`${normalizeBaseUrl(baseUrl)}${endpoint}`, {
        headers: this.buildAuthHeader(accessToken),
      });
      const data = this.parseSub2ApiEnvelope<any>(res, endpoint);
      const rawItems = Array.isArray(data)
        ? data
        : (Array.isArray(data?.items) ? data.items : []);
      const rows: SiteAnnouncement[] = [];
      for (const item of rawItems) {
        const id = Number.parseInt(String(item?.id), 10);
        if (!Number.isFinite(id) || id <= 0) continue;
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        const content = typeof item?.content === 'string' ? item.content.trim() : '';
        if (!title && !content) continue;
        rows.push({
          sourceKey: `announcement:${id}`,
          title: title || `Announcement ${id}`,
          content: content || title,
          level: 'info',
          startsAt: typeof item?.starts_at === 'string' ? item.starts_at : undefined,
          endsAt: typeof item?.ends_at === 'string' ? item.ends_at : undefined,
          upstreamCreatedAt: typeof item?.created_at === 'string' ? item.created_at : undefined,
          upstreamUpdatedAt: typeof item?.updated_at === 'string' ? item.updated_at : undefined,
          rawPayload: item,
        });
      }
      return rows;
    } catch {
      return [];
    }
  }

  override async getApiTokens(baseUrl: string, accessToken: string): Promise<ApiTokenInfo[]> {
    try {
      const keys = await this.listApiKeys(normalizeBaseUrl(baseUrl), accessToken);
      return keys.map((item) => {
        const tokenInfo: ApiTokenInfo = {
          name: item.name,
          key: item.key,
          enabled: item.enabled,
        };
        if (item.tokenGroup) tokenInfo.tokenGroup = item.tokenGroup;
        return tokenInfo;
      });
    } catch {
      return [];
    }
  }

  override async getApiToken(baseUrl: string, accessToken: string): Promise<string | null> {
    const tokens = await this.getApiTokens(baseUrl, accessToken);
    return tokens.find((token) => token.enabled !== false)?.key || tokens[0]?.key || null;
  }

  override async getUserGroups(baseUrl: string, accessToken: string): Promise<string[]> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const directGroups = await this.listGroups(normalizedBase, accessToken);
    if (directGroups.length > 0) return directGroups;

    const inferredFromKeys = await this.inferGroupsFromKeys(normalizedBase, accessToken);
    if (inferredFromKeys.length > 0) return inferredFromKeys;

    return ['default'];
  }

  override async createApiToken(
    baseUrl: string,
    accessToken: string,
    _platformUserId?: number,
    options?: CreateApiTokenOptions,
  ): Promise<boolean> {
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const payload: Record<string, unknown> = {
      name: (options?.name || '').trim() || 'metapi',
    };

    const requestedGroupId = Number.parseInt((options?.group || '').trim(), 10);
    const explicitGroupId = Number.isFinite(requestedGroupId) && requestedGroupId > 0
      ? requestedGroupId
      : null;
    // Deployments that gate keys behind group membership reject a key created
    // without one, so a group-less key would stay unusable forever. Fall back
    // to the first group the account may actually use.
    const groupId = explicitGroupId ?? await this.resolveDefaultGroupId(normalizedBase, accessToken);
    if (groupId) {
      payload.group_id = groupId;
    }

    const expiresInDays = this.resolveExpiresInDays(options?.expiredTime);
    if (expiresInDays) {
      payload.expires_in_days = expiresInDays;
    }

    if (options?.unlimitedQuota === false && Number.isFinite(options.remainQuota)) {
      payload.quota = Math.max(0, Number(options.remainQuota));
    }

    const endpoints = ['/api/v1/keys', '/api/v1/api-keys'];
    const headers = this.buildAuthHeader(accessToken);
    const groupLessPayload = { ...payload };
    delete groupLessPayload.group_id;
    const attempts = groupId ? [payload, groupLessPayload] : [payload];
    for (const attempt of attempts) {
      for (const endpoint of endpoints) {
        try {
          const res = await this.fetchJson<any>(`${normalizedBase}${endpoint}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(attempt),
          });
          this.parseSub2ApiEnvelope<any>(res, endpoint);
          return true;
        } catch {}
      }
    }

    return false;
  }

  override async deleteApiToken(
    baseUrl: string,
    accessToken: string,
    tokenKey: string,
  ): Promise<boolean> {
    const targetKey = this.normalizeTokenKeyForCompare(tokenKey);
    if (!targetKey) return false;

    const normalizedBase = normalizeBaseUrl(baseUrl);
    let tokenId: number | null = null;
    try {
      const items = await this.listApiKeys(normalizedBase, accessToken);
      tokenId = items.find((item) => this.normalizeTokenKeyForCompare(item.key) === targetKey)?.id || null;
    } catch {
      return false;
    }

    // Upstream key already absent means local deletion is safe.
    if (!tokenId) return true;

    const endpoints = [
      `/api/v1/keys/${tokenId}`,
      `/api/v1/api-keys/${tokenId}`,
    ];
    const headers = this.buildAuthHeader(accessToken);
    for (const endpoint of endpoints) {
      try {
        const res = await this.fetchJson<any>(`${normalizedBase}${endpoint}`, {
          method: 'DELETE',
          headers,
        });
        this.parseSub2ApiEnvelope<any>(res, endpoint);
        return true;
      } catch {}
    }

    return false;
  }
}
