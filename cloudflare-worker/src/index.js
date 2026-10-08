import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  MEDIA_TICKET_TTL_MS,
  parseMessageId,
  parseSingleRange,
  encodeDispositionFilename,
  inferFilename,
  inferMimeType,
  normalizeOriginList,
  safeAsciiFilename,
  errorPayload,
} from "./pure.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://hj-groups-web.pages.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function envString(env, key, fallback = "") {
  const value = env?.[key];
  return value == null ? fallback : String(value).trim();
}

function allowedOrigins(env) {
  const configured = normalizeOriginList(envString(env, "CORS_ALLOWED_ORIGINS"));
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function applyCors(headers, origin, env) {
  if (origin && allowedOrigins(env).has(origin)) {
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

function required(env, keys) {
  const missing = keys.filter((key) => !envString(env, key));
  if (missing.length) throw new Error("Missing required environment variables: " + missing.join(", "));
}

function publicKey(env) {
  required(env, ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]);
  return envString(env, "SUPABASE_PUBLISHABLE_KEY");
}

function serverKey(env) {
  required(env, ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
  return envString(env, "SUPABASE_SERVICE_ROLE_KEY");
}

async function supabaseJson(env, pathname, key, authHeader = "", baseOverride = "") {
  const base = String(baseOverride || envString(env, "SUPABASE_URL")).trim();
  const headers = {
    apikey: key,
    Accept: "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;
  const response = await fetch(base.replace(/\/+$/, "") + pathname, { headers });
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

function parseAccessTypes(raw) {
  if (Array.isArray(raw)) {
    return raw.map(String).map((x) => x.trim().toLowerCase()).filter(Boolean);
  }
  const text = String(raw ?? "").trim();
  if (!text) return ["free"];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((x) => x.trim().toLowerCase()).filter(Boolean);
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

async function lookupMediaPolicy(env, kind, messageId) {
  const table = kind === "audio" ? "episodes" : kind === "video" ? "video_episodes" : "books";
  const select = kind === "video"
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
      "/rest/v1/" + table + "?" + params.toString(),
      publicKey(env)
    );
    return { row: Array.isArray(rows) ? rows[0] || null : null, error: null };
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
      "/rest/v1/content_access_settings?" + params.toString(),
      publicKey(env)
    );
    return Math.max(0, Number(Array.isArray(rows) ? rows[0]?.[key] : 0) || 0);
  } catch {
    return 0;
  }
}

function episodeNumberForPolicy(kind, row) {
  return Number(kind === "video" ? row?.number : row?.number ?? row?.episode_number);
}

async function isFreeEpisodePreview(env, kind, row) {
  if (!["audio", "video"].includes(kind)) return false;
  const types = parseAccessTypes(row?.access_type);
  if (!types.some((type) => ["premium", "vip", "ads"].includes(type))) return false;
  const number = episodeNumberForPolicy(kind, row);
  if (!Number.isInteger(number) || number <= 0) return false;
  const limit = await getEpisodePreviewLimit(env, kind);
  return limit > 0 && number <= limit;
}

async function getSupabaseUser(env, authHeader) {
  if (!/^Bearer\s+\S+/i.test(String(authHeader || ""))) return null;
  try {
    return await supabaseJson(env, "/auth/v1/user", publicKey(env), authHeader);
  } catch {
    return null;
  }
}

async function verifyWebEntitlement(env, authHeader, kind, row) {
  if (!authHeader) return { ok: false, status: 401, error: "Login is required for protected media." };
  const base = envString(env, "HJ_WEB_BASE_URL");
  if (!base) return { ok: false, status: 503, error: "HJ_WEB_BASE_URL is not configured." };
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
    try { payload = await response.json(); } catch {}
    if (response.ok && payload?.ok) return { ok: true, payload };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, status: response.status, error: String(payload?.error || "Temporary or paid access required.") };
    }
    return { ok: false, status: 503, error: "Protected media entitlement could not be verified." };
  } catch {
    return { ok: false, status: 503, error: "Protected media entitlement could not be verified." };
  }
}

