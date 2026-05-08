import * as Sentry from "@sentry/cloudflare";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const DEFAULT_SHEET_TAB = "Tickets";
const DEFAULT_SPREADSHEET_ID_HEADER = "X-Tickets-Google-Sheets-Id";
const DEFAULT_SHEET_TAB_HEADER = "X-Tickets-Google-Sheet-Tab";
const GOOGLE_WRITE_MAX_ATTEMPTS = 5;
const GOOGLE_WRITE_DEBOUNCE_MS = 750;
const GOOGLE_WRITE_MIN_INTERVAL_MS = 1500;
const BOT_API_URL_HEADER = "X-Tickets-Bot-Api-Url";
const BOT_API_SECRET_HEADER = "X-Tickets-Bot-Api-Secret";
const PRIVACY_POLICY_PATHS = new Set(["/privacy", "/privacy-policy"]);
const TICKET_COLUMNS = 11;
const TICKET_HEADERS = [
  "Ticket ID",
  "Channel ID",
  "Status",
  "Guild ID",
  "User ID",
  "Claimed By",
  "Close Requested By",
  "Opened At",
  "First Reply At",
  "Closed At",
  "Panel Title",
];

let cachedAccessToken = null;
let cachedAccessTokenExpiry = 0;
let sheetsInitialized = false;
let initializedSheetKey = null;
const sheetRowByChannelId = new Map();
const sheetRowByTicketId = new Map();
const googleSheetsWriteQueueByKey = new Map();
let googleSheetsGlobalWriteChain = Promise.resolve();
let googleSheetsLastWriteAt = 0;

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status, message) {
  return jsonResponse(status, { error: message });
}

