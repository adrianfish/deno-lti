import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { buildJwks } from "./auth/keys.ts";
import { createSessionMiddleware } from "./middleware/session.ts";
import { handleLogin } from "./routes/login.ts";
import { handleRegisterPlatform } from "./routes/register-platform.ts";
import { DenoKVStorage } from "./storage/denokv-storage.ts";
import { getCachedRoleTotals, getPageOfMembers, isMembersCacheBuilding } from "./services/nrps.ts";
import { getGroups } from "./services/groups.ts";
import { createLineItem, getLineItems, getResults, postScore } from "./services/grade.ts";
import { requestAccessToken } from "./services/oauth.ts";
import { GRADING, GROUPS, ROSTER } from "./constants.ts";
import { buildKeyId } from "./utils/platform-utils.ts";
import { createDeepLinkingForm, createDeepLinkingMessage } from "./services/deep-linking.ts";
import { deriveAesKey } from "./crypto.ts";
import { verifyLtik } from "./auth/tokens.ts";

import type { MiddlewareHandler } from "hono";
import type { Storage } from "./storage/storage.ts";
import type { MemberFilter } from "./services/nrps.ts";
import type { ContentItem, ErrorHandler, Group, LineItem, LineItemOptions, LtikPayload, LTIContext, LTIHandler, LTIToken, MemberPage, Platform, Result, Score, ToolOptions } from "./types.ts";

export class DenoLTI {

  #app = new Hono();
  #storage!: Storage;
  #toolDomain!: string;
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
   * @returns {Promise<DenoLTI>} A promise containing this DenoLTI instance
   */
  async setup(
    toolDomain: string,
    secret: string,
    clientName: string,
    description: string,
    logoUri: string,
    options: ToolOptions = {}
  ): Promise<this> {

    this.#toolDomain = toolDomain;
    this.#secret = secret;
    this.#clientName = clientName;
    this.#description = description;
    this.#logoUri = logoUri;
    this.#options = options;
    this.#aesKey = await deriveAesKey(secret);
    this.#storage = await DenoKVStorage.open();

    this.#buildRoutes();
    this.#ready = true;
    return this;
  }

  // ---------------------------------------------------------------------------
  // Public services (available after setup())
  // ---------------------------------------------------------------------------

