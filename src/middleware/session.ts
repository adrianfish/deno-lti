/**
 * LTI Session Middleware — the core of the library.
 *
 * Every incoming request passes through here. It handles three cases:
 *
 * 1. Initial launch (has id_token + state in body) → validate token, mint LTIK,
 *    store session, redirect to target_link_uri
 * 2. Subsequent requests (has ltik) → verify LTIK, check cookie, load session
 *    from storage, attach to context variables
 */

import { getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import { DenoLTI } from "../deno-lti.ts";
import { validateToken } from "../auth/tokens.ts";
import { signLtik, verifyLtik } from "../auth/tokens.ts";
import { randomHex } from "../auth/keys.ts";
import { LTIService } from "../services/lti-service.ts";

import type { Storage } from "../storage/storage.ts";
import type { CookieOptions, ErrorHandler, LTIHandler, LtikPayload, Platform } from "../types.ts";
import type { Context, MiddlewareHandler } from "hono";
import type { ValidationResult } from "../auth/tokens.ts";

const IDTOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionMiddlewareOptions {
  lti: DenoLTI;
  storage: Storage;
  secret: string;
  ltiService: LTIService;
  launchCallback: LTIHandler;
  deepLinkingCallback: LTIHandler;
  onSessionTimeout: ErrorHandler;
  onInvalidToken: ErrorHandler;
  onUnregisteredPlatform: ErrorHandler;
  onInactivePlatform: ErrorHandler;
  devMode?: boolean;
  debug?: boolean;
  cookieOptions?: CookieOptions;
  ltiRoute: string;
}

// ---------------------------------------------------------------------------
// LTIK extraction
// ---------------------------------------------------------------------------

function extractLtik(c: Context): string | undefined {
  return c.req.query("ltik");
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

export function createSessionMiddleware(opts: SessionMiddlewareOptions): MiddlewareHandler {

  const {
    lti,
    storage,
    secret,
    ltiService,
    launchCallback,
    deepLinkingCallback,
    onSessionTimeout,
    onInvalidToken,
    onUnregisteredPlatform,
    onInactivePlatform,
    devMode = false,
    debug = false,
    cookieOptions = {},
    ltiRoute,
  } = opts;

  const sameSite = cookieOptions.sameSite ?? "Lax";

  return async function sessionMiddleware(c: Context, next) {
    const { pathname } = new URL(c.req.url);
    if (debug) console.debug(`sessionMiddleware ROUTE URL: ${c.req.url}`);

    // -----------------------------------------------------------------
    // 1. Initial LTI launch — id_token POSTed by platform
    // -----------------------------------------------------------------
    let body: Record<string, string> = {};
    if (c.req.method === "POST") {
      const raw = await c.req.parseBody();
      body = raw as Record<string, string>;
    } else {
      const raw = await c.req.query();
      body = raw as Record<string, string>;
    }

    if (body.id_token && body.state) {
      return handleLaunch(c, body.id_token, body.state);
    }

    // -----------------------------------------------------------------
    // 2. Subsequent request — must carry LTIK
    // -----------------------------------------------------------------
    const ltik: string | null = extractLtik(c);
    if (!ltik) {
      return onInvalidToken(c);
    }

    const payload: LtikPayload = await verifyLtik(ltik, secret);
    if (!payload) return onInvalidToken(c);
    if (debug) console.debug(`Launch redirect LTIK PAYLOAD: ${JSON.stringify(payload)}`);

    /*
    // Verify session cookie (binds browser session to this LTIK)
    if (!devMode) {
      const cookieValue = await getSignedCookie(c, secret, payload.platformCode);
      if (debug) {
        console.debug(`COOKIE VALUE: ${cookieValue}`);
      }
      if (cookieValue !== payload.user) {
        return onSessionTimeout(c);
      }
    }
    */

    // We can now use the ltik contents to load the launch tokens from storage
    const idTokenKey = `${payload.platformCode}${payload.userId}`;
    const contextTokenKey = `${payload.contextId}${payload.userId}`;
    const [idToken, contextToken] = await Promise.all([
      storage.getIdToken(idTokenKey),
      storage.getContextToken(contextTokenKey),
    ]);

    if (!idToken || !contextToken) {
      return onSessionTimeout(c);
    }

    // Attach to Hono context variables for use in handlers
    c.set("token", { ...idToken, platformContext: contextToken });
    c.set("ltik", ltik);
    c.set("platformCode", payload.platformCode);
    c.set("platformUrl", payload.platformUrl);
    c.set("clientId", payload.clientId);
    c.set("contextId", payload.contextId);
    c.set("userId", payload.userId);
    c.set("role", payload.role);

    // Route to the right callback
    const ltiContext = {
      token: { ...idToken, platformContext: contextToken },
      ltik,
    };

    if (debug) {
      console.debug("");
      console.debug("==== LTI CONTEXT ====");
      console.debug(ltiContext);
      console.debug("");
    }

    if (contextToken.messageType === "LtiDeepLinkingRequest" && pathname === ltiRoute) {
      return deepLinkingCallback(c, ltiContext);
    }

    if (pathname === ltiRoute) {
      return launchCallback(c, ltiContext);
    }

    return next();

    // -----------------------------------------------------------------
    // Launch handler (inner function — shares closure over opts)
    // -----------------------------------------------------------------
    async function handleLaunch(
      c: Context,
      idTokenJwt: string,
      state: string,
    ): Promise<Response> {

      // Retrieve state from DB
      const stateData = await storage.getState(state);
      if (!stateData) {
        return onInvalidToken(c);
      }

      // Verify state cookie
      const stateCookie = getCookie(c, `state${state}`);
      if (!stateData.iss || (stateCookie && stateCookie !== stateData.iss)) {
        await storage.deleteState(state);
        return onInvalidToken(c);
      }

      await storage.deleteState(state);

      // Look up platform
      const platform = await ltiService.getPlatform(stateData.iss, stateData.clientId as string);
      if (!platform) return onUnregisteredPlatform(c);
      if (!platform.active) return onInactivePlatform(c);

      // Validate the id_token
      let validationResult: Awaited<ValidationResult>;
      try {
        validationResult = await validateToken(idTokenJwt, platform, storage, debug);
      } catch (error) {
        if (debug) console.debug(error);
        return onInvalidToken(c);
      }

      const { idToken, contextToken } = validationResult;

      // Trim off the lti domain and user part of the user. We only want to provide the actual user
      // id sent by the platform.
      const userIdIndex = idToken.user.lastIndexOf("/");
      const userId = idToken.user.substring(userIdIndex + 1);

      // ---------------------------------------------------------------------------
      // Platform code — stable identifier for the platform session cookie
      // ---------------------------------------------------------------------------
      const pCode = "lti" + btoa(`${idToken.iss}${idToken.clientId}${idToken.deploymentId}`);

      // Persist tokens
      const idTokenKey = `${pCode}${userId}`;
      const contextTokenKey = `${contextToken.contextId}${userId}`;
      await Promise.all([
        storage.saveIdToken(idTokenKey, idToken, IDTOKEN_TTL_MS),
        storage.saveContextToken(contextTokenKey, contextToken, CONTEXT_TTL_MS),
      ]);


      // Create a token like object to circumvent the restrictions on cross origin cookies in modern
      // browsers. This token holds the necessary data to continue with the launch request after
      // OIDC auth. We call this the LTIK (LTI Key) and the pattern was lifted from ltijs.
      const ltikPayload: LtikPayload = {
        platformUrl: idToken.iss,
        clientId: idToken.clientId,
        deploymentId: idToken.deploymentId,
        platformCode: pCode,
        contextId: contextToken.contextId,
        s: randomHex(8),
        userId: userId,
      };

      if (contextToken.roles.length) {
        const hashIndex = contextToken.roles[0].indexOf("#");
        ltikPayload.role = contextToken.roles[0].substring(hashIndex + 1);
      }

      const ltik = await signLtik(ltikPayload, secret);

      /*
      // Set signed session cookie
      await setSignedCookie(c, pCode, idToken.user, secret, {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
      });
      */

      // Kick off member and group caching
      console.debug("Kicking off members and groups caching (if requested) from launch ...");
      lti.ensureMembersCached(idToken.iss, idToken.clientId, contextToken.contextId, userId);
      lti.ensureGroupsCached(idToken.iss, idToken.clientId, contextToken.contextId, userId);

      // Redirect to target with ltik
      const targetUri = contextToken.targetLinkUri || "/";
      const redirectUrl = new URL(
        targetUri.startsWith("http") ? targetUri : new URL(c.req.url).origin + targetUri,
      );
      redirectUrl.searchParams.set("ltik", ltik);

      if (debug) console.debug("Redirecting to target with ltik ...");
      return c.redirect(redirectUrl.toString());
    }
  };
}
