import {
  MEDIA_CACHE_PREFIX,
  MEDIA_TICKET_TTL_MS,
  MAX_CHUNKS_PER_REQUEST,
  TELEGRAM_BOT_GETFILE_LIMIT_BYTES,
  TELEGRAM_CHUNK_LIMIT_BYTES,
  chunkRangePlan,
  encodeDispositionFilename,
  errorPayload,
  inferFilename,
  inferMimeType,
  normalizeOriginList,
  parseMessageId,
  parseSingleRange,
  safeAsciiFilename,
  safeKeyPart,
} from "./pure.js";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://hj-groups-web.pages.dev",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const CONTENT_TYPES = new Set(["audio", "video", "document"]);
const LISTENER_PATHS = new Set([
  "/listener/start",
  "/listener/heartbeat",
  "/listener/end",
]);

function envString(env, key, fallback = "") {
  const value = env?.[key];
  return value == null ? fallback : String(value).trim();
}

function required(env, keys) {
  const missing = keys.filter((key) => !envString(env, key));
  if (missing.length) {
    throw new Error("Missing required environment variables: " + missing.join(", "));
  }
}

function logEvent(event, fields = {}) {
  try {
    console.log(JSON.stringify({
      service: "hj-telegram-streaming",
      event,
      at: new Date().toISOString(),
      ...fields,
    }));
  } catch {}
}

function logFailure(event, error, fields = {}) {
  logEvent(event, {
    ...fields,
    error: String(error?.message || error || "unknown error")
      .replace(/[\r\n]+/g, " ")
      .slice(0, 220),
  });
}

function publicKey(env) {
  required(env, ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY"]);
  return envString(env, "SUPABASE_PUBLISHABLE_KEY");
}

function mediaIndexUrl(env) {
  const value =
    envString(env, "MEDIA_INDEX_SUPABASE_URL") ||
    envString(env, "SUPABASE_URL");
  if (!value) {
    throw new Error("Missing MEDIA_INDEX_SUPABASE_URL or SUPABASE_URL.");
  }
  return value;
}

function mediaIndexKey(env) {
  const value =
    envString(env, "MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY") ||
    envString(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!value) {
    throw new Error(
      "Missing MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY."
    );
  }
  return value;
}

function episodeChunksUrl(env) {
  return (
    envString(env, "EPISODE_CHUNKS_SUPABASE_URL") ||
    envString(env, "SUPABASE_URL")
  );
}

function episodeChunksKey(env) {
  return (
    envString(env, "EPISODE_CHUNKS_SUPABASE_SERVICE_ROLE_KEY") ||
    envString(env, "SUPABASE_SERVICE_ROLE_KEY")
  );
}

async function supabaseJson(
  env,
  pathname,
  key,
  authHeader = "",
  baseOverride = ""
) {
  const base = String(
    baseOverride || envString(env, "SUPABASE_URL")
  ).trim();
  if (!base) throw new Error("Missing SUPABASE_URL.");

  const headers = {
    apikey: key,
    Accept: "application/json",
  };
  if (authHeader) headers.Authorization = authHeader;

  const response = await fetch(
    base.replace(/\/+$/, "") + pathname,
    { headers }
  );

  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  if (!response.ok) {
    const error = new Error(
      "Supabase HTTP " +
      response.status +
      (payload?.message
        ? ": " + String(payload.message).slice(0, 220)
        : "")
    );
    error.statusCode = response.status;
    error.supabasePayload = payload;
    throw error;
  }

  return payload;
}

async function mediaIndexJson(env, pathname) {
  return supabaseJson(
    env,
    pathname,
    mediaIndexKey(env),
    "",
    mediaIndexUrl(env)
  );
}

async function getIndexedMedia(env, kind, messageId) {
  const params = new URLSearchParams({
    select:
      "storage_chat_id,telegram_message_id,media_kind,file_id,file_unique_id,file_name,mime_type,file_size,duration,width,height,updated_at",
    telegram_message_id: "eq." + String(messageId),
    media_kind: "eq." + String(kind),
    limit: "1",
  });

  const storageChatId = Number(envString(env, "STORAGE_CHAT_ID"));
  if (Number.isSafeInteger(storageChatId) && storageChatId !== 0) {
    params.set("storage_chat_id", "eq." + String(storageChatId));
  }

  const rows = await mediaIndexJson(
    env,
    "/rest/v1/telegram_media_index?" + params.toString()
  );

  return Array.isArray(rows) ? rows[0] || null : null;
}

async function getEpisodeChunks(env, kind, contentId) {
  if (!["audio", "video"].includes(kind) || !Number.isSafeInteger(contentId)) {
    return { present: false, chunks: [], totalSize: 0, error: null };
  }

  const base = episodeChunksUrl(env);
  const key = episodeChunksKey(env);
  if (!base || !key) {
    return { present: false, chunks: [], totalSize: 0, error: null };
  }

  const params = new URLSearchParams({
    select: "episode_id,idx,telegram_file_id,file_unique_id,size,sha256",
    episode_id: "eq." + String(contentId),
    order: "idx.asc",
    limit: "100",
  });

  try {
    const rows = await supabaseJson(
      env,
      "/rest/v1/episode_chunks?" + params.toString(),
      key,
      "",
      base
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return { present: false, chunks: [], totalSize: 0, error: null };
    }

    const chunks = rows
      .map((row) => ({
        episodeId: Number(row.episode_id),
        idx: Number(row.idx),
        telegramFileId: String(row.telegram_file_id || "").trim(),
        fileUniqueId: String(row.file_unique_id || "").trim(),
        size: Number(row.size),
        sha256: String(row.sha256 || "").trim().toLowerCase(),
      }))
      .sort((a, b) => a.idx - b.idx);

    const seen = new Set();
    let totalSize = 0;

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      if (
        chunk.episodeId !== contentId ||
        !Number.isInteger(chunk.idx) ||
        chunk.idx < 0 ||
        seen.has(chunk.idx) ||
        chunk.idx !== i ||
        !chunk.telegramFileId ||
        !chunk.fileUniqueId ||
        !Number.isSafeInteger(chunk.size) ||
        chunk.size <= 0 ||
        chunk.size > TELEGRAM_CHUNK_LIMIT_BYTES ||
        !/^[a-f0-9]{64}$/i.test(chunk.sha256)
      ) {
        return {
          present: true,
          chunks: [],
          totalSize: 0,
          error: new Error("Invalid episode_chunks row."),
        };
      }
      seen.add(chunk.idx);
      totalSize += chunk.size;
      if (!Number.isSafeInteger(totalSize)) {
        return {
          present: true,
          chunks: [],
          totalSize: 0,
          error: new Error("episode_chunks total size is invalid."),
        };
      }
    }

    return { present: true, chunks, totalSize, error: null };
  } catch (error) {
    const status = Number(error?.statusCode || 0);
    const message = String(error?.message || "");
    if (
      status === 404 ||
      /PGRST205|relation .*episode_chunks.*does not exist|schema cache/i.test(
        message
      )
    ) {
      return { present: false, chunks: [], totalSize: 0, error: null };
    }
    return { present: false, chunks: [], totalSize: 0, error };
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
  return (
    types.includes("premium") ||
    types.includes("vip") ||
    types.includes("ads")
  );
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
      "/rest/v1/" + table + "?" + params.toString(),
      publicKey(env)
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
  const key =
    kind === "video"
      ? "video_free_episodes"
      : "audio_free_episodes";

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

    return Math.max(
      0,
      Number(Array.isArray(rows) ? rows[0]?.[key] : 0) || 0
    );
  } catch {
    return 0;
  }
}