function privacyPolicyResponse() {
  const body = [
    "Privacy Policy",
    "",
    "Last updated: 2026-05-08",
    "",
    "This api processes ticket lifecycle events for tickets.",
    "",
    "Information used:",
    "- Discord ticket and channel IDs",
    "- Discord user IDs tied to ticket actions",
    "- Guild IDs and ticket status details",
    "- Timestamps for opened, claimed, unclaimed, first reply, close requested, panel names, and closed events",
    "- Optional spreadsheet routing settings",
    "",
    "How it is used:",
    "- To record ticket activity",
    "- To sync ticket status to Google Sheets",
    "- To coordinate with the ticket bot and related worker services",
    "",
    "Sharing:",
    "- Data is sent only to the configured Google Sheets spreadsheet and configured RankBlox ticket bot services needed to process the ticket",
    "- The worker does not sell personal data",
    "",
    "Retention:",
    "- Ticket records remain in Google Sheets until you delete them",
    "- Local worker cache is temporary and does not persist across deployments or restarts",
    "",
    "Contact:",
    "- For privacy questions, contact the developer @thebeston on Discord or via email at thebeston123@rankblox.com",
  ].join("\n");

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

function getHeaderValue(request, name) {
  const value = request.headers.get(name);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeConfiguredTicketValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getSpreadsheetConfig(request, env) {
  const spreadsheetId =
    getHeaderValue(request, DEFAULT_SPREADSHEET_ID_HEADER)
  const sheetTab =
    getHeaderValue(request, DEFAULT_SHEET_TAB_HEADER) ||
    env.GOOGLEDOCS_SHEET_TAB ||
    DEFAULT_SHEET_TAB;

  return { spreadsheetId, sheetTab };
}

function getBotApiConfig(request, env) {
  const botApiUrl = readRequiredEnv(env, "RANKBLOX_TICKETS_API_URL");
  const botApiSecret = readRequiredEnv(env, "RANKBLOX_TICKETS_API_SECRET");

  return {
    botApiUrl,
    botApiSecret,
  };
}

function isSameOriginUrl(leftUrl, rightUrl) {
  try {
    return new URL(leftUrl).origin === new URL(rightUrl).origin;
  } catch {
    return false;
  }
}

function getExpectedAuthKey(env) {
  return (
    readRequiredEnv(env, "GOOGLEDOCS_AUTH_KEY") ||
    readRequiredEnv(env, "TICKETS_SHARED_SECRET") ||
    readRequiredEnv(env, "RANKBLOX_TICKETS_API_SECRET")
  );
}

function isValidAuthRequest(request, env) {
  const expected = getExpectedAuthKey(env);
  if (!expected) {
    return true;
  }

  const provided =
    getHeaderValue(request, "X-Tickets-Auth") ||
    getHeaderValue(request, "X-Tickets-Secret") ||
    getHeaderValue(request, "Authorization") ||
    "";
  const normalized = provided.startsWith("Bearer ") ? provided.slice("Bearer ".length) : provided;
  return normalized === expected;
}

async function validateSecrets(env, secrets) {
  const spreadsheetId = secrets.spreadsheet_id || secrets.GOOGLEDOCS_SPREADSHEET_ID;
  const sheetTab = secrets.sheet_tab || secrets.GOOGLEDOCS_SHEET_TAB || DEFAULT_SHEET_TAB;

  if (!spreadsheetId) {
    return errorResponse(400, "Missing spreadsheet_id.");
  }

  if (!isSpreadsheetId(spreadsheetId)) {
    return errorResponse(400, "Your spreadsheet_id is invalid.");
  }

  if (!isValidSheetTabName(sheetTab)) {
    return errorResponse(400, "Your sheet_tab is invalid.");
  }

  return verifySpreadsheetAccess(env, spreadsheetId, sheetTab);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64UrlEncodeText(text) {
  const utf8 = new TextEncoder().encode(text);
  return base64UrlEncodeBytes(utf8);
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pemPrivateKeyToArrayBuffer(pem) {
  const stripped = pem
    .replace(/\r/g, "")
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s+/g, "");

  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function signServiceAccountJwt(serviceEmail, privateKey) {
  const header = { alg: "RS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceEmail,
    scope: GOOGLE_SHEETS_SCOPE,
    aud: GOOGLE_TOKEN_URL,
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncodeText(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeText(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemPrivateKeyToArrayBuffer(privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  const encodedSignature = base64UrlEncodeBytes(new Uint8Array(signature));
  return `${signingInput}.${encodedSignature}`;
}

function readRequiredEnv(env, key) {
  const value = env[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isSpreadsheetId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-_]{20,200}$/.test(value);
}

function isValidSheetTabName(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100;
}

function buildGoogleSheetsUrl(spreadsheetId, range) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
}

function buildHeadersUrl(spreadsheetId, sheetTab) {
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetTab)}!A1:K1?valueInputOption=USER_ENTERED`;
}

function buildSheetRange(sheetTab, rowNumber) {
  return `${sheetTab}!A${rowNumber}:K${rowNumber}`;
}

function getTicketWriteKey(spreadsheetId, sheetTab, payload) {
  const event = normaliseEventPayload(payload);
  const stableId = event.ticketId || event.channelId;
  if (!spreadsheetId || !sheetTab || !stableId) {
    return null;
  }

  return `${spreadsheetId}::${sheetTab}::${stableId}`;
}

function getTicketWriteSignature(payload) {
  return JSON.stringify(buildTicketRowFromEvent(payload));
}

function getTicketWriteQueueState(key) {
  let state = googleSheetsWriteQueueByKey.get(key);
  if (!state) {
    state = {
      timerId: null,
      running: false,
      pendingPayload: null,
      promise: null,
      resolve: null,
      reject: null,
      lastSignature: null,
      lastWriteAt: 0,
    };
    googleSheetsWriteQueueByKey.set(key, state);
  }

  return state;
}

function resetTicketWriteQueueState(key) {
  const state = googleSheetsWriteQueueByKey.get(key);
  if (!state) {
    return;
  }

  if (state.timerId) {
    clearTimeout(state.timerId);
  }

  googleSheetsWriteQueueByKey.delete(key);
}

async function runGoogleSheetsWrite(task) {
  const next = googleSheetsGlobalWriteChain.then(async () => {
    const elapsed = Date.now() - googleSheetsLastWriteAt;
    if (googleSheetsLastWriteAt > 0 && elapsed < GOOGLE_WRITE_MIN_INTERVAL_MS) {
      await sleep(GOOGLE_WRITE_MIN_INTERVAL_MS - elapsed);
    }

    const result = await task();
    googleSheetsLastWriteAt = Date.now();
    return result;
  });

  googleSheetsGlobalWriteChain = next.catch(() => null);
  return next;
}

async function flushTicketWriteQueue(key, env, spreadsheetId, sheetTab) {
  const state = googleSheetsWriteQueueByKey.get(key);
  if (!state || state.running) {
    return null;
  }

  state.running = true;
  let lastResult = { mode: "skipped", reason: "No pending ticket write" };

  try {
    while (state.pendingPayload) {
      const payload = state.pendingPayload;
      state.pendingPayload = null;

      const signature = getTicketWriteSignature(payload);
      if (signature === state.lastSignature) {
        lastResult = { mode: "skipped", reason: "Duplicate ticket state" };
        continue;
      }

      lastResult = await runGoogleSheetsWrite(() => upsertTicketToSheet(env, payload, spreadsheetId, sheetTab));
      state.lastSignature = signature;
      state.lastWriteAt = Date.now();
    }

    if (state.resolve) {
      state.resolve(lastResult);
    }

    return lastResult;
  } catch (error) {
    if (state.reject) {
      state.reject(error);
    }
    throw error;
  } finally {
    state.running = false;
    state.timerId = null;
    state.promise = null;
    state.resolve = null;
    state.reject = null;
    state.pendingPayload = null;

    if (!state.lastSignature) {
      resetTicketWriteQueueState(key);
    }
  }
}

function queueTicketWrite(env, spreadsheetId, sheetTab, payload) {
  const key = getTicketWriteKey(spreadsheetId, sheetTab, payload);
  if (!key) {
    return upsertTicketToSheet(env, payload, spreadsheetId, sheetTab);
  }

  const state = getTicketWriteQueueState(key);
  state.pendingPayload = payload;

  if (!state.promise) {
    state.promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
  }

  if (state.timerId === null && !state.running) {
    const elapsed = state.lastWriteAt > 0 ? Date.now() - state.lastWriteAt : null;
    const delayMs = elapsed === null ? GOOGLE_WRITE_DEBOUNCE_MS : Math.max(GOOGLE_WRITE_DEBOUNCE_MS, GOOGLE_WRITE_MIN_INTERVAL_MS - elapsed);

    state.timerId = setTimeout(() => {
      state.timerId = null;
      flushTicketWriteQueue(key, env, spreadsheetId, sheetTab).catch((error) => {
        console.error("[DEBUG] Google Sheets write queue failed:", error);
      });
    }, delayMs);
  }

  return state.promise;
}

function getSheetCacheKey(spreadsheetId, sheetTab) {
  return `${spreadsheetId}::${sheetTab}`;
}

function resetSheetCache() {
  sheetsInitialized = false;
  initializedSheetKey = null;
  sheetRowByChannelId.clear();
  sheetRowByTicketId.clear();
}

function parseRetryAfter(headerValue) {
  if (!headerValue) {
    return null;
  }

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return null;
}

function classifySheetsFailure(response, bodyText) {
  if (response.status === 401) {
    return {
      status: 401,
      message: "Google authentication failed. Check the service account email and private key.",
    };
  }

  if (response.status === 403) {
    return {
      status: 403,
      message:
        "Google Sheets permission denied. Share the spreadsheet with the service account email as Editor.",
    };
  }

  if (response.status === 404) {
    return {
      status: 404,
      message:
        "Google Sheets spreadsheet was not found. Verify the spreadsheet ID and sharing permissions.",
    };
  }

  if (response.status === 429) {
    return {
      status: 429,
      message: "Google Sheets rate limit exceeded. The worker will retry automatically.",
    };
  }

  if (response.status >= 500) {
    return {
      status: response.status,
      message: `Google Sheets is temporarily unavailable (${response.status}).`,
    };
  }

  return {
    status: response.status,
    message: `Google Sheets append failed (${response.status}): ${bodyText}`,
  };
}

function getEventType(payload) {
  return String(payload.event_type || payload.type || payload.event || "").trim().toLowerCase();
}

function normaliseEventPayload(payload) {
  const openedAt = payload.opened_at || payload.created_at || new Date().toISOString();
  const eventType = getEventType(payload);
  const status =
    payload.status ||
    (eventType === "closed"
      ? "closed"
      : eventType === "close_requested"
        ? "close_requested"
        : eventType === "claimed"
          ? "claimed"
          : "open");

  return {
    ticketId: payload.ticket_id || payload.ticketId || "",
    channelId: payload.ticket_channel_id || payload.channel_id || payload.channelId || "",
    status,
    guildId: payload.guild_id || payload.guildId || "",
    userId: payload.user_id || payload.userId || "",
    claimedBy: payload.claimed_by || payload.claimedBy || "",
    closeRequestedBy: payload.close_requested_by || payload.closeRequestedBy || "",
    openedAt,
    firstReplyAt: payload.first_reply_at || payload.first_response_at || payload.firstReplyAt || "",
    closedAt: payload.closed_at || payload.closedAt || "",
    panelTitle: payload.panel_title || payload.panelTitle || "",
  };
}

function buildTicketRowFromEvent(payload) {
  const event = normaliseEventPayload(payload);

  return [
    toCellValue(event.ticketId),
    toCellValue(event.channelId),
    toCellValue(event.status),
    toCellValue(event.guildId),
    toCellValue(event.userId),
    toCellValue(event.claimedBy),
    toCellValue(event.closeRequestedBy),
    toCellValue(event.openedAt),
    toCellValue(event.firstReplyAt),
    toCellValue(event.closedAt),
    toCellValue(event.panelTitle),
  ];
}

function buildBotSeedRecord(payload) {
  const event = normaliseEventPayload(payload);

  return {
    ticket_id: event.ticketId,
    ticket_channel_id: event.channelId,
    status: event.status,
    guild_id: event.guildId,
    user_id: event.userId,
    claimed_by: event.claimedBy,
    close_requested_by: event.closeRequestedBy,
    opened_at: event.openedAt,
    first_reply_at: event.firstReplyAt,
    closed_at: event.closedAt,
    panel_title: event.panelTitle,
  };
}

async function notifyBotApi(request, env, records, options = {}) {
  const { botApiUrl, botApiSecret } = getBotApiConfig(request, env);
  if (!botApiUrl) {
    console.log("[DEBUG] No bot API URL configured; skipping bot sync.");
    return null;
  }

  if (request?.url && isSameOriginUrl(request.url, botApiUrl)) {
    console.warn(
      `[DEBUG] RANKBLOX_TICKETS_API_URL points to this worker (${botApiUrl}); skipping bot sync to avoid self-posting.`,
    );
    return null;
  }

  const { spreadsheetId, sheetTab } = getSpreadsheetConfig(request, env);
  const payload = Array.isArray(records) ? records : [records];
  console.log(`[DEBUG] Syncing ${payload.length} ticket record(s) to bot API: ${botApiUrl}`);
  const response = await fetch(`${botApiUrl.replace(/\/$/, "")}/api/tickets/seed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(botApiSecret ? { "X-Tickets-Secret": botApiSecret } : {}),
      ...(spreadsheetId ? { [DEFAULT_SPREADSHEET_ID_HEADER]: spreadsheetId } : {}),
      ...(sheetTab ? { [DEFAULT_SHEET_TAB_HEADER]: sheetTab } : {}),
    },
    body: JSON.stringify({
      tickets: payload,
      replace: options.replace === true,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Bot API sync failed (${response.status}): ${details || response.statusText}`);
  }

  return response.json().catch(() => null);
}

async function decideWithBotApi(request, env, payload) {
  const { botApiUrl, botApiSecret } = getBotApiConfig(request, env);
  if (!botApiUrl) {
    return {
      shouldWrite: true,
      ticket: buildBotSeedRecord(payload),
    };
  }

  if (request?.url && isSameOriginUrl(request.url, botApiUrl)) {
    return {
      shouldWrite: true,
      ticket: buildBotSeedRecord(payload),
    };
  }

  const { spreadsheetId, sheetTab } = getSpreadsheetConfig(request, env);
  const response = await fetch(`${botApiUrl.replace(/\/$/, "")}/api/tickets/decide`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(botApiSecret ? { "X-Tickets-Secret": botApiSecret } : {}),
      ...(spreadsheetId ? { [DEFAULT_SPREADSHEET_ID_HEADER]: spreadsheetId } : {}),
      ...(sheetTab ? { [DEFAULT_SHEET_TAB_HEADER]: sheetTab } : {}),
    },
    body: JSON.stringify(buildBotSeedRecord(payload)),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Bot decision request failed (${response.status}): ${details || response.statusText}`);
  }

  const decision = await response.json().catch(() => null);
  return {
    shouldWrite: decision?.should_write !== false,
    ticket: decision?.ticket || buildBotSeedRecord(payload),
  };
}

function normalizeTicketSeedEntry(entry, fallback = {}) {
  if (typeof entry === "string") {
    return {
      ticket_channel_id: entry,
      guild_id: fallback.guild_id || fallback.guildId || "",
      user_id: fallback.user_id || fallback.userId || "",
      ticket_id: fallback.ticket_id || fallback.ticketId || "",
      status: fallback.status || "open",
      panel_title: fallback.panel_title || fallback.panelTitle || "",
      opened_at: fallback.opened_at || fallback.openedAt || new Date().toISOString(),
      claimed_by: fallback.claimed_by || fallback.claimedBy || "",
      close_requested_by: fallback.close_requested_by || fallback.closeRequestedBy || "",
      first_reply_at: fallback.first_reply_at || fallback.firstReplyAt || "",
      closed_at: fallback.closed_at || fallback.closedAt || "",
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const ticketChannelId = entry.ticket_channel_id || entry.channel_id || entry.channelId;
  if (!ticketChannelId) {
    return null;
  }

  return {
    ticket_id: entry.ticket_id || entry.ticketId || fallback.ticket_id || fallback.ticketId || "",
    ticket_channel_id: ticketChannelId,
    status: entry.status || fallback.status || "open",
    guild_id: entry.guild_id || entry.guildId || fallback.guild_id || fallback.guildId || "",
    user_id: entry.user_id || entry.userId || fallback.user_id || fallback.userId || "",
    claimed_by: entry.claimed_by || entry.claimedBy || fallback.claimed_by || fallback.claimedBy || "",
    close_requested_by:
      entry.close_requested_by ||
      entry.closeRequestedBy ||
      fallback.close_requested_by ||
      fallback.closeRequestedBy ||
      "",
    opened_at:
      entry.opened_at || entry.openedAt || fallback.opened_at || fallback.openedAt || new Date().toISOString(),
    first_reply_at:
      entry.first_reply_at || entry.first_response_at || entry.firstReplyAt || fallback.firstReplyAt || "",
    closed_at: entry.closed_at || entry.closedAt || fallback.closed_at || fallback.closedAt || "",
    panel_title: entry.panel_title || entry.panelTitle || fallback.panel_title || fallback.panelTitle || "",
  };
}

async function writeTicketSeedBatch(request, env, spreadsheetId, sheetTab, records) {
  if (!Array.isArray(records) || records.length === 0) {
    return [];
  }

  await ensureSheetsInitialized(env, spreadsheetId, sheetTab);

  const results = [];
  for (const entry of records) {
    const normalized = normalizeTicketSeedEntry(entry);
    if (!normalized) {
      continue;
    }

    const result = await queueTicketWrite(env, spreadsheetId, sheetTab, normalized);
    results.push({
      channel_id: normalized.ticket_channel_id,
      mode: result.mode,
      row_number: result.rowNumber,
    });
  }

  if (results.length > 0) {
    notifyBotApi(request, env, records.map((entry) => normalizeTicketSeedEntry(entry)).filter(Boolean), {
      replace: false,
    }).catch((error) => {
      console.error("[DEBUG] Background bot notify failed:", error.message);
    });
  }

  return results;
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && cachedAccessTokenExpiry - 60 > now) {
    return cachedAccessToken;
  }

  const serviceEmail = readRequiredEnv(env, "GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyRaw = readRequiredEnv(env, "GOOGLE_PRIVATE_KEY");
  if (!serviceEmail || !privateKeyRaw) {
    throw new Error("Missing Google service account credentials");
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  const assertion = await signServiceAccountJwt(serviceEmail, privateKey);

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!tokenResponse.ok) {
    const details = await tokenResponse.text();
    throw new Error(`Token exchange failed (${tokenResponse.status}): ${details}`);
  }

  const tokenData = await tokenResponse.json();
  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenExpiry = now + Number(tokenData.expires_in || 3600);
  return cachedAccessToken;
}

async function ensureSheetsInitialized(env, spreadsheetId, sheetTab) {
  const sheetKey = getSheetCacheKey(spreadsheetId, sheetTab);
  if (sheetsInitialized && initializedSheetKey === sheetKey) {
    return;
  }

  if (sheetsInitialized && initializedSheetKey !== sheetKey) {
    resetSheetCache();
  }

  await verifySpreadsheetAccess(env, spreadsheetId, sheetTab);
  await ensureTicketHeaders(env, spreadsheetId, sheetTab);
  await loadSheetRowIndexCache(env, spreadsheetId, sheetTab);
  initializedSheetKey = sheetKey;
  sheetsInitialized = true;
}

async function loadSheetRowIndexCache(env, spreadsheetId, sheetTab) {
  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetTab)}!A2:B`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    return;
  }

  sheetRowByChannelId.clear();
  sheetRowByTicketId.clear();
  const data = await response.json();
  const rows = Array.isArray(data.values) ? data.values : [];

  rows.forEach((row, index) => {
    const ticketId = row?.[0];
    const channelId = row?.[1];
    const rowNumber = index + 2;

    if (ticketId) {
      sheetRowByTicketId.set(String(ticketId), rowNumber);
    }

    if (channelId) {
      sheetRowByChannelId.set(String(channelId), rowNumber);
    }
  });
}

async function resolveExistingTicketRowNumber(env, spreadsheetId, sheetTab, ticketId, channelId) {
  if (ticketId) {
    const cachedTicketRowNumber = sheetRowByTicketId.get(String(ticketId));
    if (cachedTicketRowNumber) {
      return cachedTicketRowNumber;
    }
  }

  if (channelId) {
    const cachedChannelRowNumber = sheetRowByChannelId.get(String(channelId));
    if (cachedChannelRowNumber) {
      return cachedChannelRowNumber;
    }
  }

  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(sheetTab)}!A2:B`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    return null;
  }

  const data = await response.json().catch(() => null);
  const rows = Array.isArray(data?.values) ? data.values : [];

  rows.forEach((row, index) => {
    const rowTicketId = row?.[0];
    const rowChannelId = row?.[1];
    const rowNumber = index + 2;

    if (rowTicketId) {
      sheetRowByTicketId.set(String(rowTicketId), rowNumber);
    }

    if (rowChannelId) {
      sheetRowByChannelId.set(String(rowChannelId), rowNumber);
    }
  });

  if (ticketId && sheetRowByTicketId.has(String(ticketId))) {
    return sheetRowByTicketId.get(String(ticketId)) || null;
  }

  return channelId ? sheetRowByChannelId.get(String(channelId)) || null : null;
}

async function verifySpreadsheetAccess(env, spreadsheetId, sheetTab) {
  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties.title`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    if (response.status === 403) {
      return errorResponse(
        400,
        "Google Sheets permission denied. Share the spreadsheet with the service account email as Editor.",
      );
    }

    if (response.status === 404) {
      return errorResponse(400, "Google Sheets spreadsheet was not found.");
    }

    if (response.status === 429) {
      return errorResponse(400, "Google Sheets rate limit exceeded. Try again shortly.");
    }

    return errorResponse(400, "Unable to verify spreadsheet access.");
  }

  const data = await response.json();
  const sheets = Array.isArray(data.sheets) ? data.sheets : [];
  const tabExists = sheets.some((sheet) => sheet?.properties?.title === sheetTab);

  if (!tabExists) {
    return errorResponse(400, "Your sheet_tab was not found in the spreadsheet.");
  }

  return null;
}

function toCellValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function buildTicketRow(payload) {
  const openedAt = payload.opened_at || payload.created_at || new Date().toISOString();
  const firstReplyAt = payload.first_reply_at || payload.first_response_at || "";
  const closedAt = payload.closed_at || "";
  const status = payload.status || (payload.is_closed ? "closed" : "open");

  return [
    toCellValue(payload.ticket_id),
    toCellValue(payload.ticket_channel_id || payload.channel_id),
    toCellValue(status),
    toCellValue(payload.guild_id),
    toCellValue(payload.user_id),
    toCellValue(payload.claimed_by),
    toCellValue(payload.close_requested_by),
    toCellValue(openedAt),
    toCellValue(firstReplyAt),
    toCellValue(closedAt),
    toCellValue(payload.panel_title),
  ];
}

async function ensureTicketHeaders(env, spreadsheetId, sheetTab) {
  const accessToken = await getGoogleAccessToken(env);
  const response = await fetch(buildHeadersUrl(spreadsheetId, sheetTab), {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ values: [TICKET_HEADERS] }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Failed to write sheet headers (${response.status}): ${details}`);
  }
}

async function upsertTicketToSheet(env, payload, spreadsheetId, sheetTab) {
  if (!spreadsheetId) {
    throw new Error("Missing GOOGLEDOCS_SPREADSHEET_ID");
  }

  if (!isSpreadsheetId(spreadsheetId)) {
    throw new Error("Invalid spreadsheet ID");
  }

  await ensureSheetsInitialized(env, spreadsheetId, sheetTab);

  const rowValues = buildTicketRowFromEvent(payload);
  const ticketId = rowValues[0];
  const channelId = rowValues[1];
  const existingRowNumber = await resolveExistingTicketRowNumber(env, spreadsheetId, sheetTab, ticketId, channelId);
  const accessToken = await getGoogleAccessToken(env);

  const requestBody = JSON.stringify({
    majorDimension: "ROWS",
    values: [rowValues],
  });

  if (existingRowNumber) {
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(buildSheetRange(sheetTab, existingRowNumber))}?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken}`,
        },
        body: requestBody,
      },
    );

    if (!response.ok) {
      const details = await response.text();
      throw new Error(`Failed to update ticket row (${response.status}): ${details}`);
    }

    return { mode: "updated", rowNumber: existingRowNumber };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= GOOGLE_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(buildGoogleSheetsUrl(spreadsheetId, `${sheetTab}!A:K`), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: requestBody,
    });

    if (response.ok) {
      const data = await response.json().catch(() => null);
      const updatedRange = data?.updates?.updatedRange || "";
      const match = updatedRange.match(/!(?:[A-Z]+)(\d+):/);
      if (match) {
        const rowNumber = Number(match[1]);
        if (ticketId) {
          sheetRowByTicketId.set(String(ticketId), rowNumber);
        }
        if (channelId) {
          sheetRowByChannelId.set(String(channelId), rowNumber);
        }
      }
      return { mode: "inserted", rowNumber: (ticketId && sheetRowByTicketId.get(String(ticketId))) || (channelId && sheetRowByChannelId.get(String(channelId))) || null };
    }

    const details = await response.text();
    const classified = classifySheetsFailure(response, details);
    lastError = new Error(classified.message);

    if (response.status !== 429 && response.status < 500) {
      throw lastError;
    }

    if (attempt < GOOGLE_WRITE_MAX_ATTEMPTS) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
      const backoffMs = retryAfterMs ?? Math.min(5000, 500 * 2 ** (attempt - 1));
      await sleep(backoffMs);
    }
  }

  throw lastError || new Error("Failed to write ticket to Google Sheets");
}

async function processLifecycleEvent(payload, env, spreadsheetId, sheetTab) {
  if (getEventType(payload) === "first_response" && !payload.first_reply_at && !payload.first_response_at) {
    payload.first_reply_at = new Date().toISOString();
  }

  if (getEventType(payload) === "closed" && !payload.closed_at) {
    payload.closed_at = new Date().toISOString();
  }

  return queueTicketWrite(env, spreadsheetId, sheetTab, payload);
}

function queueBotSync(request, env, payload, note) {
  notifyBotApi(request, env, buildBotSeedRecord(payload))
    .then(() => {
      console.log(`[DEBUG] Bot sync queued successfully${note ? ` (${note})` : ""}`);
    })
    .catch((error) => {
      console.error(`[DEBUG] Bot sync failed${note ? ` (${note})` : ""}:`, error);
    });
}

async function handleLifecycleEvent(request, env, ctx) {
  const { spreadsheetId, sheetTab } = getSpreadsheetConfig(request, env);
  if (!spreadsheetId) {
    return errorResponse(400, "Missing spreadsheet ID.");
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "Invalid request body");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "Request body must be a JSON object");
  }

  const channelId = payload.ticket_channel_id || payload.channel_id || payload.channelId;
  if (!channelId) {
    return errorResponse(400, "Missing ticket_channel_id");
  }

  const writeTask = processLifecycleEvent(payload, env, spreadsheetId, sheetTab)
    .then((result) => {
      console.log(`[DEBUG] Lifecycle event written for channel ${channelId}: ${result.mode}`);
    })
    .catch((error) => {
      console.error("Lifecycle event write failed", error);
    });

  queueBotSync(request, env, payload, `channel ${channelId}`);

  if (ctx?.waitUntil) {
    ctx.waitUntil(writeTask);
  }

  return jsonResponse(202, {
    ok: true,
    queued: true,
    event_type: getEventType(payload),
    spreadsheet_id: spreadsheetId,
    sheet_tab: sheetTab,
  });
}

async function handleTicketSeedRequest(request, env) {
  const { spreadsheetId, sheetTab } = getSpreadsheetConfig(request, env);
  if (!spreadsheetId) {
    return errorResponse(400, "Missing spreadsheet ID.");
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "Invalid request body");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return errorResponse(400, "Request body must be a JSON object");
  }

  const records = Array.isArray(payload.tickets)
    ? payload.tickets
    : Array.isArray(payload.ticket_channels)
      ? payload.ticket_channels
      : Array.isArray(payload.channel_ids)
        ? payload.channel_ids
        : Array.isArray(payload.channelIds)
          ? payload.channelIds
          : [];

  if (records.length === 0) {
    return errorResponse(400, "Missing tickets, ticket_channels, or channel_ids");
  }

  try {
    const normalizedFallback = {
      ticket_id: payload.ticket_id || payload.ticketId || "",
      guild_id: payload.guild_id || payload.guildId || "",
      user_id: payload.user_id || payload.userId || "",
      status: payload.status || "open",
      panel_title: payload.panel_title || payload.panelTitle || "",
      opened_at: payload.opened_at || payload.openedAt || new Date().toISOString(),
      claimed_by: payload.claimed_by || payload.claimedBy || "",
      close_requested_by: payload.close_requested_by || payload.closeRequestedBy || "",
      first_reply_at: payload.first_reply_at || payload.first_response_at || payload.firstReplyAt || "",
      closed_at: payload.closed_at || payload.closedAt || "",
      replace: payload.replace === true,
    };

    if (normalizedFallback.replace) {
      resetSheetCache();
    }

    const results = await writeTicketSeedBatch(
      request,
      env,
      spreadsheetId,
      sheetTab,
      records.map((entry) => normalizeTicketSeedEntry(entry, normalizedFallback)).filter(Boolean),
    );

    return jsonResponse(200, {
      ok: true,
      replaced: normalizedFallback.replace,
      seeded: results.length,
      results,
      spreadsheet_id: spreadsheetId,
      sheet_tab: sheetTab,
    });
  } catch (error) {
    console.error("Ticket seed write failed", error);
    const message = error instanceof Error ? error.message : "Failed to seed tickets";
    if (message.includes("permission denied")) {
      return errorResponse(403, message);
    }
    if (message.includes("rate limit")) {
      return errorResponse(429, message);
    }
    return errorResponse(502, message);
  }
}

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (PRIVACY_POLICY_PATHS.has(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
    return privacyPolicyResponse();
  }

  if (url.pathname === "/api/tickets" && request.method === "GET") {
    if (!isValidAuthRequest(request, env)) {
      return errorResponse(401, "Invalid auth key");
    }

    const { spreadsheetId, sheetTab } = await getSpreadsheetConfig(request, env);

    return jsonResponse(200, {
      ok: true,
      endpoints: ["/events", "/api/tickets/bootstrap", "/api/tickets/seed", "/privacy-policy"],
      hasSpreadsheet: Boolean(spreadsheetId),
      spreadsheet_id: spreadsheetId,
      sheet_tab: sheetTab,
    });
  }

  if (request.method !== "POST") {
    return errorResponse(405, "Method Not Allowed");
  }

  if (url.pathname === "/validate-secrets") {
    let secrets;
    try {
      secrets = await request.json();
    } catch {
      return errorResponse(400, "Invalid request body");
    }

    if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
      return errorResponse(400, "Request body must be a JSON object");
    }

    const accessCheck = await validateSecrets(env, secrets);
    if (accessCheck) {
      return accessCheck;
    }

    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/events") {
    if (!isValidAuthRequest(request, env)) {
      return errorResponse(401, "Invalid auth key");
    }

    return handleLifecycleEvent(request, env, ctx);
  }

  if (url.pathname === "/api/tickets/bootstrap" || url.pathname === "/api/tickets/seed") {
    if (!isValidAuthRequest(request, env)) {
      return errorResponse(401, "Invalid auth key");
    }

    return handleTicketSeedRequest(request, env);
  }

  if (url.pathname !== "/" && url.pathname !== "/tickets-webhook") {
    return errorResponse(404, "Not Found");
  }

  if (!isValidAuthRequest(request, env)) {
    return errorResponse(401, "Invalid auth key");
  }

  const { spreadsheetId, sheetTab } = await getSpreadsheetConfig(request, env);
  if (!spreadsheetId) {
    return errorResponse(
      400,
      `Missing spreadsheet ID. Set X-Tickets-Google-Sheets-Id on the integration or GOOGLEDOCS_SPREADSHEET_ID in Cloudflare secrets.`,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "Invalid request body");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return errorResponse(400, "Request body must be a JSON object");
  }


  if (!body.user_id && url.pathname !== "/tickets-webhook") {
    return errorResponse(400, "Missing user_id in request body");
  }

  const decision = await decideWithBotApi(request, env, body)
    .then((result) => {
      console.log(
        `[DEBUG] Bot decision for channel ${body.ticket_channel_id || body.channel_id || body.channelId || "unknown"}: should_write=${result.shouldWrite}`,
      );
      return result;
    })
    .catch((error) => {
      console.error("[DEBUG] Pre-write bot decision failed", error);
      return {
        shouldWrite: true,
        ticket: buildBotSeedRecord(body),
      };
    });

  if (!decision.shouldWrite) {
    return jsonResponse(200, {
      ok: true,
      skipped: "No meaningful bot-side state change",
      spreadsheet_id: spreadsheetId,
      sheet_tab: sheetTab,
    });
  }

  const writeTask = processLifecycleEvent(decision.ticket, env, spreadsheetId, sheetTab)
    .then((result) => {
      console.log(`[DEBUG] Ticket webhook written for channel ${decision.ticket.ticket_channel_id || decision.ticket.channel_id || decision.ticket.channelId}: ${result.mode}`);
    })
    .catch((error) => {
      console.error("Google Sheets append failed", error);
    });

  if (ctx?.waitUntil) {
    ctx.waitUntil(writeTask);
  }

  return jsonResponse(202, {
    ok: true,
    queued: true,
    spreadsheet_id: spreadsheetId,
    sheet_tab: sheetTab,
  });
}

export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    tracesSampleRate: 1.0,
    sendDefaultPii: true,
  }),
  {
    async fetch(request, env, ctx) {
      return handleRequest(request, env, ctx);
    },
  },
);
