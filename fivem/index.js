import * as Sentry from "@sentry/cloudflare";

const SERVER_ID_REGEX = /^[a-z0-9]{5,10}$/;
const FIVEM_API_BASE = "https://servers-frontend.fivem.net/api/servers/single";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:102.0) Gecko/20100101 Firefox/102.0";

function bigIntEncoder(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body, bigIntEncoder), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
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
  const { server_id: serverId } = await request.json();
  if (typeof serverId !== "string" || !SERVER_ID_REGEX.test(serverId)) {
    return jsonResponse(400, { error: "Invalid FiveM server ID" });
  }

  const res = await fetchServer(serverId);
  if (res.status === 404) {
    return jsonResponse(400, {
      error: "FiveM server ID is invalid / server is not online",
    });
  }
  if (res.status !== 200) {
    return jsonResponse(500, {
      error: `FiveM server API responded with code ${res.status} - perhaps it is having an outage`,
    });
  }
  return jsonResponse(200, {});
}

async function handleLookup(url) {
  const snowflake = url.searchParams.get("snowflake");
  if (snowflake === null) {
    return jsonResponse(400, { error: "Missing snowflake" });
  }

  const serverId = url.searchParams.get("serverid");
  if (serverId === null) {
    return jsonResponse(400, { error: "Missing serverid" });
  }
  if (!SERVER_ID_REGEX.test(serverId)) {
    return jsonResponse(400, { error: "Invalid serverid" });
  }

  const res = await fetchServer(serverId);
  if (res.status !== 200) {
    console.log(`server api responded with ${res.status}: ${await res.text()}`);
    return jsonResponse(500, {
      error: `server api responded with ${res.status}`,
    });
  }

  const data = await res.json();
  const player = data.Data.players.find((p) =>
    p.identifiers.includes(`discord:${snowflake}`),
  );
  if (player === undefined) {
    return jsonResponse(404, {}, { "x-from-cache": "false" });
  }

  return jsonResponse(200, withProfileUrl(extractFields(player)), {
    "x-from-cache": "false",
  });
}

async function handleRequest(request, env) {
  if (request.headers.get("Authorization") !== env.FIVEM_AUTH_KEY) {
    return jsonResponse(401, { error: "Invalid auth key" });
  }

  const url = new URL(request.url);
  console.log(`Received request ${url}`);

  if (url.pathname === "/validate") {
    return handleValidate(request);
  }
  return handleLookup(url);
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
