import * as Sentry from "@sentry/cloudflare";

const BLOXLINK_API = "https://api.blox.link/v4/public";
const ROBLOX_USERS_API = "https://users.roblox.com/v1";
const CACHE_TTL_SECONDS = 86_400;

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

const emptyResponse = () => jsonResponse("{}");

async function fetchRobloxId(apiKey, guildId, userId) {
  const res = await fetch(
    `${BLOXLINK_API}/guilds/${guildId}/discord-to-roblox/${userId}`,
    { headers: { Authorization: apiKey } },
  );

  if (!res.ok) {
    throw new Error(`Bloxlink returned status ${res.status}`);
  }

  const data = await res.json();
  if (!data.robloxID) {
    throw new Error("User not found in Bloxlink");
  }

  return data.robloxID;
}

async function fetchRobloxUser(robloxId) {
  const res = await fetch(`${ROBLOX_USERS_API}/users/${robloxId}`);
  if (!res.ok) {
    throw new Error(`Roblox returned status ${res.status}`);
  }
  return res.json();
}

function buildPayload(user) {
  const createdTs = Math.floor(new Date(user.created).getTime() / 1000);
  return {
    roblox_username: user.name,
    roblox_id: String(user.id),
    roblox_display_name: user.displayName,
    roblox_profile_url: `https://www.roblox.com/users/${user.id}/profile`,
    roblox_account_age: `<t:${createdTs}:R>`,
    roblox_account_created: `<t:${createdTs}:D>`,
  };
}

async function handleRequest(request, env) {
  if (request.headers.get("Authorization") !== env.BLOXLINK_AUTH_KEY) {
    return new Response("Invalid auth key", { status: 401 });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid request body", { status: 400 });
  }

  const { guild_id: guildId, user_id: userId } = body;
  if (!guildId || !userId) {
    return new Response("Invalid request body", { status: 400 });
  }

  const cacheKey = `bloxlink:${guildId}:${userId}`;
  const cached = await env.INTEGRATION_CACHE.get(cacheKey);
  if (cached !== null) {
    return jsonResponse(cached);
  }

  const apiKey = request.headers.get("X-Bloxlink-Api-Key");
  if (!apiKey) {
    return new Response("Missing X-Bloxlink-Api-Key header", { status: 400 });
  }

  let robloxId;
  try {
    robloxId = await fetchRobloxId(apiKey, guildId, userId);
  } catch {
    return emptyResponse();
  }

  let user;
  try {
    user = await fetchRobloxUser(robloxId);
  } catch {
    return emptyResponse();
  }

  const payload = JSON.stringify(buildPayload(user));
  await env.INTEGRATION_CACHE.put(cacheKey, payload, { expirationTtl: CACHE_TTL_SECONDS });

  return jsonResponse(payload);
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
