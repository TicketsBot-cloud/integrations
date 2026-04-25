# TicketsBot Integration Standards

This document is the authoritative reference for building **public integrations** that are accepted into this repository and hosted by TicketsBot. Every integration in this repo **must** follow these standards.

**This does not apply to normal (self-hosted / third-party) integrations.** Those only need to comply with the [Privacy Policy](https://tickets.bot/privacy) and [Terms of Service](https://tickets.bot/terms-of-service). The standards and practices in this document are still a useful guide for anyone building their own integration well.

---

## How Integrations Work

When a ticket is opened, TicketsBot POSTs to the worker's root URL with a JSON body:

```json
{
  "guild_id": "123456789",
  "user_id": "987654321",
  "ticket_id": "42",
  "ticket_channel_id": "111222333",
  "is_new_ticket": true
}
```

All fields are always present.

The worker returns a flat or nested JSON object. TicketsBot maps response fields to ticket placeholder variables using dot-path notation (e.g. a field `user.username` becomes the placeholder `{user.username}`). **Arrays are not supported** — pre-join them to strings before returning.

The `Authorization` header and all configured integration headers (including per-guild secret placeholders) are injected by TicketsBot's backend before the request reaches the worker. The worker never reads secrets from query parameters or the POST body.

---

## Required Standards

### 1. Authorization Guard

Every worker **must** check the `Authorization` request header against a static worker secret before doing anything else. Return `401` on mismatch. This proves the caller is TicketsBot.

The secret **must** be provisioned with `wrangler secret put` (stored in Cloudflare) and is accessed at runtime via the `env` parameter as `<INTEGRATION_NAME>_AUTH_KEY`.

```js
async function handleRequest(request, env) {
  if (request.headers.get("Authorization") !== env.MYINTEGRATION_AUTH_KEY) {
    return jsonResponse({ error: "Invalid auth key" }, { status: 401 });
  }
  // ...
}
```

The auth check **must** be the very first thing in `handleRequest`, before method enforcement or routing.

---

### 2. Method Enforcement

After the auth guard passes, every worker **must** reject non-`POST` requests with `405`.

```js
if (request.method !== "POST") {
  return jsonResponse({ error: "Method Not Allowed" }, { status: 405 });
}
```

---

### 3. Sentry

Every worker **must** wrap its `fetch` handler with `Sentry.withSentry` from `@sentry/cloudflare`. The required configuration:

| Field | Value |
|-------|-------|

| `dsn` | `env.SENTRY_DSN` |
| `tracesSampleRate` | `1.0` |
| `sendDefaultPii` | `true` |

```js
import * as Sentry from "@sentry/cloudflare";

export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
  }),
  {
    async fetch(request, env) {
      return handleRequest(request, env);
    },
  },
);
```

`SENTRY_DSN` **must** be set as a `[vars]` entry in `wrangler.toml` (not a Cloudflare secret — it is not sensitive):

```toml
[vars]
SENTRY_DSN = "https://<key>@sentry.tkts.bot/<project-id>"
```

`withSentry` captures unhandled errors automatically. Do **not** add a redundant top-level `try/catch` solely for logging.

---

### 4. Secrets via Request Headers

Per-guild secrets (API keys, server IDs, tokens) **must** be passed as named request headers, not as query parameters or in the POST body.

Header names **must** follow the pattern `X-<IntegrationName>-<FieldName>` (title-case, hyphen-separated). Examples:

- `X-Bloxlink-Api-Key`
- `X-FiveM-Server-Id`

These headers are configured in the TicketsBot dashboard using `%secret_name%` placeholder syntax that resolves to per-guild values at call time. Document all integration headers in `wrangler.toml` comments (see §8).

```js
const apiKey = request.headers.get("X-Myintegration-Api-Key");
if (!apiKey) {
  return jsonResponse({ error: "Missing X-Myintegration-Api-Key header" }, { status: 400 });
}
```

---

### 5. `/validate` Endpoint

Every worker that uses per-guild secrets **must** implement a `/validate` endpoint. TicketsBot POSTs to this endpoint when a guild admin activates the integration; the secret headers are present on this request with the values the admin supplied.

`/validate` is **only** called during activation — not on every ticket open.

Requirements:

- Validate the format of all secret headers first (see §Good Practices). Return `400` with a user-readable `error` message on format failure.
- Where possible, make a live API call to confirm the secret works. Return `400` on failure (with a human-readable message), `500` if the upstream API is unexpectedly unavailable.
- Return `200 {}` on success.

```js
async function handleValidate(request) {
  const apiKey = request.headers.get("X-Myintegration-Api-Key");
  if (!apiKey) {
    return jsonResponse({ error: "Missing X-Myintegration-Api-Key header" }, { status: 400 });
  }
  if (!API_KEY_REGEX.test(apiKey)) {
    return jsonResponse({ error: "Invalid API key format" }, { status: 400 });
  }

  const res = await fetch("https://api.myintegration.example/verify", {
    headers: { Authorization: apiKey },
  });
  if (res.status === 401) {
    return jsonResponse({ error: "API key is invalid or has been revoked" }, { status: 400 });
  }
  if (!res.ok) {
    return jsonResponse(
      { error: `Upstream API responded with ${res.status} — it may be experiencing an outage` },
      { status: 500 },
    );
  }

  return jsonResponse({});
}
```

Route to `/validate` before the default lookup handler:

```js
const url = new URL(request.url);
if (url.pathname === "/validate") {
  return handleValidate(request);
}
return handleLookup(request, env);
```

---

### 6. Caching with `INTEGRATION_CACHE`

Caching is **not required**, but **must** be used whenever upstream data is reasonably stable across requests.

Use the shared KV namespace binding `INTEGRATION_CACHE` (id `7901ae2b471145d4ab7b8535c158d892`). Declare it in `wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "INTEGRATION_CACHE"
id = "7901ae2b471145d4ab7b8535c158d892"
```

**Cache key format:** `<integration>:<discriminating_secret_or_scope>:<user_id>`

Examples:

- `bloxlink:<guild_id>:<user_id>` — scoped per guild because different guilds use different API keys
- `fivem:<server_id>:<user_id>` — scoped per server

**TTL guidance:**

| Data type | `expirationTtl` |
|-----------|-----------------|

| Slow-changing (profile data, account info) | `86400` (24 h) |
| Live / session data (online players) | `300` (5 min) |

**Cache hit/miss header:** Lookup responses **must** include `x-from-cache: true` or `x-from-cache: false`.

```js
const cacheKey = `myintegration:${scope}:${userId}`;
const cached = await env.INTEGRATION_CACHE.get(cacheKey);
if (cached !== null) {
  return new Response(cached, {
    status: 200,
    headers: { "content-type": "application/json", "x-from-cache": "true" },
  });
}

// ... fetch from upstream ...

const payload = JSON.stringify(result);
await env.INTEGRATION_CACHE.put(cacheKey, payload, { expirationTtl: CACHE_TTL_SECONDS });
return new Response(payload, {
  status: 200,
  headers: { "content-type": "application/json", "x-from-cache": "false" },
});
```

---

### 7. Response Format

- All responses **must** use `content-type: application/json`.
- Error responses **must** use `{ "error": "..." }` with a user-readable message.
- When the target user is not found / not linked in the upstream service, return `200 {}` (an empty object). This signals to TicketsBot that placeholders should resolve to their configured fallback values. **Do not return `404` for not-found users.**
- Success responses **should** be flat objects where possible. Nested objects are supported via dot-path placeholders, but arrays are not.

| Condition | Status | Body |
|-----------|--------|------|

| Success with data | `200` | `{ ...fields }` |
| User not found / not linked | `200` | `{}` |
| Bad request (missing field, invalid format) | `400` | `{ "error": "..." }` |
| Unauthorized (auth key mismatch) | `401` | `{ "error": "Invalid auth key" }` |
| Method not allowed | `405` | `{ "error": "Method Not Allowed" }` |
| Upstream API unavailable / unexpected error | `500` | `{ "error": "..." }` |

---

### 8. `wrangler.toml` Conventions

```toml
name = "<integration-name>"
main = "index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[observability.logs]
enabled = true

[vars]
SENTRY_DSN = "https://<key>@sentry.tkts.bot/<project-id>"

[[kv_namespaces]]
binding = "INTEGRATION_CACHE"
id = "fbdf23642f6a40d0b5876abf3265910d"

# Secrets (set via `wrangler secret put <NAME>`):
#   <INTEGRATION>_AUTH_KEY — static guard token; callers must send this in the Authorization header
#
# Integration request headers (configured in the dashboard):
#   Authorization: <<INTEGRATION>_AUTH_KEY value>     (static, proves the caller is TicketsBot)
#   X-<Integration>-<Field>: %<placeholder_name>%     (per-guild secret; guild admin provides on activation)
```

Required fields: `compatibility_date`, `compatibility_flags`, `[observability.logs]`, `SENTRY_DSN` var, `INTEGRATION_CACHE` KV binding, and commented documentation of all secrets and integration headers.

---

## Good Practices

### `jsonResponse` Helper

Every worker **should** define a `jsonResponse` helper to avoid constructing `Response` objects inline:

```js
function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
```

For the common empty-object response, an `emptyResponse` alias is a useful convenience:

```js
const emptyResponse = () => jsonResponse({});
```

### Input Validation

Every lookup handler **must** validate `user_id` from the POST body, and any other body fields the integration relies on. Return `400` on failure. Always parse the body defensively:

```js
let body;
try {
  body = await request.json();
} catch {
  return jsonResponse({ error: "Invalid request body" }, { status: 400 });
}

const { user_id: userId } = body;
if (!userId) {
  return jsonResponse({ error: "Invalid request body" }, { status: 400 });
}
```

If the integration is scoped by guild (e.g. uses `guild_id` for upstream API calls or as a cache key component), validate it too:

```js
const { guild_id: guildId, user_id: userId } = body;
if (!guildId || !userId) {
  return jsonResponse({ error: "Invalid request body" }, { status: 400 });
}
```

### Secret Format Validation Before Live Calls

In `/validate`, always check secret format with a regex or length constraint **before** making any live API call. This gives the user a fast, specific error message and avoids unnecessary upstream requests.

```js
const API_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!API_KEY_REGEX.test(apiKey)) {
  return jsonResponse({ error: "Invalid API key format (expected UUID v4)" }, { status: 400 });
}
// Only reach the live API call if format is valid
```

### Sentry and Error Handling

`Sentry.withSentry` captures any unhandled exception thrown from the `fetch` handler and reports it to Sentry automatically. Do **not** add a top-level `try/catch` around `handleRequest` just for error logging — it is redundant and suppresses Sentry's stack-trace capture.

Handle only the errors you can meaningfully recover from inline. Let everything else propagate.
