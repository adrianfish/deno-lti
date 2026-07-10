/**
 * deno-lti — LTI 1.3 tool for Deno + Hono
 *
 * Zero Node.js dependencies. Uses Deno KV for storage by default.
 *
 * Quick start:
 *
 * <pre><code>
 *
 *   import { DenoLTI } from "jsr:@adrianfish/deno-lti";
 *   import { Hono } from "jsr:@hono/hono";
 *
 *   const lti = new DenoLTI();
 *
 *   await lti
 *     .onLaunch((c, { token }) => {
 *       return c.html(`<h1>Hello, ${token.userInfo.name}!</h1>`);
 *     })
 *     .setup("my-lti-tool-domain.com", "my-persistent-secret-key");
 *
 * </code></pre>
 */

export { DenoLTI } from "./src/deno-lti.ts";
export * from   "./src/constants.ts";

export type { LineItem, Result, Score } from "./src/services/grade.ts";
export type { ContentItem, StoredContextToken, StoredIdToken } from "./src/types.ts";
