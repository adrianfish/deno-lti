/**
 * DenoLTI — the main entry point.
 *
 *   const lti = new DenoLTI
 *   await lti
 *     .onConnect((c, { token }) => c.json({ user: token.user }))
 *     .setup("my-secret", denoKv);
 *
 *   const app = new Hono()
 *   app.route("/lti", lti.handler())
 */

import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { buildJwks } from "./auth/keys.ts";
import { createSessionMiddleware } from "./middleware/session.ts";
import { handleLogin } from "./routes/login.ts";
import { handleRegisterPlatform } from "./routes/register-platform.ts";
import { DenoKVStorage } from "./storage/denokv-storage.ts";
import { GradeService } from "./services/grade.ts";
import { NamesAndRoleService } from "./services/nrps.ts";
import { LTIService } from "./services/lti-service.ts";
import { createDeepLinkingForm, createDeepLinkingMessage } from "./services/deep-linking.ts";
import { deriveAesKey } from "./crypto.ts";
import type { Storage } from "./storage/storage.ts";
import type { CookieOptions, ErrorHandler, LTIHandler, StoredContextToken, StoredIdToken, ToolOptions } from "./types.ts";

export class DenoLTI {
  #app = new Hono();
  #storage!: Storage;
  #ltiService!: LTIService;
  #secret!: string;
  #aesKey!: CryptoKey;
  #options!: ToolOptions;
  #connectCallback: LTIHandler = (c) => c.text("No onConnect handler registered", 500);
  #deepLinkingCallback: LTIHandler = (c) => c.text("No onDeepLinking handler registered", 500);
  #sessionTimeoutCallback: ErrorHandler = (c) => c.text("Session expired", 401);
  #invalidTokenCallback: ErrorHandler = (c) => c.text("Invalid token", 401);
  #unregisteredPlatformCallback: ErrorHandler = (c) => c.text("Unregistered platform", 400);
  #inactivePlatformCallback: ErrorHandler = (c) => c.text("Platform inactive", 401);
  #ready = false;

