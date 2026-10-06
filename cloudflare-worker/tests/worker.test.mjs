import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

const env = {};

test("worker health route works without Telegram secrets", async () => {
  const response = await worker.fetch(
    new Request("https://worker.example/health"),
    env,
    { waitUntil() {} }
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.directTelegram, true);
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
  assert.notEqual(response.status, 404);
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
