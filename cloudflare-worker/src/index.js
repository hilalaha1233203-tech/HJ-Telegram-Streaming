import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import {
  MEDIA_CACHE_TTL,
  MEDIA_CHUNK_SIZE,
  MEDIA_METADATA_TTL_MS,
  MEDIA_TICKET_TTL_MS,
  MAX_METADATA_CACHE,
  encodeDispositionFilename,
  errorPayload,
  inferFilename,
  inferMimeType,
  normalizeOriginList,
  parseMessageId,
  parseSingleRange,
  safeAsciiFilename,
} from "./pure.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://hj-groups-web.vercel.app",
  "https://hj-groups-website.getvoroa.com",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const mediaMetadataCache = new Map();

function envString(env, key, fallback = "") {
  const value = env?.[key];
  return value == null ? fallback : String(value).trim();
}

function allowedOrigins(env) {
  const configured = normalizeOriginList(envString(env, "CORS_ALLOWED_ORIGINS"));
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function applyCors(headers, origin, env, { publicMedia = false } = {}) {
  if (publicMedia) {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins(env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }

  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Cache-Control, Content-Type, Pragma, Range"
  );
  headers.set(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range, Content-Disposition, Content-Type, ETag, Last-Modified, X-HJ-Telegram-Source"
  );
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
}

function requireEnv(env, keys) {
  const missing = keys.filter((key) => !envString(env, key));
  if (missing.length) {
    throw new Error("Missing required environment variables: " + missing.join(", "));
  }
}

async function createTelegramClient(env) {
  requireEnv(env, [
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_SESSION",
    "CHANNEL_ID",
  ]);

  const apiId = Number(envString(env, "TELEGRAM_API_ID"));
  const apiHash = envString(env, "TELEGRAM_API_HASH");
  const session = envString(env, "TELEGRAM_SESSION");
  const channelId = Number(envString(env, "CHANNEL_ID"));

  if (!Number.isSafeInteger(apiId) || apiId <= 0) {
    throw new Error("TELEGRAM_API_ID must be a positive integer");
  }
  if (!apiHash) throw new Error("TELEGRAM_API_HASH is empty");
  if (!session) throw new Error("TELEGRAM_SESSION is empty");
  if (!Number.isSafeInteger(channelId) || channelId === 0) {
    throw new Error("CHANNEL_ID must be a valid Telegram channel id");
  }

  const client = new TelegramClient(
    new StringSession(session),
    apiId,
    apiHash,
    {
      connectionRetries: 3,
      reconnectRetries: 3,
      requestRetries: 4,
      downloadRetries: 4,
      timeout: 10,
      retryDelay: 500,
      autoReconnect: true,
      maxConcurrentDownloads: 1,
      downloadPool: {
        maxSessions: 1,
        sessions: 1,
        inflightPerDc: 1,
      },
      deviceModel: "HJ GROUPS Cloudflare Worker",
      systemVersion: "Cloudflare Workers",
      appVersion: "1.0.0",
      langCode: "en",
      systemLangCode: "en",
    }
  );

  try {
    await client.connect();

    if (!(await client.isUserAuthorized())) {
      throw new Error("Telegram session is not authorized");
    }

    client.__hjChannelId = channelId;
    return client;
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}

function cacheMetadata(key, message) {
  mediaMetadataCache.set(key, {
    message,
    expiresAt: Date.now() + MEDIA_METADATA_TTL_MS,
  });

  while (mediaMetadataCache.size > MAX_METADATA_CACHE) {
    mediaMetadataCache.delete(mediaMetadataCache.keys().next().value);
  }
}

function getCachedMetadata(key) {
  const hit = mediaMetadataCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    mediaMetadataCache.delete(key);
    return null;
  }
  return hit.message;
}

async function getTelegramMessage(messageId, client) {
  const key = String(messageId);
  const cached = getCachedMetadata(key);
  if (cached) return cached;

  const [message] = await client.getMessages(client.__hjChannelId, {
    ids: [messageId],
  });

  if (!message || !message.media?.document) {
    throw Object.assign(new Error("Telegram message does not contain a document"), {
      code: "MEDIA_NOT_FOUND",
    });
  }

  cacheMetadata(key, message);
  return message;
}

function buildMediaHeaders(meta, kind, range, isProtected, origin, env) {
  const headers = new Headers();
  const filename = inferFilename(meta.document, kind);
  const mimeType = inferMimeType(meta.document, kind);
  const asciiName = safeAsciiFilename(filename, kind === "video" ? "video.mp4" : kind === "document" ? "document" : "audio.m4a");

  headers.set("Content-Type", mimeType);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Disposition", 'inline; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeDispositionFilename(filename));
  headers.set("Cache-Control", isProtected ? "private, no-store" : "public, max-age=" + MEDIA_CACHE_TTL + ", immutable");
  headers.set("ETag", '"tg-' + kind + '-' + meta.messageId + '-' + meta.size + '"');
  if (meta.messageDate) {
    headers.set("Last-Modified", new Date(meta.messageDate * 1000).toUTCString());
  }

  if (range.partial) {
    headers.set("Content-Range", 'bytes ' + range.start + "-" + range.end + "/" + meta.size);
  }
  headers.set("Content-Length", String(range.length));
  headers.set("X-HJ-Telegram-Source", "direct");

  applyCors(headers, origin, env, { publicMedia: !isProtected });
  return headers;
}

function mediaCacheKey(request, kind, messageId, range) {
  const url = new URL(request.url);
  return new Request(
    "https://hj-media-cache.invalid/v1/" +
      encodeURIComponent(kind) +
      "/" +
      encodeURIComponent(messageId) +
      "/" +
      encodeURIComponent(range.start) +
      "-" +
      encodeURIComponent(range.end)
  );
}

async function getCachedMedia(cache, request, kind, messageId, range) {
  if (request.method !== "GET") return null;
  try {
    return await cache.match(mediaCacheKey(request, kind, messageId, range));
  } catch {
    return null;
  }
}

function parseAccessTypes(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map(String)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
  }

  const text = String(raw ?? "").trim();
  if (!text) return ["free"];

  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed
          .map(String)
          .map((x) => x.trim().toLowerCase())
          .filter(Boolean);
      }
    } catch {}
  }

  return text
    .split(/[+,\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => ["free", "vip", "premium", "ads"].includes(x));
}