function b64url(value) {
  return Buffer.from(String(value), "utf8").toString("base64url");
}

function createMediaTicket(env, kind, messageId, userId, userAgent) {
  const secret = envString(env, "MEDIA_TICKET_SECRET");
  if (!secret) throw new Error("MEDIA_TICKET_SECRET is not configured.");
  const payload = b64url(JSON.stringify({
    kind,
    messageId: Number(messageId),
    userId: String(userId),
    ua: createHash("sha256").update(String(userAgent || "")).digest("base64url"),
    exp: Date.now() + MEDIA_TICKET_TTL_MS,
  }));
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return payload + "." + signature;
}

function verifyMediaTicket(env, token, kind, messageId, userAgent) {
  const secret = envString(env, "MEDIA_TICKET_SECRET");
  if (!secret || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const payload = parts[0];
  const signature = parts[1];
  const expected = createHmac("sha256", secret).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (value.kind !== kind || Number(value.messageId) !== Number(messageId)) return null;
    if (!value.userId || Number(value.exp) <= Date.now()) return null;
    const expectedUa = createHash("sha256").update(String(userAgent || "")).digest("base64url");
    const leftUa = Buffer.from(String(value.ua || ""));
    const rightUa = Buffer.from(expectedUa);
    if (leftUa.length !== rightUa.length || !timingSafeEqual(leftUa, rightUa)) return null;
    return value;
  } catch {
    return null;
  }
}

async function inspectMediaAccess(env, request, kind, messageId) {
  const ticket = String(new URL(request.url).searchParams.get("ticket") || "").trim();
  const ticketUser = verifyMediaTicket(
    env,
    ticket,
    kind,
    messageId,
    request.headers.get("user-agent") || ""
  );
  if (ticketUser) return { ok: true, viaTicket: true, userId: ticketUser.userId };

  const policyResult = await lookupMediaPolicy(env, kind, messageId);
  if (policyResult.error) {
    return { ok: false, status: 503, error: "Media access policy could not be verified." };
  }
  const row = policyResult.row;
  if (!row) return { ok: false, status: 404, error: "Media record was not found in the content database." };
  if (row.available === false) return { ok: false, status: 403, error: "This media is unavailable." };
  if (!isProtectedPolicy(row)) return { ok: true, viaTicket: false, row };
  if (await isFreeEpisodePreview(env, kind, row)) return { ok: true, viaTicket: false, viaPreview: true, row };

  const authHeader = String(request.headers.get("authorization") || "").trim();
  if (!authHeader) return { ok: false, status: 401, error: "Login is required for protected media." };

  const entitlement = await verifyWebEntitlement(env, authHeader, kind, row);
  if (!entitlement.ok) return entitlement;
  const user = await getSupabaseUser(env, authHeader);
  if (!user?.id) return { ok: false, status: 401, error: "Invalid or expired login session." };
  return { ok: true, viaTicket: false, row, user };
}

async function botApiGetFile(env, fileId) {
  required(env, ["TELEGRAM_BOT_TOKEN"]);
  const token = envString(env, "TELEGRAM_BOT_TOKEN");
  const response = await fetch(
    "https://api.telegram.org/bot" + token + "/getFile",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ file_id: String(fileId) }),
    }
  );
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok || !payload?.ok || !payload?.result?.file_path) {
    const error = new Error(
      String(payload?.description || "Telegram Bot API getFile failed").slice(0, 300)
    );
    error.statusCode = response.status || 502;
    throw error;
  }
  return payload.result;
}

async function telegramFileResponse(env, filePath, request, range) {
  const token = envString(env, "TELEGRAM_BOT_TOKEN");
  const headers = new Headers();
  if (range?.requested) {
    headers.set("Range", "bytes=" + range.start + "-" + range.end);
  }
  const response = await fetch(
    "https://api.telegram.org/file/bot" + token + "/" + filePath,
    { headers, redirect: "follow" }
  );
  return response;
}

