import type { BrowserContext, Page } from 'playwright-core';
import { createAssistedLoginSession, pickTokenFromRecords } from './sessionService.js';
import type { AssistedLoginProviderId } from './types.js';
import { getAssistedLoginProvider, assistedLoginProviderIds } from './providers/index.js';

export { pickTokenFromRecords };

export type AssistedLoginSessionRegistry = ReturnType<typeof createAssistedLoginSessionRegistry>;

function missingBrowserMessage(platform: NodeJS.Platform, label: string): string {
  if (platform === 'linux') {
    return `未找到可用的 Chrome/Chromium。请先安装（如 apt install -y chromium），或设置浏览器可执行文件路径后重试（${label}）。`;
  }
  return '未找到可用的 Chrome/Edge 浏览器，请安装后重试或在环境中配置浏览器可执行文件路径';
}

/**
 * One managed browser profile per provider, so a GitHub login cannot displace
 * the persisted Linux.do session (and vice versa).
 */
export function createAssistedLoginSessionRegistry() {
  const sessions = new Map<AssistedLoginProviderId, ReturnType<typeof createAssistedLoginSession>>();

  for (const id of assistedLoginProviderIds) {
    const provider = getAssistedLoginProvider(id);
    if (!provider) continue;
    sessions.set(id, createAssistedLoginSession({
      provider,
      profileDirName: `${id}-browser`,
      executableEnvVar: id === 'github' ? 'GITHUB_BROWSER_PATH' : 'LINUXDO_BROWSER_PATH',
      missingBrowserMessage: (platform) => missingBrowserMessage(platform, provider.label),
      watchStateSettingKey: `${id}_session_watch_state`,
      watchEnabledSettingKey: `${id}_session_watch_enabled`,
    }));
  }

  return {
    get(id: string) {
      const normalized = (id || '').trim().toLowerCase() as AssistedLoginProviderId;
      return sessions.get(normalized) || null;
    },
    ids: () => [...sessions.keys()],
    all: () => [...sessions.values()],
    closeAll: async () => {
      await Promise.all([...sessions.values()].map((session) => session.browser.closeManagedBrowser()));
    },
  };
}

export const assistedLoginSessions = createAssistedLoginSessionRegistry();