function episodeNumberForPolicy(kind, row) {
  return Number(
    kind === "video"
      ? row?.number
      : row?.number ?? row?.episode_number
  );
}

async function isFreeEpisodePreview(env, kind, row) {
  if (!["audio", "video"].includes(kind)) return false;

  const types = parseAccessTypes(row?.access_type);
  if (!types.some((type) =>
    ["premium", "vip", "ads"].includes(type)
  )) {
    return false;
  }

  const number = episodeNumberForPolicy(kind, row);
  if (!Number.isInteger(number) || number <= 0) return false;

  const limit = await getEpisodePreviewLimit(env, kind);
  return limit > 0 && number <= limit;
}

async function getSupabaseUser(env, authHeader) {
  if (!/^Bearer\s+\S+/i.test(String(authHeader || ""))) return null;
  try {
    return await supabaseJson(
      env,
      "/auth/v1/user",
      publicKey(env),
      authHeader
    );
  } catch {
    return null;
  }
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
    return {
      ok: false,
      status: 400,
      error: "Media record is invalid.",
    };
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

    if (response.ok && payload?.ok) {
      return { ok: true, payload };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        error: String(
          payload?.error ||
          "Temporary or paid access required."
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

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded =
    String(value || "").replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (String(value || "").length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64Url(value) {
  return bytesToBase64Url(
    new TextEncoder().encode(String(value))
  );
}

function decodeBase64Url(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

async function hmacSign(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(String(value))
    )
  );
}

async function hmacVerify(secret, value, signatureBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    new TextEncoder().encode(String(value))
  );
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value))
  );
  return bytesToBase64Url(digest);
}

async function sha256Hex(value) {
  const input =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", input)
  );
  return Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function createMediaTicket(env, kind, messageId, userId, userAgent) {
  const secret = envString(env, "MEDIA_TICKET_SECRET");
  if (!secret) throw new Error("MEDIA_TICKET_SECRET is not configured.");

  const payload = encodeBase64Url(
    JSON.stringify({
      kind,
      messageId: Number(messageId),
      userId: String(userId),
      ua: await sha256Base64Url(String(userAgent || "")),
      exp: Date.now() + MEDIA_TICKET_TTL_MS,
    })
  );
  const signature = bytesToBase64Url(
    await hmacSign(secret, payload)
  );
  return payload + "." + signature;
}

async function verifyMediaTicket(
  env,
  token,
  kind,
  messageId,
  userAgent
) {
  const secret = envString(env, "MEDIA_TICKET_SECRET");
  if (!secret || !token) return null;

  const parts = String(token).split(".");
  if (parts.length !== 2) return null;

  try {
    const verified = await hmacVerify(
      secret,
      parts[0],
      base64UrlToBytes(parts[1])
    );
    if (!verified) return null;

    const value = JSON.parse(decodeBase64Url(parts[0]));
    if (
      value.kind !== kind ||
      Number(value.messageId) !== Number(messageId) ||
      !value.userId ||
      Number(value.exp) <= Date.now()
    ) {
      return null;
    }

    const expectedUa = await sha256Base64Url(
      String(userAgent || "")
    );
    if (String(value.ua || "") !== expectedUa) return null;

    return value;
  } catch {
    return null;
  }
}

