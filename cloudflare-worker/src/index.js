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
  "https://hj-groups-web.vercel.app",
  "https://hj-groups-website.getvoroa.com",
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

async function telegramFileResponse(env, filePath, request) {
  const token = envString(env, "TELEGRAM_BOT_TOKEN");
  const headers = new Headers();
  const range = request.headers.get("range");
  if (range) headers.set("Range", range);
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
  headers.set("ETag", "\"tg-" + kind + "-" + indexed.telegram_message_id + "-" + indexed.file_size + "\"");
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

const MEDIA_MAX_DURATION_MS=24*60*60*1000; const MEDIA_CACHE_GRACE_MS=15*60*1000; const MEDIA_LISTENER_LEASE_MS=45*1000;
export class MediaListener extends DurableObject { constructor(ctx,env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS listeners (session_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,last_seen INTEGER NOT NULL,lease_until INTEGER NOT NULL,ended_at INTEGER)");ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS media_state (cache_key TEXT PRIMARY KEY,base_expiry INTEGER NOT NULL,last_listener_end INTEGER NOT NULL DEFAULT 0)");});} async prime(cacheKey,durationMs,uploadedAt=Date.now()){const now=Date.now(),d=Math.min(MEDIA_MAX_DURATION_MS,Math.max(0,Number(durationMs)||0)),u=Number.isFinite(Number(uploadedAt))?Number(uploadedAt):now,base=u+d+MEDIA_CACHE_GRACE_MS;this.ctx.storage.sql.exec("INSERT INTO media_state (cache_key,base_expiry,last_listener_end) VALUES (?,?,0) ON CONFLICT(cache_key) DO UPDATE SET base_expiry=MAX(base_expiry,excluded.base_expiry)",String(cacheKey),base);await this.schedule();return {ok:true,baseExpiry:base};} async start(userId,durationMs,cacheKey,uploadedAt=Date.now()){const now=Date.now(),d=Math.min(MEDIA_MAX_DURATION_MS,Math.max(0,Number(durationMs)||0)),u=Number.isFinite(Number(uploadedAt))?Number(uploadedAt):now,base=u+d+MEDIA_CACHE_GRACE_MS;this.ctx.storage.sql.exec("INSERT INTO media_state (cache_key,base_expiry,last_listener_end) VALUES (?,?,0) ON CONFLICT(cache_key) DO UPDATE SET base_expiry=MAX(base_expiry,excluded.base_expiry)",String(cacheKey),base);const sessionId=crypto.randomUUID();this.ctx.storage.sql.exec("INSERT INTO listeners (session_id,user_id,last_seen,lease_until,ended_at) VALUES (?,?,?,?,NULL)",sessionId,String(userId),now,now+MEDIA_LISTENER_LEASE_MS);await this.schedule();return {sessionId,baseExpiry:base};} async heartbeat(sessionId){const now=Date.now(),r=this.ctx.storage.sql.exec("UPDATE listeners SET last_seen=?,lease_until=?,ended_at=NULL WHERE session_id=? AND ended_at IS NULL",now,now+MEDIA_LISTENER_LEASE_MS,String(sessionId));if(r.rowsWritten>0)await this.schedule();return {ok:r.rowsWritten>0};} async end(sessionId){const now=Date.now(),r=this.ctx.storage.sql.exec("UPDATE listeners SET ended_at=?,lease_until=? WHERE session_id=? AND ended_at IS NULL",now,now,String(sessionId));if(r.rowsWritten>0){this.ctx.storage.sql.exec("UPDATE media_state SET last_listener_end=MAX(last_listener_end,?)",now);await this.schedule();}return {ok:r.rowsWritten>0};} async alarm(){const now=Date.now();this.expireLeases(now);const s=this.ctx.storage.sql.exec("SELECT cache_key,base_expiry,last_listener_end FROM media_state LIMIT 1").one();if(!s?.cache_key){await this.ctx.storage.deleteAlarm();return;}const active=Number(this.ctx.storage.sql.exec("SELECT COUNT(*) AS active FROM listeners WHERE ended_at IS NULL AND lease_until>?",now).one()?.active||0);if(active>0){await this.schedule();return;}const deleteAt=Math.max(Number(s.base_expiry||0),Number(s.last_listener_end||0)+MEDIA_CACHE_GRACE_MS);if(now>=deleteAt){if(this.env.MEDIA_CACHE)await this.env.MEDIA_CACHE.delete(String(s.cache_key));this.ctx.storage.sql.exec("DELETE FROM listeners");this.ctx.storage.sql.exec("DELETE FROM media_state");await this.ctx.storage.deleteAlarm();return;}await this.ctx.storage.setAlarm(deleteAt);} expireLeases(now){const r=this.ctx.storage.sql.exec("UPDATE listeners SET ended_at=last_seen WHERE ended_at IS NULL AND lease_until<=?",now);if(r.rowsWritten>0){const row=this.ctx.storage.sql.exec("SELECT MAX(ended_at) AS last_end FROM listeners WHERE ended_at IS NOT NULL").one();if(Number(row?.last_end||0)>0)this.ctx.storage.sql.exec("UPDATE media_state SET last_listener_end=MAX(last_listener_end,?)",Number(row.last_end));}} async schedule(){const now=Date.now(),s=this.ctx.storage.sql.exec("SELECT base_expiry,last_listener_end FROM media_state LIMIT 1").one(),nl=Number(this.ctx.storage.sql.exec("SELECT MIN(lease_until) AS next_lease FROM listeners WHERE ended_at IS NULL").one()?.next_lease||0),da=Math.max(Number(s?.base_expiry||0),Number(s?.last_listener_end||0)+MEDIA_CACHE_GRACE_MS),next=nl>now?Math.min(nl,da||nl):da;await this.ctx.storage.setAlarm(next>now?next:now+1000);}}

