import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { buildJwks } from "./auth/keys.ts";
import { createSessionMiddleware } from "./middleware/session.ts";
import { handleLogin } from "./routes/login.ts";
import { handleRegisterPlatform } from "./routes/register-platform.ts";
import { DenoKVStorage } from "./storage/denokv-storage.ts";
import { GradeService } from "./services/grade.ts";
import { NamesAndRoleService } from "./services/nrps.ts";
import { GRADING, GROUPS, ROSTER } from "./constants.ts";
import { GroupsService } from "./services/groups.ts";
import { LTIService } from "./services/lti-service.ts";
import { createDeepLinkingForm, createDeepLinkingMessage } from "./services/deep-linking.ts";
import { deriveAesKey } from "./crypto.ts";

import type { MiddlewareHandler } from "hono";
import type { MemberPage, Storage } from "./storage/storage.ts";
import type { ErrorHandler, LTIHandler, ToolOptions } from "./types.ts";

export class DenoLTI {

  #app = new Hono();
  #storage!: Storage;
  #nrps!: NamesAndRoleService;
  #groups!: GroupsService;
  #ltiService!: LTIService;
  #secret!: string;
  #clientName!: string;
  #logoUri!: string;
  #description!: string;
  #aesKey!: CryptoKey;
  #options!: ToolOptions;
  #launchCallback: LTIHandler = (c) => c.text("No onLaunch handler registered", 500);
  #deepLinkingCallback: LTIHandler = (c) => c.text("No onDeepLinking handler registered", 500);
  #sessionTimeoutCallback: ErrorHandler = (c) => c.text("Session expired", 401);
  #invalidTokenCallback: ErrorHandler = (c) => c.text("Invalid token", 401);
  #unregisteredPlatformCallback: ErrorHandler = (c) => c.text("Unregistered platform", 400);
  #inactivePlatformCallback: ErrorHandler = (c) => c.text("Platform inactive", 401);
  #ready = false;

  /**
   * Initialize the tool.
   *
   * <pre><code>
   *   const lti = new DenoLTI();
   *   await lti.setup("myltitool.com", "some-secret", "Tool Name", "A Great Tool", "https://logos.com/logo.png", { ltiRoute: "/lti", debug: true });
   * </code></pre>
   *
   * @param {string} toolDomain The domain that this LTI tool will be hosted under.
   * @param {string} secret Passphrase used to sign LTIKs and encrypt stored keys.
   *                 Keep this secret and consistent across restarts.
   * @param {string} clientName The name of your LTI tool. This will be supplied during the dynamic
   *                 registration and displayed in the Platform's UI
   * @param {string} description The description of your LTI tool. This will be supplied during the
   *                 dynamic registration and displayed in the Platform's UI
   * @param {string} logoUri The uri of the logo to use with your tool. This will be supplied during
   *                 the dynamic registration and displayed in the Platform's UI
   * @param {ToolOptions} options Optional configuration.
   *
   * @returns A promise containing this DenoLTI instance
   */
  async setup(
    toolDomain: string,
    secret: string,
    clientName: string,
    description: string,
    logoUri: string,
    options: ToolOptions = {}
  ): Promise<this> {

    this.#secret = secret;
    this.#clientName = clientName;
    this.#description = description;
    this.#logoUri = logoUri;
    this.#aesKey = await deriveAesKey(secret);
    this.#storage = await DenoKVStorage.open();
    this.#options = options;

    if (options.services?.includes(GRADING)) {
      this.grade = new GradeService(this.#storage, this.#aesKey);
    }

    this.#ltiService = new LTIService(options);
    this.#ltiService.storage = this.#storage;
    this.#ltiService.aesKey = this.#aesKey;
    this.#ltiService.toolDomain = toolDomain;

    if (options.services?.includes(ROSTER)) {
      this.#nrps = new NamesAndRoleService(this.#storage, this.#aesKey, this.#ltiService);
    }

    if (options.services?.includes(GROUPS)) {
      this.#groups = new GroupsService(this.#storage, this.#aesKey, this.#ltiService);
    }

    this.#buildRoutes();
    this.#ready = true;
    return this;
  }

  // ---------------------------------------------------------------------------
  // Public services (available after setup())
  // ---------------------------------------------------------------------------

  grade!: GradeService;
  groups!: GroupsService;

  async getPageOfMembers(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
    startNum: number,
    lengthNum: number,
    filter?: (object) => boolean,
  ): Promise<MemberPage> {

    return this.#nrps.getPageOfMembers(platformUrl, clientId, contextId, userId, startNum, lengthNum, filter);
  }

  async ensureMembersCached(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
  ): Promise<void> {

    if (this.#options.services?.includes(ROSTER)) {
      await this.#nrps.ensureMembersCached(
        platformUrl,
        clientId,
        contextId,
        userId,
      );
    }
  }