function mediaHeaders(indexed, kind, range, requestOrigin, env) {
  const headers = new Headers();
  const filename = String(indexed.file_name || inferFilename({ attributes: [] }, kind));
  const asciiName = safeAsciiFilename(
    filename,
    kind === "video" ? "video.mp4" : kind === "document" ? "document" : "audio.m4a"
  );
  const mimeType = inferMimeType(
    {
      mimeType: indexed.mime_type,
      attributes: [{ className: "DocumentAttributeFilename", fileName: filename }],
    },
    kind
  );
  headers.set("Content-Type", mimeType);
  headers.set("Accept-Ranges", "bytes");
  headers.set(
    "Content-Disposition",
    "inline; filename=\"" + asciiName + "\"; filename*=UTF-8''" + encodeDispositionFilename(filename)
  );
  headers.set("Cache-Control", "private, no-store");
  headers.set("ETag", "\"tg-" + kind + "-" + (indexed.original_telegram_message_id || messageId) + "-" + indexed.file_size + "\"");
  headers.set("X-HJ-Telegram-Source", "bot-api");
  if (range.partial) {
    headers.set("Content-Range", "bytes " + range.start + "-" + range.end + "/" + indexed.file_size);
    headers.set("Content-Length", String(range.length));
  } else {
    headers.set("Content-Length", String(indexed.file_size));
  }
  applyCors(headers, requestOrigin, env);
  return headers;
}

function responseHeadersFromUpstream(upstream, fallback) {
  const headers = new Headers(fallback);
  for (const key of ["content-type", "content-length", "content-range", "last-modified", "etag", "accept-ranges"]) {
    const value = upstream.headers.get(key);
    if (value) headers.set(key, value);
  }
  return headers;
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

async function getIndexedMediaParts(env, kind, messageId) {
  const params = new URLSearchParams({
    select:
      "content_kind,content_id,source_group,part_index,part_count," +
      "original_telegram_message_id,source_telegram_message_id,media_kind," +
      "file_id,file_unique_id,file_name,mime_type,file_size,assembled_file_size," +
      "duration,width,height,verified_at,updated_at",
    original_telegram_message_id: "eq." + String(messageId),
    media_kind: "eq." + String(kind),
    order: "part_index.asc",
  });
  const rows = await supabaseJson(
    env,
    "/rest/v1/streaming_media_sources?" + params.toString(),
    serverKey(env)
  );
  return Array.isArray(rows) ? rows : [];
}

function validateMediaParts(parts, kind, messageId) {
  if (!parts.length) {
    return { ok: false, status: 404, error: "Media source mapping was not found." };
  }

  const expectedCount = Number(parts[0]?.part_count || 0);
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
    return { ok: false, status: 500, error: "Media mapping has an invalid part count." };
  }

  if (expectedCount !== parts.length) {
    return {
      ok: false,
      status: 503,
      error: "Media mapping is incomplete; not all verified parts are available.",
    };
  }

  let assembledSize = Number(parts[0]?.assembled_file_size || 0);
  let total = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (Number(part.part_count) !== expectedCount || Number(part.part_index) !== index) {
      return { ok: false, status: 503, error: "Media mapping part order/count is invalid." };
    }
    if (
      Number(part.original_telegram_message_id) !== Number(messageId) ||
      String(part.media_kind) !== String(kind)
    ) {
      return { ok: false, status: 503, error: "Media mapping identity is inconsistent." };
    }

    const sourceMessageId = Number(part.source_telegram_message_id);
    const fileSize = Number(part.file_size || 0);
    const fileId = String(part.file_id || "").trim();
    if (!Number.isSafeInteger(sourceMessageId) || sourceMessageId <= 0 || !fileId) {
      return { ok: false, status: 503, error: "Media mapping contains an invalid Telegram source." };
    }
    if (!Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > 19 * 1024 * 1024) {
      return { ok: false, status: 503, error: "Media mapping contains an unsupported chunk size." };
    }

    if (index === 0 && (!Number.isSafeInteger(assembledSize) || assembledSize <= 0)) {
      return { ok: false, status: 503, error: "Media mapping is missing the assembled file size." };
    }

    total += fileSize;
  }

  if (total !== assembledSize) {
    return {
      ok: false,
      status: 503,
      error: "Media mapping chunk sizes do not equal the assembled file size.",
    };
  }

  return { ok: true, assembledSize };
}

