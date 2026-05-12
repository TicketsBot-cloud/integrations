import * as Sentry from "@sentry/cloudflare";

const MELONLY_API = "https://api.melonly.xyz/api/v1";
const CACHE_TTL_SECONDS = 86_400;
const DISCORD_ID_REGEX = /^\d{17,20}$/;

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const emptyResponse = () => jsonResponse({});

async function fetchConnection(authKey, userId) {
  return fetch(`${MELONLY_API}/verification/discord/${userId}/roblox`, {
    headers: { Authorization: `Bearer ${authKey}` },
  });
}

function buildPayload(connection) {
  return {
    melonly_user_id: connection.userId,
    melonly_name: connection.name,
    melonly_nickname: connection.nickname,
    melonly_preferred_username: connection.preferredUsername,
    melonly_roblox_id: connection.robloxId,
    melonly_profile: connection.profile,
    melonly_headshot_image: connection.headShotImage,
    melonly_created_at: connection.createdAt,
    melonly_last_updated_at: connection.lastUpdatedAt,
    melonly_roblox_created_at: connection.robloxCreatedAt,
  };
}

async function handleValidate() {
  return jsonResponse({});
}

async function handleLookup(request, env, authKey) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, { status: 400 });
  }

  const { user_id: userId } = body;
  if (!DISCORD_ID_REGEX.test(userId)) {
    return jsonResponse({ error: "Invalid request body" }, { status: 400 });
  }

  const cacheKey = `melonly:global:${userId}`;
  const cached = await env.INTEGRATION_CACHE.get(cacheKey);
  if (cached !== null) {
    return new Response(cached, {
      status: 200,
      headers: { "content-type": "application/json", "x-from-cache": "true" },
    });
  }

  const res = await fetchConnection(authKey, userId);
  if (res.status === 404) return emptyResponse();
  if (res.status === 401) {
    return jsonResponse(
      { error: "Melonly API rejected the verification key" },
      { status: 500 },
    );
  }
  if (!res.ok) {
    return jsonResponse({ error: `Melonly API responded with ${res.status}` }, { status: 500 });
  }

  const payload = JSON.stringify(buildPayload(await res.json()));
  await env.INTEGRATION_CACHE.put(cacheKey, payload, { expirationTtl: CACHE_TTL_SECONDS });

  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json", "x-from-cache": "false" },
  });
}

async function handleRequest(request, env) {
  const authKey = request.headers.get("Authorization");
  if (authKey !== env.MELONLY_AUTH_KEY) {
    return jsonResponse({ error: "Invalid auth key" }, { status: 401 });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, { status: 405 });
  }

  const url = new URL(request.url);

  if (url.pathname === "/validate") {
    return handleValidate();
  }
  return handleLookup(request, env, authKey);
}

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
