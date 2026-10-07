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

function mockResponse(body, status = 200, headers = {}) {
  return new Response(body, { status, headers });
}

function installWorkerFetch({ size = 1024 * 1024, accessType = "free", messageId = 7 } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const total = Number(size);
  const firstByte = new Uint8Array([1, 2, 3, 4]);
  const secondByte = new Uint8Array([9, 8, 7, 6]);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input?.url || input);
    const headers = new Headers(init?.headers || input?.headers || {});
    calls.push({ url, headers });

    if (url.includes("/rest/v1/episodes?")) {
      return mockResponse(
        JSON.stringify([{ id: 9001, access_type: accessType, available: true, number: 1 }]),
        200,
        { "content-type": "application/json" }
      );
    }

    if (url.includes("/rest/v1/telegram_media_index?")) {
      return mockResponse(
        JSON.stringify([{
          storage_chat_id: -100123,
          telegram_message_id: messageId,
          media_kind: "audio",
          file_id: "file-test-7",
          file_unique_id: "unique-test-7",
          file_name: "episode.m4a",
          mime_type: "audio/mp4",
          file_size: total,
          duration: 30,
          width: 0,
          height: 0,
          updated_at: new Date().toISOString(),
        }]),
        200,
        { "content-type": "application/json" }
      );
    }

    if (url.startsWith("https://api.telegram.org/botTEST_TOKEN/getFile")) {
      return mockResponse(
        JSON.stringify({ ok: true, result: { file_path: "audio/episode.m4a" } }),
        200,
        { "content-type": "application/json" }
      );
    }

    if (url.startsWith("https://api.telegram.org/file/botTEST_TOKEN/audio/episode.m4a")) {
      const range = headers.get("range");
      if (!range) {
        return mockResponse(new Uint8Array(total).fill(42), 200, {
          "content-type": "audio/mp4",
          "content-length": String(total),
          "accept-ranges": "bytes",
        });
      }
      const match = range.match(/^bytes=(\d+)-(\d+)$/);
      const start = Number(match[1]);
      const end = Number(match[2]);
      const length = end - start + 1;
      const payload = new Uint8Array(length);
      payload.fill(start === 0 ? 11 : 22);
      return mockResponse(payload, 206, {
        "content-type": "audio/mp4",
        "content-length": String(length),
        "content-range": `bytes ${start}-${end}/${total}`,
        "accept-ranges": "bytes",
      });
    }

    throw new Error("Unexpected fetch URL: " + url);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
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


test("HEAD media route returns exact metadata without Bot API download", async () => {
  const mock = installWorkerFetch({ size: 1024 * 1024 });
  try {
    const response = await worker.fetch(
      new Request("https://worker.example/audio/message/7", {
        method: "HEAD",
        headers: { Origin: "https://hj-groups-web.vercel.app" },
      }),
      {
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
      },
      { waitUntil() {} }
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Length"), String(1024 * 1024));
    assert.equal(response.headers.get("Accept-Ranges"), "bytes");
    assert.equal(response.headers.get("Content-Type"), "audio/mp4");
    assert.equal(mock.calls.filter((call) => call.url.includes("/getFile")).length, 0);
  } finally {
    mock.restore();
  }
});

test("Worker can use a separate media-index Supabase project", async () => {
  const mock = installWorkerFetch({ size: 1024 * 1024 });
  try {
    const response = await worker.fetch(
      new Request("https://worker.example/audio/message/7", {
        headers: { Range: "bytes=0-127" },
      }),
      {
        SUPABASE_URL: "https://web-supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_SERVICE_ROLE_KEY: "web-service-unused",
        MEDIA_INDEX_SUPABASE_URL: "https://index-supabase.example",
        MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY: "index-service",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
      },
      { waitUntil() {} }
    );
    assert.equal(response.status, 206);
    assert.equal(
      mock.calls.some((call) =>
        call.url.startsWith("https://web-supabase.example/rest/v1/episodes?")
      ),
      true
    );
    assert.equal(
      mock.calls.some((call) =>
        call.url.startsWith("https://index-supabase.example/rest/v1/telegram_media_index?")
      ),
      true
    );
    assert.equal((await response.arrayBuffer()).byteLength, 128);
  } finally {
    mock.restore();
  }
});

test("GET range 1 returns 206 with the requested 512 KiB body", async () => {
  const mock = installWorkerFetch({ size: 2 * 1024 * 1024 });
  try {
    const response = await worker.fetch(
      new Request("https://worker.example/audio/message/7", {
        headers: {
          Origin: "https://hj-groups-web.vercel.app",
          Range: "bytes=0-524287",
        },
      }),
      {
        SUPABASE_URL: "https://web-supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
        MEDIA_INDEX_SUPABASE_URL: "https://index-supabase.example",
        MEDIA_INDEX_SUPABASE_SERVICE_ROLE_KEY: "index-service",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
        STORAGE_CHAT_ID: "-100123",
      },
      { waitUntil() {} }
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), "bytes 0-524287/2097152");
    assert.equal(response.headers.get("Content-Length"), "524288");
    assert.equal((await response.arrayBuffer()).byteLength, 524288);
  } finally {
    mock.restore();
  }
});