async function inspectMediaAccess(env, request, kind, messageId) {
  const ticket = String(
    new URL(request.url).searchParams.get("ticket") || ""
  ).trim();

  const ticketUser = await verifyMediaTicket(
    env,
    ticket,
    kind,
    messageId,
    request.headers.get("user-agent") || ""
  );

  if (ticketUser) {
    const authHeader = String(
      request.headers.get("authorization") || ""
    ).trim();

    if (authHeader) {
      const authUser = await getSupabaseUser(env, authHeader);
      if (!authUser?.id || String(authUser.id) !== String(ticketUser.userId)) {
        return {
          ok: false,
          status: 403,
          error: "Media ticket is bound to a different user.",
        };
      }
    }

    return {
      ok: true,
      viaTicket: true,
      userId: ticketUser.userId,
    };
  }

  const policyResult = await lookupMediaPolicy(
    env,
    kind,
    messageId
  );
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

  const authHeader = String(
    request.headers.get("authorization") || ""
  ).trim();
  if (!authHeader) {
    return {
      ok: false,
      status: 401,
      error: "Login is required for protected media.",
    };
  }

  const entitlement = await verifyWebEntitlement(
    env,
    authHeader,
    kind,
    row
  );
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

function cacheBucket(env) {
  if (!env?.MEDIA_CACHE || typeof env.MEDIA_CACHE.get !== "function") {
    throw new Error("MEDIA_CACHE R2 binding is not configured.");
  }
  return env.MEDIA_CACHE;
}

function buildExpectedMetadata({
  kind,
  messageId,
  contentId,
  sourceIdentity,
  size,
  mimeType,
  fileUniqueId,
  version,
  sha256 = "",
  sourceEtag = "",
}) {
  return {
    complete: "1",
    kind: String(kind),
    messageId: String(messageId),
    contentId: String(contentId || ""),
    sourceIdentity: String(sourceIdentity),
    sourceSize: String(size),
    mimeType: String(mimeType),
    fileUniqueId: String(fileUniqueId || ""),
    version: String(version),
    sha256: String(sha256 || "").toLowerCase(),
    sourceEtag: String(sourceEtag || ""),
  };
}

async function buildMediaDescriptor(kind, messageId, indexed, policyRow) {
  const size = Number(indexed?.file_size);
  const contentId = Number(policyRow?.id) || 0;
  const fileUniqueId = String(
    indexed?.file_unique_id || ""
  ).trim();

  const sourceIdentity = fileUniqueId
    ? "file_unique_id:" + fileUniqueId
    : "telegram:" +
      String(indexed?.storage_chat_id || "unknown") +
      ":" +
      String(messageId) +
      ":" +
      String(kind);

  const mimeType = inferMimeType(
    {
      mimeType: indexed?.mime_type,
      attributes: [
        {
          className: "DocumentAttributeFilename",
          fileName: indexed?.file_name || "",
        },
      ],
    },
    kind
  );

  const versionInput = [
    "v3",
    kind,
    messageId,
    contentId,
    sourceIdentity,
    String(indexed?.file_id || ""),
    size,
    mimeType,
    String(indexed?.updated_at || "0"),
  ].join("|");

  const version = await sha256Hex(versionInput);
  const key = [
    MEDIA_CACHE_PREFIX + "media",
    safeKeyPart(kind),
    safeKeyPart(sourceIdentity),
    String(size),
    version,
    "media",
  ].join("/");

  return {
    key,
    kind,
    messageId: Number(messageId),
    contentId,
    sourceIdentity,
    fileUniqueId,
    size,
    mimeType,
    version,
    filename: String(
      indexed?.file_name ||
      inferFilename(
        { attributes: [] },
        kind
      )
    ),
    fileId: String(indexed?.file_id || "").trim(),
  };
}

async function buildChunkDescriptor(kind, messageId, contentId, chunk, mimeType) {
  const version = await sha256Hex(
    [
      "v3-chunk",
      kind,
      messageId,
      contentId,
      chunk.episodeId,
      chunk.idx,
      chunk.fileUniqueId,
      chunk.size,
      chunk.sha256,
    ].join("|")
  );

  const key = [
    MEDIA_CACHE_PREFIX + "chunk",
    String(contentId),
    String(chunk.idx),
    safeKeyPart(chunk.fileUniqueId),
    String(chunk.size),
    version,
    "chunk",
  ].join("/");

  return {
    key,
    kind,
    messageId: Number(messageId),
    contentId: Number(contentId),
    idx: chunk.idx,
    sourceIdentity:
      "episode:" +
      String(contentId) +
      ":chunk:" +
      String(chunk.idx),
    fileUniqueId: chunk.fileUniqueId,
    fileId: chunk.telegramFileId,
    size: chunk.size,
    mimeType,
    version,
    expectedSha256: chunk.sha256,
  };
}

function cachePutOptions(expected, sourceEtag = "") {
  const customMetadata = {
    ...expected,
    sourceEtag: String(sourceEtag || expected.sourceEtag || ""),
  };

  const options = {
    httpMetadata: {
      contentType: expected.mimeType,
      contentDisposition: "inline",
      cacheControl: "private, no-store",
    },
    customMetadata,
  };

  if (/^[a-f0-9]{64}$/i.test(expected.sha256 || "")) {
    options.sha256 = expected.sha256;
  }

  return options;
}

function checksumHex(value) {
  if (!value) return "";
  if (typeof value === "string") return value.toLowerCase();
  if (value instanceof ArrayBuffer) {
    return Array.from(new Uint8Array(value), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }
  if (ArrayBuffer.isView(value)) {
    return Array.from(new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength
    ), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }
  return "";
}

function validateCacheObject(object, expected) {
  if (!object || !Number.isSafeInteger(object.size)) {
    return { ok: false, reason: "missing" };
  }

  const metadata = object.customMetadata || {};
  const actualType = String(
    object.httpMetadata?.contentType || ""
  ).trim().toLowerCase();

  if (metadata.complete !== "1") {
    return { ok: false, reason: "incomplete" };
  }
  if (object.size !== expected.size) {
    return {
      ok: false,
      reason: "size-mismatch",
      actual: object.size,
    };
  }
  if (
    actualType !== String(expected.mimeType).trim().toLowerCase()
  ) {
    return {
      ok: false,
      reason: "mime-mismatch",
      actual: actualType,
    };
  }

  for (const [key, value] of Object.entries(expected)) {
    if (value === "" || key === "sourceEtag") continue;
    if (String(metadata[key] || "") !== String(value)) {
      return { ok: false, reason: "metadata-mismatch:" + key };
    }
  }

  if (!String(object.etag || "").trim()) {
    return { ok: false, reason: "missing-r2-etag" };
  }

  if (expected.sourceEtag) {
    if (String(metadata.sourceEtag || "") !== expected.sourceEtag) {
      return { ok: false, reason: "source-etag-mismatch" };
    }
  }

  if (expected.sha256) {
    const actualSha = checksumHex(object.checksums?.sha256);
    if (!actualSha || actualSha !== expected.sha256.toLowerCase()) {
      return { ok: false, reason: "sha256-mismatch" };
    }
  }

  return { ok: true };
}

async function getValidatedCache(bucket, descriptor, expected) {
  const object = await bucket.head(descriptor.key);
  if (!object) {
    return { hit: false, object: null, reason: "not-found" };
  }

  const validation = validateCacheObject(object, expected);
  if (!validation.ok) {
    logEvent("cache_mismatch", {
      kind: descriptor.kind,
      messageId: descriptor.messageId,
      cacheKeyHash: await sha256Hex(descriptor.key),
      reason: validation.reason,
    });
    await bucket.delete(descriptor.key).catch(() => {});
    return { hit: false, object: null, reason: validation.reason };
  }

  logEvent("cache_hit", {
    kind: descriptor.kind,
    messageId: descriptor.messageId,
    cacheKeyHash: await sha256Hex(descriptor.key),
    size: descriptor.size,
    chunkIndex:
      Number.isInteger(descriptor.idx) ? descriptor.idx : null,
  });

  return { hit: true, object, reason: "validated" };
}

async function writeCacheAtomically(bucket, descriptor, body, expected) {
  if (!body) throw new Error("Source stream body is missing.");

  const tempKey =
    descriptor.key +
    ".tmp-" +
    crypto.randomUUID();

  logEvent("r2_write", {
    phase: "temp_begin",
    kind: descriptor.kind,
    messageId: descriptor.messageId,
    chunkIndex:
      Number.isInteger(descriptor.idx) ? descriptor.idx : null,
    cacheKeyHash: await sha256Hex(descriptor.key),
    size: descriptor.size,
  });

  try {
    await bucket.put(
      tempKey,
      body,
      cachePutOptions(expected)
    );

    const tempHead = await bucket.head(tempKey);
    const tempValidation = validateCacheObject(
      tempHead,
      expected
    );
    if (!tempValidation.ok) {
      throw new Error(
        "Temporary R2 cache validation failed: " +
        tempValidation.reason
      );
    }

    const tempObject = await bucket.get(tempKey);
    if (!tempObject?.body) {
      throw new Error("Temporary R2 cache body is unavailable.");
    }

    await bucket.put(
      descriptor.key,
      tempObject.body,
      cachePutOptions(expected)
    );

    const finalHead = await bucket.head(descriptor.key);
    const finalValidation = validateCacheObject(
      finalHead,
      expected
    );
    if (!finalValidation.ok) {
      throw new Error(
        "Final R2 cache validation failed: " +
        finalValidation.reason
      );
    }

    logEvent("r2_write", {
      phase: "complete",
      kind: descriptor.kind,
      messageId: descriptor.messageId,
      chunkIndex:
        Number.isInteger(descriptor.idx) ? descriptor.idx : null,
      cacheKeyHash: await sha256Hex(descriptor.key),
      size: descriptor.size,
    });

    return finalHead;
  } finally {
    await bucket.delete(tempKey).catch(() => {});
  }
}

async function botApiGetFile(env, fileId) {
  required(env, ["TELEGRAM_BOT_TOKEN"]);
  const token = envString(env, "TELEGRAM_BOT_TOKEN");

  const response = await fetch(
    "https://api.telegram.org/bot" +
    token +
    "/getFile",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        file_id: String(fileId),
      }),
    }
  );

  let payload = null;
  try {
    payload = await response.json();
  } catch {}

  if (
    !response.ok ||
    !payload?.ok ||
    !payload?.result?.file_path
  ) {
    const description = String(
      payload?.description ||
      "Telegram Bot API getFile failed"
    ).slice(0, 300);

    const error = new Error(description);
    error.statusCode = response.status || 502;
    if (/too large|file is too big|20\s*mb/i.test(description)) {
      error.code = "TELEGRAM_FILE_TOO_LARGE";
    }
    throw error;
  }

  return payload.result;
}

async function telegramFileResponse(
  env,
  filePath
) {
  const token = envString(env, "TELEGRAM_BOT_TOKEN");
  return fetch(
    "https://api.telegram.org/file/bot" +
    token +
    "/" +
    filePath,
    {
      redirect: "follow",
    }
  );
}

