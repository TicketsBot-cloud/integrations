import * as Sentry from "@sentry/cloudflare";

const ERROR_HEADER_NAME = "x-proxy-error";

const HOP_HEADER_BLACKLIST = new Set([
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "x-forwarded-port",
]);

// Upstream hostname -> env binding name. Hosts in this map are reached via a
// service binding so traffic stays on Cloudflare's network; anything else
// falls back to a public fetch().
const SERVICE_BINDINGS = {
  "fivem.tickets-v2.workers.dev": "FIVEM",
  "guild-lookup-worker.tickets-v2.workers.dev": "GUILDLOOKUP",
  "bloxlink.tickets-v2.workers.dev": "BLOXLINK",
};

function errorResponse(status, message) {
  return new Response(message, {
    status,
    statusText: message,
    headers: { [ERROR_HEADER_NAME]: message },
  });
}

function sanitiseHeaders(request) {
  const headers = new Headers();
  const clientIp = request.headers.get("Cf-Connecting-Ip");

  for (const [key, value] of request.headers.entries()) {
    const name = key.toLowerCase();
    if (name.startsWith("cf-") || HOP_HEADER_BLACKLIST.has(name)) continue;
    if (clientIp !== null && value.includes(clientIp)) continue;
    headers.append(name, value);
  }

  return headers;
}

async function buildRequestInit(request) {
  const hasBody = request.method !== "HEAD" && request.method !== "GET";
  return {
    method: request.method,
    headers: sanitiseHeaders(request),
    body: hasBody ? await request.arrayBuffer() : undefined,
  };
}

async function handleRequest(request, env) {
  if (request.headers.get(env.PROXY_AUTH_HEADER) !== env.PROXY_AUTH_KEY) {
    return errorResponse(401, "Missing auth key");
  }

  const incomingUrl = new URL(request.url);
  let proxyUrl;
  try {
    proxyUrl = new URL(incomingUrl.searchParams.get("url"));
  } catch {
    return errorResponse(400, "Invalid URL");
  }

  console.log(`Proxying request to ${proxyUrl}`);

  const init = await buildRequestInit(request);
  const bindingName = SERVICE_BINDINGS[proxyUrl.host];
  if (bindingName) {
    console.log(`Proxying via service binding ${bindingName}`);
    return env[bindingName].fetch(proxyUrl, init);
  }

  return fetch(proxyUrl, init);
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
