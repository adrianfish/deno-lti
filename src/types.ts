import { DEEP_LINKING, RESOURCE_LINK } from "./messages.ts";

import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Platform configuration
// ---------------------------------------------------------------------------

export interface Platform {
  /** Issuer URL (matches iss claim in LTI tokens) */
  url: string;
  clientId: string;
  name: string;
  /** OIDC authorization endpoint */
  authEndpoint: string;
  /** OAuth2 token endpoint */
  accesstokenEndpoint: string;
  method: string;
  key: string;
  jwksUri: string;
  kid: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Stored token records
// ---------------------------------------------------------------------------

export interface UserInfo {
  given_name?: string;
  family_name?: string;
  name?: string;
  email?: string;
}

export interface StoredIdToken {
  iss: string;
  user: string;
  userInfo: UserInfo;
  platformInfo: Record<string, unknown>;
  clientId: string;
  platformId: string;
  deploymentId: string;
}

export interface StoredContextToken {
  contextId: string;
  user: string;
  roles: string[];
  path: string;
  targetLinkUri: string;
  context: Record<string, unknown>;
  resource: Record<string, unknown>;
  custom: Record<string, unknown>;
  launchPresentation: Record<string, unknown>;
  messageType: RESOURCE_LINK | DEEP_LINKING;
  version: string;
  deepLinkingSettings?: Record<string, unknown>;
  lis: Record<string, unknown>;
  endpoint?: Record<string, unknown>;
  namesRoles?: Record<string, unknown>;
  groups?: Record<string, string>;
  /** tool_platform claim — `product_family_code` identifies the LMS. */
  toolPlatform?: Record<string, string>;
}

/** Combined token as seen by LTI handlers */
export interface LTIToken extends StoredIdToken {
  platformContext: StoredContextToken;
}

// ---------------------------------------------------------------------------
// LTIK — our signed session JWT payload
// ---------------------------------------------------------------------------

export interface LtikPayload {
  platformUrl: string;
  clientId: string;
  deploymentId: string;
  /** base64(iss+clientId+deploymentId) — used as cookie name */
  platformCode: string;
  contextId: string;
  user: string;
  /** Random salt — makes each launch unique */
  s: string;
}

// ---------------------------------------------------------------------------
// OIDC state record (10-minute TTL)
// ---------------------------------------------------------------------------

export interface OidcStateData {
  iss: string;
  clientId?: string;
  loginHint: string;
  ltiMessageHint?: string;
  targetLinkUri?: string;
}

// ---------------------------------------------------------------------------
// OAuth2 access token cache record
// ---------------------------------------------------------------------------

export interface StoredAccessToken {
  token: string;
  platformUrl: string;
  clientId: string;
  /** Space-separated scope string */
  requestedScopes: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Handler types for the public API
// ---------------------------------------------------------------------------

export interface LTIContext {
  token: LTIToken;
  context: StoredContextToken;
  ltik: string;
}

/** Main LTI launch handler — return a Response */
export type LTIHandler = (
  c: Context,
  lti: LTIContext,
) => Response | Promise<Response>;

/** Error/lifecycle handler — return a Response */
export type ErrorHandler = (c: Context) => Response | Promise<Response>;

// ---------------------------------------------------------------------------
// Tool options
// ---------------------------------------------------------------------------

export interface CookieOptions {
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  domain?: string;
}

export interface ToolOptions {
  /** If true, skips session cookie validation. Never use in production. */
  devMode?: boolean;
  /** If true, print lots of debug stuff */
  debug?: boolean;
  /** Custom route for the main LTI launch. Defaults to "/lti". */
  ltiRoute?: string;
  /** Cookie options applied to all set-cookie responses */
  cookies?: CookieOptions;
  /**
   * Extra custom parameters to request at dynamic registration, keyed by the
   * custom-claim name the platform will return. Values may be literals or LTI
   * substitution variables (e.g. "$Person.name.full"). Merged over the built-in
   * Tier 1 enrichment parameters (profile picture, pronouns, …).
   */
  customParameters?: Record<string, string>;
  services?: Array<string>;
}

export interface ContentItem {
  type: string;
  [key: string]: unknown;
}

export interface Group {
  id: string;
  name: string;
  tag: string;
}