function contentDispositionHeaders(indexed, kind) {
  const filename = String(
    indexed?.file_name ||
    inferFilename(
      { attributes: [] },
      kind
    )
  );
  const fallback =
    kind === "video"
      ? "video.mp4"
      : kind === "document"
        ? "document"
        : "audio.m4a";

  const asciiName = safeAsciiFilename(
    filename,
    fallback
  );

  return {
    "Content-Disposition":
      "inline; filename=\"" +
      asciiName +
      "\"; filename*=UTF-8''" +
      encodeDispositionFilename(filename),
  };
}

function applyCors(headers, origin, env) {
  const configured = normalizeOriginList(
    envString(env, "CORS_ALLOWED_ORIGINS")
  );
  const allowed = new Set([
    ...DEFAULT_ALLOWED_ORIGINS,
    ...configured,
  ]);

  if (origin && allowed.has(origin)) {
    headers.set(
      "Access-Control-Allow-Origin",
      origin
    );
    headers.set("Vary", "Origin");
  }

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, OPTIONS"
  );
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Cache-Control, Content-Type, Pragma, Range"
  );
  headers.set(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Length, Content-Range, Content-Disposition, Content-Type, ETag, Last-Modified, X-HJ-Telegram-Source, X-HJ-Telegram-Cache, X-HJ-Telegram-Chunked"
  );
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
}

function jsonResponse(data, status, origin, env) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  applyCors(headers, origin, env);
  return new Response(
    JSON.stringify(data),
    { status, headers }
  );
}

function mediaError(
  status,
  code,
  origin,
  env,
  detail = "",
  hint = ""
) {
  return jsonResponse(
    errorPayload(code, detail, hint),
    status,
    origin,
    env
  );
}

function mediaHeaders({
  filename,
  mimeType,
  totalSize,
  range,
  etag,
  source,
  chunked,
  origin,
  env,
}) {
  const headers = new Headers({
    "Content-Type": mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    ETag: etag,
    "X-HJ-Telegram-Source": source,
    "X-HJ-Telegram-Cache": source === "r2-cache" ? "HIT" : "MISS",
    "X-HJ-Telegram-Chunked": chunked ? "true" : "false",
  });

  Object.entries(
    contentDispositionHeaders(
      { file_name: filename },
      "document"
    )
  ).forEach(([key, value]) => headers.set(key, value));

  if (range.partial) {
    headers.set(
      "Content-Range",
      "bytes " +
      range.start +
      "-" +
      range.end +
      "/" +
      totalSize
    );
    headers.set(
      "Content-Length",
      String(range.length)
    );
  } else {
    headers.set(
      "Content-Length",
      String(totalSize)
    );
  }

  applyCors(headers, origin, env);
  return headers;
}

function mediaHeadersByKind({
  indexed,
  kind,
  totalSize,
  range,
  etag,
  source,
  chunked,
  origin,
  env,
}) {
  const filename = String(
    indexed?.file_name ||
    inferFilename({ attributes: [] }, kind)
  );

  const asciiName = safeAsciiFilename(
    filename,
    kind === "video"
      ? "video.mp4"
      : kind === "document"
        ? "document"
        : "audio.m4a"
  );

  const headers = new Headers({
    "Content-Type":
      inferMimeType(
        {
          mimeType: indexed?.mime_type,
          attributes: [
            {
              className: "DocumentAttributeFilename",
              fileName: filename,
            },
          ],
        },
        kind
      ),
    "Accept-Ranges": "bytes",
    "Content-Disposition":
      "inline; filename=\"" +
      asciiName +
      "\"; filename*=UTF-8''" +
      encodeDispositionFilename(filename),
    "Cache-Control": "private, no-store",
    ETag: etag,
    "X-HJ-Telegram-Source": source,
    "X-HJ-Telegram-Cache":
      source === "r2-cache" ? "HIT" : "MISS",
    "X-HJ-Telegram-Chunked": chunked
      ? "true"
      : "false",
  });

  if (range.partial) {
    headers.set(
      "Content-Range",
      "bytes " +
      range.start +
      "-" +
      range.end +
      "/" +
      totalSize
    );
  }

  headers.set(
    "Content-Length",
    String(range.partial ? range.length : totalSize)
  );

  applyCors(headers, origin, env);
  return headers;
}

async function sourceEtagFromResponse(response) {
  return String(
    response?.headers?.get("etag") || ""
  ).trim();
}

async function fetchWholeToCache(
  env,
  descriptor,
  expected
) {
  if (!descriptor.fileId) {
    throw Object.assign(
      new Error("Telegram file_id is missing."),
      { code: "TELEGRAM_FILE_ID_MISSING" }
    );
  }

  let fileInfo;
  try {
    logEvent("telegram_fetch", {
      kind: descriptor.kind,
      messageId: descriptor.messageId,
      mode: "whole",
      size: descriptor.size,
    });
    fileInfo = await botApiGetFile(
      env,
      descriptor.fileId
    );
  } catch (error) {
    if (
      error?.code === "TELEGRAM_FILE_TOO_LARGE"
    ) {
      throw error;
    }
    throw error;
  }

  const telegramReportedSize = Number(
    fileInfo?.file_size || 0
  );

  if (
    Number.isSafeInteger(telegramReportedSize) &&
    telegramReportedSize > TELEGRAM_BOT_GETFILE_LIMIT_BYTES
  ) {
    throw Object.assign(
      new Error(
        "Telegram reports this source is above the cloud Bot API getFile download limit."
      ),
      { code: "TELEGRAM_FILE_TOO_LARGE" }
    );
  }

  const upstream = await telegramFileResponse(
    env,
    fileInfo.file_path
  );

  if (!upstream.ok || !upstream.body) {
    const error = new Error(
      "Telegram file delivery failed."
    );
    error.statusCode = upstream.status || 502;
    throw error;
  }

  const contentLength = Number(
    upstream.headers.get("content-length") || 0
  );

  if (
    Number.isSafeInteger(contentLength) &&
    contentLength > 0 &&
    contentLength !== descriptor.size
  ) {
    throw Object.assign(
      new Error(
        "Telegram source size does not match the verified media index."
      ),
      { code: "TELEGRAM_SOURCE_SIZE_MISMATCH" }
    );
  }

  const sourceEtag = await sourceEtagFromResponse(
    upstream
  );
  const expectedWithSourceEtag = {
    ...expected,
    sourceEtag,
  };

  await writeCacheAtomically(
    cacheBucket(env),
    descriptor,
    upstream.body,
    expectedWithSourceEtag
  );

  return {
    sourceEtag,
    expected: expectedWithSourceEtag,
  };
}

