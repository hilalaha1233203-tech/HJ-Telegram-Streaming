# HJ GROUPS — Cloudflare Direct Telegram Streaming

This worker is the direct-media replacement for the old Node/Render streaming hop.

## Runtime architecture

`Telegram MTProto → Cloudflare Worker → Browser`

The existing website routes remain compatible:

- `GET /audio/message/:messageId`
- `GET /video/message/:messageId`
- `GET /document/message/:messageId`
- `HEAD` equivalents
- `GET /media-ticket/:type/message/:messageId`
- `GET /telegram/messages`
- `GET /telegram/status`
- `GET /health`

The Worker deliberately serves media in bounded HTTP Range chunks (512 KiB maximum per request). This avoids buffering an entire episode in memory and lets browser media elements continue with normal byte-range requests.

Public media chunks are cached at Cloudflare's edge cache. Protected media with signed tickets is never cached.

## Required Worker secrets / variables

Set these in Cloudflare; never commit them:

```text
TELEGRAM_API_ID
TELEGRAM_API_HASH
TELEGRAM_SESSION
CHANNEL_ID
MEDIA_TICKET_SECRET
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY
HJ_WEB_BASE_URL
CORS_ALLOWED_ORIGINS
```

Use a strong random `MEDIA_TICKET_SECRET`.

## Important plan note

The Workers Free plan has a 10 ms CPU limit per invocation. The Workers Paid plan starts at $5/month and has no additional data-transfer/egress or throughput charge; its standard model includes 30 million CPU milliseconds/month. For reliable MTProto media streaming, use Workers Paid rather than relying on the 10 ms Free CPU ceiling.

## Deployment

From `cloudflare-worker/`:

```bash
npm install
npx wrangler login
npm run test
npm run dry-run
npx wrangler deploy
```

Then set secrets with `npx wrangler secret put NAME`.

After deployment, verify:

```text
GET /health
GET /telegram/status?ping=1
HEAD /audio/message/7
GET /audio/message/7
Range: bytes=0-524287
Range: bytes=524288-1048575
```

Set the website's existing `VITE_STREAMING_SERVER_URL` to the Worker URL. No Episode Analytics changes are required.

## Security rules

- Telegram credentials are Worker secrets.
- Protected media still uses the HJ entitlement authority through `/api/shortener/access`.
- Signed media tickets are bound to user-agent and expire after 5 minutes.
- Free public chunks use wildcard CORS because they contain no browser credentials.
- The Worker never returns the Telegram session in an error response.
