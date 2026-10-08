import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import worker, {
  buildMediaDescriptor,
  buildChunkDescriptor,
  createMediaTicket,
} from "../src/index.js";

const MB = 1024 * 1024;
const ORIGIN = "https://test.example";

const BASE_MEDIA = {
  "audio:101": {
    index: {
      storage_chat_id: 12345,
      telegram_message_id: 101,
      media_kind: "audio",
      file_id: "fid-a101",
      file_unique_id: "uid-a101",
      file_name: "episode-101.m4a",
      mime_type: "audio/mp4",
      file_size: 20,
      duration: 10,
      updated_at: "2026-10-08T00:00:00Z",
    },
    policy: {
      id: 1,
      story_id: 10,
      access_type: "free",
      available: true,
      episode_number: 101,
      number: 101,
    },
    body: new TextEncoder().encode("0123456789ABCDEFGHIJ"),
  },
  "video:202": {
    index: {
      storage_chat_id: 12345,
      telegram_message_id: 202,
      media_kind: "video",
      file_id: "fid-v202",
      file_unique_id: "uid-v202",
      file_name: "clip-202.mp4",
      mime_type: "video/mp4",
      file_size: 10,
      duration: 5,
      updated_at: "2026-10-08T00:00:00Z",
    },
    policy: {
      id: 2,
      video_story_id: 20,
      access_type: "free",
      available: true,
      number: 1,
    },
    body: new TextEncoder().encode("VIDEO-202!"),
  },
  "document:303": {
    index: {
      storage_chat_id: 12345,
      telegram_message_id: 303,
      media_kind: "document",
      file_id: "fid-d303",
      file_unique_id: "uid-d303",
      file_name: "book-303.pdf",
      mime_type: "application/pdf",
      file_size: 10,
      updated_at: "2026-10-08T00:00:00Z",
    },
    policy: {
      id: 3,
      access_type: "free",
    },
    body: new TextEncoder().encode("%PDF-303!!"),
  },
  "audio:404": {
    index: {
      storage_chat_id: 12345,
      telegram_message_id: 404,
      media_kind: "audio",
      file_id: "fid-a404",
      file_unique_id: "uid-a404",
      file_name: "large.m4a",
      mime_type: "audio/mp4",
      file_size: 21 * MB,
      updated_at: "2026-10-08T00:00:00Z",
    },
    policy: {
      id: 4,
      story_id: 10,
      access_type: "free",
      available: true,
      episode_number: 404,
      number: 404,
    },
    body: new TextEncoder().encode("not downloaded"),
  },
};

const CHUNKS = {
  1: [
    { episode_id: 1, idx: 0, telegram_file_id: "chunk-1-a", file_unique_id: "chunkuid-1-a", size: 10, value: "ABCDEFGHIJ" },
    { episode_id: 1, idx: 1, telegram_file_id: "chunk-1-b", file_unique_id: "chunkuid-1-b", size: 10, value: "klmnopqrst" },
  ],
  5: [
    { episode_id: 5, idx: 0, telegram_file_id: "chunk-5-a", file_unique_id: "chunkuid-5-a", size: 8, value: "aaaaaaaa" },
    { episode_id: 5, idx: 1, telegram_file_id: "chunk-5-b", file_unique_id: "chunkuid-5-b", size: 8, value: "bbbbbbbb" },
    { episode_id: 5, idx: 2, telegram_file_id: "chunk-5-c", file_unique_id: "chunkuid-5-c", size: 8, value: "cccccccc" },
  ],
};

const state = {
  media: new Map(),
  chunks: new Map(),
  fileMap: new Map(),
  calls: { getFile: 0, file: 0 },
};

function cloneBaseMedia() {
  return new Map(
    Object.entries(BASE_MEDIA).map(([key, value]) => [
      key,
      {
        ...value,
        index: { ...value.index },
        policy: { ...value.policy },
        body: value.body.slice(),
      },
    ])
  );
}