async function fetchChunkToCache(
  env,
  descriptor,
  expected
) {
  if (!descriptor.fileId) {
    throw Object.assign(
      new Error("Telegram chunk file_id is missing."),
      { code: "TELEGRAM_FILE_ID_MISSING" }
    );
  }

  logEvent("chunk_fetch", {
    kind: descriptor.kind,
    messageId: descriptor.messageId,
    chunkIndex: descriptor.idx,
    size: descriptor.size,
  });

  const fileInfo = await botApiGetFile(
    env,
    descriptor.fileId
  );

  const telegramReportedSize = Number(
    fileInfo?.file_size || 0
  );
  if (
    Number.isSafeInteger(telegramReportedSize) &&
    telegramReportedSize !== descriptor.size
  ) {
    throw Object.assign(
      new Error(
        "Telegram chunk size does not match episode_chunks."
      ),
      { code: "TELEGRAM_CHUNK_SIZE_MISMATCH" }
    );
  }

  if (
    Number.isSafeInteger(telegramReportedSize) &&
    telegramReportedSize > TELEGRAM_CHUNK_LIMIT_BYTES
  ) {
    throw Object.assign(
      new Error(
        "Telegram chunk exceeds the approved <=19 MB chunk limit."
      ),
      { code: "TELEGRAM_CHUNK_TOO_LARGE" }
    );
  }

  const upstream = await telegramFileResponse(
    env,
    fileInfo.file_path
  );

  if (!upstream.ok || !upstream.body) {
    const error = new Error(
      "Telegram chunk delivery failed."
    );
    error.statusCode = upstream.status || 502;
    throw error;
  }

  const contentLength = Number(
    upstream.headers.get("content-length") || 0
  );

  if (
    Number.isSafeInteger(contentLength) &&
    contentLength > 0 &&
    contentLength !== descriptor.size
  ) {
    throw Object.assign(
      new Error(
        "Telegram chunk HTTP size does not match episode_chunks."
      ),
      { code: "TELEGRAM_CHUNK_SIZE_MISMATCH" }
    );
  }

  await writeCacheAtomically(
    cacheBucket(env),
    descriptor,
    upstream.body,
    expected
  );
}

async function getCachedBody(
  bucket,
  key,
  range
) {
  const options = range?.partial
    ? {
        range: {
          offset: range.start,
          length: range.length,
        },
      }
    : undefined;

  return bucket.get(key, options);
}

function deterministicResponseEtag(descriptor, totalSize) {
  return (
    "\"hj-" +
    descriptor.kind +
    "-" +
    descriptor.messageId +
    "-" +
    String(totalSize) +
    "-" +
    descriptor.version.slice(0, 24) +
    "\""
  );
}

function r2ObjectResponse(
  object,
  range,
  descriptor,
  totalSize,
  origin,
  env,
  chunked = false,
  source = "r2-cache",
  filename = ""
) {
  if (!object?.body) {
    throw new Error("R2 cache object body is unavailable.");
  }

  logEvent("r2_stream", {
    kind: descriptor.kind,
    messageId: descriptor.messageId,
    chunkIndex:
      Number.isInteger(descriptor.idx)
        ? descriptor.idx
        : null,
    size:
      Number.isSafeInteger(object.size)
        ? object.size
        : null,
    rangeStart:
      range.partial ? range.start : 0,
    rangeLength:
      range.partial ? range.length : totalSize,
  });

  const headers = mediaHeadersByKind({
    indexed: {
      file_name: filename,
      mime_type: object.httpMetadata?.contentType ||
        descriptor.mimeType,
    },
    kind: descriptor.kind,
    totalSize,
    range,
    etag:
      object.httpEtag ||
      deterministicResponseEtag(
        descriptor,
        totalSize
      ),
    source,
    chunked,
    origin,
    env,
  });

  return new Response(
    object.body,
    {
      status: range.partial ? 206 : 200,
      headers,
    }
  );
}

async function serveWholeMedia(
  request,
  env,
  indexed,
  descriptor,
  range,
  origin
) {
  const bucket = cacheBucket(env);

  const expected = buildExpectedMetadata({
    kind: descriptor.kind,
    messageId: descriptor.messageId,
    contentId: descriptor.contentId,
    sourceIdentity: descriptor.sourceIdentity,
    size: descriptor.size,
    mimeType: descriptor.mimeType,
    fileUniqueId: descriptor.fileUniqueId,
    version: descriptor.version,
  });

  const cached = await getValidatedCache(
    bucket,
    descriptor,
    expected
  );

  if (cached.hit) {
    const object = await getCachedBody(
      bucket,
      descriptor.key,
      range
    );
    if (!object) {
      logEvent("cache_miss", {
        reason: "r2-get-after-head-miss",
        kind: descriptor.kind,
        messageId: descriptor.messageId,
      });
    } else {
      return r2ObjectResponse(
        object,
        range,
        descriptor,
        descriptor.size,
        origin,
        env,
        false,
        "r2-cache",
        descriptor.filename
      );
    }
  } else {
    logEvent("cache_miss", {
      kind: descriptor.kind,
      messageId: descriptor.messageId,
      cacheKeyHash: await sha256Hex(descriptor.key),
      reason: cached.reason,
    });
  }

  let fetchResult;
  try {
    fetchResult = await fetchWholeToCache(
      env,
      descriptor,
      expected
    );
  } catch (error) {
    if (error?.code === "TELEGRAM_FILE_TOO_LARGE") {
      return mediaError(
        413,
        "TELEGRAM_FILE_TOO_LARGE",
        origin,
        env,
        "Cloud Bot API getFile cannot download this source above 20 MB.",
        "needs_split"
      );
    }
    if (error?.code === "TELEGRAM_FILE_ID_MISSING") {
      return mediaError(
        422,
        "TELEGRAM_FILE_ID_MISSING",
        origin,
        env,
        "The authoritative Telegram file_id is not recorded yet."
      );
    }
    if (error?.code === "TELEGRAM_SOURCE_SIZE_MISMATCH") {
      return mediaError(
        422,
        "TELEGRAM_SOURCE_SIZE_MISMATCH",
        origin,
        env,
        error.message
      );
    }
    logFailure("failure", error, {
      phase: "whole-cache-fill",
      kind: descriptor.kind,
      messageId: descriptor.messageId,
    });
    return mediaError(
      502,
      "TELEGRAM_FILE_DOWNLOAD_FAILED",
      origin,
      env,
      "Telegram file delivery failed."
    );
  }

  const refreshedExpected =
    buildExpectedMetadata({
      ...expected,
      sourceEtag: fetchResult.sourceEtag,
    });

  const final = await bucket.head(
    descriptor.key
  );
  const validation = validateCacheObject(
    final,
    refreshedExpected
  );
  if (!validation.ok) {
    logFailure(
      "failure",
      new Error(
        "R2 cache failed post-write validation: " +
        validation.reason
      ),
      {
        phase: "whole-cache-post-write",
        kind: descriptor.kind,
        messageId: descriptor.messageId,
      }
    );
    return mediaError(
      502,
      "R2_CACHE_WRITE_UNVERIFIED",
      origin,
      env
    );
  }

  const object = await getCachedBody(
    bucket,
    descriptor.key,
    range
  );
  if (!object) {
    return mediaError(
      502,
      "R2_CACHE_READ_FAILED",
      origin,
      env
    );
  }

  return r2ObjectResponse(
    object,
    range,
    descriptor,
    descriptor.size,
    origin,
    env,
    false,
    "r2-cache",
    descriptor.filename
  );
}