function isProtectedPolicy(row) {
  const types = parseAccessTypes(row?.access_type);
  return types.includes("premium") || types.includes("vip") || types.includes("ads");
}

async function supabaseJson(env, pathname, authHeader = "") {
  const base = envString(env, "SUPABASE_URL");
  const key = envString(env, "SUPABASE_PUBLISHABLE_KEY");

  if (!base || !key) throw new Error("Supabase configuration is missing");

  const headers = {
    apikey: key,
    Accept: "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;

  const response = await fetch(base.replace(/\/+$/, "") + pathname, {
    headers,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok) {
    const error = new Error(
      "Supabase HTTP " +
        response.status +
        (payload?.message ? ": " + String(payload.message).slice(0, 220) : "")
    );
    error.statusCode = response.status;
    throw error;
  }

  return payload;
}

async function lookupMediaPolicy(env, kind, messageId) {
  const table =
    kind === "audio"
      ? "episodes"
      : kind === "video"
        ? "video_episodes"
        : "books";

  const select =
    kind === "video"
      ? "id,video_story_id,access_type,available,number"
      : kind === "audio"
        ? "id,story_id,access_type,available,episode_number,number"
        : "id,access_type";

  const params = new URLSearchParams({
    select,
    telegram_message_id: "eq." + String(messageId),
    limit: "1",
  });

  try {
    const rows = await supabaseJson(
      env,
      "/rest/v1/" + table + "?" + params.toString()
    );
    return {
      row: Array.isArray(rows) ? rows[0] || null : null,
      error: null,
    };
  } catch (error) {
    return { row: null, error };
  }
}

async function getEpisodePreviewLimit(env, kind) {
  const key = kind === "video" ? "video_free_episodes" : "audio_free_episodes";
  try {
    const params = new URLSearchParams({
      select: key,
      id: "eq.default",
      limit: "1",
    });
    const rows = await supabaseJson(
      env,
      "/rest/v1/content_access_settings?" + params.toString()
    );
    return Math.max(0, Number(Array.isArray(rows) ? rows[0]?.[key] : 0) || 0);
  } catch {
    return 0;
  }
}

function episodeNumberForPolicy(kind, row) {
  return Number(
    kind === "video" ? row?.number : row?.number ?? row?.episode_number
  );
}

async function isFreeEpisodePreview(env, kind, row) {
  if (!["audio", "video"].includes(kind)) return false;
  const types = parseAccessTypes(row?.access_type);
  if (!types.some((type) => ["premium", "vip", "ads"].includes(type))) {
    return false;
  }

  const number = episodeNumberForPolicy(kind, row);
  if (!Number.isInteger(number) || number <= 0) return false;

  const limit = await getEpisodePreviewLimit(env, kind);
  return limit > 0 && number <= limit;
}

async function verifyWebEntitlement(env, authHeader, kind, row) {
  if (!authHeader) {
    return {
      ok: false,
      status: 401,
      error: "Login is required for protected media.",
    };
  }

  const base = envString(env, "HJ_WEB_BASE_URL");
  if (!base) {
    return {
      ok: false,
      status: 503,
      error: "HJ_WEB_BASE_URL is not configured.",
    };
  }

  const contentType = kind === "document" ? "book" : kind;
  const contentId = Number(row?.id);
  if (!Number.isSafeInteger(contentId) || contentId <= 0) {
    return { ok: false, status: 400, error: "Media record is invalid." };
  }

  try {
    const response = await fetch(
      base.replace(/\/+$/, "") + "/api/shortener/access",
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ contentType, contentId }),
      }
    );

    let payload = null;
    try {
      payload = await response.json();
    } catch {}

    if (response.ok && payload?.ok) return { ok: true, payload };

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        error: String(
          payload?.error || "Temporary or paid access required."
        ),
      };
    }

    return {
      ok: false,
      status: 503,
      error: "Protected media entitlement could not be verified.",
    };
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Protected media entitlement could not be verified.",
    };
  }
}

