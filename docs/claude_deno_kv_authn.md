Deno KV remote stores (hosted on Deno Deploy) use access tokens for authentication. Here's how it works:

---

## Access Tokens

When you connect to a remote KV store, you authenticate using a Deno Deploy access token:

```typescript
const kv = await Deno.openKv(
  "https://api.deno.com/databases/<database-id>/connect"
);
```

The token is provided via the `DENO_KV_ACCESS_TOKEN` environment variable:

```bash
DENO_KV_ACCESS_TOKEN=<your_token> deno run --unstable-kv script.ts
```

You generate tokens in the Deno Deploy dashboard under **Account Settings → Access Tokens**.

---

## Scoping Access

There are two levels of token:

**Personal access tokens** — full access to all databases in your account. Suitable for development and tooling but too broad for production services.

**Deploy-scoped tokens** — automatically provisioned for Deno Deploy applications. When your code runs on Deno Deploy itself, it gets implicit access to KV databases in the same project without needing an explicit token.

---

## Best Practices

**Never hardcode tokens** — always use environment variables:

```typescript
// This is handled automatically - don't do this:
// const token = "ddp_abc123...";

// Instead set DENO_KV_ACCESS_TOKEN in your environment
// and just open the KV store:
const kv = await Deno.openKv(process.env.KV_URL);
```

**Use project-scoped databases** — keep your KV database in the same Deno Deploy project as your application so it uses implicit auth rather than explicit tokens.

**Rotate tokens regularly** — if you're using personal access tokens for external access (e.g. from a script or CI pipeline), rotate them periodically in the dashboard.

**Restrict by environment** — use different databases for development and production, so a leaked dev token doesn't expose production data:

```bash
# Development
DENO_KV_ACCESS_TOKEN=<dev_token>
KV_URL=https://api.deno.com/databases/<dev-db-id>/connect

# Production (set in Deno Deploy project env vars)
KV_URL=https://api.deno.com/databases/<prod-db-id>/connect
```

---

## Accessing from Outside Deno Deploy

If you need to access a remote KV store from outside Deno Deploy (e.g. from a local script, a different server, or a CI pipeline), you need the `@deno/kv` npm package or the Deno runtime with the access token set:

```typescript
import { openKv } from "jsr:@deno/kv";

const kv = await openKv(
  "https://api.deno.com/databases/<database-id>/connect",
  { accessToken: Deno.env.get("DENO_KV_ACCESS_TOKEN") }
);
```

---

## What There Isn't

It's worth noting that Deno KV doesn't currently have:
- Fine-grained key-level access control (you can't give a token read-only access to a specific key prefix)
- IP allowlisting
- Audit logging

So the security model is fairly coarse — a token either has full access to a database or it doesn't. If you need more granular access control, the recommended pattern is to put your own API layer in front of KV and handle authorization there, rather than exposing KV directly.