async function telegramPartResponse(env, part, localStart = null, localEnd = null) {
  const fileInfo = await botApiGetFile(env, part.file_id);
  const headers = new Headers();
  const range = localStart != null && localEnd != null
    ? {
        start: Number(localStart),
        end: Number(localEnd),
        requested: true,
      }
    : {
        start: 0,
        end: Number(part.file_size) - 1,
        requested: false,
      };

  return telegramFileResponse(env, fileInfo.file_path, new Request("https://worker.invalid/", {
    method: "GET",
    headers: range.requested
      ? { Range: "bytes=" + range.start + "-" + range.end }
      : {},
  }), range);
}

async function sliceReadableBody(body, skipBytes, outputBytes) {
  if (!body) throw new Error("Telegram response has no body.");
  const reader = body.getReader();
  let skip = Math.max(0, Number(skipBytes) || 0);
  let remaining = Math.max(0, Number(outputBytes) || 0);

  return new ReadableStream({
    async start(controller) {
      try {
        while (remaining > 0) {
          const { done, value } = await reader.read();
          if (done) {
            throw new Error("Telegram response ended before the requested byte range was available.");
          }
          let chunk = value instanceof Uint8Array ? value : new Uint8Array(value);

          if (skip > 0) {
            const consume = Math.min(skip, chunk.byteLength);
            skip -= consume;
            chunk = chunk.subarray(consume);
          }

          if (!chunk.byteLength) continue;

          const emit = Math.min(remaining, chunk.byteLength);
          controller.enqueue(chunk.subarray(0, emit));
          remaining -= emit;

          if (emit < chunk.byteLength) {
            break;
          }
        }

        await reader.cancel().catch(() => {});
        controller.close();
      } catch (error) {
        await reader.cancel().catch(() => {});
        controller.error(error);
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => {});
    },
  });
}

function splitMediaStream(env, parts, range) {
  return new ReadableStream({
    async start(controller) {
      try {
        let cursor = 0;

        for (const part of parts) {
          const partSize = Number(part.file_size);
          const partStart = cursor;
          const partEnd = cursor + partSize - 1;
          cursor += partSize;

          if (range.requested && (range.end < partStart || range.start > partEnd)) {
            continue;
          }

          const overlapStart = range.requested
            ? Math.max(range.start, partStart)
            : partStart;
          const overlapEnd = range.requested
            ? Math.min(range.end, partEnd)
            : partEnd;

          const localStart = overlapStart - partStart;
          const localLength = overlapEnd - overlapStart + 1;
          const upstream = await telegramPartResponse(
            env,
            part,
            range.requested ? localStart : null,
            range.requested ? localStart + localLength - 1 : null
          );

          if (!upstream.ok) {
            throw new Error(
              "Telegram chunk " +
                String(part.part_index) +
                " download failed with HTTP " +
                String(upstream.status)
            );
          }

          if (range.requested && upstream.status === 206) {
            const reader = upstream.body?.getReader();
            if (!reader) throw new Error("Telegram chunk returned no body.");
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) controller.enqueue(value);
              }
            } finally {
              reader.releaseLock();
            }
          } else {
            const sliced = await sliceReadableBody(
              upstream.body,
              range.requested ? localStart : 0,
              localLength
            );
            const reader = sliced.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) controller.enqueue(value);
              }
            } finally {
              reader.releaseLock();
            }
          }
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

function mediaCacheKey(kind, indexed, assembledSize) {
  return (
    "media/" +
    String(kind) +
    "/" +
    String(indexed.original_telegram_message_id) +
    "/" +
    encodeURIComponent(
      String(indexed.source_group || indexed.source_telegram_message_id || indexed.file_id || "source")
    ) +
    "-" +
    String(assembledSize)
  );
}

