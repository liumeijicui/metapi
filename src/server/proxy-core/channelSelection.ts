import { proxyChannelCoordinator } from '../services/proxyChannelCoordinator.js';
import { canRetryProxyChannel } from '../services/proxyChannelRetry.js';
import type { DownstreamRoutingPolicy } from '../services/downstreamPolicyTypes.js';
import { tokenRouter } from '../services/tokenRouter.js';

type SelectedChannel = Awaited<ReturnType<typeof tokenRouter.selectChannel>>;

export const TESTER_FORCED_CHANNEL_HEADER = 'x-metapi-tester-forced-channel-id';
export const TESTER_REQUEST_HEADER = 'x-metapi-tester-request';

function headerValueEquals(
  headers: Record<string, unknown> | undefined,
  expectedKey: string,
  expectedValue: string,
): boolean {
  if (!headers) return false;
  const normalizedExpectedKey = expectedKey.trim().toLowerCase();
  const normalizedExpectedValue = expectedValue.trim().toLowerCase();
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== normalizedExpectedKey) continue;
    if (typeof rawValue === 'string' && rawValue.trim().toLowerCase() === normalizedExpectedValue) {
      return true;
    }
  }
  return false;
}

function isLoopbackClientIp(value: string | null | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  if (trimmed === '::1' || trimmed === '127.0.0.1') return true;
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice('::ffff:'.length).trim() === '127.0.0.1';
  }
  return false;
}

export function normalizeForcedChannelId(value: unknown): number | null {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim()
      ? Number(value.trim())
      : NaN;
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return null;
  return numeric;
}

type TesterRequestInput = {
  headers?: Record<string, unknown>;
  clientIp?: string | null;
};

export function isTrustedTesterRequest(input?: TesterRequestInput): boolean {
  if (!input) return false;
  if (!isLoopbackClientIp(input.clientIp)) return false;
  return headerValueEquals(input.headers, TESTER_REQUEST_HEADER, '1');
}

export function getTesterForcedChannelId(input?: TesterRequestInput): number | null {
  if (!isTrustedTesterRequest(input)) return null;
  const headers = input?.headers;
  if (!headers) return null;
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawKey.trim().toLowerCase() !== TESTER_FORCED_CHANNEL_HEADER) continue;
    return normalizeForcedChannelId(rawValue);
  }
  return null;
}

/**
 * 没有可用通道时的对外说明。
 *
 * 老路由退出派发之后，这句话必须说真话：以前不管什么原因都回
 * `No available channels after retries`，用户看到的却是上游的 401 / 限流，对不上。
 * 现在按真实原因给出「没配规则 / 规则停用 / 目标全停用 / 目标没可用通道」。
 */
export async function buildModelUnavailableMessage(
  requestedModel: string,
  forcedChannelId?: number | null,
): Promise<string> {
  const normalizedForcedChannelId = normalizeForcedChannelId(forcedChannelId);
  if (normalizedForcedChannelId !== null) {
    return `指定通道 #${normalizedForcedChannelId} 当前不可用，固定通道模式不会自动切换其他通道`;
  }
  try {
    // 动态引入：channelSelection 在代理热路径上被很早加载，而 modelForwardService 会
    // 反查 tokenRouter，静态引入会形成「模块求值期」的循环依赖（schema 还没就位）。
    // 这里只在「没有可用通道」这一条冷路径上用到，代价可以忽略。
    const { describeForwardDispatchFailure } = await import('../services/modelForwardService.js');
    return (await describeForwardDispatchFailure(requestedModel)).message;
  } catch (error) {
    console.warn('[channelSelection] 解析转发失败原因时出错', error);
    return `模型 ${requestedModel} 没有可用的转发目标，无法派发`;
  }
}

export function canRetryChannelSelection(retryCount: number, forcedChannelId?: number | null): boolean {
  if (normalizeForcedChannelId(forcedChannelId) !== null) return false;
  return canRetryProxyChannel(retryCount);
}

export async function selectProxyChannelForAttempt(input: {
  requestedModel: string;
  downstreamPolicy: DownstreamRoutingPolicy;
  excludeChannelIds: number[];
  retryCount: number;
  stickySessionKey?: string | null;
  forcedChannelId?: number | null;
}): Promise<SelectedChannel> {
  const normalizedForcedChannelId = normalizeForcedChannelId(input.forcedChannelId);
  if (normalizedForcedChannelId !== null) {
    if (input.retryCount > 0) return null;
    return await tokenRouter.selectPreferredChannel(
      input.requestedModel,
      normalizedForcedChannelId,
      input.downstreamPolicy,
      input.excludeChannelIds,
    );
  }

  let selected: SelectedChannel = null;

  if (input.retryCount === 0 && input.stickySessionKey) {
    const preferredChannelId = proxyChannelCoordinator.getStickyChannelId(input.stickySessionKey);
    if (preferredChannelId && !input.excludeChannelIds.includes(preferredChannelId)) {
      selected = await tokenRouter.selectPreferredChannel(
        input.requestedModel,
        preferredChannelId,
        input.downstreamPolicy,
        input.excludeChannelIds,
        // 手工排过顺序的「模型转发」路由：粘滞会让顺序变更对老会话失效，必须忽略。
        { ignoreOnManualForwardRoute: true },
      );
      if (!selected) {
        // 选不出来就换一次普通选路。以前这里还会「刷新模型并重建路由再试一次」，那是
        // 老路由时代的兜底：模型刷新只影响按 model_pattern 自动生成的老路由，而老路由
        // 已经不参与派发，刷新既救不回请求，又会让每次失败都拖上几十秒。
        selected = await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy);
      }
    }
  }

  if (!selected) {
    selected = input.retryCount === 0
      ? await tokenRouter.selectChannel(input.requestedModel, input.downstreamPolicy)
      : await tokenRouter.selectNextChannel(
        input.requestedModel,
        input.excludeChannelIds,
        input.downstreamPolicy,
      );
  }

  return selected;
}
