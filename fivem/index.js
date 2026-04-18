import * as Sentry from "@sentry/cloudflare";

const SERVER_ID_REGEX = /^[a-z0-9]{5,10}$/;
const FIVEM_API_BASE = "https://servers-frontend.fivem.net/api/servers/single";
const CACHE_TTL_SECONDS = 300;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0";

function bigIntEncoder(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function jsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fetchServer(serverId) {
  return fetch(`${FIVEM_API_BASE}/${serverId}`, {
    headers: { "User-Agent": USER_AGENT },
  });
}

function extractField(identifiers, fieldName) {
  const entry = identifiers.find((id) => id.startsWith(fieldName));
  if (entry === undefined) return null;
  const parts = entry.split(":");
  return parts.length === 2 ? parts[1] : null;
}

function extractFields(player) {
  const steamIdHex = extractField(player.identifiers, "steam");
  return {
    id: player.id,
    name: player.name,
    steam_id: steamIdHex ? BigInt(`0x${steamIdHex}`) : null,
    steam_id_hex: steamIdHex,
    license: extractField(player.identifiers, "license"),
    license2: extractField(player.identifiers, "license2"),
  };
}

function withProfileUrl(player) {
  if (player.steam_id !== null) {
    player.steam_profile_url = `https://steamcommunity.com/profiles/${player.steam_id}`;
  }
  return player;
}

async function handleValidate(request) {
  const serverId = request.headers.get("X-FiveM-Server-Id");
  if (serverId === null) {
    return jsonResponse({ error: "Missing X-FiveM-Server-Id header" }, { status: 400 });
  }
  if (!SERVER_ID_REGEX.test(serverId)) {
    return jsonResponse({ error: "Invalid FiveM server ID" }, { status: 400 });
  }

  const res = await fetchServer(serverId);
  if (res.status === 404) {
    return jsonResponse(
      { error: "FiveM server ID is invalid / server is not online" },
      { status: 400 },
    );
  }
  if (res.status !== 200) {
    return jsonResponse(
      { error: `FiveM server API responded with code ${res.status} - perhaps it is having an outage` },
      { status: 500 },
    );
  }
  return jsonResponse({});
}

async function handleLookup(request, env) {
  const serverId = request.headers.get("X-FiveM-Server-Id");
  if (serverId === null) {
    return jsonResponse({ error: "Missing X-FiveM-Server-Id header" }, { status: 400 });
  }
  if (!SERVER_ID_REGEX.test(serverId)) {
    return jsonResponse({ error: "Invalid X-FiveM-Server-Id header" }, { status: 400 });
  }

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

  const cacheKey = `fivem:${serverId}:${userId}`;
  const cached = await env.INTEGRATION_CACHE.get(cacheKey);
  if (cached !== null) {
    return new Response(cached, {
      status: 200,
      headers: { "content-type": "application/json", "x-from-cache": "true" },
    });
  }

  const res = await fetchServer(serverId);
  if (res.status !== 200) {
    console.log(`FiveM API responded with ${res.status}: ${await res.text()}`);
    return jsonResponse(
      { error: `FiveM server API responded with ${res.status}` },
      { status: 500 },
    );
  }

  const data = await res.json();
  const player = data.Data.players.find((p) =>
    p.identifiers.includes(`discord:${userId}`),
  );
  if (player === undefined) {
    return jsonResponse({}, { status: 404 });
  }

  const payload = JSON.stringify(withProfileUrl(extractFields(player)), bigIntEncoder);
  await env.INTEGRATION_CACHE.put(cacheKey, payload, { expirationTtl: CACHE_TTL_SECONDS });

  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json", "x-from-cache": "false" },
  });
}

async function handleRequest(request, env) {
  if (request.headers.get("Authorization") !== env.FIVEM_AUTH_KEY) {
    return jsonResponse({ error: "Invalid auth key" }, { status: 401 });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, { status: 405 });
  }

  const url = new URL(request.url);

  if (url.pathname === "/validate") {
    return handleValidate(request);
  }
  return handleLookup(request, env);
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
