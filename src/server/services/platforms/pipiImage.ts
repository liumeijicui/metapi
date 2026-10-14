import { StandardApiProviderAdapterBase } from './standardApiProvider.js';
import { detectPlatformByUrlHint } from '../../../shared/platformIdentity.js';
import type { BalanceInfo, CheckinResult, UserInfo } from './base.js';

/**
 * 皮皮智绘（`img.pipiwangcom.com`）是自研出图面板，不是 new-api 分支：
 *
 *  - 没有任何管理面（`/api/user/*`、`/api/token/*` 全是 404），所以余额、
 *    模型列表这些「new-api 惯例」在这里都读不到；
 *  - 唯一凭据是 `POST /api/v1/auth/linuxdo/callback` 回跳后写进
 *    `localStorage.pipi_pc_token` 的 bearer（有效期 7 天），用
 *    `Authorization: Bearer <token>` 打 `/api/v1/pc/*`；
 *  - 它没有对话模型（用户明确要求不要为它建 SK 秘钥），但有每日签到与
 *    「图片站积分 → API 余额」兑换，两者都在 `/api/v1/pc/` 下。
 *
 * 因此这个适配器只实现「人」的那条线：验证凭据、签到、读积分。模型列表
 * 固定为空——让它在界面上看起来「没有模型」比伪造一个空模型池诚实。
 */
export const PIPI_IMAGE_PLATFORM = 'pipi-image';
export const PIPI_IMAGE_HOST = 'img.pipiwangcom.com';

/** 出图站的真实主机名，用于给登录捕获挑选站点专属的 storage 键。 */
export function isPipiImageSiteUrl(url: string): boolean {
  const raw = (url || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.trim().toLowerCase() === PIPI_IMAGE_HOST;
  } catch {
    return false;
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

/** 站点自己的积分字段：顶层 `points`，旧版本塞在 `quota.points` 里。 */
function readPoints(payload: any): number | null {
  const candidates = [payload?.points, payload?.quota?.points];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function errorText(error: unknown): string {
  return (error as Error)?.message || String(error) || '网络错误';
}

export class PipiImageAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = PIPI_IMAGE_PLATFORM;

  /**
   * 图片站按设计就没有对话模型：模型监控不该把它报成「密钥无权限」，
   * 那是它从空模型列表猜出来的结论。
   */
  readonly modelMonitorUnsupportedReason =
    '皮皮智绘是图片站，只有出图模型（image-1 / image-2），没有对话模型，因此没有成功率 / 延迟可采样';

  protected override loginUnsupportedMessage =
    '皮皮智绘只支持 Linux.do 快捷登录，请在该站完成 Linux.do 授权后重试';

  override async detect(url: string): Promise<boolean> {
    return detectPlatformByUrlHint(url) === this.platformName;
  }

  override async getUserInfo(baseUrl: string, accessToken: string): Promise<UserInfo | null> {
    try {
      const payload = await this.fetchJson<any>(`${stripTrailingSlashes(baseUrl)}/api/v1/pc/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const user = payload?.user || payload;
      const username = String(user?.username || user?.nickname || user?.name || '').trim();
      if (!username) return null;
      return {
        username,
        displayName: String(user?.nickname || user?.display_name || '').trim() || undefined,
        email: String(user?.email || '').trim() || undefined,
      };
    } catch {
      return null;
    }
  }

  /** 该站没有对话模型：返回空列表，不发起任何 `/v1/models` 探测。 */
  override async getModels(): Promise<string[]> {
    return [];
  }

  /** 站点余额就是图片站积分（1 美元 API 余额 = `pointsPerUsd` 积分，默认 20）。 */
  override async getBalance(baseUrl: string, accessToken: string): Promise<BalanceInfo> {
    const payload = await this.fetchJson<any>(`${stripTrailingSlashes(baseUrl)}/api/v1/pc/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const points = readPoints(payload) ?? 0;
    return { balance: points, used: 0, quota: points };
  }

  /**
   * 每日签到。站点用 `{already:true}` 表示「今天已经领过」，那对调度器而言
   * 就是签到成功（这一天已认领），不是错误——报成失败会让调度器每个周期
   * 都重试同一天。
   */
  override async checkin(baseUrl: string, accessToken: string): Promise<CheckinResult> {
    let payload: any;
    try {
      payload = await this.fetchJson<any>(`${stripTrailingSlashes(baseUrl)}/api/v1/pc/checkin`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({}),
      });
    } catch (error) {
      const message = errorText(error);
      if (/HTTP 401\b/.test(message)) {
        return {
          success: false,
          message: `皮皮智绘登录凭证已失效（HTTP 401），请重新完成 Linux.do 授权：${message}`,
        };
      }
      return { success: false, message: `签到失败：${message}` };
    }

    if (payload?.already) {
      return { success: true, message: '今日已签到' };
    }
    const granted = Number(payload?.grantedPoints);
    if (!Number.isFinite(granted) || granted <= 0) {
      return { success: true, message: '签到成功（站点未返回积分数量）' };
    }
    return { success: true, message: `签到成功 +${granted} 积分`, reward: String(granted) };
  }
}