function mediaCacheKey(kind,indexed){return "media/"+String(kind)+"/"+String(indexed.telegram_message_id)+"/"+encodeURIComponent(String(indexed.file_id||"file"))+"-"+String(indexed.file_size||0);}
function mediaListenerStub(env,kind,messageId){return env.MEDIA_LISTENER.getByName(String(kind)+":"+String(messageId));}
async function listenerUser(request,env,kind,messageId){const t=String(new URL(request.url).searchParams.get("ticket")||"").trim(),tu=verifyMediaTicket(env,t,kind,messageId,request.headers.get("user-agent")||"");if(tu?.userId)return String(tu.userId);const a=String(request.headers.get("authorization")||"").trim(),u=await getSupabaseUser(env,a);if(u?.id)return String(u.id);const anon=String(new URL(request.url).searchParams.get("listenerId")||"").trim();return anon?("anon:"+anon):null;}
async function handleListener(request,env,action){const origin=request.headers.get("origin")||"",url=new URL(request.url),kind=String(url.searchParams.get("kind")||"").toLowerCase(),messageId=parseMessageId(url.searchParams.get("messageId"));if(!["audio","video","document"].includes(kind)||!messageId)return mediaError(400,"INVALID_LISTENER_REQUEST",origin,env);const access=await inspectMediaAccess(env,request,kind,messageId);if(!access.ok)return mediaError(access.status||403,"MEDIA_ACCESS_DENIED",origin,env,access.error);const indexed=await getIndexedMedia(env,kind,messageId);if(!indexed)return mediaError(404,"MEDIA_INDEX_NOT_FOUND",origin,env);const userId=await listenerUser(request,env,kind,messageId);if(!userId)return mediaError(401,"LISTENER_AUTH_REQUIRED",origin,env);const stub=mediaListenerStub(env,kind,messageId),cacheKey=mediaCacheKey(kind,indexed);let result;if(action==="start"){const requestedDurationMs=Number(url.searchParams.get("durationMs")||0);const indexedDurationMs=Math.max(0,Number(indexed.duration||0)*1000);const effectiveDurationMs=Math.min(MEDIA_MAX_DURATION_MS,Math.max(0,Number.isFinite(requestedDurationMs)&&requestedDurationMs>0?requestedDurationMs:indexedDurationMs));let uploadedAt=Date.now();if(env.MEDIA_CACHE){try{const head=await env.MEDIA_CACHE.head(cacheKey);if(head?.uploaded)uploadedAt=head.uploaded.getTime();}catch{}}result=await stub.start(userId,effectiveDurationMs,cacheKey,uploadedAt);}else{const sid=String(url.searchParams.get("sessionId")||"").trim();if(!sid)return mediaError(400,"LISTENER_SESSION_REQUIRED",origin,env);result=action==="heartbeat"?await stub.heartbeat(sid):await stub.end(sid);}return jsonResponse(result,200,origin,env);}
async function handleMedia(request, env, kind, messageId, ctx) {
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
    const indexed = await getIndexedMedia(env, kind, Number(messageId));
    if (!indexed) return mediaError(404, "MEDIA_INDEX_NOT_FOUND", origin, env);

  --- TRUNCATED --- 40,771 char