  /**
   * Initialize the tool.
   *
   * @param {string} secret Passphrase used to sign LTIKs and encrypt stored keys.
   *                 Keep this secret and consistent across restarts.
   * @param {Deno.Kv} kv Pre-initialised DenoKv instance
   * @param {ToolOptions} options Optional configuration.
   */
  async setup(secret: string, kv?: Deno.Kv, options: ToolOptions = {}): Promise<this> {
    this.#secret = secret;
    this.#aesKey = await deriveAesKey(secret);
    this.#storage = await DenoKVStorage.open(kv);
    this.#options = options;
    this.grade = new GradeService(this.#storage, this.#aesKey);

    this.#ltiService = new LTIService(options);
    this.#ltiService.storage = this.#storage;
    this.#ltiService.aesKey = this.#aesKey;

    this.nrps = new NamesAndRoleService(this.#storage, this.#aesKey, this.#ltiService);

    this.#buildRoutes();
    this.#ready = true;
    return this;
  }


  // ---------------------------------------------------------------------------
  // Public services (available after setup())
  // ---------------------------------------------------------------------------

  grade!: GradeService;

  nrps!: NameAndRoleService;

  loadUsers(
    membershipsUrl?: string,
    accessToken?: string,
    platformUrl?: string,
    clientId?: string,
    contextId?: string,
    user?: string
  ): Promise<any> {
    return this.nrps.loadUsers(membershipsUrl, accessToken, platformUrl, clientId, contextId, user);
  }

  get DeepLinking() {
    return {
      createDeepLinkingForm: (
        token: Parameters<typeof createDeepLinkingForm>[0],
        items: Parameters<typeof createDeepLinkingForm>[1],
        toolUrl: string,
      ) =>
        createDeepLinkingForm(
          token,
          items,
          this.#storage,
          this.#aesKey,
          toolUrl,
        ),

      createDeepLinkingMessage: (
        token: Parameters<typeof createDeepLinkingMessage>[0],
        items: Parameters<typeof createDeepLinkingMessage>[1],
        toolUrl: string,
      ) =>
        createDeepLinkingMessage(
          token,
          items,
          this.#storage,
          this.#aesKey,
          toolUrl,
        ),
    };
  }

  // ---------------------------------------------------------------------------
  // Callback registration
  // ---------------------------------------------------------------------------

  onConnect(handler: LTIHandler): this {
    this.#connectCallback = handler;
    return this;
  }

  onDeepLinking(handler: LTIHandler): this {
    this.#deepLinkingCallback = handler;
    return this;
  }

  onSessionTimeout(handler: ErrorHandler): this {
    this.#sessionTimeoutCallback = handler;
    return this;
  }

  onInvalidToken(handler: ErrorHandler): this {
    this.#invalidTokenCallback = handler;
    return this;
  }

  onUnregisteredPlatform(handler: ErrorHandler): this {
    this.#unregisteredPlatformCallback = handler;
    return this;
  }

  onInactivePlatform(handler: ErrorHandler): this {
    this.#inactivePlatformCallback = handler;
    return this;
  }

  getContextToken(key: string): Promise<StoredContextToken | null> {
    return this.#storage.getContextToken(key);
  }

  getIdToken(key: string): Promise<StoredIdToken | null> {
    return this.#storage.getIdToken(key);
  }

  // ---------------------------------------------------------------------------
  // Hono app accessor — embed in a larger app
  // ---------------------------------------------------------------------------

  /**
   * Returns the configured Hono instance.
   * Use this to mount deno-lti under a sub-path or alongside other routes:
   *
   *   const mainApp = new Hono()
   *   mainApp.route("/lti", await lti.setup(key, denoKv).then(l => l.handler()))
   */
  handler(): Hono {
    this.#assertReady();
    return this.#app;
  }

  /**
   * Build all of our Hono lti routes
   */
  #buildRoutes(): void {
    const ltiRoute = this.#options.ltiRoute ?? "/";

    // Security middleware
    this.#app.use(
      "*",
      secureHeaders({
        xFrameOptions: false, // Must allow iframe embedding for LTI
      }),
    );

    // CORS — LTI launches are always cross-origin
    this.#app.use("*", cors({ origin: "*", credentials: true }));

    // -------------------------------------------------------------------------
    // OIDC login initiation
    // -------------------------------------------------------------------------
    this.#app.on(
      ["GET", "POST"],
      "/login",
      (c) =>
        handleLogin(c, this.#storage, this.#ltiService, {
          secure: this.#options.cookies?.secure ?? false,
          sameSite: this.#options.cookies?.sameSite ?? "Lax",
        }),
    );

    this.#app.on(
      ["GET", "POST"],
      "/register",
      (c) => handleRegisterPlatform(c, this.#storage, this.#ltiService, this.#options.debug),
    );

    // -------------------------------------------------------------------------
    // JWKS keyset endpoint
    // -------------------------------------------------------------------------
    this.#app.get("/keys", async (c) => c.json(await buildJwks(this.#storage, this.#aesKey)));

    // -------------------------------------------------------------------------
    // Session middleware — covers all other routes
    // -------------------------------------------------------------------------
    const sessionMiddleware = createSessionMiddleware({
      lti: this,
      storage: this.#storage,
      secret: this.#secret,
      ltiService: this.#ltiService,
      connectCallback: this.#connectCallback,
      deepLinkingCallback: this.#deepLinkingCallback,
      onSessionTimeout: this.#sessionTimeoutCallback,
      onInvalidToken: this.#invalidTokenCallback,
      onUnregisteredPlatform: this.#unregisteredPlatformCallback,
      onInactivePlatform: this.#inactivePlatformCallback,
      devMode: this.#options.devMode,
      debug: this.#options.debug,
      cookieOptions: this.#options.cookies,
      ltiRoute,
    });

    this.#app.use("*", sessionMiddleware);
  }

  #assertReady(): void {
    if (!this.#ready) {
      throw new Error("Call lti.setup() before using the tool");
    }
  }
}
