import { StandardApiProviderAdapterBase } from './standardApiProvider.js';
import { detectPlatformByUrlHint } from '../../../shared/platformIdentity.js';

/**
 * X-API (x-api.cfd) runs its own gateway rather than a New API fork: it has no
 * `/api/user/*` management surface and no session API at all. Sign-in happens
 * through Linux.do OAuth on the site itself, so the only credential this
 * platform can be bound with is the site's own API key, spent against the
 * OpenAI-compatible `/v1` endpoints.
 */
export class XApiAdapter extends StandardApiProviderAdapterBase {
  readonly platformName = 'xapi';

  protected override loginUnsupportedMessage =
    'X-API 仅支持 Linux.do 快捷登录，请在该站生成 API Key 后以 API Key 方式连接';
  protected override checkinUnsupportedMessage = 'X-API 未提供签到接口';

  async detect(url: string): Promise<boolean> {
    return detectPlatformByUrlHint(url) === this.platformName;
  }

  async getModels(
    baseUrl: string,
    apiToken: string,
    _platformUserId?: number,
    contextSourceScope?: string,
  ): Promise<string[]> {
    return this.fetchModelsFromStandardEndpoint({
      baseUrl,
      headers: { Authorization: `Bearer ${apiToken}` },
      contextSourceScope,
    });
  }
}