  async isMembersCacheBuilding(
    clientId: string,
    contextId: string
  ): Promise<boolean> {

    if (this.#options.services?.includes(ROSTER)) {
      return await this.#nrps.isMembersCacheBuilding(clientId, contextId);
    }

    return false;
  }

  async ensureGroupsCached(
    platformUrl: string,
    clientId: string,
    contextId: string,
    userId: string,
  ): Promise<void> {

    if (this.#options.services?.includes(GROUPS)) {
      await this.#groups.ensureGroupsCached(
        platformUrl,
        clientId,
        contextId,
        userId,
      );
    }
  }

  async getGroups(
    clientId: string,
    contextId: string,
  ): Promise<Array<Record<string, string>> | null> {

    if (this.#options.services?.includes(GROUPS)) {
      return this.#groups.getGroups(clientId, contextId);
    }

    return null;
  }

  async getCachedTotals(
    clientId: string,
    contextId: string,
  ): Promise<Record<string, string> | null> {

    if (this.#options.services?.includes(ROSTER)) {
      return this.#nrps.getCachedTotals(clientId, contextId);
    }

    return null;
  }

  get DeepLinking() {
    return {
      createDeepLinkingForm: (
        data: Record<string, string>,
        items: Parameters<typeof createDeepLinkingForm>[1],
        toolUrl: string,
      ) =>
        createDeepLinkingForm(
          data,
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

  onLaunch(handler: LTIHandler): this {
    this.#launchCallback = handler;
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

  // ---------------------------------------------------------------------------
  // Hono app accessor — embed in a larger app
  // ---------------------------------------------------------------------------

  /**
   * Returns the configured Hono instance.
   * Use this to mount deno-lti under a sub-path or alongside other routes:
   *
   *   const mainApp = new Hono()
   *   mainApp.route("/lti", await lti.setup(domain, key).then(l => l.handler()))
   */
  handler(): Hono {

    this.#assertReady();
    return this.#app;
  }

  /**
   * Build all of our Hono lti routes
   */
  #buildRoutes(): void {

    // ltiRoute defaults to /lti
    const ltiRoute = this.#options.ltiRoute ?? "/lti";

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

    // Dynamic registration
    this.#app.on(
      ["GET", "POST"],
      "/register",
      (c) => handleRegisterPlatform(c, this.#storage, this.#ltiService, this.#clientName, this.#description, this.#logoUri, this.#options),
    );

    // -------------------------------------------------------------------------
    // JWKS keyset endpoint
    // -------------------------------------------------------------------------
    this.#app.get("/keys", async (c) => c.json(await buildJwks(this.#storage, this.#aesKey)));

    // -------------------------------------------------------------------------
    // Session middleware — covers all other routes
    // -------------------------------------------------------------------------
    const sessionMiddleware: MiddlewareHandler = createSessionMiddleware({
      lti: this,
      storage: this.#storage,
      secret: this.#secret,
      ltiService: this.#ltiService,
      launchCallback: this.#launchCallback,
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
