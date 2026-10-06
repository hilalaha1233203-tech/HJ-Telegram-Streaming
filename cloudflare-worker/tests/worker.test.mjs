import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import worker from "../src/index.js";

const env = {};

function makeTicket(secret, kind, messageId, userId, userAgent) {
  const payload = Buffer.from(
    JSON.stringify({
      kind,
      messageId,
      userId,
      ua: createHash("sha256").update(userAgent).digest("base64url"),
      exp: Date.now() + 5 * 60 * 1000,
    })
  ).toString("base64url");

  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return payload + "." + signature;
}

test("worker health route works without Telegram secrets", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/health"),
    env,
    { waitUntil() {} }
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.directTelegram, false);
  assert.equal(payload.botApiStreaming, true);
});

test("media route is matched and validates its message id", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/audio/message/not-an-id"),
    env,
    { waitUntil() {} }
  );
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error, "INVALID_MESSAGE_ID");
});

test("valid media route never falls through to 404", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/audio/message/7"),
    env,
    { waitUntil() {} }
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, "MEDIA_ACCESS_DENIED");
});

test("media ticket route is matched separately", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/media-ticket/audio/message/7"),
    env,
    { waitUntil() {} }
  );
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, "MEDIA_ACCESS_DENIED");
});

test("valid protected ticket uses protected CORS and never becomes public", async () => {
  const secret = "test-secret";
  const userAgent = "HJ-Test-Agent/1.0";
  const ticket = makeTicket(secret, "audio", 7, "test-user", userAgent);

  const response = await worker.fetch(
    new Request("https://worker.example/audio/message/7?ticket=" + encodeURIComponent(ticket), {
      headers: {
        Origin: "https://hj-groups-web.vercel.app",
        "User-Agent": userAgent,
      },
    }),
    {
      TELEGRAM_API_ID: "1",
      TELEGRAM_API_HASH: "test",
      TELEGRAM_SESSION: "1test-session",
      CHANNEL_ID: "-1001234567890",
      MEDIA_TICKET_SECRET: secret,
    },
    { waitUntil() {} }
  );

  assert.equal(response.status, 502);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://hj-groups-web.vercel.app"
  );
  assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
});