async function handleMedia(request, env, kind, messageId, ctx) {{
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
    return mediaError(403, "SECURE_TICKET_REQUIRED", request.headers.get("origin") || "", env);
  }

  const origin = request.headers.get("origin") || "";
  try {
    const parts = await getIndexedMediaParts(env, kind, Number(messageId));
    const validation = validateMediaParts(parts, kind, Number(messageId));
    if (!validation.ok) {
      return mediaError(
        validation.status || 503,
        "MEDIA_MAPPING_INVALID",
        origin,
        env,
        validation.error
      );
    }

    const indexed = parts[0];
    const size = validation.assembledSize;

    const range = parseSingleRange(
      request.headers.get("range"),
      size,
      1024 * 1024
    );
    if (range.error) {
      const headers = new Headers({
        "Content-Range": "bytes */" + size,
        "Accept-Ranges": "bytes",
      });
      applyCors(headers, origin, env);
      return new Response(null, { status: 416, headers });
    }

    const headers = mediaHeaders(indexed, kind, range, origin, env);
    if (request.method === "HEAD") {
      return new Response(null, {
        status: range.requested ? 206 : 200,
        headers,
      });
    }

    const cacheKey = mediaCacheKey(kind, indexed, size);

    // R2 is the first media source. Telegram is contacted only after an R2 MISS.
    if (env.MEDIA_CACHE) {
      try {
        const cached = await env.MEDIA_CACHE.get(cacheKey, {
          range: request.headers,
        });
        if (cached?.body) {
          const cachedHeaders = new Headers();
          cached.writeHttpMetadata(cachedHeaders);
          cachedHeaders.set("ETag", cached.httpEtag);
          cachedHeaders.set("Accept-Ranges", "bytes");
          cachedHeaders.set("X-HJ-Telegram-Source", "r2-cache");
          applyCors(cachedHeaders, origin, env);

          if (cached.range) {
            const offset = Number(cached.range.offset || 0);
            const length = Number(cached.range.length || cached.size);
            cachedHeaders.set(
              "Content-Range",
              "bytes " +
                offset +
                "-" +
                (offset + length - 1) +
                "/" +
                cached.size
            );
            cachedHeaders.set("Content-Length", String(length));
            return new Response(cached.body, { status: 206, headers: cachedHeaders });
          }

          cachedHeaders.set("Content-Length", String(cached.size));
          return new Response(cached.body, { status: 200, headers: cachedHeaders });
        }
      } catch (error) {
        console.warn(
          "HJ R2 cache read failed",
          String(error?.message || error).slice(0, 180)
        );
      }
    }

    if (parts.length === 1) {
      let fileInfo;
      try {
        fileInfo = await botApiGetFile(env, indexed.file_id);
      } catch (firstError) {
        return mediaError(
          Number(firstError.statusCode) === 400 ? 404 : 502,
          "TELEGRAM_FILE_LOOKUP_FAILED",
          origin,
          env,
          firstError.message
        );
      }

      let upstream = await telegramFileResponse(env, fileInfo.file_path, request, range);
      if (!upstream.ok) {
        try {
          fileInfo = await botApiGetFile(env, indexed.file_id);
          upstream = await telegramFileResponse(env, fileInfo.file_path, request, range);
        } catch {}
      }

      if (!upstream.ok) {
        return mediaError(
          upstream.status || 502,
          "TELEGRAM_FILE_DOWNLOAD_FAILED",
          origin,
          env,
          "Telegram file delivery failed."
        );
      }

      let responseBody = upstream.body;
      let responseStatus = upstream.status;
      let responseHeaders = responseHeadersFromUpstream(upstream, headers);
      if (range.requested) {
        responseStatus = 206;
        responseHeaders.set("Content-Range", "bytes " + range.start + "-" + range.end + "/" + size);
        responseHeaders.set("Content-Length", String(range.length));
        responseHeaders.set(
          "X-HJ-Telegram-Range",
          upstream.status === 206 ? "206" : "sliced-from-200"
        );
        if (upstream.status === 200) {
          responseBody = await sliceReadableBody(upstream.body, range.start, range.length);
        }
      } else {
        responseHeaders.set("X-HJ-Telegram-Range", upstream.status === 206 ? "206" : "full");
        responseStatus = upstream.status;
      }

      if (
        env.MEDIA_CACHE &&
        ctx &&
        responseStatus === 200 &&
        !range.requested &&
        upstream.body
      ) {
        ctx.waitUntil(
          (async () => {
            try {
              if (await env.MEDIA_CACHE.head(cacheKey)) return;
              const cacheBody = upstream.clone().body;
              if (!cacheBody) return;
              await env.MEDIA_CACHE.put(cacheKey, cacheBody, {
                httpMetadata: {
                  contentType: indexed.mime_type || "application/octet-stream",
                  contentDisposition: responseHeaders.get("Content-Disposition") || "inline",
                  cacheControl: "private, no-store",
                },
                customMetadata: {
                  original_message_id: String(messageId),
                  source_message_id: String(indexed.source_telegram_message_id || messageId),
                  media_kind: String(kind),
                  uploaded_at: String(Date.now()),
                },
              });
            } catch (error) {
              console.warn(
                "HJ R2 cache write failed",
                String(error?.message || error).slice(0, 180)
              );
            }
          })()
        );
      }

      return new Response(responseBody, {
        status: responseStatus,
        headers: responseHeaders,
      });
    }

    // Multi-part source: stream the verified Telegram chunks in order and expose
    // the concatenated bytes as the original file. No source file is rewritten.
    const assembledStream = splitMediaStream(env, parts, range);
    let responseBody = assembledStream;
    let responseStatus = range.requested ? 206 : 200;

    if (env.MEDIA_CACHE && ctx && !range.requested) {
      const [clientStream, cacheStream] = assembledStream.tee();
      responseBody = clientStream;
      ctx.waitUntil(
        (async () => {
          try {
            if (await env.MEDIA_CACHE.head(cacheKey)) return;
            await env.MEDIA_CACHE.put(cacheKey, cacheStream, {
              httpMetadata: {
                contentType: indexed.mime_type || "application/octet-stream",
                contentDisposition: headers.get("Content-Disposition") || "inline",
                cacheControl: "private, no-store",
              },
              customMetadata: {
                original_message_id: String(messageId),
                source_group: String(indexed.source_group || ""),
                part_count: String(parts.length),
                media_kind: String(kind),
                uploaded_at: String(Date.now()),
              },
            });
          } catch (error) {
            console.warn(
              "HJ R2 assembled cache write failed",
              String(error?.message || error).slice(0, 180)
            );
          }
        })()
      );
    }

    return new Response(responseBody, {
      status: responseStatus,
      headers,
    });
  } catch (error) {
    console.error("HJ Bot API media error", {
      kind,
      messageId: Number(messageId),
      error: String(error?.message || error).slice(0, 220),
    });
    return mediaError(
      502,
      "MEDIA_STREAM_ERROR",
      origin,
      env,
      error?.message || error
    );
  }
}
async function handleMediaTicket(request, env) {
  const url = new URL(request.url);
  const type = String(url.pathname.split("/")[2] || "").toLowerCase();
  const messageId = parseMessageId(url.pathname.split("/").pop());
  if (!["audio", "video", "document"].includes(type) || !messageId) {
    return jsonResponse({ error: "INVALID_MEDIA_TICKET_REQUEST" }, 400, request.headers.get("origin") || "", env);
  }

  try {
    const access = await inspectMediaAccess(env, request, type, messageId);
    if (!access.ok) {
      return mediaError(access.status || 403, "MEDIA_ACCESS_DENIED", request.headers.get("origin") || "", env, access.error);
    }
    if (!access.row || !isProtectedPolicy(access.row)) {
      return jsonResponse({ error: "Media is not protected" }, 400, request.headers.get("origin") || "", env);
    }
    const userId = String(access.user?.id || access.userId || "").trim();
    if (!userId) {
      return jsonResponse({ error: "Login is required for premium/VIP media." }, 401, request.headers.get("origin") || "", env);
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
      "?ticket=" + encodeURIComponent(token);
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
    return jsonResponse({ error: "MEDIA_TICKET_ERROR" }, 503, request.headers.get("origin") || "", env);
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
    const params = new URLSearchParams({
      select:
        "original_telegram_message_id,source_telegram_message_id,file_name," +
        "mime_type,file_size,assembled_file_size,duration,width,height,updated_at",
      media_kind: "eq." + mediaType,
      part_index: "eq.0",
      order: "original_telegram_message_id.desc",
      limit: String(limit),
    });
    if (offsetId > 0) {
      params.set("original_telegram_message_id", "lt." + String(offsetId));
    }

    const rows = await supabaseJson(
      env,
      "/rest/v1/streaming_media_sources?" + params.toString(),
      serverKey(env)
    );

    const mediaMessages = Array.isArray(rows)
      ? rows.map((row) => ({
          messageId: Number(row.original_telegram_message_id),
          sourceMessageId: Number(row.source_telegram_message_id),
          fileName:
            row.file_name ||
            (mediaType === "video"
              ? "video.mp4"
              : mediaType === "document"
                ? "book.pdf"
                : "audio.m4a"),
          mimeType: row.mime_type || "",
          size: Number(row.assembled_file_size || row.file_size || 0),
          duration: Number(row.duration || 0),
          width: Number(row.width || 0),
          height: Number(row.height || 0),
          date: row.updated_at || null,
        }))
      : [];

    const nextOffsetId =
      mediaMessages.length >= limit
        ? Number(mediaMessages[mediaMessages.length - 1]?.messageId || 0)
        : 0;

    const headers = new Headers();
    applyCors(headers, origin, env);
    headers.set("Cache-Control", "no-store");
    headers.set(
      "X-HJ-Telegram-Next-Offset",
      nextOffsetId ? String(nextOffsetId) : ""
    );
    headers.set("X-HJ-Telegram-Has-More", nextOffsetId ? "true" : "false");
    headers.set("Content-Type", "application/json; charset=utf-8");

    return new Response(JSON.stringify(mediaMessages), {
      status: 200,
      headers,
    });
  } catch (error) {
    return jsonResponse(
      {
        error: "TELEGRAM_MESSAGES_ERROR",
        detail: String(error?.message || error)
          .replace(/[\r\n]+/g, " ")
          .slice(0, 180),
      },
      503,
      origin,
      env
    );
  }
}

async function handleTelegramStatus(request, env) {
  const requiredKeys = [
    "TELEGRAM_BOT_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  const missing = requiredKeys.filter((key) => !envString(env, key));
  const configured = missing.length === 0;
  return jsonResponse(
    {
      ok: configured,
      telegramConfigured: Boolean(envString(env, "TELEGRAM_BOT_TOKEN")),
      botApiStreaming: true,
      streamingMediaMappingConfigured: configured,
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
      if (method !== "GET" && method !== "HEAD") {
        return jsonResponse({ error: "METHOD_NOT_ALLOWED" }, 405, origin, env);
      }

      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      if (parts.length === 0 || url.pathname === "/health") {
        return jsonResponse(
          {
            status: "ok",
            service: "hj-telegram-streaming-cloudflare",
            directTelegram: false,
            botApiStreaming: true,
          },
          200,
          origin,
          env
        );
      }
      if (url.pathname === "/telegram/status") return handleTelegramStatus(request, env);
      if (url.pathname === "/telegram/messages") return handleTelegramMessages(request, env);

      if (
        parts.length === 4 &&
        parts[0] === "media-ticket" &&
        parts[2] === "message"
      ) {
        return handleMediaTicket(request, env);
      }

      if (
        parts.length === 3 &&
        ["audio", "video", "document"].includes(parts[0]) &&
        parts[1] === "message"
      ) {
        return handleMedia(request, env, parts[0], parts[2], ctx);
      }

      return jsonResponse({ error: "NOT_FOUND" }, 404, origin, env);
    } catch (error) {
      console.error("HJ Worker unhandled error", String(error?.message || error).slice(0, 200));
      return jsonResponse({ error: "INTERNAL_SERVER_ERROR" }, 500, origin, env);
    }
  },
};