async function getSupabaseUser(env, authHeader) {
  if (!/^Bearer\s+\S+/i.test(String(authHeader || ""))) return null;
  try {
    return await supabaseJson(env, "/auth/v1/user", authHeader);
  } catch {
    return null;
  }
}

async function inspectMediaAccess(env, req, kind, messageId) {
  const ticket = String(new URL(req.url).searchParams.get("ticket") || "").trim();
  const ticketUser = verifyMediaTicket(
    env,
    ticket,
    kind,
    messageId,
    req.headers.get("user-agent") || ""
  );
  if (ticketUser) {
    return { ok: true, viaTicket: true, userId: ticketUser.userId };
  }

  const policyResult = await lookupMediaPolicy(env, kind, messageId);
  if (policyResult.error) {
    return {
      ok: false,
      status: 503,
      error: "Media access policy could not be verified.",
    };
  }

  const row = policyResult.row;
  if (!row) {
    return {
      ok: false,
      status: 404,
      error: "Media record was not found in the content database.",
    };
  }

  if (row.available === false) {
    return {
      ok: false,
      status: 403,
      error: "This media is unavailable.",
    };
  }

  if (!isProtectedPolicy(row)) {
    return { ok: true, viaTicket: false, row };
  }

  if (await isFreeEpisodePreview(env, kind, row)) {
    return {
      ok: true,
      viaTicket: false,
      viaPreview: true,
      row,
    };
  }

  const authHeader = String(req.headers.get("authorization") || "").trim();
  if (!authHeader) {
    return {
      ok: false,
      status: 401,
      error: "Login is required for protected media.",
    };
  }

  const entitlement = await verifyWebEntitlement(env, authHeader, kind, row);
  if (!entitlement.ok) return entitlement;

  const user = await getSupabaseUser(env, authHeader);
  if (!user?.id) {
    return {
      ok: false,
      status: 401,
      error: "Invalid or expired login session.",
    };
  }

  return {
    ok: true,
    viaTicket: false,
    row,
    user,
  };
}