async function sha256Hex(value) {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : value;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes)
  );
  return Array.from(digest, (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

async function makeChunkRows(episodeId) {
  return Promise.all(
    CHUNKS[episodeId].map(async (row) => ({
      ...row,
      sha256: await sha256Hex(row.value),
    }))
  );
}

function resetState() {
  state.media = cloneBaseMedia();
  state.chunks = new Map();
  state.fileMap = new Map();
  state.calls = { getFile: 0, file: 0 };

  for (const item of state.media.values()) {
    state.fileMap.set(item.index.file_id, {
      size: item.index.file_size,
      body: item.body,
      path: "source/" + item.index.file_id,
    });
  }
}

function authUserFromHeaders(options) {
  const auth = String(
    options?.headers?.get?.("authorization") ||
    options?.headers?.Authorization ||
    ""
  );
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  return match[1];
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

async function fakeFetch(input, options = {}) {
  const url = new URL(String(input));
  const path = url.pathname;

  if (url.origin === "https://supabase.test") {
    if (path === "/auth/v1/user") {
      const userId = authUserFromHeaders(options);
      if (!userId) return json({ message: "missing user" }, 401);
      return json({
        id: userId,
        app_metadata: { role: userId === "admin" ? "admin" : "user" },
      });
    }

    if (path === "/rest/v1/content_access_settings") {
      return json([{ audio_free_episodes: 0, video_free_episodes: 0 }]);
    }

    if (path === "/rest/v1/episode_chunks") {
      const rawId = url.searchParams.get("episode_id") || "";
      const episodeId = Number(rawId.replace(/^eq\./, ""));
      const rows = state.chunks.get(episodeId) || [];
      return json(rows);
    }

    if (path === "/rest/v1/telegram_media_index") {
      const rawId =
        url.searchParams.get("telegram_message_id") || "";
      const messageId = Number(rawId.replace(/^eq\./, ""));
      const kind =
        String(
          url.searchParams.get("media_kind") || ""
        ).replace(/^eq\./, "");
      const item = state.media.get(kind + ":" + messageId);
      return json(item ? [item.index] : []);
    }

    if (
      path === "/rest/v1/episodes" ||
      path === "/rest/v1/video_episodes" ||
      path === "/rest/v1/books"
    ) {
      const rawId =
        url.searchParams.get("telegram_message_id") || "";
      const messageId = Number(rawId.replace(/^eq\./, ""));
      const item = [...state.media.entries()].find(
        ([key]) => key.endsWith(":" + messageId)
      )?.[1];

      if (!item) return json([]);
      return json([item.policy]);
    }

    return json({ error: "unknown supabase path", path }, 404);
  }

  if (url.origin === "https://web.test") {
    if (path === "/api/shortener/access") {
      return json({ ok: true });
    }
    return json({ error: "unknown web path" }, 404);
  }

  if (url.origin === "https://api.telegram.org") {
    if (path.includes("/getFile")) {
      state.calls.getFile += 1;
      let bodyText = "";
      if (typeof options.body === "string") {
        bodyText = options.body;
      } else if (options.body) {
        bodyText = await new Response(options.body).text();
      }
      const payload = bodyText ? JSON.parse(bodyText) : {};
      const file = state.fileMap.get(String(payload.file_id));
      if (!file) return json({ ok: false, description: "Bad Request: file not found" }, 400);

      if (Number(file.size) > 20 * MB) {
        return json({
          ok: false,
          description: "Bad Request: file is too big",
        }, 400);
      }

      return json({
        ok: true,
        result: {
          file_id: String(payload.file_id),
          file_size: Number(file.size),
          file_path: file.path,
        },
      });
    }

    if (path.includes("/file/bot-test-bot-token/")) {
      state.calls.file += 1;
      const filePath = path.split("/").pop();
      const file = [...state.fileMap.values()].find(
        (entry) => entry.path === filePath
      );
      if (!file) return new Response("missing file", { status: 404 });

      return new Response(file.body, {
        status: 200,
        headers: {
          "Content-Length": String(file.body.byteLength),
          "Content-Type": "application/octet-stream",
          ETag: '"telegram-source"',
        },
      });
    }
  }

  return new Response("unhandled test fetch: " + url.toString(), {
    status: 500,
  });
}

async function request(path, init = {}) {
  return worker.fetch(
    new Request("https://worker.test" + path, init),
    env
  );
}

async function readText(response) {
  return new TextDecoder().decode(
    new Uint8Array(await response.arrayBuffer())
  );
}

async function clearBucket() {
  let cursor;
  do {
    const listed = await env.MEDIA_CACHE.list({
      prefix: "streaming-cache/",
      limit: 1000,
      cursor,
    });
    if (listed.objects.length) {
      await env.MEDIA_CACHE.delete(
        listed.objects.map((object) => object.key)
      );
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function getOnlyCacheKey(prefix) {
  const listed = await env.MEDIA_CACHE.list({
    prefix,
    limit: 1000,
  });
  expect(listed.objects).toHaveLength(1);
  return listed.objects[0].key;
}

beforeEach(async () => {
  resetState();
  await clearBucket();
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
});

describe("Phase 3 Cloudflare streaming worker", () => {
  it("does R2 MISS -> Telegram -> R2 and then HIT, including Range/seek/HEAD/416", async () => {
    const first = await request("/audio/message/101", {
      headers: { Origin: ORIGIN, "User-Agent": "HJ-Test/1.0" },
    });
    expect(first.status).toBe(200);
    expect(await readText(first)).toBe("0123456789ABCDEFGHIJ");
    expect(state.calls.getFile).toBe(1);
    expect(state.calls.file).toBe(1);

    const second = await request("/audio/message/101", {
      headers: { Origin: ORIGIN, "User-Agent": "HJ-Test/1.0" },
    });
    expect(second.status).toBe(200);
    expect(await readText(second)).toBe("0123456789ABCDEFGHIJ");
    expect(state.calls.getFile).toBe(1);
    expect(state.calls.file).toBe(1);
    expect(second.headers.get("X-HJ-Telegram-Cache")).toBe("HIT");

    const range = await request("/audio/message/101", {
      headers: {
        Origin: ORIGIN,
        "User-Agent": "HJ-Test/1.0",
        Range: "bytes=5-9",
      },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 5-9/20");
    expect(range.headers.get("Content-Length")).toBe("5");
    expect(await readText(range)).toBe("56789");
    expect(state.calls.getFile).toBe(1);

    const seek = await request("/audio/message/101", {
      headers: {
        Origin: ORIGIN,
        Range: "bytes=15-",
      },
    });
    expect(seek.status).toBe(206);
    expect(await readText(seek)).toBe("FGHIJ");

    const head = await request("/audio/message/101", {
      method: "HEAD",
      headers: { Origin: ORIGIN },
    });
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe("20");
    expect(await head.text()).toBe("");

    const unsat = await request("/audio/message/101", {
      headers: {
        Origin: ORIGIN,
        Range: "bytes=999-1000",
      },
    });
    expect(unsat.status).toBe(416);
    expect(unsat.headers.get("Content-Range")).toBe("bytes */20");
  });

  it("supports OPTIONS and all three final media routes", async () => {
    const options = await request("/audio/message/101", {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);

    const video = await request("/video/message/202", {
      headers: { Origin: ORIGIN },
    });
    expect(video.status).toBe(200);
    expect(await readText(video)).toBe("VIDEO-202!");

    const document = await request("/document/message/303", {
      headers: { Origin: ORIGIN },
    });
    expect(document.status).toBe(200);
    expect(await readText(document)).toBe("%PDF-303!!");
  });

  it("fails safely for missing media and oversized source without chunks", async () => {
    const missing = await request("/audio/message/9999", {
      headers: { Origin: ORIGIN },
    });
    expect(missing.status).toBe(404);

    const oversized = await request("/audio/message/404", {
      headers: { Origin: ORIGIN },
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: "TELEGRAM_FILE_TOO_LARGE",
      hint: "needs_split",
    });
    expect(state.calls.getFile).toBe(0);
  });

  it("keeps listener endpoints compatible without state or Durable Objects", async () => {
    for (const name of ["start", "heartbeat", "end"]) {
      const response = await request("/listener/" + name, {
        method: "POST",
        headers: { Origin: ORIGIN },
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    }
  });

  it("preserves ticket expiry, user binding, user-agent binding and protected access", async () => {
    state.media.get("audio:101").policy.access_type = "premium";

    const ticketResponse = await request(
      "/media-ticket/audio/message/101",
      {
        headers: {
          Origin: ORIGIN,
          Authorization: "Bearer user-1",
          "User-Agent": "HJ-Phone/1",
        },
      }
    );
    expect(ticketResponse.status).toBe(200);
    const ticketPayload = await ticketResponse.json();
    const ticketUrl = new URL(ticketPayload.url);

    const valid = await request(
      ticketUrl.pathname + ticketUrl.search,
      {
        headers: {
          Origin: ORIGIN,
          "User-Agent": "HJ-Phone/1",
        },
      }
    );
    expect(valid.status).toBe(200);

    const wrongUa = await request(
      ticketUrl.pathname + ticketUrl.search,
      {
        headers: {
          Origin: ORIGIN,
          "User-Agent": "HJ-Phone/2",
        },
      }
    );
    expect(wrongUa.status).toBe(401);

    const wrongUser = await request(
      ticketUrl.pathname + ticketUrl.search,
      {
        headers: {
          Origin: ORIGIN,
          Authorization: "Bearer user-2",
          "User-Agent": "HJ-Phone/1",
        },
      }
    );
    expect(wrongUser.status).toBe(403);

    const unauth = await request("/audio/message/101", {
      headers: {
        Origin: ORIGIN,
        "User-Agent": "HJ-Phone/1",
      },
    });
    expect(unauth.status).toBe(401);

    const expiredTicket = await makeExpiredTicket("user-1", "HJ-Phone/1");
    const expired = await request(
      "/audio/message/101?ticket=" +
      encodeURIComponent(expiredTicket),
      {
        headers: {
          Origin: ORIGIN,
          "User-Agent": "HJ-Phone/1",
        },
      }
    );
    expect(expired.status).toBe(401);
  });

  it("detects corrupted direct R2 cache and recreates it after deletion", async () => {
    const first = await request("/audio/message/101");
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    const descriptor = await buildMediaDescriptor(
      "audio",
      101,
      state.media.get("audio:101").index,
      state.media.get("audio:101").policy
    );
    const key = await getOnlyCacheKey("streaming-cache/media/audio");

    await env.MEDIA_CACHE.put(key, "bad-cache", {
      httpMetadata: { contentType: "audio/mp4" },
      customMetadata: {
        complete: "1",
        kind: "audio",
        messageId: "101",
        contentId: "1",
        sourceIdentity: descriptor.sourceIdentity,
        sourceSize: "20",
        mimeType: "audio/mp4",
        fileUniqueId: descriptor.fileUniqueId,
        version: descriptor.version,
      },
    });

    const repaired = await request("/audio/message/101");
    expect(repaired.status).toBe(200);
    expect(await readText(repaired)).toBe("0123456789ABCDEFGHIJ");
    expect(state.calls.getFile).toBe(2);

    await env.MEDIA_CACHE.delete(key);
    const recreated = await request("/audio/message/101");
    expect(recreated.status).toBe(200);
    expect(await readText(recreated)).toBe("0123456789ABCDEFGHIJ");
    expect(state.calls.getFile).toBe(3);
  });

  it("plays chunked media as one logical file, including boundary ranges and last-chunk seek", async () => {
    const rows = await makeChunkRows(1);
    state.chunks.set(1, rows);
    state.media.get("audio:101").index.file_size = 20;

    for (const row of rows) {
      state.fileMap.set(row.telegram_file_id, {
        size: row.size,
        body: new TextEncoder().encode(row.value),
        path: "source/" + row.telegram_file_id,
      });
    }

    const full = await request("/audio/message/101", {
      headers: { Origin: ORIGIN },
    });
    expect(full.status).toBe(200);
    expect(full.headers.get("Content-Length")).toBe("20");
    expect(await readText(full)).toBe("ABCDEFGHIJklmnopqrst");
    expect(state.calls.getFile).toBe(2);

    const boundary = await request("/audio/message/101", {
      headers: {
        Origin: ORIGIN,
        Range: "bytes=8-12",
      },
    });
    expect(boundary.status).toBe(206);
    expect(boundary.headers.get("Content-Range")).toBe("bytes 8-12/20");
    expect(await readText(boundary)).toBe("IJklm");
    expect(state.calls.getFile).toBe(2);

    const last = await request("/audio/message/101", {
      headers: {
        Origin: ORIGIN,
        Range: "bytes=18-19",
      },
    });
    expect(last.status).toBe(206);
    expect(await readText(last)).toBe("st");
    expect(state.calls.getFile).toBe(2);
  });

  it("fetches only the chunk(s) needed for a ranged request and verifies chunk cache integrity", async () => {
    const rows = await makeChunkRows(5);
    state.chunks.set(5, rows);
    state.media.set("audio:505", {
      index: {
        storage_chat_id: 12345,
        telegram_message_id: 505,
        media_kind: "audio",
        file_id: "unused",
        file_unique_id: "uid-a505",
        file_name: "episode-505.m4a",
        mime_type: "audio/mp4",
        file_size: 24,
        updated_at: "2026-10-08T00:00:00Z",
      },
      policy: {
        id: 5,
        story_id: 10,
        access_type: "free",
        available: true,
        episode_number: 505,
        number: 505,
      },
      body: new Uint8Array(),
    });

    for (const row of rows) {
      state.fileMap.set(row.telegram_file_id, {
        size: row.size,
        body: new TextEncoder().encode(row.value),
        path: "source/" + row.telegram_file_id,
      });
    }

    const middle = await request("/audio/message/505", {
      headers: {
        Origin: ORIGIN,
        Range: "bytes=9-11",
      },
    });
    expect(middle.status).toBe(206);
    expect(await readText(middle)).toBe("bbb");
    expect(state.calls.getFile).toBe(1);

    const middleKey = (await env.MEDIA_CACHE.list({
      prefix: "streaming-cache/chunk/5/1",
    })).objects[0]?.key;
    expect(middleKey).toBeTruthy();

    await env.MEDIA_CACHE.put(middleKey, "x", {
      httpMetadata: { contentType: "audio/mp4" },
      customMetadata: { complete: "1" },
    });

    const repaired = await request("/audio/message/505", {
      headers: {
        Origin: ORIGIN,
        Range: "bytes=9-11",
      },
    });
    expect(repaired.status).toBe(206);
    expect(await readText(repaired)).toBe("bbb");
    expect(state.calls.getFile).toBe(2);
  });

  it("rejects malformed or missing chunk metadata instead of fetching an unsafe source", async () => {
    state.chunks.set(1, [
      {
        episode_id: 1,
        idx: 0,
        telegram_file_id: "",
        file_unique_id: "bad",
        size: 10,
        sha256: "0".repeat(64),
      },
    ]);

    const response = await request("/audio/message/101");
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "EPISODE_CHUNKS_INVALID",
    });
    expect(state.calls.getFile).toBe(0);
  });
});

async function makeExpiredTicket(userId, userAgent) {
  const payload = {
    kind: "audio",
    messageId: 101,
    userId,
    ua: await base64Sha256(userAgent),
    exp: Date.now() - 60_000,
  };

  const encoded = base64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("phase3-test-secret"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(encoded)
  );

  return encoded + "." + base64Url(signature);
}

async function base64Sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(value))
  );
  return base64Url(digest);
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
