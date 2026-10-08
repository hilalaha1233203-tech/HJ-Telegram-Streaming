import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { DurableObject } from "cloudflare:workers";
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
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
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

function mediaIndexUrl(env) {
  const value = envString(env, "MEDIA_INDEX_SUPABASE_URL") || envString(env, "SUPABASE_URL");
  if (!value) throw new Error("Missing required environment variables: MEDIA_INDEX_SUPABASE_URL or SUPABASE_URL");
  return value;
}

function mediaIndexKey(env) {
  const value =
    envString(env, "MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY") ||
    envString(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!value) {
    throw new Error(
      "Missing required environment variables: MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return value;
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

async function getIndexedMedia(env, kind, messageId) {
  const params = new URLSearchParams({
    select: "storage_chat_id,telegram_message_id,media_kind,file_id,file_unique_id,file_name,mime_type,file_size,duration,width,height,updated_at",
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
  if (!/^Bearer\s+\S+/i.test(String(authHead_KEY or SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  return value;
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

async function getIndexedMedia(env, kind, messageId) {
  const params = new URLSearchParams({
    select: "storage_chat_id,telegram_message_id,media_kind,file_id,file_unique_id,file_name,mime_type,file_size,duration,width,height,updated_at",
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
  const expected = createHmac("sha256", secret)exed.file_size + "\"");
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

const MEDIA_MAX_DURATION_MS = 24 * 60 * 60 * 1000;
const MEDIA_CACHE_GRACE_MS = 10 * 60 * 1000;
const MEDIA_LISTENER_LEASE_MS = 45 * 1000;
const MEDIA_FILL_LEASE_MS = 2 * 60 * 1000;

export class MediaListener extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS listeners (session_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,last_seen INTEGER NOT NULL,lease_until INTEGER NOT NULL,ended_at INTEGER)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS media_state (cache_key TEXT PRIMARY KEY,base_expiry INTEGER NOT NULL,last_listener_end INTEGER NOT NULL DEFAULT 0)");
      ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fill_locks (cache_key TEXT PRIMARY KEY,lease_until INTEGER NOT NULL)");
    });
  }
  async prime(cacheKey, durationMs, uploadedAt = Date.now()) {
    const d = Math.min(MEDIA_MAX_DURATION_MS, Math.max(0, Number(durationMs) || 0));
    const u = Number.isFinite(Number(uploadedAt)) ? Number(uploadedAt) : Date.now();
    const base = u + d + MEDIA_CACHE_GRACE_MS;
    this.ctx.storage.sql.exec("INSERT INTO media_state (cache_key,base_expiry,last_listener_end) VALUES (?,?,0) ON CONFLICT(cache_key) DO UPDATE SET base_expiry=MAX(base_expiry,excluded.base_expiry)", String(cacheKey), base);
    await this.schedule();
    return { ok: true, baseExpiry: base };
  }
  async acquireFill(cacheKey, leaseMs = MEDIA_FILL_LEASE_MS) {
    const now = Date.now();
    const leaseUntil = now + Math.max(10000, Number(leaseMs) || MEDIA_FILL_LEASE_MS);
    const key = String(cacheKey);
    const current = this.ctx.storage.sql.exec("SELECT lease_until FROM fill_locks WHERE cache_key=?", key).one();
    if (Number(current?.lease_until || 0) > now) return { acquired: false, leaseUntil: Number(current.lease_until) };
    this.ctx.storage.sql.exec("INSERT INTO fill_locks (cache_key,lease_until) VALUES (?,?) ON CONFLICT(cache_key) DO UPDATE SET lease_until=excluded.lease_until", key, leaseUntil);
    await this.schedule();
    return { acquired: true, leaseUntil };
  }
  async releaseFill(cacheKey) {
    this.ctx.storage.sql.exec("DELETE FROM fill_locks WHERE cache_key=?", String(cacheKey));
    await this.schedule();
    return { ok: true };
  }
  async start(userId, durationMs, cacheKey, uploadedAt = Date.now()) {
    const now = Date.now();
    const d = Math.min(MEDIA_MAX_DURATION_MS, Math.max(0, Number(durationMs) || 0));
    const u = Number.isFinite(Number(uploadedAt)) ? Number(uploadedAt) : now;
    const base = u + d + MEDIA_CACHE_GRACE_MS;
    this.ctx.storage.sql.exec("INSERT INTO media_state (cache_key,base_expiry,last_listener_end) VALUES (?,?,0) ON CONFLICT(cache_key) DO UPDATE SET base_expiry=MAX(base_expiry,excluded.base_expiry)", String(cacheKey), base);
    const sessionId = crypto.randomUUID();
    this.ctx.storage.sql.exec("INSERT INTO listeners (session_id,user_id,last_seen,lease_until,ended_at) VALUES (?,?,?,?,NULL)", sessionId, String(userId), now, now + MEDIA_LISTENER_LEASE_MS);
    await this.schedule();
    return { sessionId, baseExpiry: base };
  }
  async heartbeat(sessionId) {
    const now = Date.now();
    const r = this.ctx.storage.sql.exec("UPDATE listeners SET last_seen=?,lease_until=?,ended_at=NULL WHERE session_id=? AND ended_at IS NULL", now, now + MEDIA_LISTENER_LEASE_MS, String(sessionId));
    if (r.rowsWritten > 0) await this.schedule();
    return { ok: r.rowsWritten > 0 };
  }
  async end(sessionId) {
    const now = Date.now();
    const r = this.ctx.storage.sql.exec("UPDATE listeners SET ended_at=?,lease_until=? WHERE session_id=? AND ended_at IS NULL", now, now, String(sessionId));
    if (r.rowsWritten > 0) {
      this.ctx.storage.sql.exec("UPDATE media_state SET last_listener_end=MAX(last_listener_end,?)", now);
      await this.schedule();
    }
    return { ok: r.rowsWritten > 0 };
  }
  async alarm() {
    const now = Date.now();
    this.expireLeases(now);
    this.ctx.storage.sql.exec("DELETE FROM fill_locks WHERE lease_until<=?", now);
    const state = this.ctx.storage.sql.exec("SELECT cache_key,base_expiry,last_listener_end FROM media_state LIMIT 1").one();
    if (!state?.cache_key) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const active = Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS active FROM listeners WHERE ended_at IS NULL AND lease_until>?", now).one()?.active || 0);
    if (active > 0) {
      await this.schedule();
      return;
    }
    const deleteAt = Math.max(Number(state.base_expiry || 0), Number(state.last_listener_end || 0) + MEDIA_CACHE_GRACE_MS);
    if (now >= deleteAt) {
      if (this.env.MEDIA_CACHE) await this.env.MEDIA_CACHE.delete(String(state.cache_key));
      this.ctx.storage.sql.exec("DELETE FROM listeners");
      this.ctx.storage.sql.exec("DELETE FROM media_state");
      this.ctx.storage.sql.exec("DELETE FROM fill_locks WHERE cache_key=?", String(state.cache_key));
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.schedule();
  }
  expireLeases(now) {
    const r = this.ctx.storage.sql.exec("UPDATE listeners SET ended_at=last_seen WHERE ended_at IS NULL AND lease_until<=?", now);
    if (r.rowsWritten > 0) {
      const row = this.ctx.storage.sql.exec("SELECT MAX(ended_at) AS last_end FROM listeners WHERE ended_at IS NOT NULL").one();
      if (Number(row?.last_end || 0) > 0) this.ctx.storage.sql.exec("UPDATE media_state SET last_listener_end=MAX(last_listener_end,?)", Number(row.last_end));
    }
  }
  async schedule() {
    const now = Date.now();
    const state = this.ctx.storage.sql.exec("SELECT base_expiry,last_listener_end FROM media_state LIMIT 1").one();
    const nextLease = Number(this.ctx.storage.sql.exec("SELECT MIN(lease_until) AS next_lease FROM listeners WHERE ended_at IS NULL").one()?.next_lease || 0);
    const fillLease = Number(this.ctx.storage.sql.exec("SELECT MIN(lease_until) AS fill_lease FROM fill_locks").one()?.fill_lease || 0);
    const deleteAt = Math.max(Number(state?.base_expiry || 0), Number(state?.last_listener_end || 0) + MEDIA_CACHE_GRACE_MS);
    const candidates = [deleteAt, nextLease, fillLease].filter((value) => value > now);
    await this.ctx.storage.setAlarm(candidates.length ? Math.min(...candidates) : now + 1000);
  }
}

function mediaCacheKey(kind,indexed){return "media/"+String(kind)+"/"+String(indexed.telegram_message_id)+"/"+encodeURIComponent(String(indexed.file_id||"file"))+"-"+String(indexed.file_size||0);}
function mediaListenerStub(env,kind,messageId){return env.MEDIA_LISTENER.getByName(String(kind)+":"+String(messageId));}
async function listenerUser(request,env,kind,messageId){const t=String(new URL(request.url).searchParams.get("ticket")||"").trim(),tu=verifyMediaTicket(env,t,kind,messageId,request.headers.get("user-agent")||"");if(tu?.userId)return String(tu.userId);const a=String(request.headers.get("authorization")||"").trim(),u=await getSupabaseUser(env,a);if(u?.id)return String(u.id);const anon=String(new URL(request.url).searchParams.get("listenerId")||"").trim();return anon?("anon:"+anon):null;}
async function handleListener(request,env,action){const origin=request.headers.get("origin")||"",url=new URL(request.url),kind=String(url.searchParams.get("kind")||"").toLowerCase(),messageId=parseMessageId(url.searchParams.get("messageId"));if(!["audio","video","document"].includes(kind)||!messageId)return mediaError(400,"INVALID_LISTENER_REQUEST",origin,env);const access=await inspectMediaAccess(env,request,kind,messageId);if(!access.ok)return mediaError(access.status||403,"MEDIA_ACCESS_DENIED",origin,env,access.error);const indexed=await getIndexedMedia(env,kind,messageId);if(!indexed)return mediaError(404,"MEDIA_INDEX_NOT_FOUND",origin,env);const userId=await listenerUser(request,env,kind,messageId);if(!userId)return mediaError(401,"LISTENER_AUTH_REQUIRED",origin,env);const stub=mediaListenerStub(env,kind,messageId),cacheKey=mediaCacheKey(kind,indexed);let result;if(action==="start"){const requestedDurationMs=Number(url.searchParams.get("durationMs")||0);const indexedDurationMs=Math.max(0,Number(indexed.duration||0)*1000);const effectiveDurationMs=Math.min(MEDIA_MAX_DURATION_MS,Math.max(0,Number.isFinite(requestedDurationMs)&&requestedDurationMs>0?requestedDurationMs:indexedDurationMs));let uploadedAt=Date.now();if(env.MEDIA_CACHE){try{const head=await env.MEDIA_CACHE.head(cacheKey);if(head?.uploaded)uploadedAt=head.uploaded.getTime();}catch{}}result=await stub.start(userId,effectiveDurationMs,cacheKey,uploadedAt);}else{const sid=String(url.searchParams.get("sessionId")||"").trim();if(!sid)return mediaError(400,"LISTENER_SESSION_REQUIRED",origin,env);result=action==="heartbeat"?await stub.heartbeat(sid):await stub.end(sid);}return jsonResponse(result,200,origin,env);}
async function handleMedia(request, env, kind, messageId, ctx) {
  if (!parseMessageId(messageId)) return mediaError(400, "INVALID_MESSAGE_ID", request.headers.get("origin") || "", env);
  const access = await inspectMediaAccess(env, request, kind, Number(messageId));
  if (!access.ok) return mediaError(access.status || 403, "MEDIA_ACCESS_DENIED", request.headers.get("origin") || "", env, access.error);

  const isPreview = Boolean(access.viaPreview);
  const isProtected = Boolean(access.viaTicket || isProtectedPolicy(access.row || {}));
  if (isProtected && !access.viaTicket && !isPreview) return mediaError(403, "SECURE_TICKET_REQUIRED", request.headers.get("origin") || "", env);

  const origin = request.headers.get("origin") || "";
  try {
    const indexed = await getIndexedMedia(env, kind, Number(messageId));
    if (!indexed) return mediaError(404, "MEDIA_INDEX_NOT_FOUND", origin, env);
    const size = Number(indexed.file_size);
    if (!Number.isSafeInteger(size) || size <= 0) return mediaError(404, "MEDIA_INDEX_SIZE_MISSING", origin, env);
    if (size > 20 * 1024 * 1024) return mediaError(413, "MEDIA_TOO_LARGE_FOR_BOT_API_STREAM", origin, env, "Compress this Telegram media below 20 MB before website streaming.");

    const range = parseSingleRange(request.headers.get("range"), size, 1024 * 1024);
    if (range.error) {
      const h = new Headers({"Content-Range":"bytes */"+size,"Accept-Ranges":"bytes"});
      applyCors(h, origin, env);
      return new Response(null,{status:416,headers:h});
    }

    const headers = mediaHeaders(indexed, kind, range, origin, env);
    if (request.method === "HEAD") return new Response(null,{status:range.requested?206:200,headers});

    const cacheKey = mediaCacheKey(kind, indexed);
    const listenerStub = mediaListenerStub(env, kind, messageId);

    // R2 is the first media source. Telegram is not contacted on an R2 cache hit.
    if (env.MEDIA_CACHE) {
      try {
        const cached = await env.MEDIA_CACHE.get(cacheKey, { range: request.headers });
        if (cached?.body) {
          const h = new Headers();
          cached.writeHttpMetadata(h);
          h.set("ETag", cached.httpEtag);
          h.set("Accept-Ranges", "bytes");
          h.set("X-HJ-Telegram-Source", "r2-cache");
          applyCors(h, origin, env);
          if (cached.range) {
            const offset = Number(cached.range.offset || 0);
            const length = Number(cached.range.length || cached.size);
            h.set("Content-Range", "bytes " + offset + "-" + (offset + length - 1) + "/" + cached.size);
            h.set("Content-Length", String(length));
            return new Response(cached.body,{status:206,headers:h});
          }
          h.set("Content-Length", String(cached.size));
          return new Response(cached.body,{status:200,headers:h});
        }
      } catch (error) {
        console.warn("HJ R2 cache read failed", String(error?.message || error).slice(0,180));
      }
    }

    let fileInfo;
    try {
      fileInfo = await botApiGetFile(env, indexed.file_id);
    } catch (firstError) {
      return mediaError(Number(firstError.statusCode)===400?404:502,"TELEGRAM_FILE_LOOKUP_FAILED",origin,env,firstError.message);
    }

    // One per-media Durable Object prevents concurrent requests from filling the same R2 object.
    if (env.MEDIA_CACHE && ctx) {
      ctx.waitUntil((async()=>{
        let acquired=false;
        try {
          const lock=await listenerStub.acquireFill(cacheKey);
          acquired=Boolean(lock?.acquired);
          if (!acquired || await env.MEDIA_CACHE.head(cacheKey)) return;

          if (range.requested) {
            const fullHeaders=new Headers(request.headers);
            fullHeaders.delete("Range");
            const fullRequest=new Request(request,{headers:fullHeaders});
            const full=await telegramFileResponse(env,fileInfo.file_path,fullRequest);
            if (!full.ok || full.status!==200 || !full.body) return;
            const uploadedAt=Date.now();
            await env.MEDIA_CACHE.put(cacheKey,full.body,{
              httpMetadata:{contentType:indexed.mime_type||"application/octet-stream",contentDisposition:headers.get("Content-Disposition")||"inline",cacheControl:"private, no-store"},
              customMetadata:{duration_ms:String(Math.max(0,Number(indexed.duration||0)*1000)),uploaded_at:String(uploadedAt),message_id:String(messageId),media_kind:String(kind)}
            });
            await listenerStub.prime(cacheKey,Math.max(0,Number(indexed.duration||0)*1000),uploadedAt);
          }
        } catch(error) {
          console.warn("HJ R2 background fill failed",String(error?.message||error).slice(0,180));
        } finally {
          if(acquired) try{await listenerStub.releaseFill(cacheKey);}catch{}
        }
      })());
    }

    let upstream=await telegramFileResponse(env,fileInfo.file_path,request,range);
    if(!upstream.ok){
      try{
        fileInfo=await botApiGetFile(env,indexed.file_id);
        upstream=await telegramFileResponse(env,fileInfo.file_path,request,range);
      }catch{}
    }
    if(!upstream.ok) return mediaError(upstream.status||502,"TELEGRAM_FILE_DOWNLOAD_FAILED",origin,env,"Telegram file delivery failed.");

    const upstreamHeaders=responseHeadersFromUpstream(upstream,headers);
    if(range.requested&&upstream.status===200){
      upstreamHeaders.delete("Content-Range");
      upstreamHeaders.set("X-HJ-Telegram-Range","upstream-did-not-honor-range");
    }else{
      upstreamHeaders.set("X-HJ-Telegram-Range",upstream.status===206?"206":"full");
    }

    // Full responses are cached as well, guarded by the same per-media lock.
    if(env.MEDIA_CACHE&&upstream.status===200&&!range.requested&&upstream.body&&ctx){
      ctx.waitUntil((async()=>{
        let acquired=false;
        try{
          const lock=await listenerStub.acquireFill(cacheKey);
          acquired=Boolean(lock?.acquired);
          if(!acquired||await env.MEDIA_CACHE.head(cacheKey)) return;
          const clone=upstream.clone();
          const uploadedAt=Date.now();
          await env.MEDIA_CACHE.put(cacheKey,clone.body,{
            httpMetadata:{contentType:indexed.mime_type||"application/octet-stream",contentDisposition:upstreamHeaders.get("Content-Disposition")||"inline",cacheControl:"private, no-store"},
            customMetadata:{duration_ms:String(Math.max(0,Number(indexed.duration||0)*1000)),uploaded_at:String(uploadedAt),message_id:String(messageId),media_kind:String(kind)}
          });
          await listenerStub.prime(cacheKey,Math.max(0,Number(indexed.duration||0)*1000),uploadedAt);
        }catch(error){
          console.warn("HJ R2 full-response cache write failed",String(error?.message||error).slice(0,180));
        }finally{
          if(acquired)try{await listenerStub.releaseFill(cacheKey);}catch{}
        }
      })());
    }

    return new Response(upstream.body,{status:upstream.status,headers:upstreamHeaders});
  }catch(error){
    console.error("HJ Bot API media error",{kind,messageId:Number(messageId),error:String(error?.message||error).slice(0,220)});
    return mediaError(502,"MEDIA_STREAM_ERROR",origin,env,error?.message||error);
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
  const mediaType = ["audio", "video", "document"].includes(requestedType) ? requestedType : "audio";

  try {
    const params = new URLSearchParams({
      select: "telegram_message_id,file_name,mime_type,file_size,duration,width,height,updated_at",
      media_kind: "eq." + mediaType,
      order: "telegram_message_id.desc",
      limit: String(limit),
    });
    if (offsetId > 0) params.set("telegram_message_id", "lt." + String(offsetId));
    const rows = await mediaIndexJson(
      env,
      "/rest/v1/telegram_media_index?" + params.toString()
    );
    const mediaMessages = Array.isArray(rows)
      ? rows.map((row) => ({
          messageId: Number(row.telegram_message_id),
          fileName: row.file_name || (mediaType === "video" ? "video.mp4" : mediaType === "document" ? "book.pdf" : "audio.m4a"),
          mimeType: row.mime_type || "",
          size: Number(row.file_size || 0),
          duration: Number(row.duration || 0),
          width: Number(row.width || 0),
          height: Number(row.height || 0),
          date: row.updated_at || null,
        }))
      : [];

    const nextOffsetId = mediaMessages.length >= limit
      ? Number(mediaMessages[mediaMessages.length - 1]?.messageId || 0)
      : 0;
    const headers = new Headers();
    applyCors(headers, origin, env);
    headers.set("Cache-Control", "no-store");
    headers.set("X-HJ-Telegram-Next-Offset", nextOffsetId ? String(nextOffsetId) : "");
    headers.set("X-HJ-Telegram-Has-More", nextOffsetId ? "true" : "false");
    headers.set("Content-Type", "application/json; charset=utf-8");

    return new Response(JSON.stringify(mediaMessages), { status: 200, headers });
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

async function handleTelegramStatus(request, env) {
  const missing = [];
  for (const key of [
    "TELEGRAM_BOT_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
  ]) {
    if (!envString(env, key)) missing.push(key);
  }
  if (!envString(env, "MEDIA_INDEX_SUPABASE_URL") && !envString(env, "SUPABASE_URL")) {
    missing.push("MEDIA_INDEX_SUPABASE_URL");
  }
  if (
    !envString(env, "MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY") &&
    !envString(env, "SUPABASE_SERVICE_ROLE_KEY")
  ) {
    missing.push("MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!envString(env, "SUPABASE_SERVICE_ROLE_KEY") && !envString(env, "MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY")) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  const hasMediaIndexUrl = Boolean(
    envString(env, "MEDIA_INDEX_SUPABASE_URL") || envString(env, "SUPABASE_URL")
  );
  const hasMediaIndexKey = Boolean(
    envString(env, "MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY") ||
    envString(env, "SUPABASE_SERVICE_ROLE_KEY")
  );
  if (!hasMediaIndexUrl) missing.push("MEDIA_INDEX_SUPABASE_URL");
  if (!hasMediaIndexKey) missing.push("MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY");
  const configured = missing.length === 0;
  return jsonResponse(
    {
      ok: configured,
      telegramConfigured: Boolean(envString(env, "TELEGRAM_BOT_TOKEN")),
      botApiStreaming: true,
      mediaIndexConfigured: hasMediaIndexUrl && hasMediaIndexKey,
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
      if (method !== "GET" && method !== "HEAD" && method !== "POST") {
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
      if (url.pathname === "/listener/start") return handleListener(request, env, "start");
      if (url.pathname === "/listener/heartbeat") return handleListener(request, env, "heartbeat");
      if (url.pathname === "/listener/end") return handleListener(request, env, "end");
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

--37b1ce9e6ca725b46ce178082bcd5b82698c2246cece2eef3f3f70273f4a
Content-Disposition: form-data; name="pure.js"; filename="pure.js"
Content-Type: application/javascript+module

export const MEDIA_CHUNK_SIZE = 1024 * 1024;
export const MEDIA_TICKET_TTL_MS = 5 * 60 * 1000;
export const MEDIA_METADATA_TTL_MS = 5 * 60 * 1000;
export const MAX_METADATA_CACHE = 128;

export function parseMessageId(raw) {
  const value = Number(String(raw ?? "").trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function parseSingleRange(header, size, maxBytes = MEDIA_CHUNK_SIZE) {
  const fileSize = Number(size);
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    return { error: "invalid-size" };
  }

  const raw = String(header ?? "").trim();
  if (!raw) {
    return {
      start: 0,
      end: fileSize - 1,
      length: fileSize,
      partial: false,
      requested: false,
    };
  }

  if (!raw.toLowerCase().startsWith("bytes=")) {
    return { error: "invalid-unit" };
  }

  const spec = raw.slice(6).trim();
  if (!spec || spec.includes(",")) {
    return { error: "multiple-or-empty-range" };
  }

  const match = spec.match(/^(\d*)-(\d*)$/);
  if (!match) {
    return { error: "invalid-range" };
  }

  const [, left, right] = match;
  let start;
  let end;

  if (!left && !right) {
    return { error: "invalid-range" };
  }

  if (!left) {
    const suffixLength = Number(right);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { error: "unsatisfiable" };
    }
    const length = Math.min(suffixLength, fileSize, maxBytes);
    start = fileSize - length;
    end = fileSize - 1;
  } else {
    start = Number(left);
    if (!Number.isSafeInteger(start) || start < 0 || start >= fileSize) {
      return { error: "unsatisfiable" };
    }
    end = right ? Number(right) : fileSize - 1;
    if (!Number.isSafeInteger(end) || end < start) {
      return { error: "unsatisfiable" };
    }
    end = Math.min(end, fileSize - 1, start + maxBytes - 1);
  }

  const length = end - start + 1;
  return {
    start,
    end,
    length,
    partial: true,
    requested: true,
  };
}

export function normalizeOriginList(raw) {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

export function inferMimeType(document, routeKind) {
  const explicit = String(document?.mimeType || "").trim().toLowerCase();
  if (explicit && explicit !== "application/octet-stream") return explicit;

  const filename = String(
    (document?.attributes || []).find(
      (attr) => attr?.className === "DocumentAttributeFilename"
    )?.fileName || ""
  ).toLowerCase();

  const byExtension = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg; codecs=opus",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".pdf": "application/pdf",
    ".epub": "application/epub+zip",
  };

  for (const [ext, mime] of Object.entries(byExtension)) {
    if (filename.endsWith(ext)) return mime;
  }

  if (routeKind === "video") return "video/mp4";
  if (routeKind === "document") return "application/octet-stream";
  return "audio/mp4";
}

export function inferFilename(document, routeKind) {
  const raw = String(
    (document?.attributes || []).find(
      (attr) => attr?.className === "DocumentAttributeFilename"
    )?.fileName || ""
  ).trim();

  if (raw) return raw;
  if (routeKind === "video") return "video.mp4";
  if (routeKind === "document") return "document";
  return "audio.m4a";
}

export function safeAsciiFilename(name, fallback) {
  const ascii = String(name || "")
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\r\n]/g, "_")
    .trim();
  return ascii || fallback;
}

export function encodeDispositionFilename(name) {
  return encodeURIComponent(String(name || "media")).replace(
    /['()*]/g,
    (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase()
  );
}

export function errorPayload(code, error = "") {
  const normalized = String(error || "").replace(/[\r\n]+/g, " ").slice(0, 180);
  return normalized ? { error: code, detail: normalized } : { error: code };
}

--37b1ce9e6ca725b46ce178082bcd5b82698c2246cece2eef3f3f70273f4a--