test("GET range 2 returns a different body and exact second Content-Range", async () => {
  const mock = installWorkerFetch({ size: 2 * 1024 * 1024 });
  try {
    const first = await worker.fetch(
      new Request("https://worker.example/audio/message/7", {
        headers: { Range: "bytes=0-524287" },
      }),
      {
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
      },
      { waitUntil() {} }
    );
    const second = await worker.fetch(
      new Request("https://worker.example/audio/message/7", {
        headers: { Range: "bytes=524288-1048575" },
      }),
      {
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
      },
      { waitUntil() {} }
    );
    assert.equal(first.status, 206);
    assert.equal(second.status, 206);
    assert.equal(second.headers.get("Content-Range"), "bytes 524288-1048575/2097152");
    assert.equal(second.headers.get("Content-Length"), "524288");
    const firstBody = new Uint8Array(await first.arrayBuffer());
    const secondBody = new Uint8Array(await second.arrayBuffer());
    assert.equal(firstBody.length, 524288);
    assert.equal(secondBody.length, 524288);
    assert.notDeepEqual(firstBody.slice(0, 16), secondBody.slice(0, 16));
  } finally {
    mock.restore();
  }
});

test("media over 20 MiB is rejected before Telegram download", async () => {
  const mock = installWorkerFetch({ size: 21 * 1024 * 1024 });
  try {
    const response = await worker.fetch(
      new Request("https://worker.example/audio/message/7"),
      {
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        TELEGRAM_BOT_TOKEN: "TEST_TOKEN",
      },
      { waitUntil() {} }
    );
    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.equal(payload.error, "MEDIA_TOO_LARGE_FOR_BOT_API_STREAM");
    assert.equal(mock.calls.filter((call) => call.url.includes("/getFile")).length, 0);
  } finally {
    mock.restore();
  }
});

test("ticket with the wrong user-agent is rejected for protected media", async () => {
  const secret = "test-secret";
  const userAgent = "HJ-Test-Agent/1.0";
  const ticket = makeTicket(secret, "audio", 7, "test-user", userAgent);

  const mock = installWorkerFetch({ size: 1024 * 1024, accessType: "premium" });
  try {
    const response = await worker.fetch(
      new Request(
        "https://worker.example/audio/message/7?ticket=" + encodeURIComponent(ticket),
        { headers: { "User-Agent": "HJ-Different-Agent/9.0" } }
      ),
      {
        SUPABASE_URL: "https://supabase.example",
        SUPABASE_PUBLISHABLE_KEY: "publishable",
        SUPABASE_SERVICE_ROLE_KEY: "service",
        MEDIA_TICKET_SECRET: secret,
      },
      { waitUntil() {} }
    );
    assert.equal(response.status, 401);
  } finally {
    mock.restore();
  }
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