async function ensureChunkCached(
  env,
  descriptor
) {
  const bucket = cacheBucket(env);
  const expected = buildExpectedMetadata({
    kind: descriptor.kind,
    messageId: descriptor.messageId,
    contentId: descriptor.contentId,
    sourceIdentity: descriptor.sourceIdentity,
    size: descriptor.size,
    mimeType: descriptor.mimeType,
    fileUniqueId: descriptor.fileUniqueId,
    version: descriptor.version,
    sha256: descriptor.expectedSha256,
  });

  const cached = await getValidatedCache(
    bucket,
    descriptor,
    expected
  );

  if (cached.hit) {
    return {
      hit: true,
      expected,
      object: cached.object,
    };
  }

  logEvent("cache_miss", {
    kind: descriptor.kind,
    messageId: descriptor.messageId,
    chunkIndex: descriptor.idx,
    cacheKeyHash: await sha256Hex(descriptor.key),
    reason: cached.reason,
  });

  try {
    await fetchChunkToCache(
      env,
      descriptor,
      expected
    );
  } catch (error) {
    if (
      error?.code === "TELEGRAM_FILE_TOO_LARGE" ||
      error?.code === "TELEGRAM_CHUNK_TOO_LARGE"
    ) {
      throw Object.assign(
        new Error(
          "A Telegram chunk exceeds the approved Bot API chunk size."
        ),
        { code: "TELEGRAM_CHUNK_TOO_LARGE" }
      );
    }
    throw error;
  }

  const final = await bucket.head(
    descriptor.key
  );
  const validation = validateCacheObject(
    final,
    expected
  );
  if (!validation.ok) {
    throw new Error(
      "R2 chunk cache failed validation: " +
      validation.reason
    );
  }

  return {
    hit: false,
    expected,
    object: final,
  };
}

async function streamChunkPlan(
  env,
  plan,
  descriptor,
  totalSize,
  range,
  origin
) {
  const bucket = cacheBucket(env);
  const controllerStream = new ReadableStream({
    async start(controller) {
      try {
        for (const entry of plan) {
          const chunkDescriptor = entry.chunkDescriptor;
          const subrange = {
            partial:
              entry.localStart !== 0 ||
              entry.localEnd !==
                chunkDescriptor.size - 1,
            start: entry.localStart,
            end: entry.localEnd,
            length: entry.length,
          };

          const object = await getCachedBody(
            bucket,
            chunkDescriptor.key,
            subrange
          );

          if (!object?.body) {
            throw new Error(
              "R2 chunk body became unavailable after validation."
            );
          }

          logEvent("r2_stream", {
            kind: descriptor.kind,
            messageId: descriptor.messageId,
            chunkIndex: chunkDescriptor.idx,
            rangeStart: entry.localStart,
            rangeLength: entry.length,
          });

          const reader = object.body.getReader();
          try {
            while (true) {
              const result = await reader.read();
              if (result.done) break;
              controller.enqueue(result.value);
            }
          } finally {
            try {
              reader.releaseLock();
            } catch {}
          }
        }

        controller.close();
      } catch (error) {
        logFailure("failure", error, {
          phase: "chunk-stream",
          kind: descriptor.kind,
          messageId: descriptor.messageId,
        });
        controller.error(error);
      }
    },
  });

  const headers = mediaHeadersByKind({
    indexed: {
      file_name: descriptor.filename,
      mime_type: descriptor.mimeType,
    },
    kind: descriptor.kind,
    totalSize,
    range,
    etag: descriptor.responseEtag,
    source: "r2-cache",
    chunked: true,
    origin,
    env,
  });

  return new Response(
    controllerStream,
    {
      status: range.partial ? 206 : 200,
      headers,
    }
  );
}

async function handleChunkedMedia(
  request,
  env,
  indexed,
  policyRow,
  chunkInfo,
  kind,
  messageId,
  range,
  origin
) {
  if (chunkInfo.totalSize <= 0) {
    return mediaError(
      422,
      "EPISODE_CHUNKS_INVALID",
      origin,
      env,
      "Episode chunk metadata has no usable total size."
    );
  }

  const indexedSize = Number(indexed?.file_size || 0);
  if (
    Number.isSafeInteger(indexedSize) &&
    indexedSize > 0 &&
    indexedSize !== chunkInfo.totalSize
  ) {
    return mediaError(
      422,
      "EPISODE_CHUNKS_SIZE_MISMATCH",
      origin,
      env,
      "Chunk total size does not match the authoritative media index."
    );
  }

  const chunkRange = parseSingleRange(
    request.headers.get("range"),
    chunkInfo.totalSize
  );
  if (chunkRange.error) {
    const headers = new Headers({
      "Content-Range":
        "bytes */" + chunkInfo.totalSize,
      "Accept-Ranges": "bytes",
    });
    applyCors(headers, origin, env);
    return new Response(null, {
      status: 416,
      headers,
    });
  }

  const descriptors = [];
  for (const chunk of chunkInfo.chunks) {
    descriptors.push(
      await buildChunkDescriptor(
        kind,
        messageId,
        policyRow?.id,
        chunk,
        inferMimeType(
          {
            mimeType: indexed?.mime_type,
            attributes: [
              {
                className:
                  "DocumentAttributeFilename",
                fileName: indexed?.file_name || "",
              },
            ],
          },
          kind
        )
      )
    );
  }

  const planEntries = chunkRangePlan(
    chunkInfo.chunks,
    chunkRange.start,
    chunkRange.end
  ).map((entry) => {
    const descriptor =
      descriptors[entry.chunk.idx];
    return {
      ...entry,
      chunkDescriptor: descriptor,
    };
  });

  if (
    !planEntries.length ||
    planEntries.length > MAX_CHUNKS_PER_REQUEST
  ) {
    return mediaError(
      413,
      "CHUNK_REQUEST_TOO_LARGE",
      origin,
      env,
      "This request would require too many Telegram chunks for one Worker invocation."
    );
  }

  if (request.method === "HEAD") {
    const firstDescriptor =
      descriptors[0];

    const headers = mediaHeadersByKind({
      indexed,
      kind,
      totalSize: chunkInfo.totalSize,
      range: chunkRange,
      etag:
        deterministicResponseEtag(
          firstDescriptor,
          chunkInfo.totalSize
        ),
      source: "r2-cache",
      chunked: true,
      origin,
      env,
    });

    return new Response(null, {
      status: chunkRange.partial ? 206 : 200,
      headers,
    });
  }

  for (const planEntry of planEntries) {
    try {
      await ensureChunkCached(
        env,
        planEntry.chunkDescriptor
      );
    } catch (error) {
      if (
        error?.code === "TELEGRAM_CHUNK_TOO_LARGE"
      ) {
        return mediaError(
          413,
          "TELEGRAM_FILE_TOO_LARGE",
          origin,
          env,
          "A chunk exceeds the approved 19 MB chunk size.",
          "needs_split"
        );
      }
      if (
        error?.code === "TELEGRAM_FILE_ID_MISSING"
      ) {
        return mediaError(
          422,
          "TELEGRAM_FILE_ID_MISSING",
          origin,
          env,
          "A chunk does not have an authoritative Telegram file_id."
        );
      }
      logFailure("failure", error, {
        phase: "chunk-cache-fill",
        kind,
        messageId,
        chunkIndex:
          planEntry.chunkDescriptor.idx,
      });
      return mediaError(
        502,
        "TELEGRAM_CHUNK_DOWNLOAD_FAILED",
        origin,
        env,
        "Telegram chunk delivery failed."
      );
    }
  }

  const first = descriptors[0];
  const aggregateVersion = await sha256Hex(
    descriptors
      .map((descriptor) => descriptor.version)
      .join("|")
  );

  const responseDescriptor = {
    kind,
    messageId: Number(messageId),
    version: aggregateVersion,
    mimeType: first.mimeType,
    filename: String(
      indexed?.file_name ||
      inferFilename({ attributes: [] }, kind)
    ),
    responseEtag:
      "\"hj-" +
      kind +
      "-" +
      String(messageId) +
      "-" +
      String(chunkInfo.totalSize) +
      "-" +
      aggregateVersion.slice(0, 24) +
      "\"",
  };

  return streamChunkPlan(
    env,
    planEntries,
    responseDescriptor,
    chunkInfo.totalSize,
    chunkRange,
    origin
  );
}

