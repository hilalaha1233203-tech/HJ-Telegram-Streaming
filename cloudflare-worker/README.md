# HJ GROUPS — Lightweight Telegram Bot API Streaming

This Worker is the browser-facing media gateway for the HJ GROUPS website.

## Runtime architecture

Browser -> Cloudflare Worker -> Telegram Bot API getFile -> Telegram file response -> Browser

The Worker no longer uses the heavy MTProto teleproto client for website media delivery. This is intentional: the free Worker CPU limit previously terminated the MTProto streaming request.

## Required Worker secrets / variables

Set these in Cloudflare; never commit them:

- TELEGRAM_BOT_TOKEN
- STORAGE_CHAT_ID (recommended when multiple storage channels exist)
- SUPABASE_URL
- SUPABASE_PUBLISHABLE_KEY
- SUPABASE_SERVICE_ROLE_KEY (fallback for the index if both databases are the same)
- MEDIA_INDEX_SUPABASE_URL (recommended when Store Keeper and website use different Supabase projects)
- MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY (server-only key for the Store Keeper index project)
- HJ_WEB_BASE_URL
- MEDIA_TICKET_SECRET
- CORS_ALLOWED_ORIGINS

The website database is used for content/access policy (`episodes`, `video_episodes`, `books`). The Store Keeper database contains the server-only `telegram_media_index`. When those are different Supabase projects, set `MEDIA_INDEX_SUPABASE_URL` and `MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY`; otherwise the Worker falls back to the regular Supabase URL/service key.
Never expose any service-role key to the browser.

## Media requirement

Telegram Bot API getFile currently supports bot downloads up to 20 MB. The Worker intentionally returns HTTP 413 for indexed media above 20 MB. Use the HJ Store Keeper Compression Center and the 19 MB — Web Stream target for website playback.

The Worker passes browser Range requests to Telegram's file URL and preserves a 206 response when Telegram honors the range. If Telegram returns a full 200 response to a requested range, the Worker forwards that response and marks X-HJ-Telegram-Range accordingly; a live browser seek test is still required after deployment.

## Existing website routes

- GET /audio/message/:messageId
- GET /video/message/:messageId
- GET /document/message/:messageId
- HEAD equivalents
- GET /media-ticket/:type/message/:messageId
- GET /telegram/messages
- GET /telegram/status
- GET /health

## Deployment

From cloudflare-worker/:

1. npm install
2. npm run test
3. npm run dry-run
4. npx wrangler deploy

Then configure the Worker secrets with wrangler secret put NAME.

The old TELEGRAM_API_ID, TELEGRAM_API_HASH and TELEGRAM_SESSION secrets can remain for the old branch, but this Worker code does not use them for media delivery.
