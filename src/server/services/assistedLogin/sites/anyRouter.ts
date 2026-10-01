import {
  isSiteUrl,
  judgeLinuxDoCallback,
  reloginWithLinuxDo,
  type LinuxDoReloginResult,
} from './linuxDoOAuthRelogin.js';

/**
 * Any Router's Linux.do re-login.
 *
 * Any Router pays its daily $25 through the login handler too, and — like Agent
 * Router — answers its check-in route with a success that never touches the
 * balance, so the grant only lands when the account is signed out and signed back
 * in through Linux.do. The handshake itself lives in the shared driver; this
 * module declares what is specific to anyrouter.top.
 */

const ANY_ROUTER_HOST = 'anyrouter.top';
const CALLBACK_PATH = '/api/oauth/linuxdo';
export const ANY_ROUTER_HOSTS: readonly string[] = [ANY_ROUTER_HOST];

export type AnyRouterLinuxDoLoginResult = LinuxDoReloginResult;

export type AnyRouterLinuxDoLoginRequest = {
  /** Origin of the deployment, e.g. https://anyrouter.top */
  baseUrl: string;
  /** Linux.do OAuth client id the deployment advertises on /api/status. */
  clientId: string;
  /** Deployment user id this account must end up signed in as. */
  expectedUserId?: number;
};

/** The flow signs the profile out of this site, so it must be the real one. */
export function isAnyRouterSite(rawUrl: string): boolean {
  return isSiteUrl(rawUrl, ANY_ROUTER_HOSTS);
}

/**
 * Turns the OAuth callback response into a verdict. The page navigates to
 * /console regardless of the outcome, so only the API answer is trustworthy.
 */
export function judgeAnyRouterCallback(
  status: number,
  body: string,
  expectedUserId?: number,
): AnyRouterLinuxDoLoginResult {
  return judgeLinuxDoCallback(status, body, { expectedUserId });
}

export async function loginAnyRouterWithLinuxDo(
  request: AnyRouterLinuxDoLoginRequest,
): Promise<AnyRouterLinuxDoLoginResult> {
  return reloginWithLinuxDo({
    baseUrl: request.baseUrl,
    clientId: request.clientId,
    expectedUserId: request.expectedUserId,
    hosts: ANY_ROUTER_HOSTS,
    callbackPath: CALLBACK_PATH,
    siteLabel: ANY_ROUTER_HOST,
  });
}