async function handleMedia(
  request,
  env,
  kind,
  messageId
) {
  const parsedMessageId = parseMessageId(
    messageId
  );
  if (!parsedMessageId) {
    return mediaError(
      400,
      "INVALID_MESSAGE_ID",
      request.headers.get("origin") || "",
      env
    );
  }

  const origin =
    request.headers.get("origin") || "";

  const access = await inspectMediaAccess(
    env,
    request,
    kind,
    parsedMessageId
  );

  if (!access.ok) {
    return mediaError(
      access.status || 403,
      "MEDIA_ACCESS_DENIED",
      origin,
      env,
      access.error
    );
  }

  const isPreview = Boolean(
    access.viaPreview
  );
  const isProtected = Boolean(
    access.viaTicket ||
    isProtectedPolicy(access.row || {})
  );

  if (
    isProtected &&
    !access.viaTicket &&
    !isPreview
  ) {
    return mediaError(
      403,
      "SECURE_TICKET_REQUIRED",
      origin,
      env
    );
  }

  try {
    const indexed = await getIndexedMedia(
      env,
      kind,
      parsedMessageId
    );

    if (!indexed) {
      return mediaError(
        404,
        "MEDIA_INDEX_NOT_FOUND",
        origin,
        env
      );
    }

    const size = Number(
      indexed.file_size
    );
    if (!Number.isSafeInteger(size) || size <= 0) {
      return mediaError(
        422,
        "MEDIA_INDEX_SIZE_MISSING",
        origin,
        env
      );
    }

    const policyRow =
      access.row ||
      (
        await lookupMediaPolicy(
          env,
          kind,
          parsedMessageId
        )
      ).row;

    const contentId =
      Number(policyRow?.id) || 0;

    const chunkInfo =
      await getEpisodeChunks(
        env,
        kind,
        contentId
      );

    if (chunkInfo.error) {
      return mediaError(
        503,
        "EPISODE_CHUNKS_LOOKUP_FAILED",
        origin,
        env
      );
    }

    if (chunkInfo.present) {
      return handleChunkedMedia(
        request,
        env,
        indexed,
        policyRow,
        chunkInfo,
        kind,
        parsedMessageId,
        null,
        origin
      );
    }

    const range = parseSingleRange(
      request.headers.get("range"),
      size
    );

    if (range.error) {
      const headers = new Headers({
        "Content-Range": "bytes */" + size,
        "Accept-Ranges": "bytes",
      });
      applyCors(headers, origin, env);
      return new Response(null, {
        status: 416,
        headers,
      });
    }

    if (size > TELEGRAM_BOT_GETFILE_LIMIT_BYTES) {
      return mediaError(
        413,
        "TELEGRAM_FILE_TOO_LARGE",
        origin,
        env,
        "Cloud Bot API getFile cannot download this source above 20 MB.",
        "needs_split"
      );
    }

    const descriptor =
      await buildMediaDescriptor(
        kind,
        parsedMessageId,
        indexed,
        access.row
      );

    if (request.method === "HEAD") {
      const expected = buildExpectedMetadata({
        kind,
        messageId: parsedMessageId,
        contentId: descriptor.contentId,
        sourceIdentity: descriptor.sourceIdentity,
        size: descriptor.size,
        mimeType: descriptor.mimeType,
        fileUniqueId: descriptor.fileUniqueId,
        version: descriptor.version,
      });

      const cached =
        await getValidatedCache(
          cacheBucket(env),
          descriptor,
          expected
        ).catch(() => ({
          hit: false,
          reason: "head-cache-check-failed",
        }));

      const source = cached.hit
        ? "r2-cache"
        : "r2-cache";

      const headers =
        mediaHeadersByKind({
          indexed,
          kind,
          totalSize: size,
          range,
          etag:
            deterministicResponseEtag(
              descriptor,
              size
            ),
          source,
          chunked: false,
          origin,
          env,
        });

      return new Response(null, {
        status: range.partial ? 206 : 200,
        headers,
      });
    }

    return serveWholeMedia(
      request,
      env,
      indexed,
      descriptor,
      range,
      origin
    );
  } catch (error) {
    logFailure("failure", error, {
      phase: "media-route",
      kind,
      messageId: parsedMessageId,
    });
    return mediaError(
      502,
      "MEDIA_STREAM_ERROR",
      origin,
      env,
      "Media streaming failed safely."
    );
  }
}

async function handleMediaTicket(
  request,
  env
) {
  const url = new URL(request.url);
  const parts = url.pathname
    .split("/")
    .filter(Boolean);

  const type = String(
    parts[1] || ""
  ).toLowerCase();
  const messageId = parseMessageId(
    parts[3]
  );

  if (
    parts.length !== 4 ||
    !CONTENT_TYPES.has(type) ||
    parts[2] !== "message" ||
    !messageId
  ) {
    return jsonResponse(
      { error: "INVALID_MEDIA_TICKET_REQUEST" },
      400,
      request.headers.get("origin") || "",
      env
    );
  }

  try {
    const access =
      await inspectMediaAccess(
        env,
        request,
        type,
        messageId
      );

    if (!access.ok) {
      return mediaError(
        access.status || 403,
        "MEDIA_ACCESS_DENIED",
        request.headers.get("origin") || "",
        env,
        access.error
      );
    }

    if (
      !access.row ||
      !isProtectedPolicy(access.row)
    ) {
      return jsonResponse(
        { error: "Media is not protected" },
        400,
        request.headers.get("origin") || "",
        env
      );
    }

    const userId = String(
      access.user?.id ||
      access.userId ||
      ""
    ).trim();

    if (!userId) {
      return jsonResponse(
        {
          error:
            "Login is required for premium/VIP media.",
        },
        401,
        request.headers.get("origin") || "",
        env
      );
    }

    const token =
      await createMediaTicket(
        env,
        type,
        messageId,
        userId,
        request.headers.get("user-agent") || ""
      );

    const mediaUrl =
      new URL(
        "/" +
        type +
        "/message/" +
        messageId,
        request.url
      ).toString() +
      "?ticket=" +
      encodeURIComponent(token);

    const headers = new Headers({
      "Content-Type":
        "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    applyCors(
      headers,
      request.headers.get("origin") || "",
      env
    );

    return new Response(
      JSON.stringify({
        url: mediaUrl,
        expires_at:
          new Date(
            Date.now() +
            MEDIA_TICKET_TTL_MS
          ).toISOString(),
      }),
      {
        status: 200,
        headers,
      }
    );
  } catch (error) {
    logFailure(
      "failure",
      error,
      { phase: "media-ticket" }
    );
    return jsonResponse(
      { error: "MEDIA_TICKET_ERROR" },
      503,
      request.headers.get("origin") || "",
      env
    );
  }
}

function listenerResponse(
  request,
  env,
  name
) {
  const headers = new Headers({
    "Content-Type":
      "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  applyCors(
    headers,
    request.headers.get("origin") || "",
    env
  );

  logEvent("listener_compat", {
    action: name,
  });

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers,
    });
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers }
  );
}

