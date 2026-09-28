import type { Page } from 'playwright-core';

export type AssistedLoginProviderId = 'linuxdo' | 'github';

export type LoginState = {
  loggedIn: boolean;
  username: string | null;
  userId: number | null;
  blocked: boolean;
  message?: string;
};

/**
 * Minimal request surface handed to `probeLoginStateHttp`. Providers parse their
 * own endpoints; transport, proxy, cookie header, and timeout stay with the caller.
 */
export type ProviderHttpFetch = (
  path: string,
  options?: { accept?: string },
) => Promise<{ status: number; body: string }>;

export type CapturedCredentials = {
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: number | null;
  username: string | null;
  /**
   * The site's own user id (`uid`). new-api deployments require it in the
   * `New-Api-User` header, and guessing it from the username picks the wrong
   * value for accounts whose name has no numeric suffix.
   */
  platformUserId: number | null;
  source: 'localStorage' | 'cookie';
  harvestedKeys: string[];
};

export type CaptureStatus =
  | 'captured'
  | 'needs_provider_login'
  | 'already_authorized'
  | 'login_button_not_found'
  | 'timeout'
  | 'browser_unavailable'
  | 'site_not_found';

export type CaptureResult = {
  status: CaptureStatus;
  credentials: CapturedCredentials | null;
  message?: string;
  url?: string;
};

export type WatchState = {
  lastStatus: 'unknown' | 'logged_in' | 'logged_out';
  lastUsername: string | null;
  lastCheckedAt: string | null;
  /** Last real keep-alive probe; a page view refreshes `lastCheckedAt` only. */
  lastKeepAliveAt: string | null;
};

/**
 * Everything that differs between assisted-login providers. The orchestration in
 * sessionService is provider-agnostic and only reads this descriptor.
 */
export type AssistedLoginProvider = {
  id: AssistedLoginProviderId;
  /** Human label used in messages, e.g. "Linux.do". */
  label: string;
  /** Origin whose login session is persisted and reused. */
  origin: string;
  /** Path appended to `origin` to open the provider login form. */
  loginPath: string;
  /** True when a URL host belongs to the provider's OAuth handoff. */
  isHandoffHost: (host: string) => boolean;
  /**
   * True only for the provider's OAuth *authorize* page, not its homepage or
   * sign-in form. The managed window keeps a probe tab parked on the provider
   * homepage, so the host alone cannot tell a live handoff from that probe.
   */
  isAuthorizationUrl: (url: string) => boolean;
  /** Reads the provider login state from its own probe page. */
  probeLoginState: (page: Page) => Promise<LoginState>;
  /**
   * Reads the provider login state over plain HTTP with an imported session
   * cookie, so a server that cannot host a browser still verifies the session.
   */
  probeLoginStateHttp: (fetchWithSession: ProviderHttpFetch) => Promise<LoginState>;
  /** Matchers for the provider entry button on a target site. */
  entryNamePattern: RegExp;
  entrySelectors: string[];
  entryTextSelectors: string[];
  /** Matchers for the OAuth authorize/consent button on the handoff page. */
  consentButtonNames: RegExp;
  consentSelectors: string[];
  messages: {
    needsLogin: string;
    sessionExpired: string;
    entryMissing: string;
    blocked: string;
  };
};
