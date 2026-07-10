# deno-lti

A zero-dependency [LTI 1.3](https://www.imsglobal.org/spec/lti/v1p3/) tool library for [Deno](https://deno.land/), built on [Hono](https://hono.dev/).

Implements the full LTI 1.3 + OIDC launch flow, Assignment & Grade Services (AGS), Deep Linking, and Names & Roles Provisioning. Uses Deno KV for storage.

## Installation

*This hasn't been added to JSR yet so you currently need to clone the source code and work with that.*

Install from JSR:

deno add @adrianfish/deno-lti

## Quick start

```ts
import { DenoLTI } from "jsr:@adrianfish/deno-lti";
import { Hono } from "jsr:@hono/hono";

const lti = new DenoLTI();

await lti
  .onLaunch((c, { token }) => {
    return c.html(`<h1>Hello, ${token.userInfo.name}!</h1>`);
  })
  .setup("my-lti-tool-domain.com", "SECRET", "My LTI Tool", "A tool that does stuff", "https://logos.com/my-tool-logo.png");

// If you're using Hono for your app logic, you can mount under a sub-path alongside other routes
const app = new Hono();
app.route("/lti", lti.handler());
app.get("/some-app-route", someAppRouteHandler);

Deno.serve(app.fetch);
```

The secret is used to sign session tokens (LTIKs) and encrypt stored RSA keys. It must remain consistent across restarts — changing it invalidates all active sessions and stored keys.

## Built-in routes

Once initialized, `lti.handler()` exposes these routes:

| Method | Path | Purpose |
|--------|------|---------|
| `GET, POST` | `/login` | OIDC login initiation (third-party login) |
| `GET, POST` | `/register` | Dynamic platform registration |
| `GET` | `/keys` | JWKS endpoint (your tool's public keys) |
| `GET, POST` | `/` *(or `appRoute`)* | LTI launch and subsequent requests |

When registering your tool with an LMS, point the **Initiate Login URL** at `/login`, the **Redirect/Launch URL** at `/` (or your `appRoute`), and the **Public Key / JWKS URL** at `/keys`.

## API reference

### `new DenoLTI()`

Creates a new LTI tool instance. Call the fluent callback-registration methods before calling `setup()`.

---

### `lti.setup(domain, secret, name, description, logoUri, options?): Promise<this>`

Initializes the tool. Must be called before `handler()`.

| Parameter | Type | Description |
|-----------|------|-------------|
| `toolDomain` | `string` | The domain that this tool will be hosted under. |
| `secret` | `string` | The passphrase for signing LTIKs and encrypting stored keys. Keep stable across restarts. |
| `name` | `string` | The name of your LTI tool. This is what will be displayed in the Platform's UI. |
| `description` | `string` | The description of your LTI tool. This is what will be displayed in the Platform's UI. |
| `logoUri` | `string` | The uri to your tools logo. This is what will be displayed in the Platform's UI. |
| `options` | `ToolOptions` *(optional)* | Configuration — see below. |

**`ToolOptions`**

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `ltiRoute` | `string` | `"/"` | Route for the main LTI launch endpoint. |
| `cookies` | `CookieOptions` | — | Cookie settings: `secure`, `sameSite` (`"Strict"` \| `"Lax"` \| `"None"`), `domain`. |
| `devMode` | `boolean` | `false` | Skips session cookie validation. **Never use in production.** |
| `debug` | `boolean` | `false` | Enables verbose debug logging. |
| `customParameters` | `object` | `undefined` | Extra custom parameters to request at registration. |
| `services` | `string[]` | `undefined` | Services to enable for this LTI tool. ROSTER, GROUPS and GRADINGE currently supported. |

---

### `lti.handler(): Hono`

Returns the configured Hono instance. Mount it in a larger application with `app.route(path, lti.handler())`, or pass `lti.handler().fetch` directly to `Deno.serve()`.

Must be called after `setup()`.

---

### Event handlers (fluent, chainable)

Register callbacks before calling `setup()`. Each returns `this` for chaining.

#### `lti.onLaunch(handler): this`

Called on every standard LTI resource-link launch (`LtiResourceLinkRequest`). This is the primary entry point for your tool's UI.

```ts
lti.onLaunch(async (c, { token, ltik }) => {
  const name = token.userInfo.name;
  const roles = token.platformContext.roles;
  return c.html(`<p>Hello ${name} — roles: ${roles.join(", ")}</p>`);
});
```

#### `lti.onDeepLinking(handler): this`

Called when the platform initiates a Deep Linking content selection (`LtiDeepLinkingRequest`).

```ts
lti.onDeepLinking(async (c, { token }) => {
  // Build items and return a response form
  const form = await lti.DeepLinking.createDeepLinkingForm(
    token,
    [{ type: "ltiResourceLink", title: "My Activity", url: "https://example.com/activity" }],
    "https://my-tool.example.com",
  );
  return c.html(form);
});
```

#### Error handlers

| Method | Default response | Trigger |
|--------|-----------------|---------|
| `lti.onSessionTimeout(handler)` | `401 Session expired` | LTIK expired or not found in storage |
| `lti.onInvalidToken(handler)` | `401 Invalid token` | ID token fails validation |
| `lti.onUnregisteredPlatform(handler)` | `400 Unregistered platform` | Platform issuer not in the registry |
| `lti.onInactivePlatform(handler)` | `401 Platform inactive` | Platform has been deactivated |

All error handlers receive a Hono `Context` and must return a `Response`.

---

### Handler arguments

Both `onLaunch` and `onDeepLinking` receive `(c: Context, lti: LTIContext)`.

**`LTIContext`**

| Field | Type | Description |
|-------|------|-------------|
| `token` | `LTIToken` | Combined identity + launch context (see below). |
| `context` | `StoredContextToken` | Alias for `token.platformContext`. |
| `ltik` | `string` | The signed session JWT. Pass this in subsequent API requests as the ltik query parameter. |

**`LTIToken`** (extends `StoredIdToken`)

| Field | Type | Description |
|-------|------|-------------|
| `iss` | `string` | Platform issuer URL. |
| `user` | `string` | User `sub` claim. |
| `userInfo` | `UserInfo` | `given_name`, `family_name`, `name`, `email`. |
| `platformInfo` | `Record<string, unknown>` | Raw platform instance claim. |
| `clientId` | `string` | Tool client ID registered with the platform. |
| `platformId` | `string` | Internal platform identifier. |
| `deploymentId` | `string` | LTI deployment ID. |
| `platformContext` | `StoredContextToken` | Launch context (see below). |

**`StoredContextToken`**

| Field | Type | Description |
|-------|------|-------------|
| `contextId` | `string` | Platform context identifier (course/group ID). |
| `user` | `string` | User `sub`. |
| `roles` | `string[]` | LTI role URNs (e.g. `http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor`). |
| `targetLinkUri` | `string` | Requested resource URL. |
| `messageType` | `"LtiResourceLinkRequest" \| "LtiDeepLinkingRequest"` | Launch message type. |
| `context` | `Record<string, unknown>` | Platform context claim (title, label, types). |
| `resource` | `Record<string, unknown>` | Resource link claim. |
| `custom` | `Record<string, unknown>` | Custom parameters set in the platform. |
| `launchPresentation` | `Record<string, unknown>` | Presentation hints (locale, document target). |
| `deepLinkingSettings` | `Record<string, unknown>` *(optional)* | Deep Linking settings (present on Deep Linking launches). |
| `lis` | `Record<string, unknown>` | LIS data (course sourced ID, etc.). |
| `endpoint` | `Record<string, unknown>` *(optional)* | AGS endpoint URLs (`lineitems`, `lineitem`). |
| `namesRoles` | `Record<string, unknown>` *(optional)* | Names & Roles Provisioning endpoint. |

---

### Session token transport

Subsequent requests (after the initial launch redirect) must carry the LTIK session token as a query parameter.

`?ltik=<ltik>` query parameter

---

### `lti.grade` — Assignment & Grade Service

Available after `setup()`. Implements [LTI AGS v2.0](https://www.imsglobal.org/spec/lti-ags/v2p0/).

#### `lti.grade.getLineItems(token, options?): Promise<LineItem[]>`

Fetches all line items for the current context. Follows pagination automatically.

```ts
const items = await lti.grade.getLineItems(token, { resourceId: "quiz-1" });
```

Options: `resourceId?: string`, `tag?: string`.

#### `lti.grade.createLineItem(token, lineItem): Promise<LineItem>`

Creates a new gradebook column.

```ts
const item = await lti.grade.createLineItem(token, {
  label: "Midterm Exam",
  scoreMaximum: 100,
  resourceId: "midterm",
});
```

#### `lti.grade.postScore(token, lineItemId, score): Promise<void>`

Posts a score for a user to a line item.

```ts
await lti.grade.postScore(token, item.id!, {
  userId: token.user,
  scoreGiven: 85,
  scoreMaximum: 100,
  activityProgress: "Completed",
  gradingProgress: "FullyGraded",
});
```

#### `lti.grade.getResults(token, lineItemId): Promise<Result[]>`

Retrieves all results for a line item. Follows pagination automatically.

**`LineItem`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scoreMaximum` | `number` | yes | Maximum possible score. |
| `label` | `string` | yes | Display name in the gradebook. |
| `id` | `string` | no | Set by platform on create; use for subsequent calls. |
| `resourceId` | `string` | no | Tool-defined identifier for the associated resource. |
| `tag` | `string` | no | Arbitrary tag for filtering. |
| `resourceLinkId` | `string` | no | Links the line item to a specific resource link. |

**`Score`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `userId` | `string` | yes | The user's `sub` claim. |
| `activityProgress` | `string` | yes | `"Initialized"` \| `"Started"` \| `"InProgress"` \| `"Submitted"` \| `"Completed"` |
| `gradingProgress` | `string` | yes | `"FullyGraded"` \| `"Pending"` \| `"PendingManual"` \| `"Failed"` \| `"NotReady"` |
| `scoreGiven` | `number` | no | Points awarded. |
| `scoreMaximum` | `number` | no | Maximum points (overrides line item value if set). |
| `comment` | `string` | no | Instructor feedback. |
| `timestamp` | `string` | no | ISO 8601; defaults to current time. |

**`Result`**

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Result identifier. |
| `userId` | `string` | User `sub`. |
| `resultScore` | `number` | Score awarded. |
| `resultMaximum` | `number` | Maximum possible. |
| `comment` | `string` | Instructor feedback. |

---

### `lti.DeepLinking` — Deep Linking Service

Available after `setup()`. Implements [LTI Deep Linking v1.2](https://www.imsglobal.org/spec/lti-dl/v1p0/).

#### `lti.createDeepLinkingForm(data, items, toolUrl): Promise<string>`

Returns an HTML string containing a form that auto-submits the signed Deep Linking response back to
the platform. Render this directly as the response body.

#### `lti.createDeepLinkingMessage(token, items, toolUrl): Promise<string>`

Returns the raw signed JWT Deep Linking response message, for cases where you need to submit it
manually.

**`ContentItem`**

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Item type, e.g. `"ltiResourceLink"`, `"link"`, `"file"`, `"html"`. |
| *(additional)* | `unknown` | Any additional fields defined by the content item type spec. |

---

## Platform registration

Direct the LMS to `GET /register?openid_configuration=<url>`. The handler fetches the platform's
OpenID configuration, completes OAuth2 dynamic client registration, and stores the platform
automatically.

---

## Exported types

```ts
import type {
  // Grade service types
  LineItem,
  Result,
  Score,
  // Launch context types
  ContentItem,
  StoredContextToken,
  StoredIdToken,
} from "jsr:@adrianfish/deno-lti";
```

---

## LTI 1.3 specifications

| Specification | Link |
|---------------|------|
| LTI 1.3 Core | https://www.imsglobal.org/spec/lti/v1p3/ |
| LTI Security Framework (OIDC) | https://www.imsglobal.org/spec/security/v1p0/ |
| Assignment and Grade Services 2.0 | https://www.imsglobal.org/spec/lti-ags/v2p0/ |
| Deep Linking 1.2 | https://www.imsglobal.org/spec/lti-dl/v1p0/ |
| Names and Role Provisioning Services 2.0 | https://www.imsglobal.org/spec/lti-nrps/v2p0/ |
| LTI 1.3 Implementation Guide | https://www.imsglobal.org/spec/lti/v1p3/impl/ |
