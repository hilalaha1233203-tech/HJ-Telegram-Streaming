# HJ GROUPS — Cloudflare Telegram Media Gateway

This directory contains the Cloudflare Worker used for the HJ GROUPS media gateway.

## Runtime architecture

`HJ web → Cloudflare Worker → Supabase media index → Telegram Bot API / R2 cache → browser`

The original Node/MTProto server at repository root remains intact for rollback and for media that the Bot API path cannot safely serve.

## Production routes

- `GET /health`
- `GET /audio/message/:messageId`
- `HEAD /audio/message/:messageId`
- `GET /video/message/:messageId`
- `HEAD /video/message/:messageId`
- `GET /document/message/:messageId`
- `HEAD /document/message/:messageId`
- `GET /media-ticket/:type/message/:messageId`
- `GET /telegram/status`
- listener lifecycle endpoints used by the player

The Worker preserves HTTP range semantics and emits `206`, `Content-Range`, `Content-Length`, and `Accept-Ranges` for satisfiable single-range requests.

## Telegram Bot API limit — important

The official Telegram Bot API `getFile` download method currently supports files up to **20 MB**. That means a cache-miss for a larger Telegram file cannot be treated as a successful Cloudflare-only media path.

The current HJ production test file is around 23 MB. A real Message 7 test must therefore verify whether that media is already present in the configured R2 cache or whether the request needs to remain on the existing MTProto/Node path. Do not declare large-file Cloudflare streaming production-ready until this is proven.

## Cloudflare resources

- Worker: `hj-telegram-streaming`
- Durable Object: `MediaListener`
- R2 bucket: `hj-groups-media`

The Durable Object namespace and R2 bucket are existing production resources. Do not delete them during migration.

## Environment / secrets

Configure these in Cloudflare. Never commit secret values:

```text
TELEGRAM_BOT_TOKEN
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
MEDIA_INDEX_SUPABASE_URL
MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY
HJ_WEB_BASE_URL
MEDIA_TICKET_SECRET
CORS_ALLOWED_ORIGINS
STORAGE_CHAT_ID
```

## Deployment

From `cloudflare-worker/`:

```bash
npm install
npm test
npm run dry-run
npx wrangler deploy
```

The repository also keeps the original Node/MTProto implementation so rollback is immediate if a media compatibility test fails.

## Verification gate

Before changing the HJ production streaming URL, verify all of the following against the real Worker:

```text
/health
/telegram/status
Message 7 HEAD
Message 7 GET
Range bytes=0-524287
Range bytes=524288-1048575
multiple seek requests
download
CORS preflight
invalid message ID
unavailable media
large-file behaviour
```

A successful Worker deployment alone is not sufficient evidence of production readiness.

## Rollback

Rollback target is the existing Node/MTProto server and its current deployment. Do not remove that deployment until the Cloudflare path passes the real regression matrix.
