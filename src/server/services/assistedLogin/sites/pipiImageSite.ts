import type { StorageCredentialHints } from '../types.js';

/**
 * 皮皮智绘（`img.pipiwangcom.com`）的登录不是 new-api 那一套：Linux.do OAuth
 * 回跳到站点后，前端把令牌写进自己命名的 localStorage 键，然后所有请求都带
 * `Authorization: Bearer <pipi_pc_token>`。通用采集只认识 `token` /
 * `access_token` 这些通用键名，所以这里把站点专属的键名显式声明出来，
 * 否则捕获流程会「看到用户已登录、却读不到任何凭据」。
 */
const PIPI_IMAGE_HOST = 'img.pipiwangcom.com';

export function isPipiImageLoginSite(siteUrl: string): boolean {
  const raw = (siteUrl || '').trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return parsed.hostname.trim().toLowerCase() === PIPI_IMAGE_HOST;
  } catch {
    return false;
  }
}

/** 站点自己的三个键：令牌、用户对象、用户 id。 */
export function pipiImageStorageHints(): StorageCredentialHints {
  return {
    tokenKeys: ['pipi_pc_token'],
    userKeys: ['pipi_pc_user'],
    uidKeys: ['pipi_pc_uid'],
  };
}

/** 站点专属的捕获提示；不是这个站点时返回 null，调用方保持通用逻辑。 */
export function pipiImageHintsFor(siteUrl: string): StorageCredentialHints | null {
  return isPipiImageLoginSite(siteUrl) ? pipiImageStorageHints() : null;
}
