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

import type { Context, MiddlewareHandler } from "hono";
import { getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import { DenoLTI } from "../deno-lti.ts";
import { validateToken } from "../auth/tokens.ts";
import { signLtik, verifyLtik } from "../auth/tokens.ts";
import { randomHex } from "../auth/keys.ts";
import { LTIService } from "../services/lti-service.ts";
import type { Storage } from "../storage/storage.ts";
import type { CookieOptions, ErrorHandler, LTIHandler, LtikPayload, Platform } from "../types.ts";

const IDTOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface SessionMiddlewareOptions {
  lti: DenoLTI;
  storage: Storage;
  secret: string;
  ltiService: LTIService;
  connectCallback: LTIHandler;
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

function extractLtik(c: Context): string | null {
  // 1. LTIK-AUTH-V1 header: Authorization: LTIK-AUTH-V1 Token=<ltik>[,Additional=<extra>]
  const authHeader = c.req.header("authorization") ?? "";
  if (authHeader.startsWith("LTIK-AUTH-V1")) {
    const match = authHeader.match(/Token=([^,\s]+)/);
    if (match) return match[1];
  }

  // 2. Bearer token
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // 3. Query parameter
  const queryLtik = c.req.query("ltik");
  if (queryLtik) return queryLtik;

  return null;
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
    connectCallback,
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
    const ltik = extractLtik(c);
    if (!ltik) {
      return onInvalidToken(c);
    }

    const ltikPayload = await verifyLtik(ltik, secret);
    if (!ltikPayload) {
      return onInvalidToken(c);
    }

    const payload = ltikPayload as unknown as LtikPayload;
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

    // Load tokens from storage
    const tokenKey = `${payload.platformCode}${payload.user}`;
    const contextKey = `${payload.contextId}${payload.user}`;
    const [idToken, contextToken] = await Promise.all([
      storage.getIdToken(tokenKey),
      storage.getContextToken(contextKey),
    ]);

    if (!idToken || !contextToken) {
      return onSessionTimeout(c);
    }

    // Attach to Hono context variables for use in handlers
    c.set("token", { ...idToken, platformContext: contextToken });
    c.set("context", contextToken);
    c.set("ltik", ltik);
    c.set("platformCode", payload.platformCode);
    c.set("platformUrl", payload.platformUrl);
    c.set("clientId", payload.clientId);
    c.set("contextId", payload.contextId);
    c.set("user", payload.user);

    // Route to the right callback
    const ltiContext = {
      token: { ...idToken, platformContext: contextToken },
      context: contextToken,
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
      return connectCallback(c, ltiContext);
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
      let validationResult: Awaited<ReturnType<typeof validateToken>>;
      try {
        validationResult = await validateToken(idTokenJwt, platform, storage, debug);
      } catch (_err) {
        if (debug) console.debug(_err);
        return onInvalidToken(c);
      }

      const { idToken, contextToken } = validationResult;

      // ---------------------------------------------------------------------------
      // Platform code — stable identifier for the platform session cookie
      // ---------------------------------------------------------------------------
      const pCode = "lti" + btoa(`${idToken.iss}${idToken.clientId}${idToken.deploymentId}`);

      // Persist tokens
      const tokenKey = `${pCode}${idToken.user}`;
      const contextKey = `${contextToken.contextId}${idToken.user}`;
      await Promise.all([
        storage.saveIdToken(tokenKey, idToken, IDTOKEN_TTL_MS),
        storage.saveContextToken(contextKey, contextToken, CONTEXT_TTL_MS),
      ]);

      // Mint LTIK
      const ltikPayloadData: LtikPayload = {
        platformUrl: idToken.iss,
        clientId: idToken.clientId,
        deploymentId: idToken.deploymentId,
        platformCode: pCode,
        contextId: contextToken.contextId,
        user: idToken.user,
        s: randomHex(8),
      };
      const ltik = await signLtik(ltikPayloadData as unknown as Record<string, unknown>, secret);

      /*
      // Set signed session cookie
      await setSignedCookie(c, pCode, idToken.user, secret, {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
      });
      */

      // Redirect to target with ltik
      const targetUri = contextToken.targetLinkUri || "/";
      const redirectUrl = new URL(
        targetUri.startsWith("http") ? targetUri : new URL(c.req.url).origin + targetUri,
      );
      redirectUrl.searchParams.set("ltik", ltik);

      if (debug) console.debug("Redirecting to target with ltik ...");
      return c.redirect(redirectUrl.toString(), 302);
    }
  };
}
