import { assistedLoginSessions } from '../assistedLogin/sessionRegistry.js';
import type { AssistedLoginProviderId } from '../assistedLogin/types.js';
import { assistedLoginProviders } from '../assistedLogin/providers/index.js';

export {
  pickTokenFromRecords,
  type AssistedLoginSession,
} from '../assistedLogin/sessionService.js';
export type {
  CapturedCredentials,
  CaptureResult,
  CaptureStatus,
  LoginState,
} from '../assistedLogin/types.js';

/**
 * Back-compat facade over the generic assisted-login core. The Linux.do provider
 * was the first implementation, so the original module names and route payloads
 * keep working while the shared logic now lives in `services/assistedLogin`.
 */
export function getAssistedLoginSessionFor(id: AssistedLoginProviderId) {
  const session = assistedLoginSessions.get(id);
  if (!session) {
    throw new Error(`Assisted login provider "${id}" is not registered`);
  }
  return session;
}

const linuxdoSession = getAssistedLoginSessionFor('linuxdo');

export type LinuxDoLoginState = import('../assistedLogin/types.js').LoginState;

export function getLinuxDoBrowserState() {
  return linuxdoSession.browser.getManagedBrowserState();
}

export function getLinuxDoLoginState() {
  return linuxdoSession.getLoginState();
}

export function openLinuxDoLoginWindow() {
  return linuxdoSession.openLoginWindow();
}

export function captureSiteCredentials(input: { siteId: number }) {
  return linuxdoSession.captureSiteCredentials(input);
}

export function getManagedBrowserProfileDir(): string {
  return linuxdoSession.browser.getBrowserProfileDir();
}

export { assistedLoginProviders };