function createMediaTicket(env, kind, messageId, userId, userAgent) {
  const secret = envString(env, "MEDIA_TICKET_SECRET");
  if (!secret) throw new Error("MEDIA_TICKET_SECRET is not configured.");

  const payload = b64url(
    JSON.stringify({
      kind,
      messageId: Number(messageId),
      userId: String(userId),
      ua: createHash("sha256")
        .update(String(userAgent || ""))
        .digest("base64url"),
      exp: Date.now() + MEDIA_TICKET_TTL_MS,
    })
  );

  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

function b64url(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function verifyMediaTicket(env, token, kind, messageId, userAgent) {
  const secret = envString(env, "MEDIA_TICKET_SECRET");
  if (!secret || !token) return null;

  const parts = String(token).split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;
  const expected = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return null;
  }

  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (value.kind !== kind) return null;
    if (Number(value.messageId) !== Number(messageId)) return null;
    if (!value.userId || Number(value.exp) <= Date.now()) return null;

    const expectedUa = createHash("sha256")
      .update(String(userAgent || ""))
      .digest("base64url");

    const actualUa = Buffer.from(String(value.ua || ""));
    const expectedUaBuffer = Buffer.from(expectedUa);

    if (
      actualUa.length !== expectedUaBuffer.length ||
      !timingSafeEqual(actualUa, expectedUaBuffer)
    ) {
      return null;
    }

    return value;
  } catch {
    return null;
  }
}

function jsonResponse(data, status, origin, env) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  applyCors(headers, origin, env);
  return new Response(JSON.stringify(data), { status, headers });
}

function mediaError(status, code, origin, env, detail = "") {
  return jsonResponse(errorPayload(code, detail), status, origin, env);
}

function createTelegramMediaStream(client, message, startOffset, byteLength, requestSignal) {
  let clientClosed = false;
  const closeClient = async () => {
    if (clientClosed) return;
    clientClosed = true;
    try { await client.disconnect(); } catch {}
  };

  const streamAbort = new AbortController();
  let generator = null;
  let remaining = byteLength == null ? null : Number(byteLength);
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    requestSignal?.removeEventListener("abort", onRequestAbort);
  };

  const onRequestAbort = () => streamAbort.abort();

  if (requestSignal?.aborted) {
    streamAbort.abort();
  } else {
    requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
  }

  const finishGenerator = async () => {
    try { await generator?.return?.(); } catch {}
    generator = null;
  };

  return new ReadableStream({
    async pull(controller) {
      try {
        if (streamAbort.signal.aborted) {
          cleanup();
          await finishGenerator();
          await closeClient();
          controller.close();
          return;
        }

        if (!generator) {
          generator = client.iterDownload(message, {
            offset: startOffset,
            limit: remaining == null ? undefined : remaining,
            requestSize: MEDIA_CHUNK_SIZE,
            signal: streamAbort.signal,
          });
        }

        const next = await generator.next();

        if (next.done) {
          cleanup();
          await closeClient();
          controller.close();
          return;
        }

        const chunk = Buffer.from(next.value || "");
        if (!chunk.length) {
          cleanup();
          await finishGenerator();
          await closeClient();
          controller.close();
          return;
        }

        if (remaining != null) {
          const take = Math.min(chunk.length, remaining);
          if (take > 0) {
            controller.enqueue(chunk.subarray(0, take));
            remaining -= take;
          }

          if (remaining <= 0) {
            await finishGenerator();
            cleanup();
            await closeClient();
            controller.close();
          }
          return;
        }

        controller.enqueue(chunk);
      } catch (error) {
        cleanup();
        await finishGenerator();
        await closeClient();

        if (streamAbort.signal.aborted || error?.name === "AbortError") {
          controller.close();
          return;
        }

        console.error("HJ Telegram media stream error", {
          messageId: message?.id,
          error: String(error?.message || error).slice(0, 200),
        });
        controller.error(error);
      }
    },

    async cancel() {
      streamAbort.abort();
      await finishGenerator();
      await closeClient();
      cleanup();
    },
  });
}