async function handleTelegramMessages(
  request,
  env
) {
  const origin =
    request.headers.get("origin") || "";
  const authHeader =
    request.headers.get("authorization") || "";
  const user =
    await getSupabaseUser(
      env,
      authHeader
    );

  if (user?.app_metadata?.role !== "admin") {
    return jsonResponse(
      {
        error: authHeader
          ? "FORBIDDEN"
          : "UNAUTHORIZED",
      },
      authHeader ? 403 : 401,
      origin,
      env
    );
  }

  const url = new URL(request.url);
  const requestedLimit = Number(
    url.searchParams.get("limit")
  );
  const limit = Number.isSafeInteger(
    requestedLimit
  )
    ? Math.min(
        100,
        Math.max(1, requestedLimit)
      )
    : 100;

  const requestedOffsetId =
    Number(
      url.searchParams.get("offset_id")
    );
  const offsetId =
    Number.isSafeInteger(
      requestedOffsetId
    ) && requestedOffsetId > 0
      ? requestedOffsetId
      : 0;

  const requestedType = String(
    url.searchParams.get("type") ||
    "audio"
  ).toLowerCase();

  const mediaType =
    CONTENT_TYPES.has(requestedType)
      ? requestedType
      : "audio";

  try {
    const params = new URLSearchParams({
      select:
        "telegram_message_id,file_name,mime_type,file_size,duration,width,height,updated_at",
      media_kind:
        "eq." + mediaType,
      order:
        "telegram_message_id.desc",
      limit: String(limit),
    });

    if (offsetId > 0) {
      params.set(
        "telegram_message_id",
        "lt." + String(offsetId)
      );
    }

    const rows =
      await mediaIndexJson(
        env,
        "/rest/v1/telegram_media_index?" +
        params.toString()
      );

    const mediaMessages =
      Array.isArray(rows)
        ? rows.map((row) => ({
            messageId: Number(
              row.telegram_message_id
            ),
            fileName:
              row.file_name ||
              (
                mediaType === "video"
                  ? "video.mp4"
                  : mediaType === "document"
                    ? "book.pdf"
                    : "audio.m4a"
              ),
            mimeType:
              row.mime_type || "",
            size: Number(
              row.file_size || 0
            ),
            duration: Number(
              row.duration || 0
            ),
            width: Number(
              row.width || 0
            ),
            height: Number(
              row.height || 0
            ),
            date:
              row.updated_at ||
              null,
          }))
        : [];

    const nextOffsetId =
      mediaMessages.length >= limit
        ? Number(
            mediaMessages[
              mediaMessages.length - 1
            ]?.messageId || 0
          )
        : 0;

    const headers = new Headers();
    applyCors(headers, origin, env);
    headers.set(
      "Cache-Control",
      "no-store"
    );
    headers.set(
      "X-HJ-Telegram-Next-Offset",
      nextOffsetId
        ? String(nextOffsetId)
        : ""
    );
    headers.set(
      "X-HJ-Telegram-Has-More",
      nextOffsetId
        ? "true"
        : "false"
    );
    headers.set(
      "Content-Type",
      "application/json; charset=utf-8"
    );

    return new Response(
      JSON.stringify(mediaMessages),
      { status: 200, headers }
    );
  } catch (error) {
    return jsonResponse(
      {
        error:
          "TELEGRAM_MESSAGES_ERROR",
        detail: String(
          error?.message || error
        )
          .replace(/[\r\n]+/g, " ")
          .slice(0, 180),
      },
      503,
      origin,
      env
    );
  }
}

async function handleTelegramStatus(
  request,
  env
) {
  const requiredKeys = [
    "TELEGRAM_BOT_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];

  const missing = requiredKeys.filter(
    (key) => !envString(env, key)
  );

  if (
    !mediaIndexUrl(env)
  ) {
    missing.push(
      "MEDIA_INDEX_SUPABASE_URL"
    );
  }

  if (
    !mediaIndexKey(env)
  ) {
    missing.push(
      "MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY"
    );
  }

  if (!env?.MEDIA_CACHE) {
    missing.push("MEDIA_CACHE");
  }

  const uniqueMissing = [
    ...new Set(missing),
  ];

  const configured =
    uniqueMissing.length === 0;

  return jsonResponse(
    {
      ok: configured,
      telegramConfigured:
        Boolean(
          envString(
            env,
            "TELEGRAM_BOT_TOKEN"
          )
        ),
      botApiStreaming: true,
      r2CacheConfigured:
        Boolean(env?.MEDIA_CACHE),
      durableObjectsUsed: false,
      mediaIndexConfigured:
        Boolean(
          mediaIndexUrl(env) &&
          mediaIndexKey(env)
        ),
      missing: uniqueMissing,
    },
    configured ? 200 : 503,
    request.headers.get("origin") || "",
    env
  );
}

export {
  buildMediaDescriptor,
  buildChunkDescriptor,
  getEpisodeChunks,
  parseSingleRange,
  createMediaTicket,
  verifyMediaTicket,
};

export default {
  async fetch(request, env) {
    const origin =
      request.headers.get("origin") || "";
    const url = new URL(request.url);

    try {
      const method =
        request.method.toUpperCase();

      if (method === "OPTIONS") {
        const headers = new Headers();
        applyCors(
          headers,
          origin,
          env
        );
        return new Response(null, {
          status: 204,
          headers,
        });
      }

      if (
        LISTENER_PATHS.has(
          url.pathname
        )
      ) {
        return listenerResponse(
          request,
          env,
          url.pathname
            .split("/")
            .filter(Boolean)
            .pop() || "unknown"
        );
      }

      if (
        method !== "GET" &&
        method !== "HEAD"
      ) {
        return jsonResponse(
          { error: "METHOD_NOT_ALLOWED" },
          405,
          origin,
          env
        );
      }

      if (
        url.pathname === "/" ||
        url.pathname === "/health"
      ) {
        return jsonResponse(
          {
            status: "ok",
            service:
              "hj-telegram-streaming-cloudflare",
            directTelegram: false,
            botApiStreaming: true,
            r2Cache: true,
            durableObjectsUsed: false,
          },
          200,
          origin,
          env
        );
      }

      if (
        url.pathname ===
        "/telegram/status"
      ) {
        return handleTelegramStatus(
          request,
          env
        );
      }

      if (
        url.pathname ===
        "/telegram/messages"
      ) {
        return handleTelegramMessages(
          request,
          env
        );
      }

      const parts = url.pathname
        .split("/")
        .filter(Boolean);

      if (
        parts.length === 4 &&
        parts[0] === "media-ticket" &&
        parts[2] === "message"
      ) {
        return handleMediaTicket(
          request,
          env
        );
      }

      if (
        parts.length === 3 &&
        CONTENT_TYPES.has(
          parts[0]
        ) &&
        parts[1] === "message"
      ) {
        return handleMedia(
          request,
          env,
          parts[0],
          parts[2]
        );
      }

      return jsonResponse(
        { error: "NOT_FOUND" },
        404,
        origin,
        env
      );
    } catch (error) {
      logFailure(
        "failure",
        error,
        { phase: "unhandled" }
      );
      return jsonResponse(
        { error: "INTERNAL_SERVER_ERROR" },
        500,
        origin,
        env
      );
    }
  },
};