  /**
   * Returns a page of members from the roster service. If the cache is hot, this will be very
   * quick but, if not, there may be a delay while the members are retrieved from the LTI Platform.
   *
   * @param {string} ltik A JWT with the basic platform details needed for api calls
   * @param {number} startNum The page number to retrieve
   * @param {number} lengthNum The number of members to retrieve
   * @param {object} [filter] The spec to be used while filtering the members
   *
   * @returns {Promise<MemberPage | null>} A promise which fulfils with the MemberPage
   */
  async getPageOfMembers(
    ltik: string,
    startNum: number,
    lengthNum: number,
    filter?: MemberFilter,
  ): Promise<MemberPage | null> {

    const { platformUrl, clientId, contextId, userId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!platformUrl || !clientId || !contextId || !userId) {
      return null;
    }

    if (this.#options.services?.includes(ROSTER)) {
      return getPageOfMembers(this.#storage, this.#toolDomain, this.#aesKey, platformUrl, clientId, contextId, userId, startNum, lengthNum, filter);
    }

    return null;
  }

  /**
   * Tests if the cache of members is currently being built.
   *
   * @param {string} ltik A JWT with the basic platform details needed for api calls
   *
   * @returns {Promise<boolean|null>} A promise which fulfils to either true or false.
   */
  async isMembersCacheBuilding(ltik: string): Promise<boolean | null> {

    const { clientId, contextId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!clientId || !contextId) {
      return null;
    }

    if (this.#options.services?.includes(ROSTER)) {
      return await isMembersCacheBuilding(this.#storage, clientId, contextId);
    }

    return false;
  }

  /*
   * Returns the groups from the groups service. If the cache is hot, this will be very
   * quick but, if not, there may be a delay while the groups are retrieved from the LTI Platform.
   * If GROUPS was not specified during setup, a null promise will be returned.
   *
   * @param {string} ltik A JWT with the basic platform details needed for api calls
   *
   * @returns {Promise<Array<Group> | null>} A promise which fulfils with the MemberPage or null
   */
  async getGroups(ltik: string,): Promise<Array<Group> | null> {

    const { platformUrl, clientId, contextId, userId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!platformUrl || !clientId || !contextId || !userId) {
      return null;
    }

    if (this.#options.services?.includes(GROUPS)) {
      return getGroups(this.#storage, this.#toolDomain, this.#aesKey, platformUrl, clientId, contextId, userId);
    }

    return null;
  }

  /**
   * Get the total members, broken down by LTI role.
   *
   * @param {string} ltik A JWT with the basic platform details needed for api calls
   *
   * @returns {Promise<Object | null>} A promise which fulfils with the totals object or null
   */
  async getRoleTotals(ltik: string): Promise<Record<string, number> | null> {

    const { clientId, contextId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!clientId || !contextId) {
      return null;
    }

    if (this.#options.services?.includes(ROSTER)) {
      return getCachedRoleTotals(this.#storage, clientId, contextId);
    }

    return null;
  }

  /**
   * Get the line items.
   *
   * @param {string} ltik A JWT with the basic platform details needed for api calls
   * @param {Object} [options] An optional LineItemOptions object
   *
   * @returns {Promise<Array> | null>} A promise which fulfils with an array of LineItem or null
   */
  async getLineItems(ltik: string, options?: LineItemOptions): Promise<LineItem[] | null> {

    const { platformUrl, clientId, contextId, userId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!platformUrl || !clientId || !contextId || !userId) {
      return null;
    }

    return getLineItems(
      this.#storage,
      this.#toolDomain,
      this.#aesKey,
      platformUrl,
      clientId,
      contextId,
      userId,
      options,
    );
  }


  async createLineItem(ltik: string, lineItem: LineItem): Promise<LineItem | null> {

    const { platformUrl, clientId, contextId, userId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!platformUrl || !clientId || !contextId || !userId) {
      return null;
    }

    return createLineItem(
      this.#storage,
      this.#toolDomain,
      this.#aesKey,
      platformUrl,
      clientId,
      contextId,
      userId,
      lineItem);
  }

  async postScore(ltik: string, lineItemId: string, score: Score): Promise<boolean> {

    const { platformUrl, clientId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!platformUrl || !clientId) {
      console.warn("platformUrl and clientId must be supplied");
      return false;
    }

    return postScore(
      this.#storage,
      this.#toolDomain,
      this.#aesKey,
      platformUrl,
      clientId,
      lineItemId,
      score
    );
  }

  async getResults(ltik: string, lineItemId: string): Promise<Result[] | null> {

    const { platformUrl, clientId, contextId, userId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!platformUrl || !clientId || !contextId || !userId) {
      console.warn("platformUrl, clientId, contextId and userId must be supplied");
      return null;
    }

    return getResults(
      this.#storage,
      this.#toolDomain, 
      this.#aesKey,
      platformUrl,
      clientId,
      contextId,
      userId,
      lineItemId
    );
  }

  /**
   * Creates and returns a form with the supplied content items encoded ready for a deep linking
   * request. The form auto submits.
   *
   * @param {object} data The lti params
   * @param {Array} items The array of content items to encode into the form
   * @param {string} toolUrl The url of this tool.
   *
   * @returns {Promise<string>} The form markup as a string.
   */
  createDeepLinkingForm(
    data: { platformCode: string; contextId: string; userId: string },
    items: ContentItem[],
    toolUrl: string,
  ): Promise<string> {

    return createDeepLinkingForm(
      data,
      items,
      this.#storage,
      this.#aesKey,
      toolUrl,
    );
  }

  /**
   * Create a signed Deep Linking response JWT. The caller can embed this in a form or return it
   * directly.
   *
   * @param {LTIToken} token The lti parameters.
   * @param {Array} items The array of content items to encode into the JWT.
   * @param {string} toolUrl The url of this tool.
   *
   * @returns {Promise<string>} The encoded deep linking JWT
   */
  createDeepLinkingMessage(
    token: LTIToken,
    items: ContentItem[],
    toolUrl: string,
  ): Promise<string> {

    return createDeepLinkingMessage(
      token,
      items,
      this.#storage,
      this.#aesKey,
      toolUrl,
    );
  }

  // ---------------------------------------------------------------------------
  // Callback registration
  // ---------------------------------------------------------------------------

  /**
   * Register a launch callback
   *
   * @param {LTIHandler} handler The handler to be called once launch has completed.
   *
   * @returns {DenoLTI} Returns this DenoLTI instance to allow chaining.
   */
  onLaunch(handler: LTIHandler): this {

    this.#launchCallback = handler;
    return this;
  }

  /**
   * Register a deep link  callback
   *
   * @param {LTIHandler} handler The handler to be called once a deep linking launch has completed.
   * @returns {DenoLTI} Returns this DenoLTI instance to allow chaining.
   */
  onDeepLinking(handler: LTIHandler): this {

    this.#deepLinkingCallback = handler;
    return this;
  }

  /**
   * Register a session timeout callback
   *
   * @param {LTIHandler} handler The handler to be called if the sessions times out.
   *
   * @returns {DenoLTI} Returns this DenoLTI instance to allow chaining.
   */
  onSessionTimeout(handler: ErrorHandler): this {

    this.#sessionTimeoutCallback = handler;
    return this;
  }

  /**
   * Register an invalid token callback
   *
   * @param {LTIHandler} handler The handler to be called if a token is invalid
   *
   * @returns {DenoLTI} Returns this DenoLTI instance to allow chaining.
   */
  onInvalidToken(handler: ErrorHandler): this {

    this.#invalidTokenCallback = handler;
    return this;
  }

  /**
   * Register an unregistered platform callback
   *
   * @param {ErrorHandler} handler The handler to be called if a platform is not registered
   *
   * @returns {DenoLTI} Returns this DenoLTI instance to allow chaining.
   */
  onUnregisteredPlatform(handler: ErrorHandler): this {

    this.#unregisteredPlatformCallback = handler;
    return this;
  }

  /**
   * Register an inactive platform callback
   *
   * @param {ErrorHandler} handler The handler to be called if the platform is inactive
   *
   * @returns {DenoLTI} Returns this DenoLTI instance to allow chaining.
   */
  onInactivePlatform(handler: ErrorHandler): this {

    this.#inactivePlatformCallback = handler;
    return this;
  }

  getProduct(ltiContext: LTIContext): string | undefined {
    return ltiContext?.token?.platformContext?.toolPlatform?.product_family_code;
  }

  async getAccessToken(ltik: string, scopes: Array<string>): Promise<string | null> {

    const { platformUrl, clientId } = (await verifyLtik(ltik, this.#secret)) || {};

    if (!platformUrl || !clientId) {
      return null;
    }

    const platform: Platform | null = await this.#storage.getPlatform(platformUrl, clientId);
    if (!platform) {
      console.warn(`Failed to get platform for url ${platformUrl} and ${clientId}`);
      return null;
    }
    const endpoint: string = platform.accesstokenEndpoint;
    const kid = buildKeyId(platform);
    return requestAccessToken(this.#toolDomain, endpoint, platformUrl, clientId, kid, scopes, this.#storage, this.#aesKey);
  }

  // ---------------------------------------------------------------------------
  // Hono app accessor — embed in a larger app
  // ---------------------------------------------------------------------------

  /**
   * Returns the configured Hono instance. Use this to mount deno-lti under a sub-path or alongside
   * other routes.
   *
   * <pre><code>
   *   const mainApp = new Hono()
   *   mainApp.route("/lti", await lti.setup(domain, key).then(l => l.handler()))
   * </code></pre>
   *
   * @returns The Hono instance
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
        handleLogin(c, this.#storage, {
          secure: this.#options.cookies?.secure ?? false,
          sameSite: this.#options.cookies?.sameSite ?? "Lax",
        }),
    );

    // Dynamic registration
    this.#app.on(
      ["GET", "POST"],
      "/register",
      (c) => handleRegisterPlatform(c, this.#storage, this.#toolDomain, this.#aesKey, this.#clientName, this.#description, this.#logoUri, this.#options),
    );

    // -------------------------------------------------------------------------
    // JWKS keyset endpoint
    // -------------------------------------------------------------------------
    this.#app.get("/keys", async (c) => c.json(await buildJwks(this.#storage, this.#aesKey)));

    // -------------------------------------------------------------------------
    // Session middleware — covers all other routes
    // -------------------------------------------------------------------------
    this.#app.use("*", createSessionMiddleware({
        storage: this.#storage,
        secret: this.#secret,
        aesKey: this.#aesKey,
        toolDomain: this.#toolDomain,
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
        services: this.#options.services,
      }));
  }

  #assertReady(): void {

    if (!this.#ready) {
      throw new Error("Call lti.setup() before using the tool");
    }
  }
}