async function handleMedia(request, env, ctx, kind, messageId) {
  if (!parseMessageId(messageId)) {
    return mediaError(400, "INVALID_MESSAGE_ID", request.headers.get("origin") || "", env);
  }

  const access = await inspectMediaAccess(env, request, kind, Number(messageId));
  if (!access.ok) {
    return mediaError(
      access.status || 403,
      "MEDIA_ACCESS_DENIED",
      request.headers.get("origin") || "",
      env,
      access.error
    );
  }

  const isPreview = Boolean(access.viaPreview);
  const isProtected = Boolean(access.viaTicket || isProtectedPolicy(access.row || {}));

  if (isProtected && !access.viaTicket && !isPreview) {
    return mediaError(
      403,
      "SECURE_TICKET_REQUIRED",
      request.headers.get("origin") || "",
      env
    );
  }

  const origin = request.headers.get("origin") || "";
  const canCache = !isProtected && request.method === "GET";

  // Public range hits can be served without opening a Telegram TCP socket.
  const rangeHint = request.headers.get("range");
  if (canCache && rangeHint) {
    const parsedRange = parseSingleRange(rangeHint, Number.MAX_SAFE_INTEGER, MEDIA_CHUNK_SIZE);
    // Do not trust the hint for lookup unless the actual Telegram file size is known;
    // therefore this fast path intentionally skips malformed/ambiguous ranges.
    if (!parsedRange.error && parsedRange.requested) {
      // Metadata is still required to know the actual file size, so cache lookup
      // happens after metadata below. This branch only documents the safe policy.
    }
  }

  let client = null;
  let handedOffToStream = false;

  try {
    client = await createTelegramClient(env);
    const message = await getTelegramMessage(Number(messageId), client);
    const document = message?.media?.document;
    const size = Number(document?.size);

    if (!document || !Number.isSafeInteger(size) || size <= 0) {
      return mediaError(404, "TELEGRAM_FILE_METADATA_MISSING", origin, env);
    }

    const range = parseSingleRange(
      request.headers.get("range"),
      size,
      MEDIA_CHUNK_SIZE
    );

    if (range.error) {
      const headers = new Headers({
        "Content-Range": "bytes */" + size,
        "Accept-Ranges": "bytes",
      });
      applyCors(headers, origin, env, { publicMedia: !isProtected });
      return new Response(null, { status: 416, headers });
    }

    const meta = {
      messageId: Number(messageId),
      messageDate: Number(message.date || 0),
      document,
      size,
    };

    const headers = buildMediaHeaders(
      meta,
      kind,
      range,
      isProtected && !isPreview,
      origin,
      env
    );

    if (request.method === "HEAD") {
      await client.disconnect().catch(() => {});
      client = null;

      return new Response(null, {
        status: range.partial ? 206 : 200,
        headers,
      });
    }

    const cache = caches.default;
    const rangeCanCache = !isProtected && range.requested;

    if (rangeCanCache) {
      const hit = await getCachedMedia(
        cache,
        request,
        kind,
        Number(messageId),
        range
      );

      if (hit) {
        await client.disconnect().catch(() => {});
        client = null;

        const hitHeaders = new Headers(hit.headers);
        applyCors(hitHeaders, origin, env, { publicMedia: true });

        return new Response(hit.body, {
          status: hit.status,
          headers: hitHeaders,
        });
      }
    }

    const body = createTelegramMediaStream(
      client,
      message,
      range.start,
      range.requested ? range.length : null,
      request.signal
    );
    handedOffToStream = true;

    const response = new Response(body, {
      status: range.requested ? 206 : 200,
      headers,
    });

    if (rangeCanCache) {
      ctx.waitUntil(
        cache
          .put(
            mediaCacheKey(request, kind, Number(messageId), range),
            response.clone()
          )
          .catch((error) => {
            console.warn("HJ Telegram edge-cache put failed", {
              messageId: Number(messageId),
              error: String(error?.message || error).slice(0, 160),
            });
          })
      );
    }

    return response;
  } catch (error) {
    if (client && !handedOffToStream) {
      await client.disconnect().catch(() => {});
    }

    console.error("HJ Telegram media request error", {
      kind,
      messageId: Number(messageId),
      error: String(error?.message || error).slice(0, 200),
    });

    if (error?.name === "AbortError") {
      return new Response(null, { status: 499 });
    }

    const code = error?.code === "MEDIA_NOT_FOUND"
      ? "MEDIA_NOT_FOUND"
      : "TELEGRAM_MEDIA_REQUEST_ERROR";

    return mediaError(
      code === "MEDIA_NOT_FOUND" ? 404 : 502,
      code,
      origin,
      env,
      error?.message
    );
  }
}
async function handleTelegramMessages(request, env) {
  const origin = request.headers.get("origin") || "";
  const authHeader = request.headers.get("authorization") || "";
  const user = await getSupabaseUser(env, authHeader);

  if (user?.app_metadata?.role !== "admin") {
    return jsonResponse(
      { error: authHeader ? "FORBIDDEN" : "UNAUTHORIZED" },
      authHeader ? 403 : 401,
      origin,
      env
    );
  }

  const url = new URL(request.url);
  const requestedLimit = Number(url.searchParams.get("limit"));
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(100, Math.max(1, requestedLimit))
    : 100;

  const requestedOffsetId = Number(url.searchParams.get("offset_id"));
  const offsetId =
    Number.isSafeInteger(requestedOffsetId) && requestedOffsetId > 0
      ? requestedOffsetId
      : 0;

  const requestedType = String(url.searchParams.get("type") || "audio").toLowerCase();
  const mediaType = ["audio", "video", "document"].includes(requestedType)
    ? requestedType
    : "audio";

  try {
    const client = await getTelegramClient(env);
    const messages = await withTelegramSlot(async () => {
      const params = { limit };
      if (offsetId > 0) params.offsetId = offsetId;
      return client.getMessages(client.__hjChannelId, params);
    });

    const mediaMessages = [];
    for (const msg of messages || []) {
      const doc = msg?.media?.document;
      const mimeType = String(doc?.mimeType || "").toLowerCase();
      const attributes = Array.isArray(doc?.attributes) ? doc.attributes : [];
      const hasAudioAttribute = attributes.some(
        (attr) => attr.className === "DocumentAttributeAudio"
      );
      const hasVideoAttribute = attributes.some(
        (attr) => attr.className === "DocumentAttributeVideo"
      );

      if (!doc) continue;

      if (
        mediaType === "audio" &&
        !mimeType.startsWith("audio/") &&
        !hasAudioAttribute
      ) {
        continue;
      }

      if (
        mediaType === "video" &&
        !mimeType.startsWith("video/") &&
        !hasVideoAttribute
      ) {
        continue;
      }

      if (mediaType === "document") {
        const looksLikeBook =
          mimeType === "application/pdf" ||
          mimeType === "application/epub+zip" ||
          (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/"));

        if (!looksLikeBook) continue;
      }

      let fileName =
        mediaType === "video"
          ? "video.mp4"
          : mediaType === "document"
            ? "book.pdf"
            : "audio.m4a";
      let duration = 0;
      let width = 0;
      let height = 0;
      let audioTitle = "";
      let performer = "";

      for (const attr of attributes) {
        if (attr.className === "DocumentAttributeFilename" && attr.fileName) {
          fileName = attr.fileName;
        }
        if (attr.className === "DocumentAttributeAudio") {
          duration = attr.duration || 0;
          audioTitle = attr.title || "";
          performer = attr.performer || "";
        }
        if (attr.className === "DocumentAttributeVideo") {
          duration = attr.duration || 0;
          width = attr.w || 0;
          height = attr.h || 0;
        }
      }

      mediaMessages.push({
        messageId: msg.id,
        fileName,
        mimeType,
        size: Number(doc.size),
        duration,
        width,
        height,
        date: msg.date,
        caption: msg.message || "",
        audioTitle,
        performer,
      });
    }

    const lastMessageId = messages?.length
      ? Number(messages[messages.length - 1]?.id)
      : 0;

    const nextOffsetId =
      messages?.length >= limit && Number.isSafeInteger(lastMessageId) && lastMessageId > 0
        ? lastMessageId
        : 0;

    const headers = new Headers();
    applyCors(headers, origin, env);
    headers.set("Cache-Control", "no-store");
    headers.set("X-HJ-Telegram-Next-Offset", nextOffsetId ? String(nextOffsetId) : "");
    headers.set("X-HJ-Telegram-Has-More", nextOffsetId ? "true" : "false");

    return new Response(JSON.stringify(mediaMessages), {
      status: 200,
      headers,
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "TELEGRAM_MESSAGES_ERROR",
        detail: String(error?.message || error).replace(/[\r\n]+/g, " ").slice(0, 180),
      },
      503,
      origin,
      env
    );
  }
}

async function handleMediaTicket(request, env) {
  const url = new URL(request.url);
  const type = String(url.pathname.split("/")[2] || "").toLowerCase();
  const messageId = parseMessageId(url.pathname.split("/").pop());

  if (!["audio", "video", "document"].includes(type) || !messageId) {
    return jsonResponse(
      { error: "INVALID_MEDIA_TICKET_REQUEST" },
      400,
      request.headers.get("origin") || "",
      env
    );
  }

  try {
    const access = await inspectMediaAccess(env, request, type, messageId);
    if (!access.ok) {
      return mediaError(
        access.status || 403,
        "MEDIA_ACCESS_DENIED",
        request.headers.get("origin") || "",
        env,
        access.error
      );
    }

    if (!access.row || !isProtectedPolicy(access.row)) {
      return jsonResponse(
        { error: "Media is not protected" },
        400,
        request.headers.get("origin") || "",
        env
      );
    }

    const userId = String(access.user?.id || access.userId || "").trim();
    if (!userId) {
      return jsonResponse(
        { error: "Login is required for premium/VIP media." },
        401,
        request.headers.get("origin") || "",
        env
      );
    }

    const token = createMediaTicket(
      env,
      type,
      messageId,
      userId,
      request.headers.get("user-agent") || ""
    );

    const mediaUrl =
      new URL("/" + type + "/message/" + messageId, request.url).toString() +
      "?ticket=" +
      encodeURIComponent(token);

    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    applyCors(headers, request.headers.get("origin") || "", env);

    return new Response(
      JSON.stringify({
        url: mediaUrl,
        expires_at: new Date(Date.now() + MEDIA_TICKET_TTL_MS).toISOString(),
      }),
      { status: 200, headers }
    );
  } catch (error) {
    return jsonResponse(
      { error: "MEDIA_TICKET_ERROR" },
      503,
      request.headers.get("origin") || "",
      env
    );
  }
}

async function handleTelegramStatus(request, env) {
  const missing = [];
  for (const key of [
    "TELEGRAM_API_ID",
    "TELEGRAM_API_HASH",
    "TELEGRAM_SESSION",
    "CHANNEL_ID",
  ]) {
    if (!envString(env, key)) missing.push(key);
  }

  const configured = missing.length === 0;

  if (new URL(request.url).searchParams.get("ping") === "1" && configured) {
    try {
      const client = await getTelegramClient(env);
      await withTelegramSlot(() =>
        client.getMessages(client.__hjChannelId, { ids: [1] })
      );
    } catch {
      return jsonResponse(
        { ok: false, telegramConfigured: true, telegramReachable: false },
        503,
        request.headers.get("origin") || "",
        env
      );
    }
  }

  return jsonResponse(
    {
      ok: configured,
      telegramConfigured: configured,
      telegramReachable: configured && Boolean(telegramClientPromise),
      missing,
    },
    configured ? 200 : 503,
    request.headers.get("origin") || "",
    env
  );
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("origin") || "";

    try {
      const method = request.method.toUpperCase();

      if (method === "OPTIONS") {
        const headers = new Headers();
        applyCors(headers, origin, env);
        return new Response(null, { status: 204, headers });
      }

      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (method !== "GET" && method !== "HEAD") {
        return jsonResponse(
          { error: "METHOD_NOT_ALLOWED" },
          405,
          origin,
          env
        );
      }

      if (parts.length === 0 || url.pathname === "/health") {
        return jsonResponse(
          {
            status: "ok",
            service: "hj-telegram-streaming-cloudflare",
            directTelegram: true,
          },
          200,
          origin,
          env
        );
      }

      if (url.pathname === "/telegram/status") {
        return handleTelegramStatus(request, env);
      }

      if (url.pathname === "/telegram/messages") {
        return handleTelegramMessages(request, env);
      }

      if (parts.length === 4 && parts[0] === "media-ticket" && parts[2] === "message") {
        return handleMediaTicket(request, env);
      }

      if (parts.length === 3 && ["audio", "video", "document"].includes(parts[0]) && parts[1] === "message") {
        return handleMedia(request, env, ctx, parts[0], parts[2]);
      }

      return jsonResponse(
        { error: "NOT_FOUND" },
        404,
        origin,
        env
      );
    } catch (error) {
      console.error("HJ Worker unhandled error", String(error?.message || error).slice(0, 200));
      return jsonResponse(
        { error: "INTERNAL_SERVER_ERROR" },
        500,
        origin,
        env
      );
    }
  },
};
