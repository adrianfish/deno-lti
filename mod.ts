/**
 * deno-lti — LTI 1.3 tool for Deno + Hono
 *
 * Zero Node.js dependencies. Uses Deno KV for storage by default.
 *
 * Quick start:
 *
 *   import { DenoLTI } from "./mod.ts"
 *
 *   const lti = new DenoLTI()
 *
 *   await lti
 *     .onConnect((c, { token }) => {
 *       return c.html(`<h1>Hello, ${token.userInfo.name}!</h1>`)
 *     })
 *     .setup("my-secret-key", denoKv)
 */

export { DenoLTI } from "./src/deno-lti.ts";
export type { LineItem, Result, Score } from "./src/services/grade.ts";
export type { ContentItem, StoredContextToken, StoredIdToken } from "./src/types.ts";
