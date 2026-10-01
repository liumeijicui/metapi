import {
  isLinuxDoAuthorizeUrl,
  isSiteUrl,
  judgeLinuxDoCallback,
  reloginWithLinuxDo,
} from './linuxDoOAuthRelogin.js';

/**
 * Agent Router's Linux.do re-login.
 *
 * Agent Router grants the daily $25 inside its login handler and its FAQ tells
 * the user to log out and back in, so its check-in replays the Linux.do OAuth
 * handshake. The handshake itself lives in the shared driver — this module only
 * declares what is specific to agentrouter.org: its host, the path it answers the
 * callback on, and the wording of its refusals.
 */

const AGENT_ROUTER_HOST = 'agentrouter.org';
const CALLBACK_PATH = '/api/oauth/linuxdo';
export const AGENT_ROUTER_HOSTS: readonly string[] = [AGENT_ROUTER_HOST];

export { isLinuxDoAuthorizeUrl };

export type AgentRouterLinuxDoLoginResult = { ok: boolean; message: string };

export type AgentRouterLinuxDoLoginRequest = {
  /** Origin of the deployment, e.g. https://agentrouter.org */
  baseUrl: string;
  /** Linux.do OAuth client id the deployment advertises on /api/status. */
  clientId: string;
  /** Deployment user id this account must end up signed in as. */
  expectedUserId?: number;
};

/** The flow signs the profile out of this site, so it must be the real one. */
export function isAgentRouterSite(rawUrl: string): boolean {
  return isSiteUrl(rawUrl, AGENT_ROUTER_HOSTS);
}

/**
 * Turns the OAuth callback response into a verdict. The page navigates to
 * /console regardless of the outcome, so only the API answer is trustworthy.
 */
export function judgeAgentRouterCallback(
  status: number,
  body: string,
  expectedUserId?: number,
): AgentRouterLinuxDoLoginResult {
  return judgeLinuxDoCallback(status, body, { expectedUserId });
}

export async function loginAgentRouterWithLinuxDo(
  request: AgentRouterLinuxDoLoginRequest,
): Promise<AgentRouterLinuxDoLoginResult> {
  return reloginWithLinuxDo({
    baseUrl: request.baseUrl,
    clientId: request.clientId,
    expectedUserId: request.expectedUserId,
    hosts: AGENT_ROUTER_HOSTS,
    callbackPath: CALLBACK_PATH,
    siteLabel: AGENT_ROUTER_HOST,
  });
}
