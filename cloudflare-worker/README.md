# HJ GROUPS — Cloudflare Telegram Media Gateway

The cloudflare-worker directory is the final containerless streaming runtime for HJ GROUPS.

## Runtime

Browser -> Cloudflare Worker -> access/ticket check -> R2 temporary cache -> browser.

On a cache miss, the Worker resolves the stored Telegram Bot API file_id, downloads the source as a stream, writes a temporary R2 object, validates it, promotes it to the deterministic final key, and only then serves the requested bytes from R2.

The root server.js Node/MTProto implementation is retained only as a rollback/manual-maintenance path. It is not bound by the final Cloudflare Worker runtime.

## Production routes

Media:
- GET /audio/message/:messageId
- HEAD /audio/message/:messageId
- GET /video/message/:messageId
- HEAD /video/message/:messageId
- GET /document/message/:messageId
- HEAD /document/message/:messageId

Security:
- GET /media-ticket/:type/message/:messageId

Compatibility / admin:
- GET /health
- GET /telegram/status
- GET /telegram/messages
- /listener/start
- /listener/heartbeat
- /listener/end

OPTIONS is supported globally with CORS headers. Listener endpoints intentionally return 200 {"ok":true} and keep no state, so the existing frontend heartbeat code remains compatible without Durable Objects.

## R2 cache

Only the existing MEDIA_CACHE binding is used:

- Bucket: hj-groups-media
- Binding: MEDIA_CACHE

No additional bucket is created.

All streaming cache objects use the streaming-cache/ prefix.

Direct media keys include:
- media kind
- verified Telegram identity (file_unique_id where available, otherwise chat/message/kind identity)
- source size
- version hash derived from content identity, file_id, MIME type, and DB update version

Chunk keys include:
- episode/content id
- chunk index
- file_unique_id
- chunk size
- version hash

This prevents a stale cache object from being reused as a different file.

## Cache validation and writes

Every R2 cache HIT validates:
- expected object size
- MIME type
- cache completion metadata
- media/chunk identity and version
- non-empty R2 ETag
- SHA-256 checksum when the episode_chunks.sha256 value is available

A mismatch is treated as a MISS and the stale object is deleted before a safe rewrite.

Cache writes use a temporary object under streaming-cache/....tmp-*. The Worker waits for the write to complete, validates the temporary object, streams that object into the deterministic final key, validates the final key, and only then serves it.

Concurrent identical MISS requests are intentionally idempotent. They may both fetch/write the same deterministic key; only a fully validated object is served.

## Range / seek semantics

Single HTTP ranges are parsed without the previous 1 MiB cap.

For R2 HITs the Worker uses R2 ranged reads and returns:
- 206 for satisfiable ranges
- 416 plus Content-Range: bytes */SIZE for unsatisfiable ranges
- exact Content-Length
- Content-Range
- Accept-Ranges: bytes

HEAD never needs to download Telegram media. OPTIONS remains a CORS preflight.

## Chunked playback for >20 MB Telegram files

The Cloud Bot API getFile path cannot download a source above its 20 MB limit. For oversized episodes, the Worker checks the optional Phase 4 episode_chunks table.

Expected schema:

```
episode_id
idx
telegram_file_id
file_unique_id
size
sha256
```

Rules:
- chunks must be ordered from idx = 0
- each chunk must be <= 19 MB
- each chunk must have a file_id, unique id, positive size, and 64-character SHA-256
- logical media size is the sum of chunk sizes
- a requested byte range is mapped to only the intersecting chunks
- each chunk is cached independently in R2
- chunk R2 writes use the DB SHA-256 checksum
- full play streams the ordered chunk sequence without assembling the whole file in Worker memory
- the current Worker caps one request at 20 chunks so the Telegram getFile + file-download calls remain within normal Worker external-subrequest headroom

If an oversized source has no valid chunk rows, the Worker returns:

```json
{
  "error": "TELEGRAM_FILE_TOO_LARGE",
  "hint": "needs_split"
}
```

with HTTP 413.

The Worker never pretends an oversized source was cached successfully.

## Telegram source

Only the stored Bot API file_id is used. The Worker calls getFile, then streams the returned file URL directly into R2. It does not buffer the whole source in Worker memory.

If Telegram reports or returns a source size inconsistent with the verified index/chunk metadata, the request fails safely and the media is not served.

## Cleanup

No Durable Objects, heartbeats, leases, alarms, or listener state are used by the streaming runtime.

R2 lifecycle rule:

```
Bucket: hj-groups-media
Prefix: streaming-cache/
Rule: streaming-cache-2d
Expiration: 2 days after object age
```

Apply with Wrangler:

```bash
npx wrangler r2 bucket lifecycle add hj-groups-media streaming-cache-2d streaming-cache/ --expire-days 2 --force
```

This rule covers final cache objects and temporary write objects because both use the streaming-cache/ prefix. Lifecycle deletion simply turns the object into a cache MISS; the next play recreates it from Telegram.

## Environment / secrets

Set these in the Cloudflare Worker environment. Never commit real values:

```
TELEGRAM_BOT_TOKEN
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
MEDIA_INDEX_SUPABASE_URL
MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY
EPISODE_CHUNKS_SUPABASE_URL
EPISODE_CHUNKS_SUPABASE_SERVICE_ROLE_KEY
HJ_WEB_BASE_URL
MEDIA_TICKET_SECRET
CORS_ALLOWED_ORIGINS
STORAGE_CHAT_ID
```

EPISODE_CHUNKS_* may remain unset until Phase 4 creates/exposes the episode_chunks table; the Worker then falls back to SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

## Tests

From cloudflare-worker:

```bash
npm install
npm test
npm run dry-run
```

The integration suite runs in Cloudflare's Workers test runtime with an R2 binding and covers:

```
MISS -> Telegram -> R2 -> response
HIT -> R2 only
Range / seek / 206
HEAD
OPTIONS / CORS
416
missing media
oversized source without chunks
chunked full play
chunked in-chunk range
chunked cross-boundary range
seek to the last chunk
missing/malformed chunk
corrupted cache -> rewrite
deleted cache -> recreate
ticket creation
expired ticket
wrong user
wrong user-agent
unauthorized protected media
listener compatibility
all three final media routes
```

A passing Worker build/test does not by itself prove live production media readiness. Live verification must still use the real Worker, real R2 binding, real Supabase data, and a permitted test media item.

## Rollback

Rollback remains possible because the original Node/MTProto source is retained at repository root, but the intended production streaming runtime is now the Cloudflare Worker.
