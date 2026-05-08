Deno Deploy edge applications have a fairly specific lifecycle that differs from traditional server applications. Here's an overview:

---

## Isolation Model

Each request to a Deno Deploy application is handled by an **isolate** — a V8 isolate, the same sandboxing primitive used by Cloudflare Workers. Isolates are lightweight compared to full processes or containers, which is what allows Deno Deploy to spin them up quickly at the edge.

---

## Cold Start vs Warm Start

**Cold start** — when no isolate is currently running for your application, Deno Deploy needs to:
1. Load your application code
2. Execute the top-level module code
3. Then handle the incoming request

**Warm start** — if an isolate is already running (because it recently handled a request), it gets reused and your handler is called directly, skipping the initialisation cost.

Top-level `await` and expensive initialisation at module scope directly impacts your cold start time, so it's worth keeping that minimal.

---

## Lifetime of an Isolate

Isolates are **not guaranteed to persist** between requests. Deno Deploy may:
- Spin up a new isolate for each request
- Reuse an existing isolate for multiple requests
- Terminate an isolate after a period of inactivity
- Run multiple isolates simultaneously across different edge locations

This means you **cannot rely on in-memory state persisting between requests**. Any state that needs to survive across requests must be stored externally — in Deno KV, a database, or another persistent store.

---

## Request Handling

Your application registers a handler using the standard `Deno.serve()` API:

```typescript
Deno.serve((req: Request) => {
  return new Response("Hello from the edge!");
});
```

Each incoming request gets a `Request` object and your handler must return a `Response`. The application has a time limit per request — long-running operations will be terminated.

---

## Global vs Request Scope

```typescript
// Global scope — runs once when the isolate initialises
// May be shared across requests if the isolate is reused
const db = await Deno.openKv();
const config = await loadConfig();

// Request scope — runs fresh for every request
Deno.serve(async (req) => {
  const data = await db.get(["key"]);
  return new Response(JSON.stringify(data));
});
```

Things initialised at global scope are shared across requests within the same isolate, but you can't count on them being available in a new isolate.

---

## Edge Distribution

Deno Deploy runs your code across a global network of data centres. A request is routed to the nearest edge location, which means:

- A different isolate may handle requests from different geographic regions simultaneously
- There's no shared memory between isolates running in different locations
- Deno KV is the recommended way to share state across regions, as it's globally replicated

---

## Deployment Lifecycle

1. **Deploy** — you push code via the Deno Deploy dashboard, CLI, or GitHub integration
2. **Propagation** — the new version is distributed across edge locations
3. **Cutover** — new requests are routed to the new version
4. **Old isolates drain** — in-flight requests on the old version complete, then old isolates are terminated

There's no gradual rollout by default — deployments are atomic across all regions.

---

## Limits

Deno Deploy enforces limits that affect lifecycle behaviour:
- **CPU time** per request (not wall clock time — time spent waiting on I/O doesn't count)
- **Memory** per isolate
- **Execution time** — requests that take too long are terminated
- **No persistent background tasks** — once a request completes, you can't continue running code in the background (unlike a long-running server process)

The lack of persistent background tasks is a significant constraint if you're used to traditional server models — things like cron jobs or background queues need to be handled externally or via Deno Deploy's built-in cron support.
